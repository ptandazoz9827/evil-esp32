/**
 * Minimal token-based auth for the EILOR dashboard.
 * - Web users authenticate with a shared password (env EILOR_PASSWORD).
 * - Tokens are random, kept in memory, and expire after TTL.
 * - The ESP32 ingestion path can optionally require EILOR_DEVICE_TOKEN.
 */
const crypto = require('crypto');

// No se incluye una contraseña de respaldo en el código publicado.
// Configure EILOR_PASSWORD antes de iniciar el servidor.
const PASSWORD = process.env.EILOR_PASSWORD || null;
const DEVICE_TOKEN = process.env.EILOR_DEVICE_TOKEN || null; // if null, ingestion is open
const TTL_MS = 1000 * 60 * 60 * 24; // 24h

const tokens = new Map(); // token -> expiry

function usingDefaultPassword() {
  return !process.env.EILOR_PASSWORD;
}

function login(password) {
  if (!PASSWORD || typeof password !== 'string' || password !== PASSWORD) return null;
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, Date.now() + TTL_MS);
  return token;
}

function isValidToken(token) {
  if (!token) return false;
  const exp = tokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { tokens.delete(token); return false; }
  return true;
}

function logout(token) {
  tokens.delete(token);
}

// Express middleware for protected mutating routes
function requireAuth(req, res, next) {
  const token = req.headers['x-eilor-token'] || req.query.token || (req.body && req.body.token);
  if (isValidToken(token)) return next();
  return res.status(401).json({ error: 'No autorizado. Inicia sesión.' });
}

// Device-side ingestion guard (optional)
function deviceAuthorized(providedToken) {
  if (!DEVICE_TOKEN) return true; // open ingestion when no device token configured
  return providedToken === DEVICE_TOKEN;
}

// periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of tokens) if (now > exp) tokens.delete(t);
}, 1000 * 60 * 30);

module.exports = {
  login, logout, isValidToken, requireAuth, deviceAuthorized,
  usingDefaultPassword, DEVICE_TOKEN
};
