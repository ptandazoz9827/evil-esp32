/**
 * EILOR RF SCANNER & SPECTRUM SUITE — REAL-TIME CLIENT & CONTROLLER
 */

// State
const state = {
  devices: [],
  heatmap: null,
  activeFilter: 'all', // 'all' | 'wifi' | 'ble'
  searchQuery: '',
  wsConnected: false,
  esp32Connected: false,
  currentModeIndex: 0,
  currentModeName: 'Wi-Fi Spectrum',
  apActive: false,
  apSsid: 'EILOR-AP-CLONE',
  apChannel: 6,
  analysis: {
    bestChannel: 11,
    worstChannel: 6,
    recommendedChannel: 11
  },
  totalPackets: 0,
  packetCountLastSec: 0,
  autoScroll: true,
  timeseries: [],
  registrations: [],
  authToken: null,
  authenticated: false
};

let ws = null;

// --- SESSION / AUTH ---
const TOKEN_KEY = 'eilor_token';

function loadStoredToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
}
function storeToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch (_) {}
}

function authHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (state.authToken) h['X-Eilor-Token'] = state.authToken;
  return h;
}

// Attach the current session token to an outgoing WS control payload
function withToken(payload) {
  return state.authToken ? { ...payload, token: state.authToken } : payload;
}

async function verifySession() {
  const token = loadStoredToken();
  if (!token) { setAuthenticated(false); return; }
  state.authToken = token;
  try {
    const res = await fetch(`/api/session?token=${encodeURIComponent(token)}`);
    const data = await res.json();
    setAuthenticated(!!data.valid);
    if (!data.valid) { storeToken(null); state.authToken = null; }
  } catch (_) {
    setAuthenticated(false);
  }
}

function setAuthenticated(isAuth) {
  state.authenticated = isAuth;
  const label = document.getElementById('sessionBtnLabel');
  const btn = document.getElementById('sessionBtn');
  if (label) label.textContent = isAuth ? 'Cerrar Sesión' : 'Iniciar Sesión';
  if (btn) btn.classList.toggle('is-authed', isAuth);
  document.body.classList.toggle('read-only', !isAuth);
}

function showLogin() {
  const overlay = document.getElementById('loginOverlay');
  const err = document.getElementById('loginError');
  if (err) err.hidden = true;
  if (overlay) overlay.hidden = false;
  const input = document.getElementById('loginPasswordInput');
  if (input) { input.value = ''; input.focus(); }
}

function dismissLogin() {
  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.hidden = true;
}

async function submitLogin() {
  const input = document.getElementById('loginPasswordInput');
  const err = document.getElementById('loginError');
  const password = input ? input.value : '';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok || !data.token) {
      if (err) { err.textContent = data.error || 'Contraseña incorrecta'; err.hidden = false; }
      return;
    }
    state.authToken = data.token;
    storeToken(data.token);
    setAuthenticated(true);
    dismissLogin();
    appendTerminalLog('INFO', 'AUTH', 'Sesión iniciada. Controles habilitados.');
    if (data.usingDefaultPassword) {
      appendTerminalLog('WARN', 'AUTH', 'Servidor usando contraseña por defecto (configura EILOR_PASSWORD).');
    }
  } catch (e) {
    if (err) { err.textContent = 'Error de red al iniciar sesión'; err.hidden = false; }
  }
}

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST', headers: authHeaders() });
  } catch (_) {}
  storeToken(null);
  state.authToken = null;
  setAuthenticated(false);
  appendTerminalLog('INFO', 'AUTH', 'Sesión cerrada. Modo solo lectura.');
}

function handleSessionButton() {
  if (state.authenticated) logout();
  else showLogin();
}

// Guard control actions behind an active session
function requireSession() {
  if (state.authenticated && state.authToken) return true;
  showLogin();
  return false;
}

const MODES_DESC = [
  "Wi-Fi Spectrum",
  "BLE Radar Proximity",
  "SoftAP Hotspot",
  "Standby / Telemetry"
];

// Wi-Fi Channel Frequencies (Channels 1 to 13)
const WIFI_FREQS = {
  1: 2412, 2: 2417, 3: 2422, 4: 2427, 5: 2432, 6: 2437, 7: 2442,
  8: 2447, 9: 2452, 10: 2457, 11: 2462, 12: 2467, 13: 2472
};

document.addEventListener('DOMContentLoaded', () => {
  initSpectrumStructure();
  verifySession();
  initWebSocket();
  startClockTicker();
  startPacketRateMeter();

  // Submit login on Enter within the password field
  const pwInput = document.getElementById('loginPasswordInput');
  if (pwInput) {
    pwInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitLogin(); }
    });
  }

  renderSparkline();
  renderRegistrations();
  window.addEventListener('resize', renderSparkline);

  const csvBtn = document.getElementById('btnExportCsv');
  if (csvBtn) csvBtn.addEventListener('click', exportRegistrationsCsv);

  lucide.createIcons();
});

// Initialize 13 Wi-Fi Channel Bars & 3 BLE Channels in DOM
function initSpectrumStructure() {
  const wifiContainer = document.getElementById('wifiSpectrumContainer');
  if (wifiContainer) {
    let html = '';
    for (let ch = 1; ch <= 13; ch++) {
      html += `
        <div class="channel-column" id="wifi-col-${ch}">
          <span class="channel-count-tag" id="ch-count-${ch}">0</span>
          <div class="channel-bar-track">
            <div class="channel-bar-fill cold-bar" id="ch-bar-${ch}" style="height: 4%;"></div>
          </div>
          <span class="channel-lbl">CH ${ch}</span>
          <span class="channel-freq">${WIFI_FREQS[ch]}</span>
        </div>
      `;
    }
    wifiContainer.innerHTML = html;
  }

  const bleContainer = document.getElementById('bleSpectrumContainer');
  if (bleContainer) {
    const bleChannels = [
      { ch: 37, freq: 2402 },
      { ch: 38, freq: 2426 },
      { ch: 39, freq: 2480 }
    ];
    bleContainer.innerHTML = bleChannels.map(b => `
      <div class="ble-channel-card" id="ble-card-${b.ch}">
        <span class="ble-ch-name">ADV ${b.ch} (${b.freq}MHz)</span>
        <span class="ble-ch-val" id="ble-count-${b.ch}">0 dev</span>
      </div>
    `).join('');
  }
}

// WebSocket Connection Management
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host || 'localhost:3002';
  const wsUrl = `${protocol}//${host}`;

  const wsBeacon = document.getElementById('wsBeacon');

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      state.wsConnected = true;
      if (wsBeacon) wsBeacon.className = 'live-beacon beacon-active';
      appendTerminalLog('NET', 'WS-CLIENT', `Conectado al servidor WebSocket ${wsUrl}`);
      // Solicitar el estado inicial completo al conectar
      ws.send(JSON.stringify({ action: 'get_state' }));
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleServerPayload(payload);
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    };

    ws.onclose = () => {
      state.wsConnected = false;
      if (wsBeacon) wsBeacon.className = 'live-beacon beacon-error';
      appendTerminalLog('WARN', 'WS-CLIENT', 'Conexión WebSocket cerrada. Reintentando en 2.5s...');
      setTimeout(initWebSocket, 2500);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      ws.close();
    };
  } catch (e) {
    console.error('[WS] Connection failed:', e);
    setTimeout(initWebSocket, 3000);
  }
}

// Handle Ingested Server Payload
function handleServerPayload(data) {
  if (data.esp32Connection) {
    updateEsp32Status(data.esp32Connection);
  }

  if (data.event === 'telemetry_log' && data.log) {
    renderSingleLog(data.log);
  }

  if (data.event === 'remote_mode_command' || data.action === 'set_mode') {
    updateActiveModeUI(data.mode, data.modeName);
  }

  if (data.event === 'initial_state') {
    if (data.telemetryLogs) {
      data.telemetryLogs.forEach(renderSingleLog);
    }
    if (Array.isArray(data.timeseries)) {
      state.timeseries = data.timeseries;
      renderSparkline();
    }
    if (Array.isArray(data.registrations)) {
      state.registrations = data.registrations;
      renderRegistrations();
    }
  }

  if (data.event === 'registration' && data.registration) {
    state.registrations.push(data.registration);
    renderRegistrations();
    appendTerminalLog('DATA', 'PORTAL-REG', `Nuevo invitado: ${data.registration.nombre} ${data.registration.apellido}`);
  }

  if (data.event === 'registrations_cleared') {
    state.registrations = [];
    renderRegistrations();
  }

  if (data.event === 'auth_error') {
    appendTerminalLog('WARN', 'AUTH', data.message || 'Comando rechazado: sesión requerida');
    setAuthenticated(false);
    storeToken(null);
    state.authToken = null;
    showLogin();
    return;
  }

  if (data.event === 'timeseries_sample' && data.sample) {
    state.timeseries.push(data.sample);
    if (state.timeseries.length > 720) state.timeseries = state.timeseries.slice(-720);
    renderSparkline();
  }

  if (data.event === 'initial_state' || data.event === 'scan_update') {
    if (data.latestBatch) {
      state.devices = data.latestBatch;
    }
    if (data.heatmap) {
      state.heatmap = data.heatmap;
      renderHeatmap(data.heatmap);
    }
    if (data.totalPackets !== undefined) {
      state.totalPackets = data.totalPackets;
      state.packetCountLastSec += (data.count || 1);
      const pktEl = document.getElementById('totalPacketsCount');
      if (pktEl) pktEl.textContent = state.totalPackets.toLocaleString();
    }
    if (data.activeTotal !== undefined) {
      const actEl = document.getElementById('totalActiveCount');
      if (actEl) actEl.textContent = data.activeTotal;
    }

    renderDevicesTable();
    renderRadarBlips();
    updateCounters();
  } else if (data.event === 'esp32_status_change') {
    updateEsp32Status(data.esp32Connection);
  } else if (data.event === 'clear') {
    state.devices = [];
    state.heatmap = data.heatmap;
    renderHeatmap(data.heatmap);
    renderDevicesTable();
    renderRadarBlips();
    updateCounters();
  }
}

// Update ESP32 Status Pill in Header
function updateEsp32Status(conn) {
  const textEl = document.getElementById('esp32StatusText');
  const beaconEl = document.getElementById('esp32Beacon');

  if (conn.connected) {
    state.esp32Connected = true;
    if (textEl) textEl.textContent = `ESP32: EN LÍNEA (${conn.lastBatchCount || 0} dev/rafaga)`;
    if (beaconEl) beaconEl.className = 'live-beacon beacon-active';
  } else {
    state.esp32Connected = false;
    if (textEl) textEl.textContent = 'ESP32: DESCONECTADO';
    if (beaconEl) beaconEl.className = 'live-beacon beacon-offline';
  }

  if (conn.currentMode || conn.modeIndex !== undefined) {
    const idx = conn.modeIndex !== undefined ? conn.modeIndex : MODES_DESC.indexOf(conn.currentMode);
    updateActiveModeUI(idx >= 0 ? idx : 0, conn.currentMode);
  }

  // SoftAP status
  if (conn.apActive !== undefined) {
    state.apActive = conn.apActive;
    state.apSsid = conn.apSsid || state.apSsid;
    state.apChannel = conn.apChannel || state.apChannel;

    const apBadge = document.getElementById('apStatusBadge');
    const apBeacon = document.getElementById('apBeacon');
    const apText = document.getElementById('apStatusText');

    if (state.apActive) {
      if (apBeacon) apBeacon.className = 'live-beacon beacon-active';
      if (apText) apText.textContent = `AP ACTIVO: "${state.apSsid}" (CH ${state.apChannel})`;
      if (apBadge) apBadge.style.borderColor = 'var(--neon-emerald)';
    } else {
      if (apBeacon) apBeacon.className = 'live-beacon beacon-offline';
      if (apText) apText.textContent = 'AP: INACTIVO';
      if (apBadge) apBadge.style.borderColor = 'rgba(255, 255, 255, 0.1)';
    }
  }

  // Analysis Recommendation Badges
  if (conn.analysis) {
    state.analysis = conn.analysis;
    const bestEl = document.getElementById('bestChannelTag');
    const worstEl = document.getElementById('worstChannelTag');
    const recEl = document.getElementById('recommendedChannelTag');
    if (bestEl) bestEl.textContent = `CH ${conn.analysis.bestChannel || 11}`;
    if (worstEl) worstEl.textContent = `CH ${conn.analysis.worstChannel || 6}`;
    if (recEl) recEl.textContent = `CH ${conn.analysis.recommendedChannel || conn.analysis.bestChannel || 11}`;
  }
}

// Update Mode UI Highlight (0 to 3)
function updateActiveModeUI(modeIdx, modeName) {
  state.currentModeIndex = parseInt(modeIdx, 10);
  state.currentModeName = modeName || MODES_DESC[state.currentModeIndex] || `Modo ${state.currentModeIndex}`;

  const modeDisplay = document.getElementById('activeModeDisplay');
  if (modeDisplay) modeDisplay.textContent = state.currentModeName;

  for (let i = 0; i < 4; i++) {
    const btn = document.getElementById(`btnMode${i}`);
    if (btn) {
      btn.classList.toggle('active-mode', i === state.currentModeIndex);
    }
  }
}

// Remote Control Functions (Virtual Pulsador)
function remoteSetMode(modeIdx) {
  if (!requireSession()) return;
  const targetMode = parseInt(modeIdx, 10);
  updateActiveModeUI(targetMode, MODES_DESC[targetMode]);
  appendTerminalLog('CMD', 'PULSADOR-WEB', `Pulsador activado: Cambiar a Modo ${targetMode} (${MODES_DESC[targetMode]})`);

  const payload = withToken({ action: 'set_mode', mode: targetMode });

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }

  fetch('/api/mode', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ mode: targetMode })
  }).catch(e => console.error('Mode API Error:', e));
}

function remoteToggleMode() {
  const nextMode = (state.currentModeIndex + 1) % 4;
  remoteSetMode(nextMode);
}

// SoftAP Manual Deployment
function deployManualSoftAp() {
  const ssidInput = document.getElementById('apSsidInput');
  const chSelect = document.getElementById('apChannelSelect');

  const ssid = (ssidInput?.value || 'EILOR-AP-CLONE').trim();
  const channel = parseInt(chSelect?.value || '6', 10);

  deploySoftAp(ssid, channel);
}

function deploySoftAp(ssid, channel) {
  if (!requireSession()) return;
  appendTerminalLog('CMD', 'SOFTAP-DISPATCH', `Desplegando Punto de Acceso SoftAP: "${ssid}" en Canal ${channel}`);

  const payload = withToken({ action: 'create_ap', ssid, channel });

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }

  fetch('/api/ap', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ ssid, channel })
  }).catch(e => console.error('AP API Error:', e));
}

// Quick Clone AP from table row
function cloneApFromRow(ssid, channel) {
  const ssidInput = document.getElementById('apSsidInput');
  const chSelect = document.getElementById('apChannelSelect');

  if (ssidInput) ssidInput.value = ssid;
  if (chSelect) chSelect.value = channel;

  deploySoftAp(ssid, channel);
}

// Render Wi-Fi (1-13) & BLE Spectrum Heatmap Bars
function renderHeatmap(heatmap) {
  if (!heatmap) return;

  if (heatmap.wifi) {
    for (let ch = 1; ch <= 13; ch++) {
      const channelData = heatmap.wifi[ch];
      const barEl = document.getElementById(`ch-bar-${ch}`);
      const countEl = document.getElementById(`ch-count-${ch}`);

      if (channelData && barEl) {
        const count = channelData.count || 0;
        const maxRssi = channelData.maxRssi || -100;

        if (countEl) {
          countEl.textContent = count > 0 ? `${count}` : '0';
          countEl.style.color = count > 0 ? '#00E5FF' : 'var(--text-dim)';
        }

        let heightPct = 5;
        if (count > 0) {
          const countWeight = Math.min(1.0, count / 6);
          const rssiWeight = Math.max(0.1, Math.min(1.0, (maxRssi + 95) / 55));
          heightPct = Math.round(Math.max(18, (countWeight * 0.7 + rssiWeight * 0.3) * 100));
        }

        barEl.style.height = `${heightPct}%`;

        barEl.className = 'channel-bar-fill';
        if (maxRssi >= -55 || count >= 4) {
          barEl.classList.add('hot-bar');
        } else if (maxRssi >= -70 || count >= 2) {
          barEl.classList.add('med-bar');
        } else {
          barEl.classList.add('cold-bar');
        }
      }
    }
  }

  if (heatmap.ble) {
    [37, 38, 39].forEach(ch => {
      const bleData = heatmap.ble[ch];
      const countEl = document.getElementById(`ble-count-${ch}`);
      if (bleData && countEl) {
        countEl.textContent = `${bleData.count || 0} dev (${bleData.maxRssi > -100 ? bleData.maxRssi + ' dBm' : 'Idle'})`;
      }
    });
  }
}

// Render Circular Radar Blips
function renderRadarBlips() {
  const container = document.getElementById('radarBlipsLayer');
  if (!container) return;

  const width = container.clientWidth || 300;
  const height = container.clientHeight || 300;
  const centerX = width / 2;
  const centerY = height / 2;
  const maxRadius = Math.min(centerX, centerY) - 16;

  container.innerHTML = state.devices.map((dev) => {
    let hash = 0;
    for (let i = 0; i < dev.mac.length; i++) {
      hash = (hash * 31 + dev.mac.charCodeAt(i)) % 360;
    }
    const angleRad = (hash * Math.PI) / 180;

    const normalizedDist = Math.min(1, Math.max(0.1, dev.distanceEst / 25));
    const radius = normalizedDist * maxRadius;

    const x = centerX + radius * Math.cos(angleRad);
    const y = centerY + radius * Math.sin(angleRad);

    const blipClass = dev.type === 'ble' ? 'blip-ble' : 'blip-wifi';

    return `
      <div class="radar-blip ${blipClass}" 
           style="left: ${x}px; top: ${y}px;" 
           title="${dev.ssid} (${dev.rssi} dBm - ${dev.distanceEst}m)"
           onclick="focusDeviceRow('${dev.mac}')">
      </div>
    `;
  }).join('');
}

// Render Devices Table with Clone AP action
function renderDevicesTable() {
  const tbody = document.getElementById('deviceTableBody');
  if (!tbody) return;

  let filtered = state.devices;

  if (state.activeFilter !== 'all') {
    filtered = filtered.filter(d => d.type === state.activeFilter);
  }

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    filtered = filtered.filter(d => 
      d.ssid.toLowerCase().includes(q) || 
      d.mac.toLowerCase().includes(q)
    );
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-table-state">
          <div class="empty-wrap">
            <i data-lucide="radio-tower" class="icon-32"></i>
            <p>${state.devices.length === 0 ? 'Esperando telemetría en tiempo real desde el ESP32...' : 'No hay dispositivos con los filtros seleccionados.'}</p>
          </div>
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }

  tbody.innerHTML = filtered.map(dev => {
    const isWifi = dev.type === 'wifi' || dev.type === 'spectrum_wifi';
    const chipClass = isWifi ? 'chip-wifi' : 'chip-ble';
    const typeLabel = isWifi ? 'Wi-Fi 2.4G' : 'BLE Beacon';
    const typeIcon = isWifi ? 'wifi' : 'bluetooth';

    const rssiVal = dev.rssi || -80;
    const rssiPercent = Math.max(5, Math.min(100, (rssiVal + 100) * 1.5));
    let rssiColorClass = 'rssi-weak';
    if (rssiVal >= -60) rssiColorClass = 'rssi-strong';
    else if (rssiVal >= -75) rssiColorClass = 'rssi-moderate';

    // Action button
    const actionHtml = isWifi
      ? `<button class="btn-clone-ap" onclick="cloneApFromRow('${escapeHtml(dev.ssid)}', ${dev.channel})"><i data-lucide="copy" class="icon-12"></i> Crear AP</button>`
      : `<span class="text-dim">--</span>`;

    // Evil-twin flag (same SSID advertised by multiple BSSIDs)
    const evilTwinBadge = dev.evilTwin
      ? `<span class="badge-evil-twin" title="SSID duplicado en múltiples BSSID (posible gemelo malicioso)"><i data-lucide="alert-octagon" class="icon-12"></i> Gemelo</span>`
      : '';

    // Vendor via OUI lookup; flag privacy-randomized MACs
    const vendor = dev.vendor || 'Desconocido';
    const vendorHtml = dev.randomMac
      ? `<span class="vendor-cell vendor-random">${escapeHtml(vendor)}</span>`
      : `<span class="vendor-cell">${escapeHtml(vendor)}</span>`;

    return `
      <tr id="row-${dev.mac}" class="${dev.evilTwin ? 'row-evil-twin' : ''}">
        <td>
          <span class="chip-type ${chipClass}">
            <i data-lucide="${typeIcon}" class="icon-12"></i> ${typeLabel}
          </span>
        </td>
        <td><strong>${escapeHtml(dev.ssid)}</strong> ${evilTwinBadge}</td>
        <td><code>${dev.mac}</code></td>
        <td>${vendorHtml}</td>
        <td><span class="badge-port">CH ${dev.channel}</span></td>
        <td>
          <div class="rssi-meter-box">
            <div class="rssi-bar-bg">
              <div class="rssi-bar-level ${rssiColorClass}" style="width: ${rssiPercent}%;"></div>
            </div>
            <strong>${dev.rssi} dBm</strong>
          </div>
        </td>
        <td>~${dev.distanceEst} m</td>
        <td><small class="text-dim">${dev.encryption}</small></td>
        <td>${actionHtml}</td>
      </tr>
    `;
  }).join('');

  lucide.createIcons();
}

// Render mini time-series sparkline (active devices + packets/min)
function renderSparkline() {
  const canvas = document.getElementById('timeseriesSparkline');
  if (!canvas) return;

  // Size the backing store to the CSS box for crisp lines on HiDPI
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  const cssH = canvas.clientHeight || 60;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const data = state.timeseries;
  const winEl = document.getElementById('sparklineWindow');

  if (!data || data.length < 2) {
    if (winEl) winEl.textContent = 'esperando muestras (1/min)…';
    ctx.fillStyle = 'rgba(132, 150, 179, 0.4)';
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.fillText('Sin histórico todavía', 8, cssH / 2 + 4);
    return;
  }

  const pad = 4;
  const w = cssW - pad * 2;
  const h = cssH - pad * 2;

  const maxActive = Math.max(1, ...data.map(d => d.active || 0));
  const maxRate = Math.max(1, ...data.map(d => d.rate || 0));

  function drawSeries(key, max, stroke, fill) {
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = pad + (i / (data.length - 1)) * w;
      const y = pad + h - ((d[key] || 0) / max) * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();
    // subtle area fill
    ctx.lineTo(pad + w, pad + h);
    ctx.lineTo(pad, pad + h);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  drawSeries('rate', maxRate, 'rgba(0, 229, 255, 0.9)', 'rgba(0, 229, 255, 0.08)');
  drawSeries('active', maxActive, 'rgba(0, 255, 157, 0.9)', 'rgba(0, 255, 157, 0.08)');

  if (winEl) {
    const spanMin = Math.round((data[data.length - 1].t - data[0].t) / 60000);
    const last = data[data.length - 1];
    winEl.textContent = `últimos ~${spanMin || 0} min · ${last.active} activos · ${last.rate} paq/min`;
  }
}

// Render captive-portal guest registrations table
function renderRegistrations() {
  const tbody = document.getElementById('registrationsTableBody');
  const countEl = document.getElementById('totalRegistrationsCount');
  if (countEl) countEl.textContent = state.registrations.length;
  if (!tbody) return;

  if (!state.registrations.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-table-state">
          <div class="empty-wrap">
            <i data-lucide="clipboard-list" class="icon-32"></i>
            <p>Aún no hay registros. Aparecerán aquí cuando alguien complete el formulario del portal.</p>
          </div>
        </td>
      </tr>`;
    lucide.createIcons();
    return;
  }

  // Newest first
  const rows = [...state.registrations].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  tbody.innerHTML = rows.map(r => {
    const when = r.ts ? new Date(r.ts).toLocaleString() : '--';
    return `
      <tr>
        <td><small class="text-dim">${escapeHtml(when)}</small></td>
        <td><strong>${escapeHtml(r.nombre || '')}</strong></td>
        <td>${escapeHtml(r.apellido || '')}</td>
        <td><code>${escapeHtml(r.telefono || '')}</code></td>
        <td><span class="badge-port">${escapeHtml(r.apSsid || '--')}</span></td>
      </tr>`;
  }).join('');
  lucide.createIcons();
}

// Download registrations CSV (auth-aware: sends session token as a query param)
function exportRegistrationsCsv(ev) {
  if (ev) ev.preventDefault();
  if (!requireSession()) return;
  const url = `/api/registrations.csv?token=${encodeURIComponent(state.authToken)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = 'eilor-registros.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Clear all registrations (owner action)
async function clearRegistrations() {
  if (!requireSession()) return;
  if (!confirm('¿Borrar TODOS los registros de invitados? Esta acción no se puede deshacer.')) return;
  try {
    const res = await fetch('/api/registrations/clear', { method: 'POST', headers: authHeaders() });
    if (res.status === 401) { appendTerminalLog('WARN', 'AUTH', 'Sesión requerida para borrar registros'); showLogin(); return; }
    state.registrations = [];
    renderRegistrations();
  } catch (err) {
    console.error('Clear registrations error:', err);
  }
}

// Telemetry Terminal Log Appender
function appendTerminalLog(level, tag, message) {
  renderSingleLog({
    timeStr: new Date().toLocaleTimeString(),
    level,
    tag,
    message
  });
}

function renderSingleLog(log) {
  const box = document.getElementById('terminalLogBox');
  if (!box) return;

  const line = document.createElement('div');
  line.className = 'terminal-line';

  let tagClass = 'tag-sys';
  if (log.level === 'DATA') tagClass = 'tag-data';
  else if (log.level === 'NET') tagClass = 'tag-net';
  else if (log.level === 'CMD') tagClass = 'tag-cmd';
  else if (log.level === 'WARN') tagClass = 'tag-warn';

  line.innerHTML = `
    <span class="log-time">[${log.timeStr || new Date().toLocaleTimeString()}]</span>
    <span class="log-tag ${tagClass}">${log.tag || log.level}</span>
    <span class="log-text">${escapeHtml(log.message)}</span>
  `;

  box.appendChild(line);

  if (state.autoScroll) {
    box.scrollTop = box.scrollHeight;
  }
}

function toggleAutoScroll() {
  state.autoScroll = !state.autoScroll;
  const btn = document.getElementById('btnAutoScroll');
  if (btn) btn.textContent = `Auto-Scroll: ${state.autoScroll ? 'ON' : 'OFF'}`;
}

function clearTerminalLogs() {
  const box = document.getElementById('terminalLogBox');
  if (box) box.innerHTML = '';
}

// Update Filter Tab Counters
function updateCounters() {
  const allCount = state.devices.length;
  const wifiCount = state.devices.filter(d => d.type === 'wifi' || d.type === 'spectrum_wifi').length;
  const bleCount = state.devices.filter(d => d.type === 'ble').length;

  const elAll = document.getElementById('countAll');
  const elWifi = document.getElementById('countWifi');
  const elBle = document.getElementById('countBle');

  if (elAll) elAll.textContent = allCount;
  if (elWifi) elWifi.textContent = wifiCount;
  if (elBle) elBle.textContent = bleCount;
}

// Filter Actions
function setDeviceFilter(filterType) {
  state.activeFilter = filterType;
  document.querySelectorAll('.filter-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === filterType);
  });
  renderDevicesTable();
}

function handleTableSearch(val) {
  state.searchQuery = val.trim();
  renderDevicesTable();
}

function focusDeviceRow(mac) {
  const row = document.getElementById(`row-${mac}`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.style.backgroundColor = 'rgba(0, 229, 255, 0.2)';
    setTimeout(() => {
      row.style.backgroundColor = '';
    }, 1500);
  }
}

// Action: Clear Data
async function clearScanData() {
  if (!requireSession()) return;
  try {
    const res = await fetch('/api/clear', { method: 'POST', headers: authHeaders() });
    if (res.status === 401) { appendTerminalLog('WARN', 'AUTH', 'Sesión requerida para limpiar datos'); showLogin(); return; }
    clearTerminalLogs();
  } catch (err) {
    console.error('Clear error:', err);
  }
}

// Packet Rate Meter
function startPacketRateMeter() {
  const rateTag = document.getElementById('packetRateTag');
  setInterval(() => {
    if (rateTag) {
      rateTag.textContent = `${state.packetCountLastSec} paq/s`;
    }
    state.packetCountLastSec = 0;
  }, 1000);
}

// Clock Ticker
function startClockTicker() {
  const clockEl = document.getElementById('lastUpdatedClock');
  if (!clockEl) return;

  function update() {
    const now = new Date();
    clockEl.textContent = `Sincronizado: ${now.toLocaleTimeString()}`;
  }
  update();
  setInterval(update, 1000);
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
