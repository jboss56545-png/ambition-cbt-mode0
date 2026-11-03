'use strict';

const http = require('../../lib/http');
const session = require('../../lib/session');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return http.methodNotAllowed(res, ['GET']);

  const cookies = http.parseCookies(req.headers.cookie);
  let payload = null;
  try { payload = session.verify(cookies[http.COOKIE_NAME]); }
  catch (e) { return http.json(res, 500, { error: 'SERVER_CONFIG' }); }

  if (!payload) return http.json(res, 401, { authenticated: false });
  return http.json(res, 200, {
    authenticated: true,
    role: payload.role,
    subject: payload.sub,
    expiresAt: payload.exp
  });
};
