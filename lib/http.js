'use strict';

const COOKIE_NAME = 'ambition_beta_session';
const MAX_AGE_SECONDS = 60 * 60 * 12; // 12 hours

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return null; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return body;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.length) return real.trim();
  return 'unknown';
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  header.split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function sessionCookie(token) {
  return COOKIE_NAME + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + MAX_AGE_SECONDS;
}

function clearCookie() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

module.exports = {
  COOKIE_NAME,
  MAX_AGE_SECONDS,
  json,
  methodNotAllowed,
  parseBody,
  clientIp,
  parseCookies,
  sessionCookie,
  clearCookie
};
