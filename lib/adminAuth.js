const crypto = require('crypto');

const COOKIE_NAME = 'nofa_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function sign(payload) {
  const secret = process.env.ADMIN_SECRET || '';
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function createSessionCookie() {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = String(expiresAt);
  const signature = sign(payload);
  const value = `${payload}.${signature}`;
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function parseCookies(cookieHeader) {
  const out = {};
  (cookieHeader || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  });
  return out;
}

function isAuthenticated(req) {
  if (!process.env.ADMIN_SECRET) return false;
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return false;

  const dotIndex = raw.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const payload = raw.slice(0, dotIndex);
  const signature = raw.slice(dotIndex + 1);
  if (!payload || !signature) return false;

  const expected = sign(payload);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;

  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  return true;
}

module.exports = { createSessionCookie, clearSessionCookie, isAuthenticated, COOKIE_NAME };
