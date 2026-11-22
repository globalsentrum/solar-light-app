#!/usr/bin/env node
// Copies shared/logic.js to the frontend and the Apps Script folder, and stamps the
// service-worker cache version so phones pick up the new app after a deploy.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'shared/logic.js'), 'utf8');
fs.writeFileSync(path.join(root, 'docs/js/logic.js'), src);
fs.writeFileSync(path.join(root, 'apps-script/Logic.gs'), src);
const swPath = path.join(root, 'docs/sw.js');
if (fs.existsSync(swPath)) {
  const files = ['index.html', 'css/app.css', 'js/app.js', 'js/logic.js', 'js/db.js', 'js/api.js', 'js/watermark.js',
    'js/sync.js', 'js/config.js', 'lib/exifr.umd.js', 'manifest.webmanifest'];
  const h = crypto.createHash('sha1');
  files.forEach((f) => { const p = path.join(root, 'docs', f); if (fs.existsSync(p)) h.update(fs.readFileSync(p)); });
  const ver = h.digest('hex').slice(0, 10);
  const sw = fs.readFileSync(swPath, 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = '${ver}';`);
  fs.writeFileSync(swPath, sw);
  console.log('Service worker version', ver);
}
console.log('logic.js copied to docs/js and apps-script/Logic.gs');
