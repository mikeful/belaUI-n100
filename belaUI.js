/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

const http = require('http');
const finalhandler = require('finalhandler');
const serveStatic = require('serve-static');
const ws = require('ws');
const { exec, execSync, spawn, spawnSync, execFileSync, execFile } = require("child_process");
const fs = require('fs')
const crypto = require('crypto');
const path = require('path');
const { Resolver} = require('dns');
const bcrypt = require('bcrypt');
const process = require('process');
const util = require('util');
const assert = require('assert');

const SETUP_FILE = 'setup.json';
const CONFIG_FILE = 'config.json';
const AUTH_TOKENS_FILE = 'auth_tokens.json';
const RELAYS_CACHE_FILE = 'relays_cache.json';
const GSM_OPERATORS_CACHE_FILE = 'gsm_operator_cache.json';

const DNS_CACHE_FILE = 'dns_cache.json';
/* Minimum age of an updated record to trigger a persistent DNS cache update (in ms)
   Some records change with almost every query if using CDNs, etc
   This limits the frequency of file writes */
const DNS_MIN_AGE = 60000; // in ms
const DNS_TIMEOUT = 2000; // in ms
const DNS_WELLKNOWN_NAME = 'wellknown.belabox.net';
const DNS_WELLKNOWN_ADDR = '127.1.33.7';

const CONNECTIVITY_CHECK_DOMAIN = 'www.gstatic.com';
const CONNECTIVITY_CHECK_PATH = '/generate_204';
const CONNECTIVITY_CHECK_CODE = 204;
const CONNECTIVITY_CHECK_BODY = '';

const BCRYPT_ROUNDS = 10;
const ACTIVE_TO = 15000;

/* Disable localization for any CLI commands we run */
process.env['LANG'] = 'C.UTF-8';
process.env['LANGUAGE'] = 'C';
/* Make sure apt-get doesn't expect any interactive user input */
process.env['DEBIAN_FRONTEND'] = 'noninteractive';

/* Read the config and setup files */
const setup = JSON.parse(fs.readFileSync(SETUP_FILE, 'utf8'));
console.log(setup);

let belacoderExec, belacoderPipelinesDir;
if (setup.belacoder_path) {
  belacoderExec = setup.belacoder_path + '/belacoder';
  belacoderPipelinesDir = setup.belacoder_path + '/pipeline';
} else {
  belacoderExec = "/usr/bin/belacoder";
  belacoderPipelinesDir = "/usr/share/belacoder/pipelines";
}

let srtlaSendExec;
if (setup.srtla_path) {
  srtlaSendExec = setup.srtla_path + '/srtla_send';
} else {
  srtlaSendExec = "/usr/bin/srtla_send";
}

function checkExecPath(path) {
  try {
    fs.accessSync(path, fs.constants.R_OK);
  } catch (err) {
    console.log(`\n\n${path} not found, double check the settings in setup.json`);
    process.exit(1);
  }
}

checkExecPath(belacoderExec);
checkExecPath(srtlaSendExec);


/* Read the revision numbers */
function getRevision(cmd) {
  try {
    return execSync(cmd).toString().trim();
  } catch (err) {
    return 'unknown revision';
  }
}

const revisions = {};
try {
  revisions['belaUI'] = fs.readFileSync('revision', 'utf8');
} catch(err) {
  revisions['belaUI'] = getRevision('git rev-parse --short HEAD');
}
revisions['belacoder'] = getRevision(`${belacoderExec} -v`);
revisions['srtla'] = getRevision(`${srtlaSendExec} -v`);
// Only show a BELABOX image version if it exists
try {
  revisions['BELABOX image'] = fs.readFileSync('/etc/belabox_img_version', 'utf8').trim();
} catch(err) {};
console.log(revisions);

let config;
let passwordHash;
let sshPasswordHash;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  console.log(config);
  passwordHash = config.password_hash;
  sshPasswordHash = config.ssh_pass_hash;
  delete config.password_hash;
  delete config.ssh_pass_hash;
} catch (err) {
  console.log(`Failed to open the config file: ${err.message}. Creating an empty config`);
  config = {};

  // Configure the default audio source depending on the platform
  switch (setup.hw) {
    case 'jetson':
      config.asrc = fs.existsSync('/dev/hdmi_capture') ? 'HDMI' : 'C4K';
      break;
    case 'rk3588':
      config.asrc = fs.existsSync('/dev/hdmirx') ? 'HDMI' : 'USB audio';
      break;
  }
}


/* tempTokens stores temporary login tokens in memory,
   persistentTokens stores login tokens to the disc */
const tempTokens = {};
let persistentTokens;
try {
  persistentTokens = JSON.parse(fs.readFileSync(AUTH_TOKENS_FILE, 'utf8'));
} catch(err) {
  persistentTokens = {};
}

function saveConfig() {
  config.password_hash = passwordHash;
  config.ssh_pass_hash = sshPasswordHash;
  const c = JSON.stringify(config);
  delete config.password_hash;
  delete config.ssh_pass_hash;
  fs.writeFileSync(CONFIG_FILE, c);
}

function savePersistentTokens() {
  fs.writeFileSync(AUTH_TOKENS_FILE, JSON.stringify(persistentTokens));
}


/* Initialize the server */
const staticHttp = serveStatic("public");

const server = http.createServer(function(req, res) {
  const done = finalhandler(req, res);
  staticHttp(req, res, done);
});

const wss = new ws.Server({ server });
wss.on('connection', function connection(conn) {
  conn.lastActive = getms();

  if (!passwordHash) {
    conn.send(buildMsg('status', {set_password: true}));
  }
  notificationSendPersistent(conn, false);

  conn.on('message', function incoming(msg) {
    try {
      msg = JSON.parse(msg);
      handleMessage(conn, msg);
    } catch (err) {
      console.log(`Error parsing client message: ${err.message}`);
    }
  });
});


/* Misc helpers */
const oneMinute = 60 * 1000;
const oneHour = 60 * oneMinute;
const oneDay = 24 * oneHour;

function getms() {
  const [sec, ns] = process.hrtime();
  return sec * 1000 + Math.floor(ns / 1000 / 1000);
}

async function readTextFile(file) {
  const readFile = util.promisify(fs.readFile);
  const contents = await readFile(file).catch(function(err) {return undefined});
  if (contents === undefined) return;
  return contents.toString('utf8');
}

async function writeTextFile(file, contents) {
  const writeFile = util.promisify(fs.writeFile);
  await writeFile(file, contents).catch(function() {return false});
  return true;
}

const execP = util.promisify(exec);
const execFileP = util.promisify(execFile);
// Promise-based exec(), but without rejections
async function execPNR(cmd) {
  try {
    const res = await execP(cmd);
    return {stdout: res.stdout, stderr: res.stderr, code: 0};
  } catch (err) {
    return {stdout: err.stdout, stderr: err.stderr, code: err.code};
  }
}

const readdirP = util.promisify(fs.readdir);


/* WS helpers */
function buildMsg(type, data, id = undefined) {
  const obj = {};
  obj[type] = data;
  obj.id = id;
  return JSON.stringify(obj);
}

function broadcastMsgLocal(type, data, activeMin = 0, except = undefined, authedOnly = true) {
  const msg = buildMsg(type, data);
  for (const c of wss.clients) {
    if (c !== except && c.lastActive >= activeMin && (authedOnly === false || c.isAuthed)) c.send(msg);
  }
  return msg;
}

function broadcastMsg(type, data, activeMin = 0, authedOnly = true) {
  const msg = broadcastMsgLocal(type, data, activeMin, undefined, authedOnly);
  if (remoteWs && remoteWs.isAuthed) {
    remoteWs.send(msg);
  }
}

function broadcastMsgExcept(conn, type, data) {
  broadcastMsgLocal(type, data, 0, conn);
  if (remoteWs && remoteWs.isAuthed) {
    const msg = buildMsg(type, data, conn.senderId);
    remoteWs.send(msg);
  }
}


/* Network interface list */
let netif = {};

function updateNetif() {
  exec("ifconfig", (error, stdout, stderr) => {
    if (error) {
      console.log(error.message);
      return;
    }

    let intsChanged = false;
    const newints = {};

    wiFiDeviceListStartUpdate();

    const interfaces = stdout.split("\n\n");
    for (const int of interfaces) {
      try {
        const name = int.split(':')[0];

        let inetAddr = int.match(/inet (\d+\.\d+\.\d+\.\d+)/);
        if (inetAddr) inetAddr = inetAddr[1];

        const flags = int.match(/flags=\d+<([A-Z,]+)>/)[1].split(',');
        const isRunning = flags.includes('RUNNING');

        // update the list of WiFi devices
        if (name && name.match('^wl')) {
          let hwAddr = int.match(/ether ([0-9a-f:]+)/);
          if (hwAddr) {
            wiFiDeviceListAdd(name, hwAddr[1], isRunning ? inetAddr : null);
          }
        }

        if (name == 'lo' || name.match('^docker') || name.match('^l4tbr') || name.match('^wg')) continue;

        if (!inetAddr) continue;
        if (!isRunning) continue;

        let txBytes = int.match(/TX packets \d+  bytes \d+/);
        txBytes = parseInt(txBytes[0].split(' ').pop());
        if (netif[name]) {
          tp = txBytes - netif[name]['txb'];
        } else {
          tp = 0;
        }

        const enabled = (netif[name] && netif[name].enabled == false) ? false : true;
        const error = netif[name] ? netif[name].error : 0;
        newints[name] = {ip: inetAddr, txb: txBytes, tp, enabled, error};

        // Detect interfaces that are new or with a different address
        if (!netif[name] || netif[name].ip != inetAddr) {
          intsChanged = true;
        }
      } catch (err) {};
    }

    // Detect removed interfaces
    for (const i in netif) {
      if (!newints[i]) {
        intsChanged = true;
      }
    }

    if (intsChanged) {
      const intAddrs = {};

      // Detect duplicate IP adddresses and set error status
      for (const i in newints) {
        const int = newints[i];
        clearNetifDup(int);

        if (intAddrs[int.ip] === undefined) {
          intAddrs[int.ip] = i;
        } else {
          if (Array.isArray(intAddrs[int.ip])) {
            intAddrs[int.ip].push(i);
          } else {
            setNetifDup(newints[intAddrs[int.ip]]);
            intAddrs[int.ip] = [intAddrs[int.ip], i];
          }
          setNetifDup(int);
        }
      }

      // Send out an error message for duplicate IP addresses
      let msg = '';
      for (const d in intAddrs) {
        if (Array.isArray(intAddrs[d])) {
          if (msg != '') {
            msg += '; ';
          }
          msg += `Interfaces ${intAddrs[d].join(', ')} can't be used because they share the same IP address: ${d}`;
        }
      }

      if (msg == '') {
        notificationRemove('netif_dup_ip');
      } else {
        notificationBroadcast('netif_dup_ip', 'error', msg, 0, true, true);
      }
    }

    if (wiFiDeviceListEndUpdate()) {
      console.log("updated wifi devices");
      // a delay seems to be needed before NM registers new devices
      setTimeout(wifiUpdateDevices, 1000);
    }

    netif = newints;

    if (intsChanged && isStreaming) {
      updateSrtlaIps();
    }

    broadcastMsg('netif', netIfBuildMsg(), getms() - ACTIVE_TO);
  });
}
updateNetif();
setInterval(updateNetif, 1000);

const NETIF_ERR_DUPIPV4 = 0x01;
const NETIF_ERR_HOTSPOT = 0x02;
// The order is deliberate, we want *hotspot* to have higher priority
const netIfErrors = {
  2: 'WiFi hotspot',
  1: 'duplicate IPv4 addr'
}

function setNetifError(int, err) {
  if (!int) return;

  int.enabled = false;
  int.error |= err;
}

function clearNetifError(int, err) {
  if (!int) return;
  int.error &= ~err;
}

function setNetifDup(int) {
  setNetifError(int, NETIF_ERR_DUPIPV4);
}
function clearNetifDup(int) {
  clearNetifError(int, NETIF_ERR_DUPIPV4);
}

function setNetifHotspot(int) {
  setNetifError(int, NETIF_ERR_HOTSPOT);
}

function netIfGetErrorMsg(i) {
  if (i.error == 0) return;

  for (const e in netIfErrors) {
    if (i.error & e) return netIfErrors[e];
  }
}

function netIfBuildMsg() {
  const m = {};
  for (const i in netif) {
    m[i] = {ip: netif[i].ip, tp: netif[i].tp, enabled: netif[i].enabled};
    const error = netIfGetErrorMsg(netif[i]);
    if (error) {
      m[i].error = error;
    }
  }
  return m;
}

function countActiveNetif() {
  let count = 0;
  for (const int in netif) {
    if (netif[int].enabled) count++;
  }
  return count;
}

function handleNetif(conn, msg) {
  const int = netif[msg.name];
  if (!int) return;

  if (int.ip != msg.ip) return;

  if (msg.enabled === true || msg.enabled === false) {
    if (msg.enabled) {
      const err = netIfGetErrorMsg(int);
      if (err) {
        notificationSend(conn, "netif_enable_error", "error", `Can't enable ${msg.name}: ${err}`, 10);
        return;
      }
    } else {
      if (int.enabled && countActiveNetif() == 1) {
        notificationSend(conn, "netif_disable_all", "error", "Can't disable all networks", 10);
        return;
      }
    }

    int.enabled = msg.enabled;
    if (isStreaming) {
      updateSrtlaIps();
    }
  }

  conn.send(buildMsg('netif', netIfBuildMsg()));
}


/*
  DNS utils w/ a persistent cache
*/

/*
  dns.Resolver uses c-ares, with each instance (and the global
  dns.resolve*() functions) mapped one-to-one to a c-ares channel

  c-ares channels re-use the underlying UDP sockets for multi queries,
  which is good for performance but the incorrect behaviour for us, as
  it can end up trying to use stale connections long after we change
  the default route after a network becomes unavailable

  For simplicity, we create a new instance for each query unless one
  is provided by the caller. The callers shouldn't reuse Resolver
  instances for unrelated queries as we call resolver.cancel() on
  timeout, which will make all pending queries time out.
*/
function resolveP(hostname, rrtype = undefined, resolver = undefined) {
  if (rrtype !== undefined && rrtype !== 'a' && rrtype !== 'aaaa') {
    throw(`invalid rrtype ${rrtype}`);
  }

  if (!resolver) {
    resolver = new Resolver();
  }

  return new Promise(function(resolve, reject) {
    let to;

    if (DNS_TIMEOUT) {
      to = setTimeout(function() {
        resolver.cancel();
        reject(`DNS timeout for ${hostname}`);
      }, DNS_TIMEOUT);
    }

    let ipv4Res;
    if (rrtype === undefined || rrtype == 'a') {
      resolver.resolve4(hostname, {}, function(err, address) {
        ipv4Res = err ? null : address;
        returnResults();
      });
    }

    let ipv6Res;
    if (rrtype === undefined || rrtype == 'aaaa') {
      resolver.resolve6(hostname, {}, function(err, address) {
        ipv6Res = err ? null : address;
        returnResults();
      });
    }

    const returnResults = function() {
      // If querying both for A and AAAA records, wait for the IPv4 result
      if (rrtype === undefined && ipv4Res === undefined) return;

      let res;
      if (ipv4Res) {
        res = ipv4Res;
      } else if (ipv6Res) {
        res = ipv6Res;
      }

      if (res) {
        if (to) {
          clearTimeout(to);
        }
        resolve(res);
      } else {
        reject(`DNS record not found for ${hostname}`);
      }
    }
  });
}

let dnsCache = {};
let dnsResults = {};
try {
  dnsCache = JSON.parse(fs.readFileSync(DNS_CACHE_FILE, 'utf8'));
} catch(err) {
  console.log("Failed to load the persistent DNS cache, starting with an empty cache");
}

function isIpv4Addr(val) {
  return val.match(/^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}$/) != null;
}

async function dnsCacheResolve(name, rrtype = undefined) {
  if (rrtype) {
    rrtype = rrtype.toLowerCase();
    if (rrtype !== 'a' && rrtype !== 'aaaa') {
      throw('Invalid rrtype');
    }
  }

  if (isIpv4Addr(name) && rrtype != 'aaaa') {
    return {addrs: [name], fromCache: false};
  }

  let badDns = true;

  // Reuse the Resolver instance for the actual query after a succesful validation
  const resolver = new Resolver();

  /* Assume that DNS resolving is broken, unless it returns
     the expected result for a known name */
  try {
    const lookup = await resolveP(DNS_WELLKNOWN_NAME, 'a', resolver);
    if (lookup.length == 1 && lookup[0] == DNS_WELLKNOWN_ADDR) {
      badDns = false;
    } else {
      console.log(`DNS validation failure: got result ${lookup} instead of the expected ${DNS_WELLKNOWN_ADDR}`);
    }
  } catch(e) {
    console.log(`DNS validation failure: ${e}`);
  }

  if (badDns) {
    delete dnsResults[name];
  } else {
    try {
      const res = await resolveP(name, rrtype, resolver);
      dnsResults[name] = res;

      return {addrs: res, fromCache: false};
    } catch(err) {
      console.log('dns error ' + err);
    }
  }

  if (dnsCache[name]) return {addrs: dnsCache[name].result, fromCache: true};

  throw('DNS query failed and no cached value is available');
}

function compareArrayElements(a1, a2) {
  if (!Array.isArray(a1) || !Array.isArray(a2)) return false;

  const cmp = {};
  for (e of a1) {
    cmp[e] = false;
  }

  // check that all elements of a2 are in a1
  for (e of a2) {
    if (cmp[e] === undefined) {
      return false;
    }
    cmp[e] = true;
  }

  // check that all elements of a1 are in a2
  for (e in cmp) {
    if (!cmp[e]) return false;
  }

  return true;
}

async function dnsCacheValidate(name) {
  if (!dnsResults[name]) {
    console.log(`DNS: error validating results for ${name}: not found`);
    return;
  }

  if (!dnsCache[name] || !compareArrayElements(dnsResults[name], dnsCache[name].results)) {
    let writeFile = true;

    if (!dnsCache[name]) {
      dnsCache[name] = {};
    }

    if (dnsCache[name].ts &&
        (Date.now() - dnsCache[name].ts) < DNS_MIN_AGE) writeFile = false;

    dnsCache[name].result = dnsResults[name];

    if (writeFile) {
      dnsCache[name].ts = Date.now();
      await writeTextFile(DNS_CACHE_FILE, JSON.stringify(dnsCache));
    }
  }
}


/*
  Check Internet connectivity and if needed update the default route
*/
function httpGet(options) {
  return new Promise(function(resolve, reject) {
    let to;

    if (options.timeout) {
      to = setTimeout(function() {
        req.destroy();
        reject('timeout');
      }, options.timeout);
    }

    var req = http.get(options, function(res) {
      let response = '';
      res.on('data', function(d) {
        response += d;
      });
      res.on('end', function() {
        if (to) {
          clearTimeout(to);
        }
        resolve( {code: res.statusCode, body: response} );
      });
    });

    req.on('error', function(e) {
      if (to) {
        clearTimeout(to);
      }
      reject(e);
    });
  });
}

async function checkConnectivity(remoteAddr, localAddress) {
  try {
    let url = {};
    url.headers = {'Host': CONNECTIVITY_CHECK_DOMAIN};
    url.path = CONNECTIVITY_CHECK_PATH;
    url.host = remoteAddr;
    url.timeout = 4000;

    if (localAddress) {
      url.localAddress = localAddress;
    }

    const res = await httpGet(url);
    if (res.code == CONNECTIVITY_CHECK_CODE && res.body == CONNECTIVITY_CHECK_BODY) {
      return true;
    }
  } catch(err) {
    console.log('Internet connectivity HTTP check error ' + (err.code || err));
  }

  return false;
}

async function clear_default_gws() {
  try {
    while(1) {
      await execP("ip route del default");
    }
  } catch(err) {
    return;
  }
}


let updateGwLock = false;
let updateGwLastRun = 0;
let updateGwQueue = true;

function queueUpdateGw() {
  updateGwQueue = true;
  updateGwWrapper();
}

async function updateGw() {
  try {
    var {addrs, fromCache} = await dnsCacheResolve(CONNECTIVITY_CHECK_DOMAIN);
  } catch (err) {
    console.log(`Failed to resolve ${CONNECTIVITY_CHECK_DOMAIN}: ${err}`);
    return false;
  }

  for (const addr of addrs) {
    if (await checkConnectivity(addr)) {
      if (!fromCache) dnsCacheValidate(CONNECTIVITY_CHECK_DOMAIN);

      console.log('Internet reachable via the default route');
      notificationRemove('no_internet');

      return true;
    }
  }

  const m = 'No Internet connectivity via the default connection, re-checking all connections...';
  notificationBroadcast('no_internet', 'warning', m, 10, true, false);

  let goodIf;
  for (const addr of addrs) {
    for (const i in netif) {
      const error = netIfGetErrorMsg(netif[i]);
      if (error) {
        console.log(`Not probing internet connectivity via ${i} (${netif[i].ip}): ${error}`);
        continue;
      }

      console.log(`Probing internet connectivity via ${i} (${netif[i].ip})`);
      if (await checkConnectivity(addr, netif[i].ip)) {
        console.log(`Internet reachable via ${i} (${netif[i].ip})`);
        if (!fromCache) dnsCacheValidate(CONNECTIVITY_CHECK_DOMAIN);

        goodIf = i;
        break;
      }
    }
  }

  if (goodIf) {
    try {
      const gw = (await execP(`ip route show table ${goodIf} default`)).stdout;
      await clear_default_gws();

      const route = `ip route add ${gw}`;
      await execP(route);

      console.log(`Set default route: ${route}`);
      notificationRemove('no_internet');

      return true;
    } catch (err) {
      console.log(`Error updating the default route: ${err}`);
    }
  }

  return false;
}

const UPDATE_GW_INT = 2000;
async function updateGwWrapper() {
  // Do nothing if no request is queued
  if (!updateGwQueue) return;

  // Rate limit
  const ts = getms();
  const to = updateGwLastRun + UPDATE_GW_INT;
  if (ts < to) return;

  // Don't allow simultaneous execution
  if (updateGwLock) return;

  // Proceeding, update status
  updateGwLastRun = ts;
  updateGwLock = true;
  updateGwQueue = false;

  const r = await updateGw();
  if (!r) {
    updateGwQueue = true;
  }
  updateGwLock = false;
}
updateGwWrapper();
setInterval(updateGwWrapper, UPDATE_GW_INT);


/*
  WiFi device list / status maintained by periodic ifconfig updates

  It tracks and detects changes by device name, physical (MAC) addresses and
  IPv4 address. It allows us to only update the WiFi status via nmcli when
  something has changed, because NM is very CPU / power intensive compared
  to the periodic ifconfig polling that belaUI is already doing
*/
let wifiDeviceHwAddr = {};
let wiFiDeviceListIsModified = false;
let wiFiDeviceListIsUpdating = false;

function wiFiDeviceListStartUpdate() {
  if (wiFiDeviceListIsUpdating) {
    throw "Called while an update was already in progress";
  }

  for (const i in wifiDeviceHwAddr) {
    wifiDeviceHwAddr[i].removed = true;
  }
  wiFiDeviceListIsUpdating = true;
  wiFiDeviceListIsModified = false
}

function wiFiDeviceListAdd(ifname, hwAddr, inetAddr) {
  if (!wiFiDeviceListIsUpdating) {
    throw "Called without starting an update";
  }

  if (wifiDeviceHwAddr[ifname]) {
    if (wifiDeviceHwAddr[ifname].hwAddr != hwAddr) {
      wifiDeviceHwAddr[ifname].hwAddr = hwAddr;
      wiFiDeviceListIsModified = true;
    }
    if (wifiDeviceHwAddr[ifname].inetAddr != inetAddr) {
      wifiDeviceHwAddr[ifname].inetAddr = inetAddr;
      wiFiDeviceListIsModified = true;
    }
    wifiDeviceHwAddr[ifname].removed = false;
  } else {
    wifiDeviceHwAddr[ifname] = {
      hwAddr,
      inetAddr
    };
    wiFiDeviceListIsModified = true;
  }
}

function wiFiDeviceListEndUpdate() {
  if (!wiFiDeviceListIsUpdating) {
    throw "Called without starting an update";
  }

  for (const i in wifiDeviceHwAddr) {
    if (wifiDeviceHwAddr[i].removed) {
      delete wifiDeviceHwAddr[i];
      wiFiDeviceListIsModified = true;
    }
  }

  wiFiDeviceListIsUpdating = false;
  return wiFiDeviceListIsModified;
}

function wifiDeviceListGetHwAddr(ifname) {
  if (wifiDeviceHwAddr[ifname]) {
    return wifiDeviceHwAddr[ifname].hwAddr;
  }
}

function wifiDeviceListGetInetAddr(ifname) {
  if (wifiDeviceHwAddr[ifname]) {
    return wifiDeviceHwAddr[ifname].inetAddr;
  }
}


/* NetworkManager / nmcli helpers */
async function nmConnAdd(fields) {
  try {
    let args = [
      "connection",
      "add"
    ];
    for (const field in fields) {
      args.push(field);
      args.push(fields[field]);
    }
    const result = await execFileP("nmcli", args);
    const success = result.stdout.match(/Connection '.+' \((.+)\) successfully added./);

    if (success) return success[1];

  } catch ({message}) {
    console.log(`nmConnNew err: ${message}`);
  }
}

async function nmConnsGet(fields) {
  try {
    const result = await execFileP("nmcli", [
      "--terse",
      "--fields",
      fields,
      "connection",
      "show",
    ]);
    return result.stdout.toString("utf-8").split("\n");

  } catch ({message}) {
    console.log(`nmConnsGet err: ${message}`);
  }
}

async function nmConnGetFields(uuid, fields) {
  try {
    const result = await execFileP("nmcli", [
      "--terse",
      "--escape", "no",
      "--show-secrets",
      "--get-values",
      fields,
      "connection",
      "show",
      uuid,
    ]);
    return result.stdout.toString("utf-8").split("\n");

  } catch ({message}) {
    console.log(`nmConnGetFields err: ${message}`);
  }
}

async function nmConnSetFields(uuid, fields) {
  try {
    let args = [
      "con",
      "modify",
      uuid,
    ];
    for (const field in fields) {
      args.push(field);
      args.push(fields[field]);
    }
    const result = await execFileP("nmcli", args);
    return (result.stdout == "");

  } catch ({message}) {
    console.log(`nmConnSetFields err: ${message}`);
  }
  return false;
}

async function nmConnSetWifiMac(uuid, mac) {
  return nmConnSetFields(uuid, {'connection.interface-name': '', '802-11-wireless.mac-address': mac});
}

async function nmConnDelete(uuid) {
  try {
    const result = await execFileP("nmcli", ["conn", "del", uuid]);
    return result.stdout.match("successfully deleted");

  } catch ({message}) {
    console.log(`nmConnDelete err: ${message}`);
  }
  return false;
}

async function nmConnect(uuid, timeout = undefined) {
  try {
    const timeoutArgs = timeout ? ["-w", timeout] : [];
    const result = await execFileP("nmcli", timeoutArgs.concat(["conn", "up", uuid]));
    return result.stdout.match("^Connection successfully activated")

  } catch ({message}) {
    console.log(`nmConnect err: ${message}`);
  }
  return false;
}

async function nmDisconnect(uuid) {
  try {
     const result = await execFileP("nmcli", ["conn", "down", uuid]);
     return result.stdout.match("successfully deactivated");

  } catch ({message}) {
    console.log(`nmDisconnect err: ${message}`);
  }
  return false;
}

async function nmDevices(fields) {
  try {
    const result = await execFileP("nmcli", [
      "--terse",
      "--fields",
      fields,
      "device",
      "status",
    ]);
    return result.stdout.toString("utf-8").split("\n");

  } catch ({message}) {
    console.log(`nmDevices err: ${message}`);
  }
}

async function nmDeviceProp(device, fields) {
  try {
    const result = await execFileP("nmcli", [
      "--terse",
      "--escape", "no",
      "--get-values",
      fields,
      "device",
      "show",
      device
    ]);
    return result.stdout.toString("utf-8").split("\n");

  } catch ({message}) {
    console.log(`nmDeviceProp err: ${message}`);
  }
}

async function nmRescan(device) {
  try {
    const args = ["device", "wifi", "rescan"];
    if (device) {
      args.push("ifname");
      args.push(device);
    }
    const result = await execFileP("nmcli", args);
    return result.stdout == "";

  } catch ({message}) {
    console.log(`nmDevices err: ${message}`);
  }
  return false;
}

async function nmScanResults(fields) {
  try {
    const result = await execFileP("nmcli", [
      "--terse",
      "--fields",
      fields,
      "device",
      "wifi",
      "list",
      "--rescan",
      "no"
    ]);
    return result.stdout.toString("utf-8").split("\n");

  } catch ({message}) {
    console.log(`nmScanResults err: ${message}`);
  }
}

async function nmHotspot(device, ssid, password, timeout = undefined) {
  try {
    const timeoutArgs = timeout ? ["-w", timeout] : [];
    const result = await execFileP("nmcli", timeoutArgs.concat([
      "device", "wifi",
      "hotspot",
      "ssid", ssid,
      "password", password,
      "ifname", device
    ]));

    const uuid = result.stdout.match(/successfully activated with '(.+)'/);
    return uuid[1];
  } catch ({message}) {
    console.log(`nmHotspot err: ${message}`);
  }
}

// parses : separated values, with automatic \ escape detection and stripping
function nmcliParseSep(value) {
  return value.split(/(?<!\\):/).map(a => a.replace(/\\:/g, ':'));
}


/*
  NetworkManager / nmcli based Wifi Manager

  Structs:

  WiFi list <wifiIfs>:
  {
    'mac': <wd>
  }

  WiFi id to MAC address mapping <wifiIdToHwAddr>:
  {
    id: 'mac'
  }

  Wifi device <wd>:
  {
    'id', // numeric id for the adapter - temporary for each belaUI execution
    'ifname': 'wlanX',
    'conn': 'uuid' or undefined; // the active connection
    'hw': 'hardware name',       // the name of the wifi adapter hardware
    'available': Map{<an>},
    'saved': {<sn>},
    'hotspot': {
      'conn': 'uuid',
      'name': 'ssid',
      'password': 'password',
      'availableChannels': ['auto', 'auto_24', 'auto_50'],
      'channel': ^see above,
      'warnings': {} / {modified: true},
    }
  }

  Available network <an>:
  {
    active, // is it currently connected?
    ssid,
    signal: 0-100,
    security,
    freq
  }

  Saved networks {<sn>}:
  {
    ssid: uuid,
  }
*/
let wifiIfId = 0;
let wifiIfs = {};
let wifiIdToHwAddr = {};

/* Builds the WiFi status structure sent over the network from the <wd> structures */
function wifiBuildMsg() {
  const ifs = {};
  for (const i in wifiIfs) {
    const id = wifiIfs[i].id;
    const s = wifiIfs[i];

    ifs[id] = {
      ifname: s.ifname,
      conn: s.conn,
      hw: s.hw
    };

    if (wifiIfIsHotspot(s)) {
      ifs[id].hotspot = {};
      ifs[id].hotspot.name = s.hotspot.name;
      ifs[id].hotspot.password = s.hotspot.password;
      ifs[id].hotspot.available_channels = getWifiChannelMap(s.hotspot.availableChannels);
      ifs[id].hotspot.channel = s.hotspot.channel;
      const warnings = Object.keys(s.hotspot.warnings);
      if (warnings.length > 0) {
        ifs[id].hotspot.warnings = warnings;
      }
    } else {
      ifs[id].available = Array.from(s.available.values());
      ifs[id].saved = s.saved;
      if (s.hotspot) {
        ifs[id].supports_hotspot = true;
      }
    }
  }

  return ifs;
}

function wifiBroadcastState() {
  broadcastMsg('status', {wifi: wifiBuildMsg()});
}

const wifiChannels = {
  auto:    {name: 'Auto (any band)', nmBand: '',   nmChannel: ''},
  auto_24: {name: 'Auto (2.4 GHz)',  nmBand: 'bg', nmChannel: ''},
  auto_50: {name: 'Auto (5.0 GHz)',  nmBand: 'a',  nmChannel: ''}
};

function getWifiChannelMap(list) {
  const map = {};
  for (const e of list) {
    if (wifiChannels[e]) {
      map[e] = {name: wifiChannels[e].name};
    } else {
      console.log(`Unknown WiFi channel ${e}`);
    }
  }

  return map;
}

function channelFromNM(band, channel) {
  for (const i in wifiChannels) {
    if (band == wifiChannels[i].nmBand &&
        (channel == wifiChannels[i].nmChannel || (channel == 0 && wifiChannels[i].nmChannel == ''))) {
      return i;
    }
  }

  console.log(`channelFromNM(): WARNING unknown NM channel (band: ${band}, channel: ${channel}`);
  return 'auto';
}

async function handleHotspotConn(macAddr, uuid) {
  if (!macAddr) {
    // Check if the connection is in use for any wifi interface
    const connIfName = await nmConnGetFields(uuid, 'connection.interface-name');

    for (const m in wifiIfs) {
      const w = wifiIfs[m];

      if (w.hotspot && (w.hotspot.conn == uuid || w.ifname == connIfName)) {
        // If we can match the connection against a certain interface
        if (!w.hotspot.conn) {
          // And if this interface doesn't already have a hotspot connection
          // Try to update the connection to match the MAC address
          if (await nmConnSetWifiMac(uuid, m)) {
            w.hotspot.conn = uuid;
            macAddr = m;
          }
        } else {
          // If the interface already has a hotspot connection, then disable autoconnect
          await nmConnSetFields(uuid, {'connection.autoconnect': 'no'});
        }
        break;
      } // if (w.hotspot && ...)
    } // for m in wifiIfs
  } // !macAddr

  if (!macAddr || !wifiIfs[macAddr] || !wifiIfs[macAddr].hotspot || (wifiIfs[macAddr].hotspot.conn && wifiIfs[macAddr].hotspot.conn != uuid)) {
    return;
  }

  /*
    we expect and will update automatically:
    connection.autoconnect-priority: 999

    we expect these settings, otherwise will mark as modified connections:
    802-11-wireless.hidden=no
    802-11-wireless-security.key-mgmt=wpa-psk
    802-11-wireless-security.pairwise=ccmp
    802-11-wireless-security.group=ccmp
    802-11-wireless-security.proto=rsn
    802-11-wireless-security.pmf=1 (disable) - disables requiring WPA3 Protected Management Frames for compatibility
  */
  const settingsFields = "connection.autoconnect-priority," +
                         "802-11-wireless.ssid," +
                         "802-11-wireless-security.psk," +
                         "802-11-wireless.band," +
                         "802-11-wireless.channel";
  const checkFields = "802-11-wireless.hidden," +
                      "802-11-wireless-security.key-mgmt," +
                      "802-11-wireless-security.pairwise," +
                      "802-11-wireless-security.group," +
                      "802-11-wireless-security.proto," +
                      "802-11-wireless-security.pmf";

  const fields = await nmConnGetFields(uuid, `${settingsFields},${checkFields}`);

  /* If the connection doesn't have maximum priority, update it
     This is required to ensure the hotspot is started even if the Wifi
     networks for some matching client connections are available
  */
  if (fields[0] != '999') {
    await nmConnSetFields(uuid, {'connection.autoconnect-priority': 999});
  }

  wifiIfs[macAddr].hotspot.conn = uuid;
  wifiIfs[macAddr].hotspot.name = fields[1];
  wifiIfs[macAddr].hotspot.password = fields[2];
  wifiIfs[macAddr].hotspot.channel = channelFromNM(fields[3], fields[4]);

  if (fields[5] != "no" || fields[6] != "wpa-psk" || fields[7] != "ccmp" || fields[8] != "ccmp" || fields[9] != "rsn" || fields[10] != "1") {
    wifiIfs[macAddr].hotspot.warnings.modified = true;
  }
}

async function wifiUpdateSavedConns() {
  let connections = await nmConnsGet("uuid,type");
  if (connections === undefined) return;

  for (const i in wifiIfs) {
    wifiIfs[i].saved = {};
  }

  for (const connection of connections) {
    try {
      const [uuid, type] = nmcliParseSep(connection);

      if (type !== "802-11-wireless") continue;

      // Get the device the connection is bound to and the ssid
      const [mode, ssid, macTmp] = await nmConnGetFields(uuid, "802-11-wireless.mode,802-11-wireless.ssid,802-11-wireless.mac-address");

      if (!ssid) continue;

      const macAddr = macTmp.toLowerCase();
      if (mode == 'ap') {
        handleHotspotConn(macAddr, uuid);
      } else if (mode == 'infrastructure') {
        if (macAddr && wifiIfs[macAddr]) {
          wifiIfs[macAddr].saved[ssid] = uuid;
        }
      }
    } catch (err) {
      console.log(`Error getting the nmcli connection information: ${err.message}`);
    }
  }
}

async function wifiUpdateScanResult() {
  const wifiNetworks = await nmScanResults("active,ssid,signal,security,freq,device");
  if (!wifiNetworks) return;

  for (const i in wifiIfs) {
    wifiIfs[i].available = new Map();
  }

  for (const wifiNetwork of wifiNetworks) {
    const [active, ssid, signal, security, freq, device] =
      nmcliParseSep(wifiNetwork);

    if (ssid == null || ssid == "") continue;

    const hwAddr = wifiDeviceListGetHwAddr(device);
    if (!wifiIfs[hwAddr] || (active != 'yes' && wifiIfs[hwAddr].available.has(ssid))) continue;

    wifiIfs[hwAddr].available.set(ssid, {
      active: (active == 'yes'),
      ssid,
      signal: parseInt(signal),
      security,
      freq: parseInt(freq),
    });
  }

  wifiBroadcastState();
}

/*
  The WiFi scan results are updated some time after a rescan command is issued /
  some time after a new WiFi adapter is plugged in.
  This function sets up a number of timers to broadcast the updated scan results
  with the expectation that eventually it will capture any relevant new results
*/
function wifiScheduleScanUpdates() {
  setTimeout(wifiUpdateScanResult, 1000);
  setTimeout(wifiUpdateScanResult, 3000);
  setTimeout(wifiUpdateScanResult, 5000);
  setTimeout(wifiUpdateScanResult, 10000);
  setTimeout(wifiUpdateScanResult, 15000);
  setTimeout(wifiUpdateScanResult, 20000);
}

let unavailableDeviceRetryExpiry = 0;
async function wifiUpdateDevices() {
  let newDevices = false;
  let statusChange = false;
  let unavailableDevices = false;

  let networkDevices = await nmDevices("device,type,state,con-uuid");
  if (!networkDevices) return;

  // sorts the results alphabetically by interface name
  networkDevices.sort();

  // mark all WiFi adapters as removed
  for (const i in wifiIfs) {
    wifiIfs[i].removed = true;
  }

  // Rebuild the id-to-hwAddr map
  wifiIdToHwAddr = {};

  for (const networkDevice of networkDevices) {
    try {
      const [ifname, type, state, connUuid] = nmcliParseSep(networkDevice);

      if (type !== "wifi") continue;
      if (state == "unavailable") {
        unavailableDevices = true;
        continue;
      }

      const conn = (connUuid != '' && wifiDeviceListGetInetAddr(ifname)) ? connUuid : null;
      const hwAddr = wifiDeviceListGetHwAddr(ifname);
      if (!hwAddr) continue;

      if (wifiIfs[hwAddr]) {
        // the interface is still available
        delete wifiIfs[hwAddr].removed;

        if (ifname != wifiIfs[hwAddr].ifname) {
          wifiIfs[hwAddr].ifname = ifname;
          statusChange = true;
        }
        if (conn != wifiIfs[hwAddr].conn) {
          wifiIfs[hwAddr].conn = conn;
          statusChange = true;
        }
      } else {
        const id = wifiIfId++;

        const prop = await nmDeviceProp(ifname, "GENERAL.VENDOR,GENERAL.PRODUCT,WIFI-PROPERTIES.AP,WIFI-PROPERTIES.5GHZ,WIFI-PROPERTIES.2GHZ");
        const vendor = prop[0].replace('Corporation', '').trim();
        const pb = prop[1].match(/[\[\(](.+)[\]\)]/);
        const product = pb ? pb[1] : prop[1];

        wifiIfs[hwAddr] = {
          id,
          ifname,
          hw: vendor + ' ' + product,
          conn,
          available: new Map(),
          saved: {}
        };
        if (prop[2] === 'yes') {
          wifiIfs[hwAddr].hotspot = {};
          wifiIfs[hwAddr].hotspot.forceHotspotStatus = 0;
          wifiIfs[hwAddr].hotspot.warnings = {};

          wifiIfs[hwAddr].hotspot.availableChannels = ['auto'];
          if (prop[3] === 'yes') {
            wifiIfs[hwAddr].hotspot.availableChannels.push('auto_50');
          }
          if (prop[4] === 'yes') {
            wifiIfs[hwAddr].hotspot.availableChannels.push('auto_24');
          }
        }
        newDevices = true;
        statusChange = true;
      }
      wifiIdToHwAddr[wifiIfs[hwAddr].id] = hwAddr;
    } catch (err) {
      console.log(`Error getting the nmcli WiFi device information: ${err.message}`);
    }
  }

  // delete removed adapters
  for (const i in wifiIfs) {
    if (wifiIfs[i].removed) {
      delete wifiIfs[i];
      statusChange = true;
    }
  }

  if (newDevices) {
    await wifiUpdateSavedConns();
    wifiScheduleScanUpdates();
  }

  if (statusChange) {
    await wifiUpdateScanResult();
    wifiScheduleScanUpdates();
  }
  if (newDevices || statusChange) {
    wifiBroadcastState();

    // Mark any WiFi hotspot interfaces as unavailable for bonding
    let hotspotCount = 0;
    for (const i in wifiIfs) {
      if (wifiIfIsHotspot(wifiIfs[i])) {
        const n = netif[wifiIfs[i].ifname];
        if (!n) continue;
        if (n.error & NETIF_ERR_HOTSPOT) continue;

        setNetifHotspot(n);
        hotspotCount++;
      }
    }
    if (hotspotCount && isStreaming) {
      updateSrtlaIps();
    }
  }
  console.log(wifiIfs);

  /* If some wifi adapters were marked unavailable, recheck periodically
     This might happen when the system has just booted up and the adapter
     typically becomes available within 30 seconds.
     Uses a 5 minute timeout to avoid polling nmcli forever */
  if (unavailableDevices) {
    if (unavailableDeviceRetryExpiry == 0) {
      unavailableDeviceRetryExpiry = getms() + 5 * 60 * 1000; // 5 minute timeout
      setTimeout(wifiUpdateDevices, 3000);
      console.log("One or more Wifi interfaces are unavailable. Will retry periodically for the next 5 minutes");
    } else if (getms() < unavailableDeviceRetryExpiry) {
      setTimeout(wifiUpdateDevices, 3000);
      console.log("One or more Wifi interfaces are still unavailable. Retrying in 3 seconds...");
    }
  } else {
    unavailableDeviceRetryExpiry = 0;
  }

  return statusChange;
}

async function wifiRescan() {
  await nmRescan();

  /* A rescan request will fail if a previous one is in progress,
     but we still attempt to update the results */
  await wifiUpdateScanResult();
  wifiScheduleScanUpdates();
}

/* Searches saved connections in wifiIfs by UUID */
function wifiSearchConnection(uuid) {
  let connFound;
  for (const i in wifiIdToHwAddr) {
    const macAddr = wifiIdToHwAddr[i];
    for (const s in wifiIfs[macAddr].saved) {
      if (wifiIfs[macAddr].saved[s] == uuid) {
        connFound = i;
        break;
      }
    }
  }

  return connFound;
}

async function wifiDisconnect(uuid) {
  if (wifiSearchConnection(uuid) === undefined) return;

  if (await nmDisconnect(uuid)) {
    await wifiUpdateScanResult();
    wifiScheduleScanUpdates();
  }
}

async function wifiForget(uuid) {
  if (wifiSearchConnection(uuid) === undefined) return;

  if (await nmConnDelete(uuid)) {
    await wifiUpdateSavedConns();
    await wifiUpdateScanResult();
    wifiScheduleScanUpdates();
  }
}

async function wifiDeleteFailedConns() {
  const connections = await nmConnsGet("uuid,type,timestamp");
  for (const c in connections) {
    const [uuid, type, ts] = nmcliParseSep(connections[c]);
    if (type !== "802-11-wireless") continue;
    if (ts == 0) {
      await nmConnDelete(uuid);
    }
  }
}

function wifiNew(conn, msg) {
  if (!msg.device || !msg.ssid) return;

  const mac = wifiIdToHwAddr[msg.device];
  if (!mac) return;

  const device = wifiIfs[mac].ifname;

  const args = [
    "-w",
    "15",
    "device",
    "wifi",
    "connect",
    msg.ssid,
    "ifname",
    device
  ];

  if (msg.password) {
    args.push('password');
    args.push(msg.password);
  }

  const senderId = conn.senderId;
  execFile("nmcli", args, async function(error, stdout, stderr) {
    if (error || stdout.match('^Error:')) {
      await wifiDeleteFailedConns();

      if (stdout.match('Secrets were required, but not provided')) {
        conn.send(buildMsg('wifi', {new: {error: "auth", device: msg.device}}, senderId));
      } else {
        conn.send(buildMsg('wifi', {new: {error: "generic", device: msg.device}}, senderId));
      }
    } else {
      const success = stdout.match(/successfully activated with '(.+)'/);
      if (success) {
        const uuid = success[1];
        if (!(await nmConnSetWifiMac(uuid, mac))) {
          console.log("Failed to set the MAC address for the newly created connection");
        }

        await wifiUpdateSavedConns();
        await wifiUpdateScanResult();

        conn.send(buildMsg('wifi', {new: {success: true, device: msg.device}}, senderId));
      } else {
        console.log(`wifiNew: no error but not matching a successful connection msg in:\n${stdout}\n${stderr}`);
      }
    }
  });
}

async function wifiConnect(conn, uuid) {
  const deviceId = wifiSearchConnection(uuid);
  if (deviceId === undefined) return;

  const senderId = conn.senderId;
  const success = await nmConnect(uuid);
  await wifiUpdateScanResult();
  conn.send(buildMsg('wifi', {connect: success, device: deviceId}, senderId));
}

function wifiForceHotspot(wifi, ms) {
  if (!wifi.hotspot) return;

  if (ms <= 0) {
    wifi.hotspot.forceHotspotStatus = 0;
    return;
  }

  const until = getms() + ms;
  if (until > wifi.hotspot.forceHotspotStatus) {
    wifi.hotspot.forceHotspotStatus = until;
  }
}

const HOTSPOT_UP_TO = 10;
const HOTSPOT_UP_FORCE_TO = (HOTSPOT_UP_TO + 2) * 1000;

async function wifiHotspotStart(msg) {
  if (!msg.device) return;

  const mac = wifiIdToHwAddr[msg.device];
  if (!mac) return;

  const i = wifiIfs[mac];
  if (!i) return;
  if (!i.hotspot) return; // hotspot not supported, nothing to do

  if (i.hotspot.conn) {
    if (i.hotspot.conn != i.conn) {
      /* We assume that the operation will succeed, to be able to show an immediate response in the UI
         But especially if we're already connected to a network in client mode, it can take a few
         seconds before NM will show us as 'connected' to our hotspot connection.
         We use wifiForceHotspot() to ensure the device is reported in hotspot mode for this duration
      */
      wifiForceHotspot(i, HOTSPOT_UP_FORCE_TO);
      wifiBroadcastState();

      if (await nmConnect(i.hotspot.conn, HOTSPOT_UP_TO)) {
        await nmConnSetFields(i.hotspot.conn, {'connection.autoconnect': 'yes',
                                               'connection.autoconnect-priority': 999});
      } else {
        // Remove the wifiForceHotspot() timer to immediately show the failure by resetting the UI to client mode
        wifiForceHotspot(i, -1);
        wifiUpdateDevices();
      }
    }
  } else {
    const ms = mac.split(':');
    const name = 'BELABOX_' + ms[4] + ms[5];
    const password = crypto.randomBytes(9).toString('base64');

    // Temporary hotspot config to send to the client
    i.hotspot.name = name;
    i.hotspot.password = password;
    i.hotspot.channel = 'auto';
    wifiForceHotspot(i, HOTSPOT_UP_FORCE_TO);
    wifiBroadcastState();

    // Create the NM connection for the hotspot
    const uuid = await nmHotspot(i.ifname, name, password, HOTSPOT_UP_TO);
    if (uuid) {
      // Update any settings that we need different from the default
      await nmConnSetFields(uuid, {'connection.interface-name': '',
                                   'connection.autoconnect': 'yes',
                                   'connection.autoconnect-priority': 999,
                                   '802-11-wireless.mac-address': mac,
                                   '802-11-wireless-security.pmf': 'disable'});
      // The updated settings will allow the connection to be recognised as our Hotspot connection
      await wifiUpdateSavedConns();
      // Restart the connection with the updated settings (needed to disable pmf)
      wifiForceHotspot(i, HOTSPOT_UP_FORCE_TO);
      await nmConnect(uuid, HOTSPOT_UP_TO);
    } else {
      // Remove the wifiForceHotspot() timer to immediately show the failure by resetting the UI to client mode
      wifiForceHotspot(i, -1);
      wifiUpdateDevices();
    }
  }
}

async function wifiHotspotStop(msg) {
  if (!msg.device) return;

  const mac = wifiIdToHwAddr[msg.device];
  if (!mac) return;

  const i = wifiIfs[mac];
  if (!i) return;
  if (!wifiIfIsHotspot(i)) return; // not in hotspot mode, nothing to do

  await nmConnSetFields(i.hotspot.conn, {'connection.autoconnect': 'no'});

  wifiForceHotspot(i, -1);
  if (await nmDisconnect(i.hotspot.conn)) {
    i.conn = null;
    i.available.clear();
    wifiBroadcastState();
    wifiRescan();
  }
}

function wifiIfIsHotspot(wifi) {
  if (!wifi || !wifi.hotspot) return false;
  return ((wifi.hotspot.conn && wifi.conn == wifi.hotspot.conn) ||
          (wifi.hotspot.forceHotspotStatus > getms()));
}

function nmConnSetHotspotFields(uuid, name, password, channel) {
  // Validate the requested channel
  const newChannel = wifiChannels[channel];
  if (!newChannel) return;

  const settingsToChange = {
    '802-11-wireless.ssid': name,
    '802-11-wireless-security.psk': password,
    '802-11-wireless.band': newChannel.nmBand,
    '802-11-wireless.channel': newChannel.nmChannel
  };

  return nmConnSetFields(uuid, settingsToChange);
}

/*
  Expects:
  {
    device: device id,
    name,
    password,
    channel  // from wifiChannels
  }
*/
async function wifiHotspotConfig(conn, msg) {
  // Find the Wifi interface
  if (!msg.device) return;

  const mac = wifiIdToHwAddr[msg.device];
  if (!mac) return;

  const i = wifiIfs[mac];
  if (!i) return;
  if (!wifiIfIsHotspot(i)) return; // Make sure the interface is already in hotspot mode

  const senderId = conn.senderId;

  // Make sure all required fields are present and valid
  if (msg.name === undefined || typeof msg.name != 'string' ||
      msg.name.length < 1 || msg.name.length > 32) {
    conn.send(buildMsg('wifi', {hotspot: {config: {device: msg.device, error: 'name'}}}, senderId));
    return;
  }

  if (msg.password === undefined || typeof msg.password != 'string' ||
      msg.password.length < 8 || msg.password.length > 64) {
    conn.send(buildMsg('wifi', {hotspot: {config: {device: msg.device, error: 'password'}}}, senderId));
    return;
  }

  if (msg.channel === undefined || typeof msg.channel != 'string' || !wifiChannels[msg.channel]) {
    conn.send(buildMsg('wifi', {hotspot: {config: {device: msg.device, error: 'channel'}}}, senderId));
    return;
  }

  // Update the NM connection
  if (!(await nmConnSetHotspotFields(i.hotspot.conn, msg.name, msg.password, msg.channel))) {
    conn.send(buildMsg('wifi', {hotspot: {config: {device: msg.device, error: 'saving'}}}, senderId));
    return;
  }

  // Restart the connection with the updated config
  wifiForceHotspot(i, HOTSPOT_UP_FORCE_TO);
  if (!(await nmConnect(i.hotspot.conn, HOTSPOT_UP_TO))) {
    conn.send(buildMsg('wifi', {hotspot: {config: {device: msg.device, error: 'activating'}}}, senderId));
    // Failed to bring up the hotspot with the new settings; restore it
    wifiForceHotspot(i, HOTSPOT_UP_FORCE_TO);
    await nmConnSetHotspotFields(i.hotspot.conn, i.hotspot.name, i.hotspot.password, i.hotspot.channel);
    await nmConnect(i.hotspot.conn, HOTSPOT_UP_TO);
    return;
  }

  // Succesfully brought up the hotspot with the new settings, reload the NM connection
  await wifiUpdateSavedConns();

  conn.send(buildMsg('wifi', {hotspot: {config: {device: msg.device, success: true}}}, senderId));
}

function handleWifi(conn, msg) {
  for (const type in msg) {
    switch(type) {
      case 'connect':
        wifiConnect(conn, msg[type]);
        break;
      case 'disconnect':
        wifiDisconnect(msg[type]);
        break;
      case 'scan':
        wifiRescan();
        break;
      case 'new':
        wifiNew(conn, msg[type]);
        break;
      case 'forget':
        wifiForget(msg[type]);
        break;
      case 'hotspot':
        if (msg[type].start) {
          wifiHotspotStart(msg[type].start);
        } else if (msg[type].stop) {
          wifiHotspotStop(msg[type].stop);
        } else if (msg[type].config) {
          wifiHotspotConfig(conn, msg[type].config);
        }
        break;
    }
  }
}


/*
  mmcli helpers
*/
function mmcliParseSep(input) {
  let output = {};
  for (let line of input.split('\n')) {
    line = line.replace(/\\\d+/g, ''); // strips special escaped characters
    if (!line) continue;

    const kv = line.split(/:(.*)/); // splits on the first ':' only
    if (kv.length != 3) {
      console.log(`mmcliParseSep: error parsing line ${line}`);
      continue;
    }
    let key = kv[0].trim();
    let value = kv[1].trim();

    // Parse mmcli arrays
    let pattern = /\.length$/;
    if (key.match(pattern)) {
      key = key.replace(pattern, '');
      value = [];
    }
    pattern = /\.value\[\d+\]$/;
    if (key.match(pattern)) {
      key = key.replace(pattern, '');
      output[key].push(value);
      continue;
    }

    // skip empty values
    if (value == '--') continue;

    output[key] = value;
  }

  return output;
}

function mmConvertNetworkType(mmType) {
  const typeMatch = mmType.match(/^allowed: (.+); preferred: (.+)$/);
  const label = typeMatch[1].split(/,? /).sort().reverse().join('');
  const allowed = typeMatch[1].replace(/,? /g, '|');
  const preferred = typeMatch[2];
  return {label, allowed, preferred};
}

function mmConvertNetworkTypes(mmTypes) {
  const types = {};
  for (const mmType of mmTypes) {
    const type = mmConvertNetworkType(mmType);
    if (!types[type.label] || types[type.label].preferred == 'none' || types[type.label].preferred < type.preferred) {
      types[type.label] = {allowed: type.allowed, preferred: type.preferred};
    }
  }
  return types;
}

function mmConvertAccessTech(accessTechs) {
  if (!accessTechs || accessTechs.length == 0) {
    return;
  }

  const accessTechToGen = {
    'gsm': '2G',
    'umts': '3G',
    'hsdpa': '3G+',
    'hsupa': '3G+',
    'lte': '4G',
    '5gnr': '5G'
  };
  // Return the highest gen for situations such as 5G NSA, which will report "lte, 5gnr"
  let gen = '';
  for (const t of accessTechs) {
    if (accessTechToGen[t] > gen) {
      gen = accessTechToGen[t];
    }
  }

  // If we only encountered unknown access techs, simply return the first one
  if (!gen) return accessTechs[0];
  return gen;
}

async function mmList() {
  try {
    const result = await execFileP("mmcli", ["-K", "-L"]);
    const modems = mmcliParseSep(result.stdout.toString("utf-8"))['modem-list'];
    let list = [];
    for (const m of modems) {
      const id = m.match(/\/org\/freedesktop\/ModemManager1\/Modem\/(\d+)/);
      if (id) {
        list.push(parseInt(id[1]));
      }
    }
    return list;
  } catch ({message}) {
    console.log(`mmList err: ${message}`);
  }
}

async function mmGetModem(id) {
  try {
    const result = await execFileP("mmcli", ["-K", "-m", id]);
    return mmcliParseSep(result.stdout.toString("utf-8"));
  } catch ({message}) {
    console.log(`mmGetModem err: ${message}`);
  }
}

async function mmGetSim(id) {
  try {
    const result = await execFileP("mmcli", ["-K", "-i", id]);
    return mmcliParseSep(result.stdout.toString("utf-8"));
  } catch ({message}) {
    console.log(`mmGetSim err: ${message}`);
  }
}

async function mmSetNetworkTypes(id, allowed, preferred) {
  try {
    let args = [
      "-m", id,
      `--set-allowed-modes=${allowed}`
    ];
    if (preferred != 'none') {
      args.push(`--set-preferred-mode=${preferred}`);
    }
    const result = await execFileP("mmcli", args);
    return result.stdout.match(/successfully set current modes in the modem/);
  } catch ({message}) {
    console.log(`mmSetNetworkTypes err: ${message}`);
  }
}

async function mmNetworkScan(id, timeout=240) {
  try {
    const result = await execFileP("mmcli", [`--timeout=${timeout}`, "-K", "-m", id, "--3gpp-scan"]);
    const networks = mmcliParseSep(result.stdout.toString("utf-8"))['modem.3gpp.scan-networks'];
    const parsed = networks.map(function(n) {
      const info = n.split(/, */);
      const output = {};
      for (const entry of info) {
        const kv = entry.split(/: */);
        output[kv[0]] = kv[1];
      }
      return output;
    });
    return parsed;
  } catch ({message}) {
    console.log(`mmNetworkScan err: ${message}`);
  }
}


/*
  ModemManager / NetworkManager based modem management

  Structs:

  Modem list <modems>:
  {
    MMid: <modem>
  }

  Individual modem struct <modem>:
  {
    ifname: wwan0,
    name: "QUECTEL Broadband Module - 00000 | VINAPHONE", <Model - partial IMEI | SIM provider>
    network_type: {
      supported: ['2g', 3g', '3g4g', '4g'],
      config: '3g4g',
    },
    is_scanning: true/undefined,
    inhibit: true/undefined, // don't bring up automatically
    config: {
      conn: 'nmUuid',
      autoconfig: true/false, // only if(setup.has_gsm_autoconfig)
      apn: '',
      username: '',
      password: '',
      roaming: true/false,
      network: ''
    },
    status: {
      state: 'connecting', 'connected', 'disconnected', etc
      network: '<GSM NETWORK NAME>',
      network_type: 3g/4g,
      signal: 0-100,
      roaming: true/false,
    }
    available_networks: undefined or {
      'id': {
        name: '',
        availability: 'available', 'forbidden', etc
      }
    }
  }
*/
let modems = {};

let gsmOperatorsCache = {};
try {
  gsmOperatorsCache = JSON.parse(fs.readFileSync(GSM_OPERATORS_CACHE_FILE, 'utf8'));
} catch(err) {
  console.log("Failed to load the persistent GSM operators cache, starting with an empty cache");
}
async function gsmOperatorsAdd(id, name) {
  if (!gsmOperatorsCache[id] || gsmOperatorsCache[id] != name) {
    gsmOperatorsCache[id] = name;
    await writeTextFile(GSM_OPERATORS_CACHE_FILE, JSON.stringify(gsmOperatorsCache));
  }
}

async function getGsmConns() {
  let byDevice = {};
  let byOperator = {};
  let byUuid = {};

  const conns = await nmConnsGet("uuid,type,state");
  for (const c of conns) {
    const [uuid, type, state] = nmcliParseSep(c);

    if (type != 'gsm') continue;

    let fields = "gsm.device-id,gsm.sim-id,gsm.sim-operator-id,gsm.apn,gsm.username,gsm.password,gsm.home-only,gsm.network-id"
    if (setup.has_gsm_autoconfig) {
      fields += ",gsm.auto-config";
    }
    const connInfo = await nmConnGetFields(uuid, fields);

    const deviceId = connInfo[0];
    const simId = connInfo[1];
    const operatorId = connInfo[2];
    const apn = connInfo[3];
    const username = connInfo[4];
    const password = connInfo[5];
    const roaming = (connInfo[6] == 'no');
    const network = connInfo[7];

    const conn = {state, uuid, deviceId, simId, operatorId, apn, username, password, roaming, network};
    if (setup.has_gsm_autoconfig) {
      conn.autoconfig = (connInfo[8] == 'yes');
    }

    byUuid[uuid] = conn;

    if (deviceId && simId) {
      if (!byDevice[deviceId]) {
        byDevice[deviceId] = {};
      }
      byDevice[deviceId][simId] = conn;
    }

    if (operatorId) {
      byOperator[operatorId] = conn;
    }
  }

  return {byDevice, byOperator, byUuid};
}

function modemConfigSantizeToNM(config) {
  fields = {};
  if (setup.has_gsm_autoconfig) {
    fields['gsm.auto-config'] = (config.autoconfig ? 'yes' : 'no');
    if (config.autoconfig) {
      config.apn = '';
      config.username = '';
      config.password = '';
    }
  } else {
    delete config.autoconfig;
  }
  fields['gsm.apn'] = config.apn;
  fields['gsm.username'] = config.username;
  fields['gsm.password'] = config.password;
  fields['gsm.password-flags'] = (!config.password ? 4 : 0);
  fields['gsm.home-only'] = (config.roaming ? 'no': 'yes');
  fields['gsm.network-id'] = (config.roaming ? config.network : '');

  return fields;
}

async function modemGetConfig(modemInfo, simInfo, gsmConns) {
  if (!modemInfo || !simInfo || !gsmConns) return;

  const modemId = modemInfo['modem.generic.device-identifier'];
  const simId = simInfo['sim.properties.iccid'];
  const operatorId = simInfo['sim.properties.operator-code'];
  let config;

  if (gsmConns.byDevice[modemId] && gsmConns.byDevice[modemId][simId]) {
    const ci = gsmConns.byDevice[modemId][simId];
    config = {conn: ci.uuid, autoconfig: ci.autoconfig, apn: ci.apn, username: ci.username,
              password: ci.password, roaming: ci.roaming, network: ci.network};
    console.log(`Found NM connection ${config.conn} for modem ${modemId}`);
    return config;
  }

  if (gsmConns && operatorId && gsmConns.byOperator[operatorId]) {
    // Copy the settings from an existing config for the same operator
    const ci = gsmConns.byOperator[operatorId];
    config = {autoconfig: ci.autoconfig, apn: ci.apn, username: ci.username, password: ci.password,
              roaming: ci.roaming, network: ci.network};
  } else {
    // New connection profile
    config = {autoconfig: true, apn: 'internet', username: '', password: '', roaming: true, network: ''};
  }

  // The NM connection doesn't exist yet, create it
  //const autoconnect = (modemInfo['modem.3gpp.registration-state'] != 'idle') ? 'yes' : 'no';
  const nmConfig = {
    'type': 'gsm',
    'ifname': '', // can be empty for gsm connections, matching by device-id and sim-id
    'autoconnect': 'yes',
    'connection.autoconnect-retries': 10,
    'ipv6.method': 'ignore',
    'gsm.device-id': modemId,
    'gsm.sim-id': simId
  };
  if (operatorId) {
    nmConfig['gsm.sim-operator-id'] = operatorId;
  }
  Object.assign(nmConfig, modemConfigSantizeToNM(config))
  const uuid = await nmConnAdd(nmConfig);
  if (uuid) {
    config.conn = uuid;
    console.log(`Created NM connection ${uuid} for ${modemId}`);
    console.log(config);
  }

  return config;
}

function modemUpdateStatus(modemInfo, modem) {
  // Some modems don't seem to always report the operator's name
  let network = modemInfo['modem.3gpp.operator-name'];
  if (!network && modemInfo['modem.3gpp.registration-state'] == 'home') {
    network = modem.sim_network;
  }
  const network_type = mmConvertAccessTech(modemInfo['modem.generic.access-technologies']);
  const signal = modemInfo['modem.generic.signal-quality.value'];
  const roaming = modemInfo['modem.3gpp.registration-state'] == 'roaming';
  let connection = modem.is_scanning ? 'scanning' : modemInfo['modem.generic.state'];

  modem.status = {connection, network, network_type, signal, roaming};
}

async function modemNetworkScan(id) {
  const modem = modems[id];

  if (!modem || !modem.config || !modem.status || modem.is_scanning) return;

  modem.is_scanning = true;

  if (modem.config && modem.config.conn) {
    await nmDisconnect(modem.config.conn);
  }
  const results = await mmNetworkScan(id);

  delete modem.is_scanning;

  /* Even if no new results are returned, resend the old ones
     to inform the clients that the scan was completed */
  if (!results) {
    broadcastModemAvailableNetworks(id);
    return;
  }

  /* Some (but not all) modems return separate results for each network type (3G, 4G, etc),
     but we merge them as we have a separate network type setting */
  const availableNetworks = {};
  for (const r of results) {
    const code = r['operator-code'];
    /* We rewrite 'current' to 'available' as these results are cached
       and could be shown even after switching to a different network.
       We remove the availability info if 'unknown' */
    switch (r.availability) {
      case 'current':
        r.availability = 'available';
        break;
      case 'unknown':
        delete r.availability;
        break;
    }
    if (availableNetworks[code]) {
      if (r.availability == 'available' && availableNetworks[code].availability != 'available') {
        availableNetworks[code].availability = 'available';
      }
    } else {
      availableNetworks[code] = {
        name: r['operator-name'],
        availability: r['availability']
      };
    }
  }

  modem.available_networks = availableNetworks;
  broadcastModemAvailableNetworks(id);
}

async function registerModem(id) {
  if (modems[id]) {
    throw new Error(`Trying to register existing modem id ${id}`);
  }

  // Get all the required info for the modem
  const modemInfo = await mmGetModem(id);

  let simInfo, config;
  if (modemInfo['modem.generic.sim']) {
    const simId = modemInfo['modem.generic.sim'].match(/\/org\/freedesktop\/ModemManager1\/SIM\/(\d+)/);
    if (simId) {
      simInfo = await mmGetSim(simId[1]);
      // If a SIM is present, try to find a matching NM connection or create one
      if (simInfo) {
        if (!gsmConns) {
          gsmConns = await getGsmConns();
        }
        config = await modemGetConfig(modemInfo, simInfo, gsmConns);
      }
    }
  }

  // Find the network interface name
  let ifname;
  for (const port of modemInfo['modem.generic.ports']) {
    const pattern = / \(net\)$/;
    if (port.match(pattern)) {
      ifname = port.replace(pattern, '');
      break;
    }
  }

  // Find the current network type
  let networkType = mmConvertNetworkType(modemInfo['modem.generic.current-modes']);

  // Find the supported network types
  const networkTypes = mmConvertNetworkTypes(modemInfo['modem.generic.supported-modes']);

  // Make sure the current mode is on the list
  if (networkType && !networkTypes[networkType.label]) {
    networkTypes[networkType.label] = {allowed: networkType.allowed, preferred: networkType.preferred};
  }
  networkType = networkType.label;

  let partialImei = modemInfo['modem.generic.equipment-identifier'];
  partialImei = partialImei.substr(partialImei.length - 5, 5);
  const hwName = `${modemInfo['modem.generic.model']} - ${partialImei}`

  let simNetwork = '<NO SIM>';
  if (simInfo) {
    simNetwork = simInfo['sim.properties.operator-name'] || 'Unknown';
  }

  const modem = {};
  modem.ifname = ifname;
  modem.name = `${hwName} | ${simNetwork}`;
  modem.sim_network = simNetwork;
  modem.network_type = {};
  modem.network_type.supported = networkTypes;
  modem.network_type.active = networkType;
  modem.config = config;
  modemUpdateStatus(modemInfo, modem);

  modems[id] = modem;
}

function modemGetAvailableNetworks(modem) {
  if (!modem.config || modem.config.network == '') return modem.available_networks || {};

  let networks = Object.assign({}, modem.available_networks);
  if (!modem.available_networks) {
    const name = gsmOperatorsCache[modem.config.network] || `Operator ID ${modem.config.network}`;
    networks[modem.config.network] = {name};
  } else if (!modem.available_networks[modem.config.network]) {
    networks[modem.config.network] = {name: 'Test', availability: 'unavailable'};
  }

  return networks;
}

function modemsBuildMsg(modemsFullState = undefined) {
  let msg = {};
  for (const i in modems) {
    const full = (modemsFullState == undefined || modemsFullState[i]);

    msg[i] = {};

    if (full) {
      msg[i].ifname = modems[i].ifname;
      msg[i].name = modems[i].name;
      msg[i].network_type = {};
      msg[i].network_type.supported = Object.keys(modems[i].network_type.supported);
      msg[i].network_type.active = modems[i].network_type.active;

      if (modems[i].config) {
        msg[i].config = {};
        if (setup.has_gsm_autoconfig) {
          msg[i].config.autoconfig = modems[i].config.autoconfig;
        }
        msg[i].config.apn = modems[i].config.apn;
        msg[i].config.username = modems[i].config.username;
        msg[i].config.password = modems[i].config.password;
        msg[i].config.roaming = modems[i].config.roaming;
        msg[i].config.network = modems[i].config.network;
      } else {
        msg[i].no_sim = true;
      }

      msg[i].available_networks = modemGetAvailableNetworks(modems[i]);
    }

    if (!modems[i].status) continue;

    msg[i].status = {};
    msg[i].status.connection = modems[i].status.connection;
    msg[i].status.network = modems[i].status.network;
    msg[i].status.network_type = modems[i].status.network_type;
    msg[i].status.signal = modems[i].status.signal;
    msg[i].status.roaming = modems[i].status.roaming;
  }

  return msg;
}

function broadcastModems(modemsFullState = undefined) {
  broadcastMsg('status', {modems: modemsBuildMsg(modemsFullState)});
}

function modemBuildAvailableNetworksMessage(id) {
  const msg = {};

  for (const i in modems) {
    msg[i] = {};
    if (id == i) {
      msg[i].available_networks = modemGetAvailableNetworks(modems[i]);
    }
  }

  return msg;
}

function broadcastModemAvailableNetworks(id) {
  broadcastMsg('status', {modems: modemBuildAvailableNetworksMessage(id)});
}

// Global variable, to allow fetching once in updateModems() and reuse in registerModem()
let gsmConns;

async function updateModems() {
  for (const m in modems) {
    modems[m].removed = true;
  }
  const modemList = await mmList() || [];

  // NM gsm connections to match with new modems - filled on demand if any new modems have been found
  gsmConns = undefined;
  let newModems = {};

  for (const m of modemList) {
    if (modems[m]) {
      // The modem is already registered, unmark it for deletion
      delete modems[m].removed;

      const modemInfo = await mmGetModem(m);
      if (!modemInfo) continue;

      const modem = modems[m];
      modemUpdateStatus(modemInfo, modem);

      // If the modem has an inactive NM connection and isn't otherwise busy, then try to bring it up
      if (!modem.inhibit && !modem.is_scanning &&
          modem.status && (modem.status.connection == 'registered' || modem.status.connection == 'enabled') &&
          modem.config && modem.config.conn) {
        // Don't try to activate NM connections that are already active
        const nmConnection = (await nmConnGetFields(modem.config.conn, 'GENERAL.STATE'));
        if (nmConnection.length == 1) {
          console.log(`Trying to bring up connection ${modem.config.conn} for modem ${m}...`);
          nmConnect(modem.config.conn);
        }
      }
    } else {
      try {
        await registerModem(m);
        newModems[m] = true;
        console.log(JSON.stringify(modems[m], undefined, 2));
      } catch(e) {
        console.log(`Failed to register modem ${m}`);
      }
    }
  } // for (const m of modemList)

  // If any modems were removed, delete them
  for (const m in modems) {
    if (modems[m].removed) {
      console.log(`Modem ${m} removed`);
      delete modems[m];
    }
  }

  broadcastModems(newModems);

  setTimeout(updateModems, 1000);
}
updateModems();

async function handleModemConfig(conn, msg) {
  if (!msg.device || !modems[msg.device]) {
    console.log(`Ignoring modem config for unknown modem ${msg.device}`);
    return;
  }

  const modem = modems[msg.device];
  if (!modem.config || !modem.config.conn) {
    console.log(`Ignoring modem config for unconfigured modem ${msg.device}`);
    console.log(modem.config);
    return;
  }
  const connUuid = modem.config.conn;
  if (!connUuid) {
    console.log(`Ignoring modem config for modem ${msg.device} with no connection UUID`);
    return;
  }

  // Ensure the configuration message has all the required fields
  if ((msg.roaming !== true && msg.roaming !== false) ||
      (msg.autoconfig !== true && msg.autoconfig !== false) ||
      (typeof msg.apn != 'string') ||
      (typeof msg.username != 'string') ||
      (typeof msg.password != 'string') ||
      (typeof msg.network != 'string') ||
      (typeof msg.network_type != 'string')) {
    console.log(`Received invalid configuration for modem ${msg.device}`);
    console.log(msg);
    return;
  }

  // Ensure the selected network type is supported
  const networkType = modem.network_type.supported[msg.network_type];
  if (!networkType) {
    console.log(`Received invalid network type ${msg.network_type} for modem ${msg.device}`);
    return;
  }

  // Only allow automatic network selection, the network previously saved, or a network included in the scan results
  if (msg.network != '' && msg.network != modem.config.network &&
      (!modem.available_networks || !modem.available_networks[msg.network])) {
    console.log(`Received unavailable network ${msg.network} for modem ${msg.device}`);
    return;
  }

  // If a new network is selected, write it to the GSM operators cache
  if (msg.network != '' && modem.available_networks && modem.available_networks[msg.network]) {
    gsmOperatorsAdd(msg.network, modem.available_networks[msg.network].name);
  }

  // Temporary config that we'll attempt to write
  let updatedConfig = {
    autoconfig: msg.autoconfig,
    apn: msg.apn,
    username: msg.username,
    password: msg.password,
    roaming: msg.roaming,
    network: msg.network
  }
  // This also modifies config in place to clear apn/username/password if autoconfig is set
  const result = await nmConnSetFields(connUuid, modemConfigSantizeToNM(updatedConfig));
  if (result) {
    // This preserves the 'conn' UUID value
    Object.assign(modem.config, updatedConfig);
  } else {
    console.log(`Failed to update NM connection ${modem.config.conn} for modem ${msg.device} to:`);
    console.log(updatedConfig);
  }

  // Bring the connection down to reload the settings, and set the network types, if needed
  modem.inhibit = true;
  await nmDisconnect(connUuid);
  if (msg.network_type != modem.network_type.active) {
    const result = await mmSetNetworkTypes(msg.device, networkType.allowed, networkType.preferred);
    if (result) {
      modem.network_type.active = msg.network_type;
    }
  }
  delete modem.inhibit;

  // Send the updated settings to the clients
  const updatedModem = {};
  updatedModem[msg.device] = true;
  broadcastModems(updatedModem);
}

async function handleModemScan(conn, msg) {
  if (!msg || !modems[msg.device]) return;

  await modemNetworkScan(msg.device);
}

function handleModems(conn, msg) {
  for (const type in msg) {
    switch (type) {
      case 'config':
        handleModemConfig(conn, msg[type]);
        break;
      case 'scan':
        handleModemScan(conn, msg[type]);
        break;
    }
  }
}


/* Remote */
/*
  A brief remote protocol version history:
  1 - initial remote release
  2 - belaUI password setting feature
  3 - apt update feature
  4 - ssh manager
  5 - wifi manager
  6 - notification sytem
  7 - support for config.bitrate_overlay
  8 - support for netif error
  9 - support for the get_log command
  10 - support for the get_syslog command
  11 - support for the asrc and acodec settings
  12 - support for receiving relay accounts and relay servers
  13 - wifi hotspot mode
  14 - support for the modem manager
*/
const remoteProtocolVersion = 14;
const remoteEndpointHost = 'remote.belabox.net';
const remoteEndpointPath = '/ws/remote';
const remoteTimeout = 5000;
const remoteConnectTimeout = 10000;

let remoteWs = undefined;
let remoteStatusHandled = false;
function handleRemote(conn, msg) {
  for (const type in msg) {
    switch (type) {
      case 'auth/encoder':
        if (msg[type] === true) {
          conn.isAuthed = true;
          sendInitialStatus(conn)
          broadcastMsgLocal('status', {remote: true}, getms() - ACTIVE_TO);
          console.log('remote: authenticated');
        } else {
          broadcastMsgLocal('status', {remote: {error: 'key'}}, getms() - ACTIVE_TO);
          remoteStatusHandled = true;
          conn.terminate();
          console.log('remote: invalid key');
        }
        break;
      case 'relays':
        handleRemoteRelays(msg[type]);
        break;
    }
  }
}

let relaysCache;
try {
  relaysCache = JSON.parse(fs.readFileSync(RELAYS_CACHE_FILE, 'utf8'));
} catch(err) {
  console.log("Failed to load the relays cache, starting with an empty cache");
}

function buildRelaysMsg() {
  const msg = {};
  msg.servers = {};
  msg.accounts = {};

  if (relaysCache) {
    for (const s in relaysCache.servers) {
      msg.servers[s] = {name: relaysCache.servers[s].name};
      if (relaysCache.servers[s].default) msg.servers[s].default = true;
    }
    for (const a in relaysCache.accounts) {
      msg.accounts[a] = {name: relaysCache.accounts[a].name};
      if (relaysCache.accounts[a].disabled) {
        msg.accounts[a].name += ' [disabled]';
        msg.accounts[a].disabled = true;
      }
    }
  }

  return msg;
}

async function updateCachedRelays(relays) {
  try {
    assert.deepStrictEqual(relays, relaysCache);
  } catch (err) {
    console.log('updated the relays cache:');
    console.log(relays);
    relaysCache = relays;
    await writeTextFile(RELAYS_CACHE_FILE, JSON.stringify(relays));
    return true;
  }
}

function validateRemoteRelays(msg) {
  try {
    const out = {servers: {}, accounts: {}};
    for (const r_id in msg.servers) {
      const r = msg.servers[r_id];
      if (r.type !== "srtla" || typeof r.name != 'string' || typeof r.addr != 'string') continue;
      if (r.default && r.default !== true) continue;
      if (!validatePortNo(r.port)) continue;

      out.servers[r_id] = {type: r.type, name: r.name, addr: r.addr, port: r.port};
      if (r.default) out.servers[r_id].default = true;
    }

    for (const a_id in msg.accounts) {
      const a = msg.accounts[a_id];
      if (typeof a.name != 'string' || typeof a.ingest_key != 'string') continue;

      out.accounts[a_id] = {name: a.name, ingest_key: a.ingest_key};
      if (a.disabled) out.accounts[a_id].disabled = true;
    }

    if (Object.keys(out.servers).length < 1) return;

    return out;
  } catch(err) {
    return undefined;
  }
}

function convertManualToRemoteRelay() {
  if (!relaysCache) return false;

  let modified = false;

  if (!config.relay_server && config.srtla_addr && config.srtla_port) {
    for (const s in relaysCache.servers) {
      if (relaysCache.servers[s].addr.toLowerCase() === config.srtla_addr.toLowerCase()
          && relaysCache.servers[s].port == config.srtla_port) {
        config.relay_server = s;
        modified = true;
        break;
      }
    }
  }

  // If not using a relay server, don't try to convert the streamid to a relay account
  if (!config.relay_server) {
    return false;
  }

  if (config.srtla_addr || config.srtla_port) {
    delete config.srtla_addr;
    delete config.srtla_port;
    modified = true;
  }

  if (!config.relay_account && config.srt_streamid) {
    for (const a in relaysCache.accounts) {
      if (relaysCache.accounts[a].ingest_key === config.srt_streamid) {
        config.relay_account = a;
        modified = true;
        break;
      }
    }
  }

  if (config.relay_account && config.srt_streamid) {
    delete config.srt_streamid;
    modified = true;
  }

  return modified;
}

function handleRemoteRelays(msg) {
  msg = validateRemoteRelays(msg);
  if (!msg) return;

  if (updateCachedRelays(msg)) {
    broadcastMsg('relays', buildRelaysMsg());
    if (convertManualToRemoteRelay()) {
      saveConfig();
      broadcastMsg('config', config);
    }
  }
}

function remoteHandleMsg(msg) {
  try {
    msg = JSON.parse(msg);
    if (msg.remote) {
      handleRemote(this, msg.remote);
    }
    delete msg.remote;

    if (Object.keys(msg).length >= 1) {
      this.senderId = msg.id;
      handleMessage(this, msg, true);
      delete this.senderId;
    }

    this.lastActive = getms();
  } catch(err) {
    console.log(`Error handling remote message: ${err.message}`);
  }
}

let remoteConnectTimer;
function remoteRetry() {
  queueUpdateGw();
  remoteConnectTimer = setTimeout(remoteConnect, 1000);
}

function remoteClose() {
  remoteRetry();

  this.removeListener('close', remoteClose);
  this.removeListener('message', remoteHandleMsg);
  remoteWs = undefined;

  if (!remoteStatusHandled) {
    broadcastMsgLocal('status', {remote: {error: 'network'}}, getms() - ACTIVE_TO);
  }
}

async function remoteConnect() {
  if (remoteConnectTimer !== undefined) {
    clearTimeout(remoteConnectTimer);
    remoteConnectTimer = undefined;
  }

  if (config.remote_key) {
    let host = remoteEndpointHost;
    try {
      var {addrs, fromCache} = await dnsCacheResolve(remoteEndpointHost);

      if (fromCache) {
        host = addrs[Math.floor(Math.random()*addrs.length)];
        queueUpdateGw();
        console.log(`remote: DNS lookup failed, using cached address ${host}`);
      }
    } catch(err) {
      return remoteRetry();
    }
    console.log(`remote: trying to connect`);

    remoteStatusHandled = false;
    remoteWs = new ws(`wss://${host}${remoteEndpointPath}`,
                      {servername: remoteEndpointHost,
                       headers: {Host: remoteEndpointHost}});
    remoteWs.isAuthed = false;
    // Set a longer initial connection timeout - mostly to deal with slow DNS
    remoteWs.lastActive = getms() + remoteConnectTimeout - remoteTimeout;
    remoteWs.on('error', function(err) {
      console.log('remote error: ' + err.message);
    });
    remoteWs.on('open', function() {
      if (!fromCache) {
        dnsCacheValidate(remoteEndpointHost);
      }

      const auth_msg = {remote: {'auth/encoder':
                        {key: config.remote_key, version: remoteProtocolVersion}
                       }};
      this.send(JSON.stringify(auth_msg));
    });
    remoteWs.on('close', remoteClose);
    remoteWs.on('message', remoteHandleMsg);
  }
}

function remoteKeepalive() {
  if (remoteWs) {
    if ((remoteWs.lastActive + remoteTimeout) < getms()) {
      remoteWs.terminate();
    }
  }
}
remoteConnect();
setInterval(remoteKeepalive, 1000);

function setRemoteKey(key) {
  config.remote_key = key;
  delete config.relay_server;
  delete config.relay_account;
  saveConfig();

  if (remoteWs) {
    remoteStatusHandled = true;
    remoteWs.terminate();
  }
  remoteConnect();

  // Clear the remote relays when switching to a different remote key
  if (updateCachedRelays(undefined)) {
    broadcastMsg('relays', buildRelaysMsg());
  }

  broadcastMsg('config', config);
}


/* Notification system */
/*
  conn - send it to a specific client, or undefined to broadcast
  name - identifier for the notification, e.g. 'belacoder'
  type - 'success', 'warning', 'error'
  msg - the human readable notification message
  duration - 0-never expires
             or number of seconds until the notification expires
             * an expired notification is hidden by the UI and removed from persistent notifications
  isPersistent - show it to every new client, conn must be undefined for broadcast
  isDismissable - is the user allowed to hide it?
*/
let persistentNotifications = new Map();

function buildNotificationMsg(n, duration) {
  return {
    name: n.name,
    type: n.type,
    msg: n.msg,
    is_dismissable: n.isDismissable,
    is_persistent: n.isPersistent,
    duration
  }
}

function notificationSend(conn, name, type, msg, duration = 0, isPersistent = false, isDismissable = true, authedOnly = true) {
  if (isPersistent && conn != undefined) {
    console.log("error: attempted to send persistent unicast notification");
    return false;
  }

  const notification = {
                         name,
                         type,
                         msg,
                         isDismissable,
                         isPersistent,
                         duration,
                         authedOnly
                       };
  let doSend = true;
  if (isPersistent) {
    let pn = persistentNotifications.get(name);
    if (pn) {
      // Rate limiting to once every second
      if (pn.last_sent && ((pn.last_sent + 1000) > getms())) {
        doSend = false;
      }
    } else {
      pn = {};
      persistentNotifications.set(name, pn)
    }

    Object.assign(pn, notification);
    pn.updated = getms();

    if (doSend) {
      pn.last_sent = getms();
    }
  }

  if (!doSend) return;

  const notificationMsg = {
                            show: [buildNotificationMsg(notification, duration)]
                          };
  if (conn) {
    conn.send(buildMsg('notification', notificationMsg, conn.senderId));
  } else {
    broadcastMsg('notification', notificationMsg, 0, authedOnly);
  }

  return true;
}

function notificationBroadcast(name, type, msg, duration = 0, isPersistent = false, isDismissable = true, authedOnly = true) {
  notificationSend(undefined, name, type, msg, duration, isPersistent, isDismissable, authedOnly);
}

function notificationRemove(name) {
  const n = persistentNotifications.get(name);
  persistentNotifications.delete(name);

  const msg = { remove: [name] };
  broadcastMsg('notification', msg, 0, (!n || n.authedOnly));
}

function _notificationIsLive(n) {
  if (n.duration === 0) return 0;

  const remainingDuration = Math.ceil(n.duration - (getms() - n.updated) / 1000);
  if (remainingDuration <= 0) {
    persistentNotifications.delete(n.name);
    return false;
  }
  return remainingDuration;
}

function notificationExists(name) {
  let pn = persistentNotifications.get(name);
  if (!pn) return;

  if (_notificationIsLive(pn) !== false) return pn;
}

function notificationSendPersistent(conn, isAuthed = false) {
  const notifications = [];
  for (const n of persistentNotifications) {
    if (!isAuthed && n[1].authedOnly !== false) continue;

    const remainingDuration = _notificationIsLive(n[1]);
    if (remainingDuration !== false) {
      notifications.push(buildNotificationMsg(n[1], remainingDuration));
    }
  }

  const msg = { show: notifications };
  conn.send(buildMsg('notification', msg));
}


/* Hardware monitoring */
let sensors = {};

function updateSensorThermal(id, name) {
  try {
    let socTemp = fs.readFileSync(`/sys/class/thermal/thermal_zone${id}/temp`, 'utf8');
    socTemp = parseInt(socTemp) / 1000.0;
    socTemp = `${socTemp.toFixed(1)} °C`;
    sensors[name] = socTemp;
  } catch (err) {};
}

function updateSensorsJetson() {
  try {
    let socVoltage = fs.readFileSync('/sys/bus/i2c/drivers/ina3221x/6-0040/iio:device0/in_voltage0_input', 'utf8');
    socVoltage = parseInt(socVoltage) / 1000.0;
    socVoltage = `${socVoltage.toFixed(3)} V`;
    sensors['SoC voltage'] = socVoltage;
  } catch(err) {};

  try {
    let socCurrent = fs.readFileSync('/sys/bus/i2c/drivers/ina3221x/6-0040/iio:device0/in_current0_input', 'utf8');
    socCurrent = parseInt(socCurrent) / 1000.0;
    socCurrent = `${socCurrent.toFixed(3)} A`;
    sensors['SoC current'] = socCurrent;
  } catch(err) {};

  updateSensorThermal(0, 'SoC temperature');
}

function updateSensorsRk3588() {
  updateSensorThermal(0, 'SoC temperature');
}

function updateSensorsN100() {
  updateSensorThermal(1, 'CPU temperature');
}

function updateSensors() {
  sensorsFunc();
  broadcastMsg('sensors', sensors, getms() - ACTIVE_TO);
}

let sensorsFunc;
switch (setup.hw) {
  case 'jetson':
    sensorsFunc = updateSensorsJetson;
    break;
  case 'rk3588':
    sensorsFunc = updateSensorsRk3588;
    break;
  case 'n100':
    sensorsFunc = updateSensorsN100;
    break;
  default:
    console.log(`Unknown sensors for ${setup.hw}`);
}

if (sensorsFunc) {
  updateSensors();
  setInterval(updateSensors, 1000);
}

async function isServiceEnabled(service) {
  const isEnabled = await execPNR(`systemctl is-enabled ${service}`);
  return (isEnabled.code === 0);
}

async function isServiceFailed(service) {
  const isFailed = await execPNR(`systemctl is-failed ${service}`)
  return (isFailed.code === 0);
}

const bootconfigService = 'belabox-firstboot-bootconfig';
async function monitorBootconfig() {
  if (await isServiceEnabled(bootconfigService)) {
    if (await isServiceFailed(bootconfigService)) {
      const msg = "Updating the bootloader failed. Please download the system log from the Advanced / developer menu";
      notificationBroadcast('bootconfig', 'error', msg, 0, true, false);
    } else {
      if (!notificationExists('bootconfig')) {
        const msg = "Don't reset or unplug the system. The bootloader is being updated in the background and doing so may brick your board..."
        notificationBroadcast('bootconfig', 'warning', msg, 0, true, false, false);
      }

      setTimeout(monitorBootconfig, 2000);
    }
  } else {
    notificationRemove('bootconfig');
  }
}

/* Hardware-specific monitoring */
switch (setup.hw) {
  case 'jetson': {
    /* Monitor the kernel log for undervoltage events */
    const dmesg = spawn("dmesg", ["-w"]);
    dmesg.stdout.on('data', function(data) {
      if (data.toString('utf8').match('soctherm: OC ALARM 0x00000001')) {
        const msg = 'System undervoltage detected. ' +
                    'You may experience system instability, ' +
                    'including glitching, freezes and the modems disconnecting';
        notificationBroadcast('jetson_undervoltage', 'error', msg, 10*60, true, false);
      }
    }); // dmesg

    /* Show an alert while belabox-firstboot-bootconfig is active */
    monitorBootconfig();
    break;
  }

  case 'rk3588': {
    const dmesg = spawn("dmesg", ["-w"]);
    dmesg.stdout.on('data', function(data) {
      data = data.toString('utf8');
      if (data.match('hdmirx_wait_lock_and_get_timing signal not lock') ||
          data.match('hdmirx_delayed_work_audio: audio underflow')) {
        const msg = 'HDMI signal issues detected. This is usually caused either by EMI or a by a faulty cable. ' +
                    'Try to move any modems away from the HDMI cable and the encoder. ' +
                    'If that fails, try out a different HDMI cable or to manually set a lower HDMI resolution/framerate on your camera';
        notificationBroadcast('hdmi_error', 'error', msg, 8, true, false);
      }
      if (data.match('hdmirx-controller: Err, timing is invalid')) {
        const hdmiNotif = notificationExists('hdmi_error');
        const msg = 'No HDMI signal detected';

        if (!hdmiNotif || hdmiNotif.msg == msg) {
          notificationBroadcast('hdmi_error', 'error', msg, 3, true, false);
        }
      }
    });
    break;
  }
}

/* Check if there are any Cam Links plugged into a USB2 port */
async function checkCamlinkUsb2() {
  const deviceDir = '/sys/bus/usb/devices';
  const devices = await readdirP(deviceDir);
  let foundUsb2 = false;

  for (const d of devices) {
    try {
      const vendor = await readTextFile(`${deviceDir}/${d}/idVendor`);
      if (vendor != "0fd9\n") continue;

      /*
        With my 20GAM9901 unit it would appear that product ID 0x66 is used for
        USB3.0 and 0x67 is used for USB2.0, but I'm not sure if this is consistent
        between different revisions. So we'll check bcdUSB (aka version) for both

        Additional product IDs for 20GAM9902 thanks to chubbybunny627: 0x7b for
        USB 3.0 and 0x85 for USB 2.0
      */
      const product = (await readTextFile(`${deviceDir}/${d}/idProduct`)).trim();
      const knownCamLinkPids = ['0066', '0067', '007b', '0085'];
      if (!knownCamLinkPids.includes(product)) continue;

      const version = await readTextFile(`${deviceDir}/${d}/version`);
      if (!version.match('3.00')) {
        foundUsb2 = true;
      }
    } catch(err) {}
  }

  if (foundUsb2) {
    const msg = "Detected a Cam Link 4K connected via USB2. This will result in low framerate operation. Ensure that it's connected to a USB3.0 port and that you're using a USB3.0 extension cable.";
    notificationBroadcast('camlink_usb2', 'error', msg, 0, true, false);
    console.log('Detected a Cam Link 4K connected via USB2.0');
  } else {
    notificationRemove('camlink_usb2');
    console.log('No Cam Link 4K connected via USB2.0');
  }
}
// check for Cam Links on USB2 at startup
checkCamlinkUsb2();


/* Audio input selection and codec */
const alsaSrcPattern = /alsasrc device=[A-Za-z0-9:=]+/;
const alsaPipelinePattern = /alsasrc device=[A-Za-z0-9:]+(.|[\s])*?mux\. *\s?/;

const audioCodecPattern = /voaacenc\s+bitrate=(\d+)\s+!\s+aacparse\s+!/;
const audioCodecs = {'opus': 'Opus (better quality)', 'aac': 'AAC (backwards compatibility)'};

const noAudioId = "No audio";
const defaultAudioId = "Pipeline default";
const audioSrcAliases = {"C4K": "Cam Link 4K", "usbaudio": "USB audio", "rockchiphdmiin": "HDMI", "rockchipes8388": "Analog in"};

let audioDevices = {};
addAudioCardById(audioDevices, noAudioId);
addAudioCardById(audioDevices, defaultAudioId);


function pipelineGetAudioProps(path) {
  const props = {};
  const contents = fs.readFileSync(path, 'utf8');
  props.asrc = contents.match(alsaPipelinePattern) != null;
  props.acodec = contents.match(audioCodecPattern) != null;
  return props;
}

async function replaceAudioSettings(pipelineFile, cardId, codec) {
  let pipeline = await readTextFile(pipelineFile);
  if (pipeline === undefined) return;

  if (cardId && cardId != defaultAudioId) {
    if (cardId == noAudioId) {
      pipeline = pipeline.replace(alsaPipelinePattern, '');
    } else {
      pipeline = pipeline.replace(alsaSrcPattern, `alsasrc device="hw:${cardId}"`);
    }
  }

  if (codec == "opus") {
    const br = pipeline.match(audioCodecPattern);
    if (br) {
      pipeline = pipeline.replace(audioCodecPattern, `audioresample quality=10 sinc-filter-mode=1 ! opusenc bitrate=${br[1]} ! opusparse !`);
    }
  }

  const pipelineTmp = "/tmp/belacoder_pipeline";
  if (!(await writeTextFile(pipelineTmp, pipeline))) return;

  return pipelineTmp;
}


function getAudioSrcName(id) {
  const name = audioSrcAliases[id];
  if (name) return name;
  return id;
}

function addAudioCardById(list, id) {
  const name = getAudioSrcName(id);
  list[name] = id;
}

async function updateAudioDevices() {
  // Ignore the onboard audio cards
  const exclude = ['tegrahda', 'tegrasndt210ref', 'rockchipdp0', 'rockchiphdmi0', 'rockchiphdmi1', 'rockchiphdmi2', 'rockchiphdmiind', 'rockchipes8316'];
  // Devices to show at the top of the list
  const priority = ['HDMI', 'rockchiphdmiin', 'rockchipes8388', 'C4K', 'usbaudio'];

  const deviceDir = '/sys/class/sound';
  const devices = await readdirP(deviceDir);
  const list = {};
  let hasCamlink = false;
  let hasUsbAudio = false;

  for (const d of devices) {
    // Only inspect cards
    if (!d.match(/^card/)) continue;

    // Get the card's ID
    const id = (await readTextFile(`${deviceDir}/${d}/id`)).trim();

    // Skip over the IDs known not to be valid audio inputs
    if (exclude.includes(id)) continue;

    list[id] = true;
  }
  // First add any priority cards found
  const sortedList = {};
  for (const id of priority) {
    if (list[id]) addAudioCardById(sortedList, id);
    delete list[id];
  }

  // Then add the remaining cards in alphabetical order
  for (const id of Object.keys(list).sort()) {
    addAudioCardById(sortedList, id);
  }

  // Always add 'no audio' and default audio options
  addAudioCardById(sortedList, noAudioId);
  addAudioCardById(sortedList, defaultAudioId);

  audioDevices = sortedList;
  console.log("audio devices:");
  console.log(audioDevices);

  broadcastMsg('status', {asrcs: Object.keys(audioDevices)});
}
updateAudioDevices();


/* Read the list of pipeline files */
function readDirAbsPath(dir, excludePattern) {
  const pipelines = {};

  try {
    const files = fs.readdirSync(dir);
    const basename = path.basename(dir);

    for (const f in files) {
      const name = basename + '/' + files[f];
      if (excludePattern && name.match(excludePattern)) continue;

      const id = crypto.createHash('sha1').update(name).digest('hex');
      const path = dir + files[f];
      pipelines[id] = {name: name, path: path};
    }
  } catch (err) {
    console.log(`Failed to read the pipeline files in ${dir}:`);
    console.log(err);
  };

  return pipelines;
}

function getPipelines() {
  const ps = {};
  Object.assign(ps, readDirAbsPath(belacoderPipelinesDir + '/custom/'));

  // Get the hardware-specific pipelines
  let excludePipelines;
  if (setup.hw == 'rk3588' && !fs.existsSync('/dev/hdmirx')) {
    excludePipelines = 'h265_hdmi';
  }
  Object.assign(ps, readDirAbsPath(belacoderPipelinesDir + `/${setup.hw}/`, excludePipelines));

  Object.assign(ps, readDirAbsPath(belacoderPipelinesDir + '/generic/'));

  for (const p in ps) {
    const props = pipelineGetAudioProps(ps[p].path)
    Object.assign(ps[p], props);
  }

  return ps;
}
const pipelines = getPipelines();

function searchPipelines(id) {
  if (pipelines[id]) return pipelines[id];
  return null;
}

// pipeline list in the format needed by the frontend
function getPipelineList() {
  const list = {};
  for (const id in pipelines) {
    list[id] = {name: pipelines[id].name, asrc: pipelines[id].asrc, acodec: pipelines[id].acodec};
  }
  return list;
}


/*
  We use an UDEV rule to send a SIGUSR2 when:
   * an Elgato USB device is plugged in or out
   * a USB audio card is plugged in or out
*/
function udevDeviceUpdate() {
  console.log("SIGUSR2");
  checkCamlinkUsb2();
  updateAudioDevices();
}

process.on('SIGUSR2', udevDeviceUpdate);


/* Stream starting, stopping, management and monitoring */
function startError(conn, msg, id = undefined) {
  const originalId = conn.senderId;
  if (id !== undefined) {
    conn.senderId = id;
  }

  notificationSend(conn, "start_error", "error", msg, 10);

  if (id !== undefined) {
    conn.senderId = originalId;
  }

  if (!updateStatus(false)) {
    conn.send(buildMsg('status', {is_streaming: false}));
  }

  return false;
}

function setBitrate(params) {
  const minBr = 300; // Kbps

  if (params.max_br == undefined) return null;
  if (params.max_br < minBr || params.max_br > 12000) return null;

  config.max_br = params.max_br;
  saveConfig();

  fs.writeFileSync(setup.bitrate_file, minBr*1000 + "\n"
                   + config.max_br*1000 + "\n");

  spawnSync("killall", ['-HUP', "belacoder"], { detached: true});

  return config.max_br;
}

async function removeBitrateOverlay(pipelineFile) {
  let pipeline = await readTextFile(pipelineFile);
  if (!pipeline) return;

  pipeline = pipeline.replace(/textoverlay[^!]*name=overlay[^!]*!/g, '');
  const pipelineTmp = "/tmp/belacoder_pipeline";
  if (!(await writeTextFile(pipelineTmp, pipeline))) return;

  return pipelineTmp;
}

async function resolveSrtla(addr, conn) {
  let srtlaAddr = addr;
  try {
    var {addrs, fromCache} = await dnsCacheResolve(addr, 'a');
  } catch (err) {
    startError(conn, "failed to resolve SRTLA addr " + addr, conn.senderId);
    queueUpdateGw();
    return;
  }

  if (fromCache) {
    srtlaAddr = addrs[Math.floor(Math.random()*addrs.length)];
    queueUpdateGw();
  } else {
    /* At the moment we don't check that the SRTLA connection was established before
       validating the DNS result. The caching DNS resolver checks for invalid
       results from captive portals, etc, so all results *should* be good already */
    dnsCacheValidate(addr);
  }

  return srtlaAddr;
}

function asrcProbe(asrc) {
  audioSrcId = audioDevices[asrc];
  if (!audioSrcId) {
    const msg = `Selected audio input '${config.asrc}' is unavailable. Waiting for it before starting the stream...`;
    notificationBroadcast('asrc_not_found', 'warning', msg, 2, true, false);
  }

  return audioSrcId;
}

async function pipelineSetAsrc(pipelineFile, audioSrcId, audioCodec) {
  pipelineFile = await replaceAudioSettings(pipelineFile, audioSrcId, audioCodec);
  if (!pipelineFile) {
    startError(conn, 'failed to generate the pipeline file - audio settings');
  }
  return pipelineFile;
}

let asrcRetryTimer;
function asrcScheduleRetry(pipelineFile, callback, conn) {
  asrcRetryTimer = setTimeout(function() {
    asrcRetry(pipelineFile, callback, conn);
  }, 1000);
}

async function asrcRetry(pipelineFile, callback, conn) {
  asrcRetryTimer = undefined;

  audioSrcId = asrcProbe(config.asrc);
  if (audioSrcId) {
    pipelineFile = await pipelineSetAsrc(pipelineFile, audioSrcId, config.acodec);
    if (!pipelineFile) return;

    let srtlaAddr = await resolveSrtla(config.srtla_addr, conn);
    if (!srtlaAddr) return;

    callback(pipelineFile, srtlaAddr);
  } else {
    asrcScheduleRetry(pipelineFile, callback, conn);
  }
}

function validatePortNo(port) {
  const portTmp = parseInt(port);
  if (portTmp != port || portTmp <= 0 || portTmp > 0xFFFF) return undefined;
  return portTmp;
}

async function updateConfig(conn, params, callback) {
  asrcRetryTimer = undefined;

  // delay
  if (params.delay == undefined)
    return startError(conn, "audio delay not specified");
  const delayTmp = parseInt(params.delay);
  if (delayTmp != params.delay || delayTmp < -2000 || delayTmp > 2000)
    return startError(conn, `invalid delay '${params.delay}'`);
  params.delay = delayTmp;

  // pipeline
  if (params.pipeline == undefined)
    return startError(conn, "pipeline not specified");
  let pipeline = await searchPipelines(params.pipeline);
  if (pipeline == null)
    return startError(conn, "pipeline not found");
  let pipelineFile = pipeline.path

  // audio codec, if needed for the pipeline
  let audioCodec;
  if (pipeline.acodec) {
    if (params.acodec == undefined) {
      return startError(conn, "audio codec not specified");
    }
    if (!audioCodecs[params.acodec]) {
      return startError(conn, "audio codec not found");
    }
    audioCodec = params.acodec;
  }

  // remove the bitrate overlay unless enabled in the config
  if (!params.bitrate_overlay) {
    pipelineFile = await removeBitrateOverlay(pipelineFile);
    if (!pipelineFile) return startError(conn, "failed to generate the pipeline file - bitrate overlay");
  }

  // bitrate
  let bitrate = setBitrate(params);
  if (bitrate == null)
    return startError(conn, "invalid bitrate range: ");

  // srt latency
  if (params.srt_latency == undefined)
    return startError(conn, "SRT latency not specified");
  const latencyTmp = parseInt(params.srt_latency);
  if (latencyTmp != params.srt_latency || latencyTmp < 100 || latencyTmp > 10000)
    return startError(conn, `invalid SRT latency '${params.srt_latency}' ms`);
  params.srt_latency = latencyTmp;

  // srtla addr & port
  let srtlaAddr, srtlaPort;
  if (relaysCache && params.relay_server) {
    const relayServer = relaysCache.servers[params.relay_server];
    if (!relayServer) {
      return startError(conn, "Invalid relay server specified");
    }
    srtlaAddr = relayServer.addr;
    srtlaPort = relayServer.port;
  } else {
    if (params.srtla_addr == undefined)
      return startError(conn, "SRTLA address not specified");
    params.srtla_addr = params.srtla_addr.trim();
    srtlaAddr = params.srtla_addr;

    if (params.srtla_port == undefined)
      return startError(conn, "SRTLA port not specified");
    params.srtla_port = validatePortNo(params.srtla_port);
    if (!params.srtla_port)
      return startError(conn, `invalid SRTLA port '${params.srtla_port}'`);
    srtlaPort = params.srtla_port;
  }

  // srt streamid
  let streamid;
  if (relaysCache && params.relay_server && params.relay_account) {
    const relayAccount = relaysCache.accounts[params.relay_account];
    if (!relayAccount) {
      return startError(conn, "Invalid relay account specified!");
    }
    streamid = relayAccount.ingest_key;
  } else {
    if (params.srt_streamid == undefined)
      return startError(conn, "SRT streamid not specified");
    streamid = params.srt_streamid;
  }

  // resolve the srtla hostname
  srtlaAddr = await resolveSrtla(srtlaAddr, conn);
  if (!srtlaAddr) return;

  // audio capture device, if needed for the pipeline
  let audioSrcId = defaultAudioId;
  if (pipeline.asrc) {
    if (params.asrc == undefined) {
      return startError(conn, "audio source not specified");
    }

    audioSrcId = audioDevices[params.asrc];
    if (!audioSrcId && params.asrc != config.asrc) {
      return startError(conn, "selected audio source not found");
    }

    audioSrcId = asrcProbe(params.asrc);
  }

  if (pipeline.asrc) {
    config.asrc = params.asrc;
  }

  if (pipeline.acodec) {
    config.acodec = params.acodec;
  }

  config.delay = params.delay;
  config.pipeline = params.pipeline;
  config.max_br = params.max_br;
  config.srt_latency = params.srt_latency;
  config.bitrate_overlay = params.bitrate_overlay;
  if (params.relay_server) {
    config.relay_server = params.relay_server;
    delete config.srtla_addr;
    delete config.srtla_port;
  } else {
    config.srtla_addr = params.srtla_addr;
    config.srtla_port = params.srtla_port;
    delete config.relay_server;
  }
  if (params.relay_account) {
    config.relay_account = params.relay_account;
    delete config.srt_streamid;
  } else {
    config.srt_streamid = params.srt_streamid;
    delete config.relay_account;
  }

  if (!params.relay_server || !params.relay_account) {
    convertManualToRemoteRelay();
  }

  saveConfig();

  broadcastMsg('config', config);

  if (audioSrcId) {
    pipelineFile = await pipelineSetAsrc(pipelineFile, audioSrcId, audioCodec);
    if (!pipelineFile) return;

    callback(pipelineFile, srtlaAddr, srtlaPort, streamid);
  } else {
    asrcScheduleRetry(pipelineFile, callback, conn);
    updateStatus(true);
  }
}

let isStreaming = false;
function updateStatus(status) {
  if (status != isStreaming) {
    isStreaming = status;
    broadcastMsg('status', {is_streaming: isStreaming});
    return true;
  }
  return false;
}

function genSrtlaIpList() {
  let list = "";
  let count = 0;

  for (i in netif) {
    if (netif[i].enabled) {
      list += netif[i].ip + "\n";
      count++;
    }
  }
  fs.writeFileSync(setup.ips_file, list);

  return count;
}

function updateSrtlaIps() {
  genSrtlaIpList();
  spawnSync("killall", ['-HUP', "srtla_send"], { detached: true});
}

let streamingProcesses = [];
function spawnStreamingLoop(command, args, cooldown = 100, errCallback) {
  const process = spawn(command, args, { stdio: ['inherit', 'inherit', 'pipe'] });
  streamingProcesses.push(process);

  if (errCallback) {
    process.stderr.on('data', function(data) {
      data = data.toString('utf8');
      console.log(data);
      errCallback(data);
    });
  }

  process.on('exit', function(code) {
    process.restartTimer = setTimeout(function() {
      // remove the old process from the list
      removeProc(process);

      spawnStreamingLoop(command, args, cooldown, errCallback);
    }, cooldown);
  })
}

function start(conn, params) {
  if (isStreaming || isUpdating()) {
    sendStatus(conn);
    return;
  }

  const senderId = conn.senderId;
  updateConfig(conn, params, function(pipeline, srtlaAddr, srtlaPort, streamid) {
    if (genSrtlaIpList() < 1) {
      startError(conn, "Failed to start, no available network connections", senderId);
      return;
    }
    updateStatus(true);

    spawnStreamingLoop(srtlaSendExec, [
                         9000,
                         srtlaAddr,
                         srtlaPort,
                         setup.ips_file
                       ], 100, function(err) {
      let msg;
      if (err.match('Failed to establish any initial connections')) {
        msg = 'Failed to connect to the SRTLA server. Retrying...';
      } else if (err.match('no available connections')) {
        msg = 'All SRTLA connections failed. Trying to reconnect...';
      }
      if (msg) {
        notificationBroadcast('srtla', 'error', msg, duration = 5, isPersistent = true, isDismissable = false);
      }
    });

    const belacoderArgs = [
                            pipeline,
                            '127.0.0.1',
                            '9000',
                            '-d', config.delay,
                            '-b', setup.bitrate_file,
                            '-l', config.srt_latency,
                          ];
    if (streamid != '') {
      belacoderArgs.push('-s');
      belacoderArgs.push(streamid);
    }
    spawnStreamingLoop(belacoderExec, belacoderArgs, 2000, function(err) {
      let msg;
      if (err.match('gstreamer error from alsasrc0')) {
        msg = 'Capture card error (audio). Trying to restart...';
      } else if (err.match('gstreamer error from v4l2src0')) {
        msg = 'Capture card error (video). Trying to restart...';
      } else if (err.match('Pipeline stall detected')) {
        msg = 'The input source has stalled. Trying to restart...';
      } else if (err.match('Failed to establish an SRT connection')) {
        if (!notificationExists('srtla')) {
          let reason = err.match(/Failed to establish an SRT connection: ([\w ]+)\./);
          reason = (reason && reason[1]) ? ` (${reason[1]})` : '';
          msg = `Failed to connect to the SRT server${reason}. Retrying...`;
        }
      } else if (err.match(/The SRT connection.+, exiting/)) {
        if (!notificationExists('srtla')) {
          msg = 'The SRT connection failed. Trying to reconnect...';
        }
      }
      if (msg) {
        notificationBroadcast('belacoder', 'error', msg, duration = 5, isPersistent = true, isDismissable = false);
      }
    });
  });
}

function removeProc(process) {
  streamingProcesses = streamingProcesses.filter(function(p) { return p !== process });
}

function stopProcess(process) {
  if (process.restartTimer) {
    clearTimeout(process.restartTimer);
  }
  process.removeAllListeners('exit');
  process.on('exit', function() {
    removeProc(process);
  })
  if (process.exitCode === null && process.signalCode === null) {
    process.kill('SIGTERM');
    return false;
  } else {
    removeProc(process);
    return true;
  }
}

const stopCheckInterval = 50;
function waitForAllProcessesToTerminate() {
  if (streamingProcesses.length == 0) {
    console.log('stop: all processes terminated');
    updateStatus(false);

    periodicCheckForSoftwareUpdates();
  } else {
    for (const p of streamingProcesses) {
      console.log(`stop: still waiting for ${p.spawnfile} to terminate...`);
    }
    setTimeout(waitForAllProcessesToTerminate, stopCheckInterval);
  }
}

function stopAll() {
  for (const p of streamingProcesses) {
    stopProcess(p);
  }
  setTimeout(waitForAllProcessesToTerminate, stopCheckInterval);
}

function stop() {
  if (asrcRetryTimer) {
    clearTimeout(asrcRetryTimer);
    asrcRetryTimer = undefined;

    if (streamingProcesses.length == 0) {
      updateStatus(false);
      return;
    }

    console.log('stop: BUG?: found both a timer and running processes');
  }

  let foundBelacoder = false;

  for (const p of streamingProcesses) {
    p.removeAllListeners('exit');
    if (p.spawnfile.match(/belacoder$/)) {
      foundBelacoder = true;
      console.log('stop: found the belacoder process');

      if (!stopProcess(p)) {
        // if the process is active, wait for it to exit
        p.on('exit', function(code) {
          console.log('stop: belacoder terminated');
          stopAll();
        });
      } else {
        // if belacoder has terminated already, skip to the next step
        console.log('stop: belacoder already terminated');
        stopAll();
      }
    }
  }

  if (!foundBelacoder) {
    console.log('stop: BUG?: belacoder not found, terminating all processes');
    stopAll();
  }
}
// make sure we didn't inherit orphan processes
spawnSync("killall", ["belacoder"], {detached: true});
spawnSync("killall", ["srtla_send"], {detached: true});


/* Misc commands */
function command(conn, cmd) {
  switch(cmd) {
    case 'get_log':
      getLog(conn, 'belaUI');
      return;
    case 'get_syslog':
      getLog(conn);
      return;
  }

  if (isStreaming || isUpdating()) {
    sendStatus(conn);
    return;
  }

  switch(cmd) {
    case 'poweroff':
      spawnSync("poweroff", {detached: true});
      break;
    case 'reboot':
      spawnSync("reboot", {detached: true});
      break;
    case 'update':
      startSoftwareUpdate();
      break;
    case 'start_ssh':
    case 'stop_ssh':
      startStopSsh(conn, cmd);
      break;
    case 'reset_ssh_pass':
      resetSshPassword(conn);
      break;
  }
}

function getLog(conn, service) {
  const senderId = conn.senderId;
  let cmd = 'journalctl -b';
  let name = 'belabox_system_log.txt';

  if (service) {
    cmd += ` -u ${service}`;
    name = service.replace('belaUI', 'belabox') + '_log.txt';
  }

  exec(cmd, {maxBuffer: 10*1024*1024}, function(err, stdout, stderr) {
    if (err) {
      const msg = `Failed to fetch the log: ${err}`;
      notificationSend(conn, "log_error", "error", msg, 10);
      console.log(msg);
      return;
    }

    conn.send(buildMsg('log', {name, contents: stdout}, senderId));
  });
}

function handleConfig(conn, msg, isRemote) {
  // setPassword does its own authentication
  for (const type in msg) {
    switch(type) {
      case 'password':
        setPassword(conn, msg[type], isRemote);
        break;
    }
  }

  if (!conn.isAuthed) return;

  for (const type in msg) {
    switch(type) {
      case 'remote_key':
        setRemoteKey(msg[type]);
        break;
    }
  }
}


/* Software updates */
let availableUpdates = setup.apt_update_enabled ? null : false;
let softUpdateStatus = null;
let aptGetUpdating = false;
let aptGetUpdateFailures = 0;
let aptHeldBackPackages;

function isUpdating() {
  return (softUpdateStatus != null);
}

function parseUpgradePackageCount(text) {
  try {
    const upgradedCount = parseInt(text.match(/(\d+) upgraded/)[1]);
    const newlyInstalledCount = parseInt(text.match(/, (\d+) newly installed/)[1]);
    const upgradeCount = upgradedCount + newlyInstalledCount;
    return upgradeCount;
  } catch(err) {
    console.log("parseUpgradePackageCount(): failed to parse the package info");
    return undefined;
  }
}

function parseUpgradeDownloadSize(text) {
  try {
    let downloadSize = text.split('Need to get ')[1];
    downloadSize = downloadSize.split(/\/|( of archives)/)[0];
    return downloadSize;
  } catch(err) {
    return undefined;
  }
}

// Show an update notification if there are pending updates to packages matching this list
const belaboxPackageList = [
  'belabox',
  'belacoder',
  'belaui',
  'srtla',
  'usb-modeswitch-data',
  'l4t'
];
// Reboot instead of just restarting belaUI if we've updated packages matching this list
const rebootPackageList = [
  'l4t',
  'belabox-linux-',
  'belabox-network-config'
];
function packageListIncludes(list, includes) {
  for (const p of includes) {
    if (list.includes(p)) return true;
  }
  return false;
}

// Parses a list of packets shown by apt-get under a certain heading
function parseAptPackageList(stdout, heading) {
  let packageList;
  try {
    packageList = stdout.split(heading)[1];
    packageList = packageList.split(/\n[\d\w]+/)[0];
    packageList = packageList.replace(/[\n ]+/g, ' ');
    packageList = packageList.trim();
  } catch (err) {};

  return packageList;
}

function parseAptUpgradedPackages(stdout) {
  return parseAptPackageList(stdout, "The following packages will be upgraded:\n")
}

function parseAptUpgradeSummary(stdout) {
  const upgradeCount = parseUpgradePackageCount(stdout);
  let downloadSize;
  let belaboxPackages = false;
  if (upgradeCount > 0) {
    downloadSize = parseUpgradeDownloadSize(stdout);

    packageList = parseAptUpgradedPackages(stdout);
    if (packageListIncludes(packageList, belaboxPackageList)) {
      belaboxPackages = true;
    }
  }

  return {upgradeCount, downloadSize, belaboxPackages};
}

async function getSoftwareUpdateSize() {
  if (isStreaming || isUpdating() || aptGetUpdating) return 'busy';

  // First see if any packages can be upgraded by dist-upgrade
  let upgrade = await execPNR("apt-get dist-upgrade --assume-no");
  let res = parseAptUpgradeSummary(upgrade.stdout);

  // Otherwise, check if any packages have been held back (e.g. by dependencies changing)
  if (res.upgradeCount == 0) {
    aptHeldBackPackages = parseAptPackageList(upgrade.stdout, "The following packages have been kept back:\n");
    if (aptHeldBackPackages) {
      if (setup.hw == 'jetson' && aptHeldBackPackages === 'belabox') {
        // This is a special case for upgrading from an old installation using the stock jetson kernel
        aptHeldBackPackages = 'belabox belabox-linux-tegra';
      }
      upgrade = await execPNR("apt-get install --assume-no " + aptHeldBackPackages);
      res = parseAptUpgradeSummary(upgrade.stdout);
    }
  } else {
    // Reset aptHeldBackPackages if some upgrades became available via dist-upgrade
    aptHeldBackPackages = undefined;
  }

  if (res.belaboxPackages) {
    notificationBroadcast('belabox_update', 'warning',
      'A BELABOX update is available. Scroll down to the System menu to install it.',
      0, true, false);
  }

  availableUpdates = {package_count: res.upgradeCount, download_size: res.downloadSize};
  broadcastMsg('status', {available_updates: availableUpdates});

  return null;
}

function checkForSoftwareUpdates(callback) {
  if (isStreaming || isUpdating() || aptGetUpdating) return;

  aptGetUpdating = true;
  exec("apt-get update --allow-releaseinfo-change", function(err, stdout, stderr) {
    aptGetUpdating = false;

    if (stderr.length) {
      var err = true;
      aptGetUpdateFailures++;
      queueUpdateGw();
    } else {
      aptGetUpdateFailures = 0;
    }

    console.log(`apt-get update: ${(err === null) ? 'success' : 'error'}`);
    console.log(stdout);
    console.log(stderr);

    if (callback) callback(err, aptGetUpdateFailures);
  });
}

let nextCheckForSoftwareUpdates = getms();
let nextCheckForSoftwareUpdatesTimer;
function periodicCheckForSoftwareUpdates() {
  if (nextCheckForSoftwareUpdatesTimer) {
    clearTimeout(nextCheckForSoftwareUpdatesTimer);
    nextCheckForSoftwareUpdatesTimer = undefined;
  }

  const ms = getms();
  if (ms < nextCheckForSoftwareUpdates) {
    nextCheckForSoftwareUpdatesTimer = setTimeout(periodicCheckForSoftwareUpdates,
                                                  nextCheckForSoftwareUpdates-ms);
    return;
  }

  checkForSoftwareUpdates(async function(err, failures) {
    if (err === null) {
      err = await getSoftwareUpdateSize();
    }
    // one hour delay after a succesful check
    let delay = oneHour;
    // otherwise, increasing delay depending on the number of failures
    if (err !== null) {
      // try after 10s for the first ~2 minutes
      if (failures < 12) {
        delay = 10;
      // back off to a minute delay
      } else {
        delay = oneMinute;
      }
    }
    nextCheckForSoftwareUpdates = getms() + delay;
    nextCheckForSoftwareUpdatesTimer = setTimeout(periodicCheckForSoftwareUpdates, delay);
  });
}
if (setup.apt_update_enabled) {
  periodicCheckForSoftwareUpdates();
}

function startSoftwareUpdate() {
  if (!setup.apt_update_enabled || isStreaming || isUpdating()) return;

  // if an apt-get update is already in progress, retry later
  if (aptGetUpdating) {
    setTimeout(startSoftwareUpdate, 3 * 1000);
    return;
  }

  checkForSoftwareUpdates(function(err) {
    if (err === null) {
      doSoftwareUpdate();
    } else {
      softUpdateStatus.result = "Failed to fetch the updated package list; aborting the update.";
      broadcastMsg('status', {updating: softUpdateStatus});
      softUpdateStatus = null;
    }
  });

  softUpdateStatus = {downloading: 0, unpacking: 0, setting_up: 0, total: 0};
  broadcastMsg('status', {updating: softUpdateStatus});
}

function doSoftwareUpdate() {
  if (!setup.apt_update_enabled || isStreaming) return;

  let rebootAfterUpgrade = false;
  let aptLog = '';
  let aptErr = '';

  let args = "-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold ";
  if (aptHeldBackPackages) {
    args += "install " + aptHeldBackPackages;
  } else {
    args += "dist-upgrade";
  }
  const aptUpgrade = spawn("apt-get", args.split(' '));

  aptUpgrade.stdout.on('data', function(data) {
    let sendUpdate = false;

    data = data.toString('utf8');
    aptLog += data;
    if (softUpdateStatus.total == 0) {
      let count = parseUpgradePackageCount(data);
      if (count !== undefined) {
        softUpdateStatus.total = count;
        sendUpdate = true;

        let packageList = parseAptUpgradedPackages(aptLog);
        if (packageListIncludes(packageList, rebootPackageList)) {
          rebootAfterUpgrade = true;
        }
      }
    }

    if (softUpdateStatus.downloading != softUpdateStatus.total) {
      const getMatch = data.match(/Get:(\d+)/);
      if (getMatch) {
        const i = parseInt(getMatch[1]);
        if (i > softUpdateStatus.downloading) {
          softUpdateStatus.downloading = Math.min(i, softUpdateStatus.total);
          sendUpdate = true;
        }
      }
    }

    const unpacking = data.match(/Unpacking /g);
    if (unpacking) {
      softUpdateStatus.downloading = softUpdateStatus.total;
      softUpdateStatus.unpacking += unpacking.length;
      softUpdateStatus.unpacking = Math.min(softUpdateStatus.unpacking, softUpdateStatus.total);
      sendUpdate = true;
    }

    const setting_up = data.match(/Setting up /g);
    if (setting_up) {
      softUpdateStatus.setting_up += setting_up.length;
      softUpdateStatus.setting_up = Math.min(softUpdateStatus.setting_up, softUpdateStatus.total);
      sendUpdate = true;
    }

    if (sendUpdate) {
      broadcastMsg('status', {updating: softUpdateStatus});
    }
  });

  aptUpgrade.stderr.on('data', function(data) {
    aptErr += data;
  });

  aptUpgrade.on('close', function(code) {
    softUpdateStatus.result = (code == 0) ? code : aptErr;
    broadcastMsg('status', {updating: softUpdateStatus});

    softUpdateStatus = null;
    console.log(aptLog);
    console.log(aptErr);

    if (code == 0) {
      if (rebootAfterUpgrade) {
        spawnSync("reboot", {detached: true});
      } else {
        process.exit(0);
      }
    }
  });
}


/* SSH control */
let sshStatus;
function handleSshStatus(s) {
  if (s.user !== undefined && s.active !== undefined && s.user_pass !== undefined) {
    if (!sshStatus ||
        s.user != sshStatus.user ||
        s.active != sshStatus.active ||
        s.user_pass != sshStatus.user_pass) {
      sshStatus = s;
      broadcastMsg('status', {ssh: sshStatus});
    }
  }
}

function getSshUserHash(callback) {
  if (!setup.ssh_user) return;

  const cmd = `grep "^${setup.ssh_user}:" /etc/shadow`;
  exec(cmd, function(err, stdout, stderr) {
    if (err === null && stdout.length) {
      callback(stdout);
    } else {
      console.log(`Error getting the password hash for ${setup.ssh_user}: ${err}`);
    }
  });
}

function getSshStatus(conn) {
  if (!setup.ssh_user) return undefined;

  let s = {};
  s.user = setup.ssh_user;

  // Check is the SSH server is running
  exec('systemctl is-active ssh', function(err, stdout, stderr) {
    if (err === null) {
      s.active = true;
    } else {
      if (stdout == "inactive\n") {
        s.active = false;
      } else {
        console.log('Error running systemctl is-active ssh: ' + err.message);
        return;
      }
    }

    handleSshStatus(s);
  });

  // Check if the user's password has been changed
  getSshUserHash(function(hash) {
    s.user_pass = (hash != sshPasswordHash);
    handleSshStatus(s);
  });

  // If an immediate result is expected, send the cached status
  return sshStatus;
}
getSshStatus();

function startStopSsh(conn, cmd) {
  if (!setup.ssh_user) return;

  switch(cmd) {
    case 'start_ssh':
      if (config.ssh_pass === undefined) {
        resetSshPassword(conn);
      }
    case 'stop_ssh':
      const action = cmd.split('_')[0];
      spawnSync('systemctl', [action, 'ssh'], {detached: true});
      getSshStatus();
      break;
  }
}

function resetSshPassword(conn) {
  if (!setup.ssh_user) return;

  const password = crypto.randomBytes(24).toString('base64').
                   replace(/\+|\/|=/g, '').substring(0,20);
  const cmd = `printf "${password}\n${password}" | passwd ${setup.ssh_user}`;
  exec(cmd, function(err, stdout, stderr) {
    if (err) {
      notificationSend(conn, "ssh_pass_reset", "error",
                       `Failed to reset the SSH password for ${setup.ssh_user}`, 10);
      return;
    }
    getSshUserHash(function(hash) {
      config.ssh_pass = password;
      sshPasswordHash = hash;
      saveConfig();
      broadcastMsg('config', config);
      getSshStatus();
    });
  });
}

/* Authentication */
function setPassword(conn, password, isRemote) {
  if (conn.isAuthed || (!isRemote && !passwordHash)) {
    const minLen = 8;
    if (password.length < minLen) {
      notificationSend(conn, "belaui_pass_length", "error",
                       `Minimum password length: ${minLen} characters`, 10);
      return;
    }
    passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    delete config.password;
    saveConfig();
  }
}

function genAuthToken(isPersistent) {
  const token = crypto.randomBytes(32).toString('base64');
  if (isPersistent) {
    persistentTokens[token] = true;
    savePersistentTokens();
  } else {
    tempTokens[token] = true;
  }
  return token;
}

function sendStatus(conn) {
  conn.send(buildMsg('status', {is_streaming: isStreaming,
                                available_updates: availableUpdates,
                                updating: softUpdateStatus,
                                ssh: getSshStatus(conn),
                                wifi: wifiBuildMsg(),
                                modems: modemsBuildMsg(),
                                asrcs: Object.keys(audioDevices)}));
}

function sendInitialStatus(conn) {
  conn.send(buildMsg('config', config));
  conn.send(buildMsg('pipelines', getPipelineList()));
  if (relaysCache)
    conn.send(buildMsg('relays', buildRelaysMsg()));
  sendStatus(conn);
  conn.send(buildMsg('netif', netIfBuildMsg()));
  conn.send(buildMsg('sensors', sensors));
  conn.send(buildMsg('revisions', revisions));
  conn.send(buildMsg('acodecs', audioCodecs));
  notificationSendPersistent(conn, true);
}

function connAuth(conn, sendToken) {
  conn.isAuthed = true;
  let result = {success: true};
  if (sendToken != undefined) {
    result['auth_token'] = sendToken;
  }
  conn.send(buildMsg('auth', result));
  sendInitialStatus(conn);
}

function tryAuth(conn, msg) {
  if (!passwordHash) {
    conn.send(buildMsg('auth', {success: false}));
    return;
  }

  if (typeof(msg.password) == 'string') {
    bcrypt.compare(msg.password, passwordHash, function(err, match) {
      if (match == true && err == undefined) {
        conn.authToken = genAuthToken(msg.persistent_token);
        connAuth(conn, conn.authToken);
      } else {
        notificationSend(conn, "auth", "error", "Invalid password");
      }
    });
  } else if (typeof(msg.token) == 'string') {
    if (tempTokens[msg.token] || persistentTokens[msg.token]) {
      connAuth(conn);
      conn.authToken = msg.token;
    } else {
      conn.send(buildMsg('auth', {success: false}));
    }
  }
}

function stripPasswords(obj) {
  if (obj.constructor !== Object) return obj;

  const copy = {...obj};
  for (const p in copy) {
    if (p === 'password') {
      copy[p] = '<password not logged>';
    } else if (copy[p] && copy[p].constructor === Object) {
      copy[p] = stripPasswords(copy[p]);
    }
  }
  return copy;
}

function handleMessage(conn, msg, isRemote = false) {
  // log all received messages except for keepalives
  if (Object.keys(msg).length > 1 || msg.keepalive === undefined) {
    console.log(stripPasswords(msg));
  }

  if (!isRemote) {
    for (const type in msg) {
      switch(type) {
        case 'auth':
          tryAuth(conn, msg[type]);
          break;
      }
    }
  }

  for (const type in msg) {
    switch(type) {
      case 'config':
        handleConfig(conn, msg[type], isRemote);
        break;
    }
  }

  if (!conn.isAuthed) return;

  for (const type in msg) {
    switch(type) {
      case 'keepalive':
        // NOP - conn.lastActive is updated when receiving any valid message
        break;
      case 'start':
        start(conn, msg[type]);
        break;
      case 'stop':
        stop();
        break;
      case 'bitrate':
        if (isStreaming) {
          const br = setBitrate(msg[type]);
          if (br != null) {
            broadcastMsgExcept(conn, 'bitrate', {max_br: br});
          }
        }
        break;
      case 'command':
        command(conn, msg[type]);
        break;
      case 'netif':
        handleNetif(conn, msg[type]);
        break;
      case 'wifi':
        handleWifi(conn, msg[type]);
        break;
      case 'modems':
        handleModems(conn, msg[type]);
        break;
      case 'logout':
        if (conn.authToken) {
          delete tempTokens[conn.authToken];
          if (persistentTokens[conn.authToken]) {
            delete persistentTokens[conn.authToken];
            savePersistentTokens();
          }
        }
        delete conn.isAuthed;
        delete conn.authToken;

        break;
    }
  }

  conn.lastActive = getms();
}

function startHttpServer() {
  if (httpListenPorts.length == 0) {
    console.log('HTTP server: no more ports left to try. Exiting...');
    process.exit(1);
  }

  const port = httpListenPorts.shift();
  const desc = (typeof port == 'number') ? `port ${port}` : 'the systemd socket'
  console.log(`HTTP server: trying to start on ${desc}...`);
  server.listen(port);
}

wss.on('error', function(e) {
  if (e.code === 'EADDRINUSE') {
    console.log('HTTP server: port already in use, trying the next one...');
    startHttpServer();
  } else {
    console.log('HTTP server: error');
    console.log(e);
    process.exit(1);
  }
});

function getSystemdSocket() {
  if (!process.env.LISTEN_FDS) return;
  if (process.env.LISTEN_FDS !== "1") return;

  const firstSystemdSocketFd = 3;
  return {fd: firstSystemdSocketFd};
}

const httpListenPorts = [80, 8080, 81];
if (process.env.PORT) {
  httpListenPorts.unshift(process.env.PORT);
}
const systemdSock = getSystemdSocket();
if (systemdSock){
  httpListenPorts.unshift(systemdSock);
}
startHttpServer();
