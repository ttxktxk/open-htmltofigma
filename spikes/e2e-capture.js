#!/usr/bin/env node
// Kept for compatibility: same as `node capture.js`, defaulting to the spike fixture.
//   node e2e-capture.js                       -> fixtures/e2e-spike.html
//   node e2e-capture.js "C:\path\mockup.html" -> any HTML (same options as capture.js)
const path = require('path');
if (process.argv.length <= 2) process.argv.push(path.join(__dirname, 'fixtures', 'e2e-spike.html'));
require('./capture.js');
