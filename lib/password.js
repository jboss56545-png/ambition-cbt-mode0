'use strict';

const crypto = require('node:crypto');
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p
  });
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}

function verifyHash(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch (e) { return false; }
  if (!salt.length || !expected.length) return false;

  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p
  });
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// Prefers ADMIN_PASSWORD_HASH; falls back to ADMIN_PASSWORD for quick setup.
function verifyAdminPassword(password) {
  if (typeof password !== 'string' || password.length === 0) return false;

  const hash = (process.env.ADMIN_PASSWORD_HASH || '').trim();
  if (hash) return verifyHash(password, hash);

  const plain = process.env.ADMIN_PASSWORD || '';
  if (!plain) return false;
  return safeEqual(password, plain);
}

module.exports = { hashPassword, verifyHash, verifyAdminPassword, safeEqual };
