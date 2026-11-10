'use strict';

const crypto = require('node:crypto');

const password = process.argv[2];
if (!password || password.length < 10) {
  console.error('Usage: npm run hash-password -- "your-long-password"');
  console.error('Use at least 10 characters.');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => {
  if (error) {
    console.error('Could not hash password:', error.message);
    process.exit(1);
  }
  console.log(`scrypt$${salt.toString('hex')}$${key.toString('hex')}`);
});
