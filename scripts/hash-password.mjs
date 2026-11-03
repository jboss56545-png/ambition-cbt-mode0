#!/usr/bin/env node
// Generate ADMIN_PASSWORD_HASH for Vercel environment variables.
//   node scripts/hash-password.mjs 'MyStrongPassword'
import crypto from 'node:crypto';

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.mjs "your-password"');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
console.log('scrypt$' + salt.toString('hex') + '$' + key.toString('hex'));
