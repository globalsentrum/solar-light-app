'use strict';
/*
 * Browser tests (Chromium via Playwright) against the real PWA + real Code.gs (mocked Google services).
 * Run: npm run test:e2e
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./e2e-server');

const FIX = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, '..', 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const GEO = { latitude: 3.21234, longitude: 101.75678, accuracy: 6 };

let browser;
const openEnvs = [];
test.before(async () => { browser = await chromium.launch(); });
// Always clean up, even when a test fails (otherwise the local server keeps Node running)
test.afterEach(async () => {
  while (openEnvs.length) { const e = openEnvs.pop(); await e.ctx.close().catch(() => {}); e.srv.server.close(); }
});
test.after(async () => { await browser.close(); });

async function setup(email, opts) {
  opts = opts || {};
  const srv = await start(0);
  const base = 'http://localhost:' + srv.port;
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
    geolocation: GEO, permissions: opts.noGeo ? [] : ['geolocation'], acceptDownloads: true,
  });
  const token = srv.rt.g.issueSession_(email);
  if (email) await ctx.addInitScript((t) => { if (!localStorage.getItem('solar.session') && !sessionStorage.getItem('noinject')) localStorage.setItem('solar.session', t); }, token);
  // Google sign-in script is not reachable in tests: fail it fast instead of hanging
  await ctx.route(/accounts\.google\.com|gstatic\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  const sheet = (name) => srv.rt.state.sheets[name].rowsAsObjects();
  const env = { ctx, srv };
  openEnvs.push(env);
  const close = async () => {
    openEnvs.splice(openEnvs.indexOf(env), 1);
    await ctx.close(); srv.server.close();
    assert.deepEqual(errors, [], 'no JS errors in page');
  };
  return { srv, base, ctx, page, sheet, close, errors };
}

async function takePhoto(page, poleId, slotIdx, mode, file) {
  if (!page.url().includes('#/tiang/' + poleId)) {
    await page.goto(page.url().split('#')[0] + '#/tiang/' + poleId);
  }
  await page.waitForSelector('.slots');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.slots .tile').nth(slotIdx).locator('[data-act=addPhoto]').last().click();
  await page.click(mode === 'camera' ? 'text=📷 Kamera' : 'text=🖼️ Galeri');
  (await chooser).setFiles(path.join(FIX, file));
  await page.waitForFunction(() => { const t = document.querySelector('#toast'); return !t.hidden && t.textContent.includes('Gambar disimpan'); });
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; });
}

const syncText = (page) => page.textContent('#syncBtn');
const waitSynced = (page, timeout) => page.waitForFunction(() => document.querySelector('#syncBtn').textContent.includes('Semua disimpan'), null, { timeout: timeout || 30000 });

test('dashboard numbers and jadual filters on imported data', async () => {
  const { page, base, close } = await setup('team@example.com');
  await page.goto(base + '/#/dashboard');
  await page.waitForSelector('.stats');
  const vals = await page.$$eval('.stat', (els) => els.map((e) => e.querySelector('.stat-label').textContent + '=' + e.querySelector('.stat-val').textContent));
  assert.deepEqual(vals, ['Kerja siap=33/123', 'Gambar lengkap=0/44', 'Perlu pasang=44', 'Tunggu kelulusan=46', 'Dalam proses=0', 'Belum mula=44']);
  const bounds = await page.$$eval('.bound-head', (els) => els.map((e) => e.textContent));
  assert.deepEqual(bounds, ['EB23 / 54 siap (43%)', 'WB10 / 69 siap (14%)']);
  await page.screenshot({ path: path.join(OUT, 'screen-dashboard.png'), fullPage: true });

  await page.click('a[href="#/jadual"].btn');
  await page.waitForSelector('.prow');
  const count = async () => page.$$eval('.prow', (e) => e.length);
  assert.equal(await count(), 123);
  await page.click('[data-act=filter][data-val=EB]');
  assert.equal(await count(), 54);
  await page.click('[data-act=filter][data-val=WB]');
  assert.equal(await count(), 69);
  await page.click('[data-act=filter][data-group=bound][data-val=all]');
  await page.click('[data-act=filter][data-val="Tunggu kelulusan"]');
  assert.equal(await count(), 46);
  await page.click('[data-act=filter][data-val="Perlu pasang"]');
  assert.equal(await count(), 44);
  await page.click('[data-act=filter][data-val=Siap]');
  assert.equal(await count(), 33);
  await page.click('[data-act=filter][data-group=status][data-val=all]');
  await page.fill('#search', 'SL-05');
  assert.equal(await count(), 10);
  await page.fill('#search', '');
  // sorted by chainage
  const ch = await page.$$eval('.prow .small', (e) => e.map((x) => parseInt(x.textContent.match(/\d+/)[0], 10)));
  assert.deepEqual(ch, ch.slice().sort((a, b) => a - b));
  // row content incl. CH label + photo x/7
  const row56 = await page.textContent('a[href="#/tiang/SL-056"]');
  assert.match(row56, /SL-056/); assert.match(row56, /CH\.42400 – CH\.42600/); assert.match(row56, /CH belum tepat/); assert.match(row56, /0\/7/); assert.match(row56, /24\/11\/2026/);
  await page.screenshot({ path: path.join(OUT, 'screen-jadual.png') });
  // dashboard card opens filtered list
  await page.goto(base + '/#/dashboard');
  await page.click('.stat >> text=Tunggu kelulusan');
  await page.waitForSelector('.prow');
  assert.equal(await count(), 46);
  await close();
});

test('OFFLINE: photos, note and Siap queued, survive reload, sync once (no duplicates even when a reply is lost)', async () => {
  const { page, base, ctx, srv, sheet, close } = await setup('team@example.com');
  await page.goto(base + '/#/tiang/SL-035');
  await page.waitForSelector('.slots');
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller);

  await ctx.setOffline(true);
  await takePhoto(page, 'SL-035', 0, 'camera', 'camera_noexif.jpg');
  await takePhoto(page, 'SL-035', 1, 'gallery', 'gallery_exif.jpg');
  await page.fill('#noteText', 'Lokasi dianjak 3 m ke arah Karak (paip air)');
  await page.click('[data-act=addNote]');
  await page.click('[data-act=done][data-val="1"]');
  await page.waitForFunction(() => document.querySelector('#syncBtn').textContent.includes('4 item'));
  assert.equal(await syncText(page), '⏳ 4 item menunggu line');
  assert.match(await page.textContent('#banner'), /Tiada line/);

  // reload while offline: app shell from service worker, queue + data from IndexedDB
  await page.reload();
  await page.waitForSelector('.slots');
  assert.equal(await syncText(page), '⏳ 4 item menunggu line');
  assert.equal(await page.locator('.thumb .tb.wait').count(), 2);
  assert.match(await page.textContent('.notes'), /Lokasi dianjak 3 m/);
  assert.match(await page.textContent('.pole-head'), /Siap/);
  assert.match(await page.textContent('.pole-head'), /Belum lengkap \(2\/7\)/);
  await page.screenshot({ path: path.join(OUT, 'screen-offline-queue.png'), fullPage: true });
  assert.equal(sheet('Photos').filter((p) => p.PoleID === 'SL-035').length, 0, 'nothing reached the server yet');

  // back online — but the reply to the first upload gets lost (server saved it; phone retries)
  srv.flags.dropNextResponse = 1;
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitSynced(page, 45000);

  const photos = sheet('Photos').filter((p) => p.PoleID === 'SL-035');
  assert.equal(photos.length, 2, 'exactly 2 photos, no duplicate after the lost reply');
  assert.equal(new Set(photos.map((p) => p.PhotoID)).size, 2);
  assert.deepEqual(photos.map((p) => p.SlotID).sort(), ['S1', 'S2']);
  const gal = photos.find((p) => p.SlotID === 'S2');
  assert.equal(gal.Source, 'Gallery');
  assert.equal(gal.CapturedAt, '2026-11-20T09:15:30+08:00', 'EXIF time');
  assert.equal(gal.Latitude, '3.212345');
  const cam = photos.find((p) => p.SlotID === 'S1');
  assert.equal(cam.Source, 'Camera');
  assert.equal(cam.GPSAvailable, 'TRUE');
  assert.equal(cam.AccuracyM, '6');
  assert.equal(sheet('Notes').filter((n) => n.PoleID === 'SL-035').length, 1);
  assert.equal(sheet('Poles').find((p) => p.PoleID === 'SL-035').IsDone, 'TRUE');
  assert.equal(sheet('AuditLog').filter((a) => a.Action === 'PhotoAdded').length, 2);
  const uploads = srv.flags.calls.filter((c) => c.action === 'uploadPhoto').length;
  assert.equal(uploads, 3, '2 photos + 1 retry of the lost reply');
  assert.equal(srv.flags.calls.filter((c) => c.action === 'PREFLIGHT').length, 0, 'no CORS preflight (text/plain)');
  // drive files: 2 photos + 2 thumbs only
  const folder = Object.values(srv.rt.state.folders).find((f) => f.name === 'SL-035');
  assert.equal(Object.values(srv.rt.state.files).filter((f) => f.parent === folder.id).length, 4);

  await page.reload();
  await page.waitForSelector('.slots');
  assert.equal(await page.locator('.thumb .tb.wait').count(), 0);
  assert.equal(await page.locator('.thumb img').count(), 2, 'thumbnails shown');
  await page.screenshot({ path: path.join(OUT, 'screen-pole-synced.png'), fullPage: true });
  await close();
});

test('OFFLINE + sign-in expired: nothing lost, user asked to sign in again, then sync continues', async () => {
  const { page, base, ctx, srv, sheet, close } = await setup('team@example.com');
  await page.goto(base + '/#/tiang/SL-036');
  await page.waitForSelector('.slots');
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller);
  await ctx.setOffline(true);
  await takePhoto(page, 'SL-036', 2, 'camera', 'camera_noexif.jpg');
  await page.fill('#noteText', 'Nota semasa tiada line');
  await page.click('[data-act=addNote]');
  // session becomes invalid while the phone is offline
  await fetch(base + '/__test/rotateSecret');
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => /Sesi log masuk tamat/.test(document.querySelector('#banner').textContent));
  assert.equal(await syncText(page), '⏳ 2 item menunggu line');
  assert.match(await page.textContent('#banner'), /2 item belum dihantar/);
  assert.equal(sheet('Photos').length, 0);
  await page.screenshot({ path: path.join(OUT, 'screen-session-expired.png') });

  // user taps "Log masuk semula" -> login screen still shows the waiting items
  await page.click('[data-act=relogin]');
  await page.waitForSelector('.login');
  assert.match(await page.textContent('.login'), /2 item masih disimpan dalam telefon/);
  // Google sign-in comes back to the app with a new session (same flow as the Apps Script redirect)
  const fresh = srv.rt.g.issueSession_('team@example.com');
  const nonce = await page.evaluate(() => localStorage.getItem('solar.nonce'));
  assert.ok(nonce, 'nonce stored before sign-in');
  await page.goto(base + '/?r=1#login=' + encodeURIComponent(fresh) + '&nonce=' + nonce);
  await waitSynced(page, 30000);
  assert.equal(sheet('Photos').filter((p) => p.PoleID === 'SL-036').length, 1);
  assert.equal(sheet('Notes').filter((n) => n.PoleID === 'SL-036').length, 1);
  assert.ok(!(await page.url()).includes('login='), 'token removed from address bar');
  await close();
});

test('sign-in return with wrong nonce is rejected; #loginerror shown in Malay', async () => {
  const { page, base, srv, close } = await setup(null);
  await page.goto(base + '/');
  await page.waitForSelector('.login');
  const tok = srv.rt.g.issueSession_('team@example.com');
  await page.goto(base + '/?a=1#login=' + encodeURIComponent(tok) + '&nonce=wrong');
  await page.waitForSelector('.login .err');
  assert.match(await page.textContent('.login .err'), /Log masuk tidak sah/);
  await page.goto(base + '/?a=2#loginerror=' + encodeURIComponent('Emel x@gmail.com tiada dalam senarai pengguna.'));
  await page.waitForSelector('.login .err');
  assert.match(await page.textContent('.login .err'), /tiada dalam senarai pengguna/);
  await page.screenshot({ path: path.join(OUT, 'screen-login.png') });
  await close();
});

test('UI per role: Boss read-only, Team no admin tools, category rules', async () => {
  // Boss
  let s = await setup('boss@example.com');
  await s.page.goto(s.base + '/#/tiang/SL-034');
  await s.page.waitForSelector('.slots');
  assert.equal(await s.page.locator('[data-act=addPhoto]').count(), 0);
  assert.equal(await s.page.locator('#noteText').count(), 0);
  assert.equal(await s.page.locator('[data-act=done]').count(), 0);
  assert.equal(await s.page.locator('text=Edit tiang').count(), 0);
  assert.equal(await s.page.isHidden('[data-tab=admin]'), true);
  await s.page.goto(s.base + '/#/laporan');
  await s.page.waitForSelector('h3');
  assert.equal(await s.page.locator('[data-act=genReport]').count(), 0);
  await s.page.goto(s.base + '/#/admin/pengguna');
  await s.page.waitForSelector('.stats');
  await s.close();
  // Team
  s = await setup('team@example.com');
  await s.page.goto(s.base + '/#/tiang/SL-034');
  await s.page.waitForSelector('.slots');
  assert.equal(await s.page.locator('[data-act=addPhoto]').count() > 0, true);
  assert.equal(await s.page.locator('text=Edit tiang').count(), 0);
  assert.equal(await s.page.isHidden('[data-tab=admin]'), true);
  await s.page.goto(s.base + '/#/tiang/SL-078'); // Tunggu kelulusan
  await s.page.waitForSelector('.slots');
  assert.equal(await s.page.locator('[data-act=addPhoto]').count(), 0);
  assert.equal(await s.page.locator('[data-act=done]').count(), 0);
  assert.equal(await s.page.locator('#noteText').count(), 1);
  assert.match(await s.page.textContent('.pole-head'), /Tunggu kelulusan/);
  await s.page.goto(s.base + '/#/tiang/SL-001'); // Sudah dipasang
  await s.page.waitForSelector('.slots');
  assert.equal(await s.page.locator('[data-act=addPhoto]').count() > 0, true);
  assert.equal(await s.page.locator('[data-act=done]').count(), 0);
  assert.match(await s.page.textContent('.pole-head'), /Tidak berkaitan/);
  await s.page.goto(s.base + '/#/laporan');
  await s.page.waitForSelector('h3');
  assert.equal(await s.page.locator('[data-act=genReport]').count(), 0);
  await s.close();
});

test('admin: retake flag, hide/unhide, choose report photo, edit pole, PDF generate + download (all roles)', async () => {
  const { page, base, srv, sheet, ctx, close } = await setup('admin@example.com');
  await page.goto(base + '/#/tiang/SL-034');
  await takePhoto(page, 'SL-034', 2, 'camera', 'camera_noexif.jpg');
  await takePhoto(page, 'SL-034', 2, 'gallery', 'gallery_noexif.jpg');
  await waitSynced(page);
  const ids = sheet('Photos').filter((p) => p.PoleID === 'SL-034').map((p) => p.PhotoID);
  assert.equal(ids.length, 2);
  // open first photo, flag retake
  await page.click(`[data-act=viewPhoto][data-id="${ids[0]}"]`);
  await page.waitForSelector('#fullImg img');
  await page.click('text=🔁 Ambil semula');
  await page.waitForSelector('#sheet', { state: 'hidden' });
  assert.equal(sheet('Photos').find((p) => p.PhotoID === ids[0]).RetakeFlag, 'TRUE');
  assert.match(await page.textContent('.slots .tile >> nth=2'), /Ambil semula/);
  // choose report photo (slot has 2)
  await page.click(`[data-act=viewPhoto][data-id="${ids[0]}"]`);
  await page.click('text=★ Pilih untuk laporan');
  await page.waitForSelector('#sheet', { state: 'hidden' });
  assert.equal(sheet('Photos').find((p) => p.PhotoID === ids[0]).SelectedForReport, 'TRUE');
  // hide second
  await page.click(`[data-act=viewPhoto][data-id="${ids[1]}"]`);
  await page.click('text=🚫 Sembunyikan');
  await page.waitForSelector('#sheet', { state: 'hidden' });
  assert.equal(sheet('Photos').find((p) => p.PhotoID === ids[1]).Hidden, 'TRUE');
  assert.equal(await page.locator('.thumb.hidden-photo').count(), 1, 'admin still sees it (greyed)');
  await page.screenshot({ path: path.join(OUT, 'screen-admin-pole.png'), fullPage: true });
  // edit pole: exact CH + category
  await page.goto(base + '/#/tiang/SL-078/edit');
  await page.fill('input[name=Chainage]', 'CH.41450');
  await page.selectOption('select[name=Category]', 'Perlu pasang');
  await page.click('button[type=submit]');
  await page.waitForSelector('.slots');
  const p78 = sheet('Poles').find((p) => p.PoleID === 'SL-078');
  assert.equal(p78.Category, 'Perlu pasang');
  assert.equal(p78.ChainageExact, 'TRUE');
  assert.equal(await page.locator('[data-act=addPhoto]').count() > 0, true, 'photos now allowed');
  // generate PDF from UI
  await page.goto(base + '/#/laporan');
  await page.check('input[value="SL-034"]');
  await page.check('input[value="SL-035"]');
  assert.equal(await page.textContent('#nSel'), '2');
  await page.click('[data-act=genReport]');
  await page.waitForSelector('[data-act=download]');
  const rep = sheet('Reports')[0];
  assert.equal(rep.PoleIDs, 'SL-034, SL-035');
  const dl = page.waitForEvent('download');
  await page.click('[data-act=download]');
  const file = await (await dl).path();
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('%PDF-MOCK'));
  // admin selection used for slot 3 even though it is flagged (admin's explicit choice)
  const docJson = JSON.parse(fs.readFileSync(file, 'utf8').replace('%PDF-MOCK\n', ''));
  assert.ok(JSON.stringify(docJson).includes(ids[0]));
  assert.ok(!JSON.stringify(docJson).includes(ids[1]), 'hidden photo not in report');
  await page.screenshot({ path: path.join(OUT, 'screen-laporan.png'), fullPage: true });
  // team sees hidden photo? no
  const teamTok = srv.rt.g.issueSession_('team@example.com');
  const tp = await ctx.newPage();
  await tp.addInitScript((t) => localStorage.setItem('solar.session', t), teamTok);
  await tp.goto(base + '/#/tiang/SL-034');
  await tp.waitForSelector('.slots');
  await tp.waitForFunction(() => window.__solar.data && window.__solar.data.user.role === 'Team');
  await tp.evaluate(() => window.__solarTest.refresh());
  assert.equal(await tp.locator(`[data-id="${ids[1]}"]`).count(), 0, 'team cannot see hidden photo');
  assert.equal(await tp.locator(`[data-id="${ids[0]}"]`).count(), 1);
  // team can download report
  await tp.goto(base + '/#/laporan');
  const dl2 = tp.waitForEvent('download');
  await tp.click('[data-act=download]');
  assert.ok(await (await dl2).path());
  await tp.close();
  await close();
});

test('admin: users and slot settings screens', async () => {
  const { page, base, sheet, close } = await setup('admin@example.com');
  await page.goto(base + '/#/admin');
  await page.click('text=Pengguna');
  await page.fill('#addUser input[name=email]', 'pekerja.baru@gmail.com');
  await page.fill('#addUser input[name=name]', 'Pekerja Baru');
  await page.click('#addUser button[type=submit]');
  await page.waitForSelector('form[data-email="pekerja.baru@gmail.com"]');
  assert.equal(sheet('Users').find((u) => u.Email === 'pekerja.baru@gmail.com').Role, 'Team');
  const f = page.locator('form[data-email="pekerja.baru@gmail.com"]');
  await f.locator('select[name=role]').selectOption('Boss');
  await f.locator('input[name=active]').uncheck();
  await f.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#overlay').hidden);
  await page.waitForTimeout(300);
  const u = sheet('Users').find((x) => x.Email === 'pekerja.baru@gmail.com');
  assert.equal(u.Role, 'Boss'); assert.equal(u.Active, 'FALSE');
  await page.click('[data-act=removeUser][data-email="pekerja.baru@gmail.com"]');
  await page.waitForFunction(() => !document.querySelector('form[data-email="pekerja.baru@gmail.com"]'));
  assert.equal(sheet('Users').some((x) => x.Email === 'pekerja.baru@gmail.com'), false);

  await page.goto(base + '/#/admin/slot');
  const s3 = page.locator('form.slot-row[data-id=S3]');
  await s3.locator('input[name=name]').fill('Ukuran lubang');
  await s3.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Disimpan');
  assert.equal(sheet('Slots').find((s) => s.SlotID === 'S3').Name, 'Ukuran lubang');
  await page.click('[data-act=moveSlot][data-id=S7][data-dir="-1"]');
  await page.waitForFunction(() => document.querySelectorAll('form.slot-row')[5].dataset.id === 'S7');
  await page.fill('#addSlot input[name=name]', 'Pendawaian');
  await page.click('#addSlot button[type=submit]');
  await page.waitForSelector('form.slot-row[data-id=S8]');
  await page.goto(base + '/#/tiang/SL-040');
  await page.waitForSelector('.slots');
  assert.match(await page.textContent('.pole-head'), /0\/8/);
  assert.match(await page.textContent('.slots'), /Ukuran lubang/);
  await page.goto(base + '/#/admin/log');
  await page.waitForSelector('.audit tr');
  assert.match(await page.textContent('.audit'), /SlotAdded/);
  await close();
});

// ------------------------------------------------------------------ watermark
async function runWatermark(page, file, opts) {
  const b64 = fs.readFileSync(path.join(FIX, file)).toString('base64');
  return page.evaluate(async ({ b64, opts, name }) => {
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const f = new File([arr], name, { type: 'image/jpeg' });
    let gpsAsked = false;
    const res = await SolarWatermark.process(f, {
      source: opts.source, now: new Date(opts.now),
      getDeviceGps: async () => { gpsAsked = true; return opts.deviceGps; },
    });
    const bmp = await createImageBitmap(res.full);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
    const lum = (x, y, w, h) => { const d = ctx.getImageData(x, y, w, h).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3; return s / (d.length / 4); };
    const b = res.stamp.box;
    const fr = new FileReader();
    const dataUrl = await new Promise((r) => { fr.onload = () => r(fr.result); fr.readAsDataURL(res.full); });
    return { meta: res.meta, lines: res.stamp.lines, w: res.width, h: res.height, box: b, gpsAsked,
      // white text inside a dark band: band is darker than the image above it, and has bright pixels (text)
      bandMax: (() => { const d = ctx.getImageData(b.x, b.y, b.w, b.h).data; let m = 0; for (let i = 0; i < d.length; i += 4) m = Math.max(m, d[i] + d[i + 1] + d[i + 2]); return m / 3; })(),
      thumbSize: res.thumb.size, fullSize: res.full.size, dataUrl };
  }, { b64, opts, name: file });
}

test('watermark: camera / gallery with EXIF / gallery without EXIF / gallery date-only / no GPS', async () => {
  const { page, base, close } = await setup('team@example.com');
  await page.goto(base + '/#/dashboard');
  await page.waitForSelector('.stats');
  const now = '2026-11-21T06:05:00Z'; // 14:05 Malaysia
  const dev = { lat: 3.123456, lng: 101.654321, acc: 7.6 };
  const save = (name, r) => fs.writeFileSync(path.join(OUT, name), Buffer.from(r.dataUrl.split(',')[1], 'base64'));

  // 1) camera-style photo (no EXIF), GPS ok
  let r = await runWatermark(page, 'camera_noexif.jpg', { source: 'Camera', now, deviceGps: dev });
  save('watermark-1-camera.jpg', r);
  assert.deepEqual([r.w, r.h], [1600, 1200], 'resized to 1600 long side');
  assert.deepEqual(r.lines, ['21/11/2026 14:05', 'GPS: 3.12346, 101.65432  ±8 m']);
  assert.equal(r.meta.capturedAt, '2026-11-21T14:05:00+08:00');
  assert.equal(r.meta.source, 'Camera');
  assert.equal(r.meta.gpsAvailable, true);
  assert.equal(r.meta.fromGalleryLabel, false);
  assert.ok(r.box.x + r.box.w === 1600 && r.box.y + r.box.h === 1200, 'stamp in bottom-right corner');
  assert.ok(r.bandMax > 200, 'white text present in band');
  assert.ok(r.fullSize < 600000, 'jpeg size reasonable: ' + r.fullSize);
  assert.ok(r.thumbSize < 40000);

  // 2) gallery WITH EXIF date + GPS -> EXIF values, no label, device GPS not needed
  r = await runWatermark(page, 'gallery_exif.jpg', { source: 'Gallery', now, deviceGps: dev });
  save('watermark-2-gallery-exif.jpg', r);
  assert.deepEqual([r.w, r.h], [1600, 1067]);
  assert.deepEqual(r.lines, ['20/11/2026 09:15', 'GPS: 3.21235, 101.75679']);
  assert.equal(r.meta.capturedAt, '2026-11-20T09:15:30+08:00');
  assert.equal(r.meta.gpsFrom, 'exif');
  assert.equal(r.meta.fromGalleryLabel, false);
  assert.equal(r.gpsAsked, false);

  // 3) gallery WITHOUT EXIF -> upload time + current GPS + "Dari galeri"
  r = await runWatermark(page, 'gallery_noexif.jpg', { source: 'Gallery', now, deviceGps: dev });
  save('watermark-3-gallery-noexif.jpg', r);
  assert.deepEqual([r.w, r.h], [1200, 1600], 'portrait kept');
  assert.deepEqual(r.lines, ['21/11/2026 14:05', 'GPS: 3.12346, 101.65432  ±8 m', 'Dari galeri']);
  assert.equal(r.meta.source, 'Gallery');
  assert.equal(r.meta.fromGalleryLabel, true);

  // 4) gallery with EXIF date but no GPS -> EXIF date, device GPS, label
  r = await runWatermark(page, 'gallery_dateonly.jpg', { source: 'Gallery', now, deviceGps: dev });
  assert.deepEqual(r.lines, ['19/11/2026 16:40', 'GPS: 3.12346, 101.65432  ±8 m', 'Dari galeri']);

  // 5) camera, no GPS fix -> "GPS tidak tersedia"
  r = await runWatermark(page, 'camera_noexif.jpg', { source: 'Camera', now, deviceGps: null });
  save('watermark-4-no-gps.jpg', r);
  assert.deepEqual(r.lines, ['21/11/2026 14:05', 'GPS tidak tersedia']);
  assert.equal(r.meta.gpsAvailable, false);
  assert.equal(r.meta.latitude, '');

  // 6) gallery, no EXIF and no GPS
  r = await runWatermark(page, 'gallery_noexif.jpg', { source: 'Gallery', now, deviceGps: null });
  assert.deepEqual(r.lines, ['21/11/2026 14:05', 'GPS tidak tersedia', 'Dari galeri']);
  await close();
});

test('GPS tracker: waits for a fix up to the timeout, returns null when none / denied', async () => {
  const { page, base, close } = await setup('team@example.com');
  await page.goto(base + '/#/dashboard');
  await page.waitForSelector('.stats');
  const res = await page.evaluate(async () => {
    const out = {};
    // never answers -> timeout
    const silent = { watchPosition: () => 1, clearWatch: () => {} };
    Object.defineProperty(navigator, 'geolocation', { value: silent, configurable: true });
    let t0 = Date.now(); let g = new SolarWatermark.GpsTracker();
    out.timeoutFix = await g.getFix(1500); out.timeoutMs = Date.now() - t0;
    // answers after 500 ms
    const slow = { watchPosition: (ok) => { setTimeout(() => ok({ coords: { latitude: 3.1, longitude: 101.6, accuracy: 9 } }), 500); return 2; }, clearWatch: () => {} };
    Object.defineProperty(navigator, 'geolocation', { value: slow, configurable: true });
    t0 = Date.now(); g = new SolarWatermark.GpsTracker();
    out.slowFix = await g.getFix(15000); out.slowMs = Date.now() - t0;
    // cached fresh fix reused immediately
    t0 = Date.now(); out.again = await g.getFix(15000); out.againMs = Date.now() - t0;
    // permission denied -> null quickly
    const denied = { watchPosition: (ok, err) => { setTimeout(() => err({ code: 1 }), 50); return 3; }, clearWatch: () => {} };
    Object.defineProperty(navigator, 'geolocation', { value: denied, configurable: true });
    t0 = Date.now(); g = new SolarWatermark.GpsTracker();
    out.denied = await g.getFix(15000); out.deniedMs = Date.now() - t0;
    return out;
  });
  assert.equal(res.timeoutFix, null);
  assert.ok(res.timeoutMs >= 1400 && res.timeoutMs < 3000);
  assert.equal(res.slowFix.lat, 3.1);
  assert.ok(res.slowMs < 2000);
  assert.ok(res.againMs < 50);
  assert.equal(res.denied, null);
  assert.ok(res.deniedMs < 1000);
  const src = fs.readFileSync(path.join(__dirname, '../docs/js/app.js'), 'utf8');
  assert.match(src, /S\.gps\.getFix\(15000/, 'app waits up to 15 s for GPS');
  await close();
});

test('camera photo end-to-end without location permission stamps "GPS tidak tersedia"', async () => {
  const { page, base, sheet, close } = await setup('team@example.com', { noGeo: true });
  await page.goto(base + '/#/tiang/SL-037');
  await takePhoto(page, 'SL-037', 0, 'camera', 'camera_noexif.jpg');
  await waitSynced(page);
  const p = sheet('Photos').find((x) => x.PoleID === 'SL-037');
  assert.equal(p.GPSAvailable, 'FALSE');
  assert.equal(p.Latitude, '');
  await close();
});
