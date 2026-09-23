#!/usr/bin/env node
/*
 * Issue a Unison Pro license key.
 *
 *   LICENSE_SECRET=your-secret node make-license.js [months] [label]
 *
 * Prints a key like `UNISON-<payload>.<signature>`. Give one key to each paying
 * customer; they paste it in Settings -> Unison -> Plan. The server verifies it
 * offline with the same LICENSE_SECRET and upgrades the room to Pro.
 */

'use strict';

const crypto = require('crypto');

const secret = process.env.LICENSE_SECRET;
if (!secret) {
  console.error('Set LICENSE_SECRET (the same value the server uses).');
  process.exit(1);
}

const months = Math.max(1, parseInt(process.argv[2] || '1', 10) || 1);
const label = (process.argv[3] || '').slice(0, 40);

const payload = {
  v: 1,
  plan: 'pro',
  id: crypto.randomBytes(6).toString('hex'),
  iat: Date.now(),
  exp: Date.now() + months * 30 * 24 * 3600 * 1000,
  label,
};

const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
const key = `UNISON-${b64}.${sig}`;

console.log(key);
console.error(`plan=pro months=${months} exp=${new Date(payload.exp).toISOString()}${label ? ' label=' + label : ''}`);
