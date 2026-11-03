'use strict';

const http = require('../../lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return http.methodNotAllowed(res, ['POST']);
  res.setHeader('Set-Cookie', http.clearCookie());
  return http.json(res, 200, { ok: true });
};
