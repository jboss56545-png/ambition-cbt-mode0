'use strict';

const crypto = require('node:crypto');
const VERSION = 'v1';

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET missing or shorter than 32 characters.');
  }
  return s;
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function hmac(body) {
  return crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}

// Token format:  v1.<base64url(json payload)>.<base64url(hmac)>
// Signed string: "v1.<payload>"   — must match middleware.js exactly.
function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const signingInput = VERSION + '.' + body;
  return signingInput + '.' + hmac(signingInput);
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;

  const signingInput = VERSION + '.' + parts[1];
  const expected = hmac(signingInput);
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch (e) { return null; }

  if (!payload || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function issue(subject, role) {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    sub: subject,
    role: role,
    iat: now,
    exp: now + 12 * 60 * 60
  });
}

module.exports = { sign, verify, issue };
