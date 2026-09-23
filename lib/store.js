/**
 * Dependency-free persistence + time-series store for EILOR.
 * Uses plain JSON files under ./data so it works on any Node version
 * without native modules (safe for PM2 deploys).
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HISTORY_FILE = path.join(DATA_DIR, 'timeseries.json');
const REGISTRATIONS_FILE = path.join(DATA_DIR, 'registrations.json');

const MAX_TIMESERIES = 720; // ~ last 12h at 1 sample/min
const MAX_REGISTRATIONS = 5000; // guest sign-ups retained

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function saveJSON(file, data) {
  try {
    ensureDir();
    // atomic-ish write
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    return false;
  }
}

/** Persisted device snapshot (array of records) */
function loadDevices() {
  const raw = loadJSON(STATE_FILE, { devices: [], totalPackets: 0 });
  return {
    devices: Array.isArray(raw.devices) ? raw.devices : [],
    totalPackets: raw.totalPackets || 0
  };
}

function saveDevices(devicesArray, totalPackets) {
  return saveJSON(STATE_FILE, { devices: devicesArray, totalPackets, savedAt: Date.now() });
}

/** Time-series: rolling array of { t, wifi, ble, active, packets, rate } */
function loadTimeseries() {
  const raw = loadJSON(HISTORY_FILE, []);
  return Array.isArray(raw) ? raw.slice(-MAX_TIMESERIES) : [];
}

function saveTimeseries(series) {
  return saveJSON(HISTORY_FILE, series.slice(-MAX_TIMESERIES));
}

/** Captive-portal guest registrations: rolling array of { id, nombre, apellido, telefono, apSsid, ts } */
function loadRegistrations() {
  const raw = loadJSON(REGISTRATIONS_FILE, []);
  return Array.isArray(raw) ? raw.slice(-MAX_REGISTRATIONS) : [];
}

function saveRegistrations(list) {
  return saveJSON(REGISTRATIONS_FILE, list.slice(-MAX_REGISTRATIONS));
}

module.exports = {
  DATA_DIR, STATE_FILE, HISTORY_FILE, REGISTRATIONS_FILE,
  MAX_TIMESERIES, MAX_REGISTRATIONS,
  loadDevices, saveDevices, loadTimeseries, saveTimeseries,
  loadRegistrations, saveRegistrations
};
