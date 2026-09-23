const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

// EILOR library modules
const { analyzeChannels, detectEvilTwins } = require('./lib/analysis');
const { lookupVendor, isRandomMac } = require('./lib/oui');
const store = require('./lib/store');
const auth = require('./lib/auth');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || '127.0.0.1';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Database for Live RF Scan & Heatmap
let activeDevices = new Map(); // key: MAC / BSSID
let scanHistory = [];
let currentModeIndex = 0; // Default: Mode 0 (Wi-Fi Spectrum)

const MODES_DESC = [
  "Wi-Fi Spectrum",
  "BLE Radar Proximity",
  "SoftAP Hotspot",
  "Standby / Telemetry"
];

let esp32Connection = {
  connected: false,
  ip: null,
  lastSeen: null,
  totalPackets: 0,
  lastBatchCount: 0,
  currentMode: MODES_DESC[0],
  modeIndex: 0,
  deviceId: 'ESP32-EILOR',
  apActive: false,
  apSsid: 'EILOR-AP-HOTSPOT',
  apChannel: 6,
  analysis: {
    bestChannel: 11,
    worstChannel: 6,
    recommendedChannel: 11
  }
};

let channelHeatmap = {
  wifi: {
    1: { freq: 2412, count: 0, maxRssi: -100, avgRssi: -100, ssids: [] },
    2: { freq: 2417, count: 0, maxRssi: -100, avgRssi: -100, ssids: [] },
    3: { freq: 2422, count: 0, maxRssi: -100, avgRssi: -100, ssids: [] },
    4: { freq: 2427, count: 0, maxRssi: -100, avgRssi: -100, ssids: [] },
    5: { freq: 2432, count: 0, maxRssi: -100, avgRssi: -100, ssids: [] },
    6: { freq: 2437, count: 0, maxRssi: -100, avgRssi: -100, ssids: [] },
    7: { freq: 2442, count: 0, maxRssi: -100, avgRssi: -100, ssids: [] },
    8: { freq: 2447, count: 0, maxRssi: -100, avgRssi: -100, ssids: [] },
    9: { freq: 2452, count: 0, maxRssi: -100, avgRssi: -100, ssids: [] },
    10: { freq: 2457, count: 0, maxRssi: -100, avgRssi: -100, ssids: [] },
    11: { freq: 2462, count: 0, maxRssi: -100, avgRssi: -100, ssids: [] },
    12: { freq: 2467, count: 0, maxRssi: -100, avgRssi: -100, ssids: [] },
    13: { freq: 2472, count: 0, maxRssi: -100, avgRssi: -100, ssids: [] }
  },
  ble: {
    37: { freq: 2402, count: 0, maxRssi: -100, avgRssi: -100 },
    38: { freq: 2426, count: 0, maxRssi: -100, avgRssi: -100 },
    39: { freq: 2480, count: 0, maxRssi: -100, avgRssi: -100 }
  }
};

let totalPacketsReceived = 0;
let lastScanTimestamp = null;
let telemetryLogs = [];
let esp32WsSocket = null;
let timeseries = [];
let evilTwinMacs = new Set();
let packetsThisWindow = 0; // packets since last time-series sample
let registrations = []; // captive-portal guest sign-ups

// --- BOOTSTRAP: restore persisted state ---
(function bootstrap() {
  const persisted = store.loadDevices();
  totalPacketsReceived = persisted.totalPackets || 0;
  esp32Connection.totalPackets = totalPacketsReceived;
  persisted.devices.forEach(d => {
    if (d && d.mac) activeDevices.set(d.mac, d);
  });
  timeseries = store.loadTimeseries();
  registrations = store.loadRegistrations();
  if (persisted.devices.length || registrations.length) {
    console.log(`[STORE] Restaurados ${persisted.devices.length} dispositivos, ${timeseries.length} muestras temporales y ${registrations.length} registros de portal`);
  }
})();

// Normalize + validate a captive-portal guest registration
function buildRegistration(payload, source) {
  const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const nombre = clean(payload.nombre || payload.name || payload.n, 60);
  const apellido = clean(payload.apellido || payload.surname || payload.a, 60);
  const telefono = clean(payload.telefono || payload.phone || payload.tel || payload.t, 30);

  if (!nombre && !apellido && !telefono) return null; // ignore empty submissions

  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    nombre,
    apellido,
    telefono,
    apSsid: clean(payload.apSsid || esp32Connection.apSsid, 40),
    source: source || 'esp32',
    ts: Date.now()
  };
}

function recordRegistration(reg) {
  registrations.push(reg);
  if (registrations.length > store.MAX_REGISTRATIONS) {
    registrations = registrations.slice(-store.MAX_REGISTRATIONS);
  }
  store.saveRegistrations(registrations);
  addTelemetryLog('DATA', 'PORTAL-REG',
    `Nuevo registro de invitado: ${reg.nombre} ${reg.apellido} (${reg.telefono}) via "${reg.apSsid}"`);
  broadcast({ event: 'registration', registration: reg, totalRegistrations: registrations.length });
}

// Helper: Broadcast payload to all connected WebSocket clients
function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function addTelemetryLog(level, tag, message, raw = null) {
  const logItem = {
    id: Date.now() + Math.random().toString(36).substr(2, 4),
    timestamp: Date.now(),
    timeStr: new Date().toLocaleTimeString(),
    level, // 'INFO' | 'WARN' | 'DATA' | 'NET' | 'CMD'
    tag,
    message,
    raw
  };
  telemetryLogs.push(logItem);
  if (telemetryLogs.length > 200) {
    telemetryLogs.shift();
  }
  broadcast({ event: 'telemetry_log', log: logItem });
}

// Recalculate Heatmap Aggregation & Spectrum Analysis (delegated to lib/analysis)
function recalculateHeatmap() {
  for (let ch = 1; ch <= 13; ch++) {
    channelHeatmap.wifi[ch].count = 0;
    channelHeatmap.wifi[ch].maxRssi = -100;
    channelHeatmap.wifi[ch].avgRssi = -100;
    channelHeatmap.wifi[ch].ssids = [];
  }

  [37, 38, 39].forEach(ch => {
    channelHeatmap.ble[ch].count = 0;
    channelHeatmap.ble[ch].maxRssi = -100;
    channelHeatmap.ble[ch].avgRssi = -100;
  });

  const now = Date.now();
  const activeCutoff = now - 90000;

  activeDevices.forEach((dev) => {
    if (dev.lastSeen < activeCutoff) return;

    if ((dev.type === 'wifi' || dev.type === 'spectrum_wifi') && dev.channel >= 1 && dev.channel <= 13) {
      const ch = channelHeatmap.wifi[dev.channel];
      ch.count++;
      ch.ssids.push(dev.ssid || 'Hidden');
      if (dev.rssi > ch.maxRssi) ch.maxRssi = dev.rssi;
      ch.avgRssi = ch.avgRssi === -100 ? dev.rssi : Math.round((ch.avgRssi + dev.rssi) / 2);
    } else if (dev.type === 'ble') {
      const targetBleCh = [37, 38, 39][Math.abs(dev.mac.charCodeAt(0) || 0) % 3];
      const ch = channelHeatmap.ble[targetBleCh];
      ch.count++;
      if (dev.rssi > ch.maxRssi) ch.maxRssi = dev.rssi;
      ch.avgRssi = ch.avgRssi === -100 ? dev.rssi : Math.round((ch.avgRssi + dev.rssi) / 2);
    }
  });

  // Interference-aware channel analysis (adjacent-channel overlap + RSSI weighting)
  const result = analyzeChannels(channelHeatmap.wifi);
  esp32Connection.analysis = {
    bestChannel: result.bestChannel,
    worstChannel: result.worstChannel,
    recommendedChannel: result.recommendedChannel,
    scores: result.scores
  };

  // Flag same-SSID / multiple-BSSID access points ("evil twins")
  evilTwinMacs = detectEvilTwins(Array.from(activeDevices.values()));
}

// Attach vendor + risk annotations for a device snapshot going to clients
function annotateDevices(list) {
  return list.map(dev => ({
    ...dev,
    vendor: dev.vendor || lookupVendor(dev.mac),
    randomMac: dev.randomMac !== undefined ? dev.randomMac : isRandomMac(dev.mac),
    evilTwin: evilTwinMacs.has((dev.mac || '').toLowerCase())
  }));
}

// Ingestion Processor (Supports standard and ultra-compact keys)
function processIncomingScan(payload, clientIp = 'ESP32-WS') {
  const { type, devices, deviceId, mode, modeIndex, analysis, channels } = payload;
  if (!devices || !Array.isArray(devices)) return;

  const timestamp = Date.now();
  lastScanTimestamp = timestamp;
  totalPacketsReceived += devices.length;
  packetsThisWindow += devices.length;

  esp32Connection.connected = true;
  esp32Connection.ip = clientIp;
  esp32Connection.lastSeen = timestamp;
  esp32Connection.totalPackets += devices.length;
  esp32Connection.lastBatchCount = devices.length;
  if (deviceId) esp32Connection.deviceId = deviceId;
  if (mode) esp32Connection.currentMode = mode;
  if (modeIndex !== undefined) {
    esp32Connection.modeIndex = modeIndex;
    currentModeIndex = modeIndex;
  }

  // Parse devices supporting both verbose and compact keys (s, b, r, c, e)
  devices.forEach(item => {
    const ssid = item.ssid || item.s || item.name || item.n || 'Oculto';
    const mac = item.bssid || item.b || item.mac || item.m || `${type}-${ssid}-${Math.random().toString(36).substr(2,4)}`;
    const rssi = parseInt(item.rssi !== undefined ? item.rssi : item.r, 10) || -80;
    const channel = parseInt(item.channel !== undefined ? item.channel : item.c, 10) || (type === 'ble' ? 37 : 6);
    const enc = item.encryption || item.e || (type === 'ble' ? 'BLE Adv' : 'WPA2');

    const distanceEst = Math.pow(10, (-45 - rssi) / (10 * 2.4)).toFixed(1);

    const record = {
      mac: mac,
      type: (type === 'spectrum_wifi' || type === 'wifi') ? 'wifi' : 'ble',
      ssid: ssid,
      rssi: rssi,
      channel: channel,
      encryption: enc,
      distanceEst: parseFloat(distanceEst),
      vendor: lookupVendor(mac),
      randomMac: isRandomMac(mac),
      lastSeen: timestamp,
      sourceDevice: deviceId || 'ESP32-EILOR'
    };

    activeDevices.set(mac, record);
    scanHistory.push({ ...record, timestamp });
  });

  if (scanHistory.length > 500) {
    scanHistory = scanHistory.slice(-300);
  }

  recalculateHeatmap();

  // If the ESP32 provided its own calculated channel histogram, apply it directly
  if (channels && typeof channels === 'object') {
    Object.keys(channels).forEach(chNum => {
      const chInt = parseInt(chNum, 10);
      if (chInt >= 1 && chInt <= 13 && channelHeatmap.wifi[chInt]) {
        const chInfo = channels[chNum];
        if (chInfo.count !== undefined) channelHeatmap.wifi[chInt].count = chInfo.count;
        if (chInfo.maxRssi !== undefined) channelHeatmap.wifi[chInt].maxRssi = chInfo.maxRssi;
        if (chInfo.c !== undefined) channelHeatmap.wifi[chInt].count = chInfo.c;
        if (chInfo.r !== undefined) channelHeatmap.wifi[chInt].maxRssi = chInfo.r;
      }
    });
  }

  addTelemetryLog(
    'DATA',
    `ESP32 -> ${(type || 'SCAN').toUpperCase()}`,
    `Recibidos ${devices.length} dispositivos en tiempo real (${esp32Connection.currentMode})`
  );

  broadcast({
    event: 'scan_update',
    source: 'esp32_websocket',
    type: type,
    count: devices.length,
    timestamp: timestamp,
    esp32Connection,
    activeTotal: activeDevices.size,
    totalPackets: totalPacketsReceived,
    heatmap: channelHeatmap,
    latestBatch: annotateDevices(Array.from(activeDevices.values()))
  });
}

function dispatchModeChange(targetMode) {
  currentModeIndex = parseInt(targetMode, 10) % 4;
  esp32Connection.modeIndex = currentModeIndex;
  esp32Connection.currentMode = MODES_DESC[currentModeIndex];

  console.log(`[REMOTE] Despachando cambio a Modo ${currentModeIndex} (${MODES_DESC[currentModeIndex]})`);
  addTelemetryLog('CMD', 'PULSADOR-WEB', `Pulsador activado: Cambiar a Modo ${currentModeIndex} (${MODES_DESC[currentModeIndex]})`);

  const cmdPayload = JSON.stringify({
    action: 'set_mode',
    mode: currentModeIndex,
    modeName: MODES_DESC[currentModeIndex]
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(cmdPayload);
    }
  });

  broadcast({ event: 'esp32_status_change', esp32Connection });
}

function dispatchCreateAp(ssid, channel) {
  const targetSsid = ssid || 'EILOR-AP-CLONE';
  const targetCh = parseInt(channel, 10) || 6;

  esp32Connection.apActive = true;
  esp32Connection.apSsid = targetSsid;
  esp32Connection.apChannel = targetCh;
  esp32Connection.currentMode = MODES_DESC[2];
  esp32Connection.modeIndex = 2;
  currentModeIndex = 2;

  console.log(`[SOFTAP] Despachando creación de AP: "${targetSsid}" en Canal ${targetCh}`);
  addTelemetryLog('CMD', 'SOFTAP-DEPLOY', `Desplegando Punto de Acceso: "${targetSsid}" (Canal ${targetCh})`);

  const cmdPayload = JSON.stringify({
    action: 'create_ap',
    ssid: targetSsid,
    channel: targetCh
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(cmdPayload);
    }
  });

  broadcast({ event: 'esp32_status_change', esp32Connection });
}

// Watchdog: Check if ESP32 timed out (>15s without packets)
setInterval(() => {
  if (esp32Connection.connected && esp32Connection.lastSeen && Date.now() - esp32Connection.lastSeen > 15000) {
    esp32Connection.connected = false;
    addTelemetryLog('WARN', 'ESP32-WATCHDOG', 'ESP32 sin transmitir en los últimos 15s');
    broadcast({ event: 'esp32_status_change', esp32Connection });
  }
}, 3000);

// Time-series sampler: one rolling sample per minute (persisted via lib/store)
setInterval(() => {
  const now = Date.now();
  const activeCutoff = now - 90000;
  let wifi = 0, ble = 0, active = 0;
  activeDevices.forEach(dev => {
    if (dev.lastSeen < activeCutoff) return;
    active++;
    if (dev.type === 'ble') ble++; else wifi++;
  });

  const sample = {
    t: now,
    wifi,
    ble,
    active,
    packets: totalPacketsReceived,
    rate: packetsThisWindow // packets in the last minute
  };
  packetsThisWindow = 0;

  timeseries.push(sample);
  if (timeseries.length > store.MAX_TIMESERIES) {
    timeseries = timeseries.slice(-store.MAX_TIMESERIES);
  }
  store.saveTimeseries(timeseries);
  broadcast({ event: 'timeseries_sample', sample });
}, 60000);

// Periodic snapshot persistence (survives restarts / PM2 reloads)
setInterval(() => {
  store.saveDevices(Array.from(activeDevices.values()), totalPacketsReceived);
}, 30000);

// --- WEBSOCKET SERVER (PORT 3002) ---
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS-CONN] Nueva conexión desde ${clientIp}`);

  addTelemetryLog('NET', 'WS-SERVER', `Cliente conectado desde ${clientIp}`);

  ws.on('message', (message) => {
    try {
      // Safely convert Buffer or ArrayBuffer to UTF-8 string
      const msgStr = typeof message === 'string' ? message : message.toString('utf8');
      const data = JSON.parse(msgStr);

      // 1. Snapshot inicial SOLAMENTE si el cliente web lo solicita
      if (data.action === 'get_state' || data.action === 'init' || data.type === 'ui_connect') {
        ws.send(JSON.stringify({
          event: 'initial_state',
          serverPort: PORT,
          timestamp: Date.now(),
          esp32Connection,
          telemetryLogs,
          activeTotal: activeDevices.size,
          totalPackets: totalPacketsReceived,
          heatmap: channelHeatmap,
          timeseries,
          registrations,
          latestBatch: annotateDevices(Array.from(activeDevices.values()))
        }));
        return;
      }

      // Captive-portal guest registration relayed by the ESP32
      if (data.type === 'registration' || data.action === 'registration') {
        if (!auth.deviceAuthorized(data.token)) {
          addTelemetryLog('WARN', 'PORTAL-AUTH', `Registro rechazado desde ${clientIp}: token de dispositivo inválido`);
          return;
        }
        const reg = buildRegistration(data, 'esp32');
        if (reg) recordRegistration(reg);
        return;
      }

      // 2. Registro y Heartbeat del ESP32 (guarda ingestión opcional por token)
      if (data.action === 'register' || data.action === 'heartbeat') {
        if (!auth.deviceAuthorized(data.token)) {
          addTelemetryLog('WARN', 'ESP32-AUTH', `Registro rechazado desde ${clientIp}: token de dispositivo inválido`);
          return;
        }
        esp32WsSocket = ws;
        esp32Connection.connected = true;
        esp32Connection.ip = clientIp;
        esp32Connection.lastSeen = Date.now();
        esp32Connection.deviceId = data.deviceId || 'ESP32-EILOR';
        if (data.mode) esp32Connection.currentMode = data.mode;
        if (data.modeIndex !== undefined) {
          esp32Connection.modeIndex = data.modeIndex;
          currentModeIndex = data.modeIndex;
        }
        if (data.apActive !== undefined) esp32Connection.apActive = data.apActive;
        if (data.apSsid) esp32Connection.apSsid = data.apSsid;
        if (data.apChannel) esp32Connection.apChannel = data.apChannel;

        addTelemetryLog('INFO', 'ESP32-STATUS', `Heartbeat recibido (${data.deviceId}) - Modo: ${esp32Connection.currentMode}`);
        broadcast({ event: 'esp32_status_change', esp32Connection });
      }
      // 3. Recepción de escaneos Wi-Fi / BLE del ESP32
      else if (data.type === 'spectrum_wifi' || data.type === 'wifi' || data.type === 'ble' || data.devices) {
        if (!auth.deviceAuthorized(data.token)) {
          addTelemetryLog('WARN', 'ESP32-AUTH', `Escaneo rechazado desde ${clientIp}: token de dispositivo inválido`);
          return;
        }
        esp32WsSocket = ws;
        processIncomingScan(data, clientIp);
      }
      // 4. Comando: Cambio de Modo desde la Web UI (0 a 3) — requiere sesión válida
      else if (data.action === 'set_mode' || data.action === 'toggle_mode') {
        if (!auth.isValidToken(data.token)) {
          ws.send(JSON.stringify({ event: 'auth_error', message: 'Sesión requerida para enviar comandos' }));
          return;
        }
        let newMode = data.mode;
        if (data.action === 'toggle_mode') {
          newMode = (currentModeIndex + 1) % 4;
        }
        dispatchModeChange(newMode);
      }
      // 5. Comando: Crear Punto de Acceso SoftAP desde la Web UI — requiere sesión válida
      else if (data.action === 'create_ap') {
        if (!auth.isValidToken(data.token)) {
          ws.send(JSON.stringify({ event: 'auth_error', message: 'Sesión requerida para desplegar SoftAP' }));
          return;
        }
        dispatchCreateAp(data.ssid, data.channel);
      }
      else if (data.action === 'ping') {
        ws.send(JSON.stringify({ event: 'pong', timestamp: Date.now() }));
      }
    } catch (err) {
      addTelemetryLog('WARN', 'WS-ERROR', `Trama no JSON o fragmentada: ${err.message}`);
    }
  });

  ws.on('close', () => {
    if (ws === esp32WsSocket) {
      esp32WsSocket = null;
      esp32Connection.connected = false;
      addTelemetryLog('WARN', 'ESP32-DISCONN', 'Socket de hardware ESP32 cerrado');
      broadcast({ event: 'esp32_status_change', esp32Connection });
    }
  });
});

// --- AUTH ENDPOINTS ---
app.post('/api/login', (req, res) => {
  const token = auth.login(req.body && req.body.password);
  if (!token) return res.status(401).json({ error: 'Contraseña incorrecta' });
  addTelemetryLog('INFO', 'AUTH', 'Sesión web iniciada correctamente');
  res.json({ status: 'success', token, usingDefaultPassword: auth.usingDefaultPassword() });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-eilor-token'] || (req.body && req.body.token);
  auth.logout(token);
  res.json({ status: 'success' });
});

app.get('/api/session', (req, res) => {
  const token = req.headers['x-eilor-token'] || req.query.token;
  res.json({ valid: auth.isValidToken(token), usingDefaultPassword: auth.usingDefaultPassword() });
});

// --- REST API ENDPOINTS ---
// Ingestion: guarded by optional device token
app.post('/api/scan', (req, res) => {
  if (!auth.deviceAuthorized(req.body && req.body.token)) {
    return res.status(401).json({ error: 'Token de dispositivo inválido' });
  }
  processIncomingScan(req.body, req.ip);
  res.json({
    status: 'success',
    received: req.body.devices ? req.body.devices.length : 0,
    activeTotal: activeDevices.size,
    timestamp: Date.now()
  });
});

// Control routes require a valid web session
app.post('/api/mode', auth.requireAuth, (req, res) => {
  const { mode } = req.body;
  if (mode !== undefined && mode >= 0 && mode <= 3) {
    dispatchModeChange(mode);
    return res.json({ status: 'success', mode: currentModeIndex, modeName: MODES_DESC[currentModeIndex] });
  }
  res.status(400).json({ error: 'Modo inválido (0 a 3)' });
});

app.post('/api/ap', auth.requireAuth, (req, res) => {
  const { ssid, channel } = req.body;
  if (ssid) {
    dispatchCreateAp(ssid, channel || 6);
    return res.json({ status: 'success', ssid, channel: channel || 6 });
  }
  res.status(400).json({ error: 'SSID requerido' });
});

app.get('/api/scan', (req, res) => {
  res.json({
    status: 'online',
    esp32Connection,
    totalDevices: activeDevices.size,
    totalPacketsReceived,
    lastScanTimestamp,
    devices: annotateDevices(Array.from(activeDevices.values()))
  });
});

app.get('/api/heatmap', (req, res) => {
  recalculateHeatmap();
  res.json({
    status: 'success',
    timestamp: Date.now(),
    esp32Connection,
    heatmap: channelHeatmap
  });
});

app.get('/api/timeseries', (req, res) => {
  res.json({ status: 'success', timeseries });
});

// Captive-portal registrations
// Direct submit path (used by the ESP32 portal over HTTP, or for testing) — device-guarded
app.post('/api/registration', (req, res) => {
  if (!auth.deviceAuthorized(req.body && req.body.token)) {
    return res.status(401).json({ error: 'Token de dispositivo inválido' });
  }
  const reg = buildRegistration(req.body || {}, req.body && req.body.source ? req.body.source : 'http');
  if (!reg) return res.status(400).json({ error: 'Registro vacío (nombre, apellido o teléfono requerido)' });
  recordRegistration(reg);
  res.json({ status: 'success', id: reg.id, totalRegistrations: registrations.length });
});

// Owner-only views (require a valid web session)
app.get('/api/registrations', auth.requireAuth, (req, res) => {
  res.json({ status: 'success', total: registrations.length, registrations });
});

app.get('/api/registrations.csv', auth.requireAuth, (req, res) => {
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = [['fecha', 'nombre', 'apellido', 'telefono', 'red_ssid']];
  registrations.forEach(r => rows.push([new Date(r.ts).toISOString(), r.nombre, r.apellido, r.telefono, r.apSsid]));
  const csv = rows.map(cols => cols.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="eilor-registros.csv"');
  res.send('﻿' + csv); // BOM for Excel/UTF-8
});

app.post('/api/registrations/clear', auth.requireAuth, (req, res) => {
  registrations = [];
  store.saveRegistrations(registrations);
  addTelemetryLog('INFO', 'PORTAL-REG', 'Registros de invitados borrados por el usuario');
  broadcast({ event: 'registrations_cleared', totalRegistrations: 0 });
  res.json({ status: 'cleared' });
});

app.post('/api/clear', auth.requireAuth, (req, res) => {
  activeDevices.clear();
  scanHistory = [];
  telemetryLogs = [];
  evilTwinMacs = new Set();
  recalculateHeatmap();
  store.saveDevices([], totalPacketsReceived);
  addTelemetryLog('INFO', 'SYS-RESET', 'Historial y registros reiniciados por el usuario');
  broadcast({ event: 'clear', timestamp: Date.now(), heatmap: channelHeatmap, latestBatch: [] });
  res.json({ status: 'cleared' });
});

// Persist on graceful shutdown
function persistAndExit() {
  store.saveDevices(Array.from(activeDevices.values()), totalPacketsReceived);
  store.saveTimeseries(timeseries);
  store.saveRegistrations(registrations);
  console.log('\n[STORE] Estado persistido. Cerrando EILOR.');
  process.exit(0);
}
process.on('SIGINT', persistAndExit);
process.on('SIGTERM', persistAndExit);

server.listen(PORT, HOST, () => {
  console.log(`\n=============================================================`);
  console.log(`📡 EILOR ESP32 WEBSOCKET & RF HEATMAP SERVER LISTENING`);
  console.log(`🌐 Web UI Dashboard:   http://localhost:${PORT}`);
  console.log(`⚡ WebSocket Stream:   ws://${HOST}:${PORT}`);
  console.log(`🔌 ESP32 Ingestion:    ws://<TU_IP_PC>:${PORT}`);
  if (auth.usingDefaultPassword()) {
    console.log(`⚠️  Usando contraseña por defecto. Configura EILOR_PASSWORD en producción.`);
  }
  if (!auth.DEVICE_TOKEN) {
    console.log(`⚠️  Ingestión ESP32 abierta. Configura EILOR_DEVICE_TOKEN para restringirla.`);
  }
  console.log(`=============================================================\n`);
});
