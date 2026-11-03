'use strict';

const http = require('../../lib/http');
const session = require('../../lib/session');
const { verifyAdminPassword } = require('../../lib/password');
const rateLimit = require('../../lib/rate-limit');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 6;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return http.methodNotAllowed(res, ['POST']);

  const ip = http.clientIp(req);
  const limit = rateLimit.hit('login:' + ip, MAX_ATTEMPTS, WINDOW_MS);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return http.json(res, 429, {
      error: 'TOO_MANY_ATTEMPTS',
      message: 'Too many attempts. Try again in ' + Math.ceil(limit.retryAfter / 60) + ' minute(s).'
    });
  }

  const body = http.parseBody(req);
  if (!body) return http.json(res, 400, { error: 'BAD_BODY' });

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password || email.length > 320 || password.length > 256) {
    return http.json(res, 400, { error: 'BAD_CREDENTIALS', message: 'Invalid email or password.' });
  }

  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const emailOk = adminEmail.length > 0 && email === adminEmail;
  const passwordOk = verifyAdminPassword(password);

  // Always evaluate both checks, then fail with one generic message.
  if (!emailOk || !passwordOk) {
    await new Promise(function (r) { setTimeout(r, 400); });
    return http.json(res, 401, { error: 'BAD_CREDENTIALS', message: 'Invalid email or password.' });
  }

  let token;
  try {
    token = session.issue(adminEmail, 'super_admin');
  } catch (e) {
    console.error('[login] session issue failed:', e.message);
    return http.json(res, 500, { error: 'SERVER_CONFIG' });
  }

  rateLimit.reset('login:' + ip);
  res.setHeader('Set-Cookie', http.sessionCookie(token));
  return http.json(res, 200, { ok: true, role: 'super_admin' });
};
