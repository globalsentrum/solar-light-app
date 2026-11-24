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


/** Open a pole, take a photo for one photo type (+ measurement if asked). */
async function takePhoto(page, poleId, typeId, mode, file, measurement) {
  if (!page.url().includes('#/tiang/' + poleId)) await page.goto(page.url().split('#')[0] + '#/tiang/' + poleId);
  await page.waitForSelector('.act');
  const chooser = page.waitForEvent('filechooser');
  await page.locator(`button[data-act=addPhoto][data-type="${typeId}"]`).click();
  await page.click(mode === 'camera' ? 'text=📷 Kamera' : 'text=🖼️ Galeri');
  (await chooser).setFiles(path.join(FIX, file));
  if (measurement !== undefined) {
    await page.waitForSelector('#measIn');
    await page.fill('#measIn', String(measurement));
    await page.click('[data-act=measOk]');
  }
  await page.waitForFunction(() => { const t = document.querySelector('#toast'); return !t.hidden && t.textContent.includes('Gambar disimpan'); });
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; });
}

const syncText = (page) => page.textContent('#syncBtn');
const waitSynced = (page, timeout) => page.waitForFunction(() => document.querySelector('#syncBtn').textContent.includes('Semua disimpan'), null, { timeout: timeout || 30000 });
/** 2027-01-05 23:59:30 in Malaysia (UTC+8) */
const KL_LATE = new Date(Date.UTC(2027, 0, 5, 15, 59, 30));
/** 2027-01-06 00:00:30 in Malaysia */
const KL_AFTER_MIDNIGHT = new Date(Date.UTC(2027, 0, 5, 16, 0, 30));
const api = (srv, email, action, params) => JSON.parse(JSON.stringify(srv.rt.g.handle_({ action, token: srv.rt.g.issueSession_(email), ...params })));

test('dashboard numbers; Admin opens Jadual on "Semua" with filters, search by number', async () => {
  const { page, base, close } = await setup('admin@example.com');
  await page.goto(base + '/#/dashboard');
  await page.waitForSelector('.stats');
  const vals = await page.$$eval('.stat', (els) => els.map((e) => e.querySelector('.stat-label').textContent + '=' + e.querySelector('.stat-val').textContent +
    (e.querySelector('.stat-sub') ? ' ' + e.querySelector('.stat-sub').textContent : '')));
  assert.deepEqual(vals, ['Baki perlu pasang=44 daripada 44', 'Perlu gambar malam=0 🌙', 'Dalam proses=0', 'Belum mula=44', 'Siap=33 daripada 123', 'Tunggu kelulusan=46']);
  await page.screenshot({ path: path.join(OUT, 'screen-dashboard.png'), fullPage: true });
  await page.click('a[href="#/jadual"].btn');
  await page.waitForSelector('.prow');
  assert.equal(await page.textContent('.seg-btn.on'), 'Semua');
  const count = async () => page.$$eval('.prow', (e) => e.length);
  assert.equal(await count(), 123);
  await page.click('[data-act=filter][data-val=EB]');
  assert.equal(await count(), 54);
  await page.click('[data-act=filter][data-group=bound][data-val=all]');
  await page.click('[data-act=filter][data-val="PENDING"]');
  assert.equal(await count(), 46);
  await page.click('[data-act=filter][data-group=status][data-val=all]');
  await page.fill('#search', '34');
  assert.deepEqual(await page.$$eval('.prow-main b', (e) => e.map((x) => x.textContent)), ['SSL034']);
  await page.fill('#search', 'SSL05');
  assert.equal(await count(), 11, 'SSL050..SSL059 + SSL005');
  await page.fill('#search', '');
  const row = await page.textContent('.prow:has(a[href="#/tiang/SSL056"])');
  assert.match(row, /SSL056/); assert.match(row, /CH belum tepat/); assert.match(row, /0\/11/);
  await close();
});

test('Team/Boss open Jadual on "Esok"; Hari ini / Esok use Malaysia dates (23:59 vs 00:00); several plans per pole; cached offline', async () => {
  const s = await setup('team@example.com');
  const { page, base, srv, ctx, close } = s;
  api(srv, 'admin@example.com', 'addPlans', { poleIds: ['SSL050', 'SSL040'], date: '2027-01-06', activityId: 'B' });
  api(srv, 'admin@example.com', 'addPlans', { poleIds: ['SSL040'], date: '2027-01-06', activityId: 'C' });
  api(srv, 'admin@example.com', 'addPlans', { poleIds: ['SSL045'], date: '2027-01-06', activityId: '' });
  api(srv, 'admin@example.com', 'addPlans', { poleIds: ['SSL036'], date: '2027-01-05', activityId: 'A' });
  await ctx.clock.setFixedTime(KL_LATE); // 23:59 on 5 Jan in Malaysia (15:59 UTC)
  await page.goto(base + '/#/jadual');
  await page.waitForSelector('.seg-btn.on');
  assert.equal(await page.textContent('.seg-btn.on'), 'Esok');
  assert.match(await page.textContent('.card'), /06\/01\/2027/);
  const ids = () => page.$$eval('.prow-main b', (e) => e.map((x) => x.textContent));
  // sorted by chainage (dummy chainages increase with the ID)
  assert.deepEqual(await ids(), ['SSL040', 'SSL045', 'SSL050']);
  assert.match(await page.textContent('.prow:has(a[href="#/tiang/SSL040"]) .b-plan'), /^Trial Pit · Installation$/);
  assert.equal(await page.locator('.prow:has(a[href="#/tiang/SSL045"]) .b-plan').count(), 0, 'blank activity -> no label');
  assert.match(await page.textContent('.prow:has(a[href="#/tiang/SSL045"])'), /Belum mula/);
  await page.screenshot({ path: path.join(OUT, 'screen-esok.png'), fullPage: true });
  await page.click('[data-act=jtab][data-val=hari]');
  assert.deepEqual(await ids(), ['SSL036']);
  // offline: reload still shows the plan from the phone's cache
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.seg-btn.on');
  await page.click('[data-act=jtab][data-val=esok]');
  assert.deepEqual(await ids(), ['SSL040', 'SSL045', 'SSL050'], 'plans cached offline');
  await ctx.setOffline(false);
  await close();
  // just after midnight in Malaysia: the 6 Jan plans are now "Hari ini", tomorrow is empty
  const s2 = await setup('boss@example.com');
  api(s2.srv, 'admin@example.com', 'addPlans', { poleIds: ['SSL050'], date: '2027-01-06', activityId: 'B' });
  await s2.ctx.clock.setFixedTime(KL_AFTER_MIDNIGHT);
  await s2.page.goto(s2.base + '/#/jadual');
  await s2.page.waitForSelector('.seg-btn.on');
  assert.equal(await s2.page.textContent('.seg-btn.on'), 'Esok');
  assert.equal(await s2.page.textContent('.empty-plan'), 'Tiada kerja dirancang untuk esok.');
  await s2.page.click('[data-act=jtab][data-val=hari]');
  assert.deepEqual(await s2.page.$$eval('.prow-main b', (e) => e.map((x) => x.textContent)), ['SSL050']);
  assert.equal(await s2.page.locator('.pchk').count(), 0, 'Boss cannot tick poles');
  await s2.close();
});

test('Admin plans work from the schedule: tick poles -> Rancang kerja -> edit / remove on the pole screen', async () => {
  const { page, base, ctx, sheet, close } = await setup('admin@example.com');
  await ctx.clock.setFixedTime(KL_LATE);
  await page.goto(base + '/#/jadual');
  await page.waitForSelector('.prow');
  await page.check('.prow:has(a[href="#/tiang/SSL034"]) input[data-act=psel]');
  await page.check('.prow:has(a[href="#/tiang/SSL041"]) input[data-act=psel]');
  assert.match(await page.textContent('.planbar'), /2 tiang dipilih/);
  await page.click('[data-act=planOpen]');
  assert.equal(await page.inputValue('#planDate'), '2027-01-06', 'defaults to tomorrow (Malaysia)');
  await page.selectOption('#planAct', 'B');
  await page.click('[data-act=planSave]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('2 pelan ditambah'));
  assert.deepEqual(sheet('WorkPlan').map((p) => p.PoleID + ' ' + p.Date + ' ' + p.Activity).sort(), ['SSL034 2027-01-06 B', 'SSL041 2027-01-06 B']);
  // same again -> skipped
  await page.check('.prow:has(a[href="#/tiang/SSL034"]) input[data-act=psel]');
  await page.click('[data-act=planOpen]');
  await page.selectOption('#planAct', 'B');
  await page.click('[data-act=planSave]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('1 sudah ada'));
  assert.equal(sheet('WorkPlan').length, 2);
  await page.click('[data-act=jtab][data-val=esok]');
  assert.deepEqual(await page.$$eval('.prow-main b', (e) => e.map((x) => x.textContent)), ['SSL034', 'SSL041']);
  // edit + remove from the pole screen
  await page.goto(base + '/#/tiang/SSL034');
  await page.waitForSelector('.planlist');
  assert.match(await page.textContent('.planlist'), /06\/01\/2027 · Trial Pit/);
  await page.click('[data-act=planEdit]');
  await page.fill('#planDate', '2027-01-09');
  await page.selectOption('#planAct', 'C');
  await page.click('[data-act=planEditSave]');
  await page.waitForFunction(() => /09\/01\/2027 · Installation/.test(document.querySelector('.planlist').textContent));
  await page.click('[data-act=planEdit]');
  await page.click('[data-act=planRemove]');
  await page.waitForFunction(() => !document.querySelector('.planlist'));
  assert.deepEqual(sheet('WorkPlan').map((p) => p.PoleID), ['SSL041']);
  assert.deepEqual(sheet('AuditLog').filter((a) => a.Entity === 'WorkPlan').map((a) => a.Action), ['PlanAdded', 'PlanAdded', 'PlanEdited', 'PlanEdited', 'PlanRemoved']);
  await close();
});

test('pole screen: 3 activity groups, counts/minimums, measurement required and validated, value under thumbnails', async () => {
  const { page, base, sheet, close } = await setup('team@example.com');
  await page.goto(base + '/#/tiang/SSL034');
  await page.waitForSelector('.act');
  assert.deepEqual(await page.$$eval('.act h3', (e) => e.map((x) => x.textContent)), ['Pegging', 'Trial Pit', 'Installation']);
  assert.match(await page.textContent('.act >> nth=1 >> .spec'), /Dalam 1.5m, lebar 1m, panjang 1m/);
  assert.match(await page.textContent('.pole-head'), /Pegging 0\/1 · Trial Pit 0\/4 · Installation 0\/6/);
  assert.match(await page.textContent('.tile:has([data-type=C1])'), /0 📷 \(min 4\)/);
  assert.match(await page.textContent('.tile:has([data-type=B2])'), /ukuran \(m\)/);
  // measurement dialog: empty / invalid / too many decimals, then "1,3"
  const chooser = page.waitForEvent('filechooser');
  await page.click('button[data-act=addPhoto][data-type="B2"]');
  await page.click('text=🖼️ Galeri');
  (await chooser).setFiles(path.join(FIX, 'gallery_exif.jpg'));
  await page.waitForSelector('#measIn');
  await page.click('[data-act=measOk]');
  assert.match(await page.textContent('#measErr'), /Sila masukkan ukuran dalam meter/);
  await page.fill('#measIn', 'abc');
  await page.click('[data-act=measOk]');
  assert.match(await page.textContent('#measErr'), /tidak sah/);
  await page.fill('#measIn', '1.355');
  await page.click('[data-act=measOk]');
  assert.match(await page.textContent('#measErr'), /maksimum 2 titik perpuluhan/);
  await page.fill('#measIn', '0');
  await page.click('[data-act=measOk]');
  assert.match(await page.textContent('#measErr'), /lebih daripada 0/);
  await page.screenshot({ path: path.join(OUT, 'screen-measurement.png') });
  await page.fill('#measIn', '1,3');
  await page.click('[data-act=measOk]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Gambar disimpan'));
  await waitSynced(page);
  assert.equal(await page.textContent('.tile:has([data-type=B2]) .meas'), '1.3 m');
  // discard: Batal throws the photo away (nothing queued, nothing uploaded)
  const ch2 = page.waitForEvent('filechooser');
  await page.click('button[data-act=addPhoto][data-type="B3"]');
  await page.click('text=📷 Kamera');
  (await ch2).setFiles(path.join(FIX, 'camera_noexif.jpg'));
  await page.waitForSelector('#measIn');
  await page.click('[data-act=measCancel]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Gambar dibuang'));
  await takePhoto(page, 'SSL034', 'B3', 'camera', 'camera_noexif.jpg', '1.6');
  await takePhoto(page, 'SSL034', 'A1', 'camera', 'camera_noexif.jpg');
  await waitSynced(page);
  const photos = sheet('Photos').filter((p) => p.PoleID === 'SSL034');
  assert.deepEqual(photos.map((p) => p.PhotoTypeID + ':' + p.MeasurementM).sort(), ['A1:', 'B2:1.3', 'B3:1.6']);
  assert.match(await page.textContent('.pole-head'), /Pegging ✓ · Trial Pit 2\/4 · Installation 0\/6/);
  await page.screenshot({ path: path.join(OUT, 'screen-pole-v2.png'), fullPage: true });
  await close();
});

test('OFFLINE: photos (incl. measurement), note and Siap queued, survive reload, sync once (no duplicates when a reply is lost)', async () => {
  const { page, base, ctx, srv, sheet, close } = await setup('team@example.com');
  await page.goto(base + '/#/tiang/SSL035');
  await page.waitForSelector('.act');
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller);
  await ctx.setOffline(true);
  await takePhoto(page, 'SSL035', 'C1', 'camera', 'camera_noexif.jpg');
  await takePhoto(page, 'SSL035', 'B4', 'gallery', 'gallery_exif.jpg', '1.5');
  await page.fill('#noteText', 'Lokasi dianjak 3 m (paip air)');
  await page.click('[data-act=addNote]');
  await page.click('[data-act=done][data-val="1"]');
  await page.waitForFunction(() => document.querySelector('#syncBtn').textContent.includes('4 item'));
  assert.equal(await syncText(page), '⏳ 4 item menunggu line');
  await page.reload();
  await page.waitForSelector('.act');
  assert.equal(await syncText(page), '⏳ 4 item menunggu line');
  assert.equal(await page.locator('.thumb .tb.wait').count(), 2);
  assert.equal(await page.textContent('.tile:has([data-type=B4]) .meas'), '1.5 m', 'measurement shown while still queued');
  assert.match(await page.textContent('.pole-head'), /Siap/);
  assert.match(await page.textContent('.pole-head'), /Trial Pit 1\/4 · Installation 1\/6/);
  assert.equal(sheet('Photos').length, 0);
  srv.flags.dropNextResponse = 1;
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitSynced(page, 45000);
  const photos = sheet('Photos').filter((p) => p.PoleID === 'SSL035');
  assert.equal(photos.length, 2, 'exactly 2 photos, no duplicate after the lost reply');
  assert.deepEqual(photos.map((p) => p.PhotoTypeID + ':' + p.MeasurementM).sort(), ['B4:1.5', 'C1:']);
  assert.equal(photos.find((p) => p.PhotoTypeID === 'B4').CapturedAt, '2026-11-20T09:15:30+08:00', 'EXIF time');
  assert.equal(sheet('Notes').filter((n) => n.PoleID === 'SSL035').length, 1);
  assert.equal(sheet('Poles').find((p) => p.PoleID === 'SSL035').IsDone, 'TRUE');
  assert.equal(srv.flags.calls.filter((c) => c.action === 'uploadPhoto').length, 3, '2 photos + 1 retry');
  assert.equal(srv.flags.calls.filter((c) => c.action === 'PREFLIGHT').length, 0);
  await close();
});

test('OFFLINE + sign-in expired: nothing lost, sign in again, then sync continues', async () => {
  const { page, base, ctx, srv, sheet, close } = await setup('team@example.com');
  await page.goto(base + '/#/tiang/SSL036');
  await page.waitForSelector('.act');
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller);
  await ctx.setOffline(true);
  await takePhoto(page, 'SSL036', 'A1', 'camera', 'camera_noexif.jpg');
  await page.fill('#noteText', 'Nota semasa tiada line');
  await page.click('[data-act=addNote]');
  await fetch(base + '/__test/rotateSecret');
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => /Sesi log masuk tamat/.test(document.querySelector('#banner').textContent));
  assert.equal(await syncText(page), '⏳ 2 item menunggu line');
  await page.click('[data-act=relogin]');
  await page.waitForSelector('.login');
  assert.match(await page.textContent('.login'), /2 item masih disimpan dalam telefon/);
  const fresh = srv.rt.g.issueSession_('team@example.com');
  const nonce = await page.evaluate(() => localStorage.getItem('solar.nonce'));
  await page.goto(base + '/?r=1#login=' + encodeURIComponent(fresh) + '&nonce=' + nonce);
  await waitSynced(page, 30000);
  assert.equal(sheet('Photos').filter((p) => p.PoleID === 'SSL036').length, 1);
  assert.equal(sheet('Notes').filter((n) => n.PoleID === 'SSL036').length, 1);
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
  await close();
});

test('UI per role: Boss read-only; Team no admin tools (no ticking, no report choice); category rules', async () => {
  let s = await setup('boss@example.com');
  api(s.srv, 'team@example.com', 'uploadPhoto', { photoId: 'boss_view_0001', poleId: 'SSL034', typeId: 'A1', imageB64: fs.readFileSync(path.join(FIX, 'tiny.jpg')).toString('base64'), source: 'Camera', gpsAvailable: false });
  await s.page.goto(s.base + '/#/tiang/SSL034');
  await s.page.waitForSelector('.act');
  for (const sel of ['[data-act=addPhoto]', '#noteText', '[data-act=done]', '[data-act=chooseReport]', 'text=Edit tiang']) {
    assert.equal(await s.page.locator(sel).count(), 0, 'Boss: ' + sel);
  }
  assert.equal(await s.page.isHidden('[data-tab=admin]'), true);
  await s.page.goto(s.base + '/#/laporan');
  await s.page.waitForSelector('h3');
  assert.equal(await s.page.locator('[data-act=genReport]').count(), 0);
  await s.close();
  s = await setup('team@example.com');
  api(s.srv, 'team@example.com', 'uploadPhoto', { photoId: 'team_view_0001', poleId: 'SSL034', typeId: 'A1', imageB64: fs.readFileSync(path.join(FIX, 'tiny.jpg')).toString('base64'), source: 'Camera', gpsAvailable: false });
  await s.page.goto(s.base + '/#/tiang/SSL034');
  await s.page.waitForSelector('.act');
  assert.equal(await s.page.locator('[data-act=addPhoto]').count() > 0, true);
  assert.equal(await s.page.locator('[data-act=chooseReport]').count(), 0);
  assert.equal(await s.page.locator('text=Edit tiang').count(), 0);
  await s.page.goto(s.base + '/#/jadual');
  await s.page.click('[data-act=jtab][data-val=semua]');
  await s.page.waitForSelector('.prow');
  assert.equal(await s.page.locator('.pchk').count(), 0, 'Team cannot tick poles for planning');
  await s.page.goto(s.base + '/#/tiang/SSL078');
  await s.page.waitForSelector('.act');
  assert.equal(await s.page.locator('[data-act=addPhoto]').count(), 0);
  assert.equal(await s.page.locator('#noteText').count(), 1);
  await s.page.goto(s.base + '/#/tiang/SSL001');
  await s.page.waitForSelector('.act');
  assert.equal(await s.page.locator('[data-act=addPhoto]').count() > 0, true);
  assert.equal(await s.page.locator('[data-act=done]').count(), 0);
  await s.close();
});

test('admin: choose report photos (C1 exactly 4 in order), retake, report screen statuses, RIN, PDF + Word download', async () => {
  const { page, base, srv, sheet, close } = await setup('admin@example.com');
  const img = fs.readFileSync(path.join(FIX, 'camera_noexif.jpg')).toString('base64');
  let k = 0;
  const up = (pole, typeId, measurement) => api(srv, 'team@example.com', 'uploadPhoto', { photoId: 'adm_' + String(++k).padStart(8, '0'), poleId: pole, typeId,
    imageB64: img, thumbB64: fs.readFileSync(path.join(FIX, 'tiny.jpg')).toString('base64'), source: 'Camera', gpsAvailable: true, latitude: 3.1, longitude: 101.6, accuracy: 5,
    capturedAt: '2027-01-05T08:' + String(k).padStart(2, '0') + ':00+08:00', measurement }).photo.PhotoID;
  const c1 = [1, 2, 3, 4, 5].map(() => up('SSL034', 'C1'));
  ['SSL034', 'SSL040'].forEach((p) => { up(p, 'B1'); up(p, 'B2', '1.3'); up(p, 'B3', '1.6'); up(p, 'B4', '1.5'); });
  up('SSL041', 'B1'); // Kurang gambar
  ['B1', 'B2', 'B3', 'B4'].forEach((t) => up('SSL045', t, t === 'B1' ? undefined : '1.2'));
  up('SSL045', 'B1'); // two Korek -> Perlu pilih gambar
  await page.goto(base + '/#/tiang/SSL034');
  await page.waitForSelector('[data-act=chooseReport][data-type=C1]');
  assert.match(await page.textContent('.tile:has([data-type=C1])'), /perlu pilih/, '5 progress photos: no automatic choice');
  await page.click('[data-act=chooseReport][data-type=C1]');
  await page.waitForSelector('.chooser');
  const order = [c1[4], c1[0], c1[2], c1[1]];
  for (const id of order.slice(0, 3)) await page.click(`.chooser [data-act=selTap][data-id="${id}"]`);
  assert.equal(await page.isDisabled('[data-act=selSave]'), true, 'Save disabled until exactly 4');
  await page.click(`.chooser [data-act=selTap][data-id="${order[3]}"]`);
  assert.equal(await page.textContent(`.chooser [data-id="${order[0]}"] .selno`), '1');
  await page.screenshot({ path: path.join(OUT, 'screen-chooser.png') });
  await page.click('[data-act=selSave]');
  await page.waitForSelector('#sheet', { state: 'hidden' });
  assert.deepEqual(order.map((id) => sheet('Photos').find((p) => p.PhotoID === id).ReportOrder), ['1', '2', '3', '4']);
  assert.match(await page.textContent('.tile:has([data-type=C1])'), /pilihan admin/);
  await page.click(`[data-act=viewPhoto][data-id="${c1[3]}"]`);
  await page.click('text=🔁 Ambil semula');
  await page.waitForSelector('#sheet', { state: 'hidden' });
  assert.equal(sheet('Photos').find((p) => p.PhotoID === c1[3]).RetakeFlag, 'TRUE');
  // report screen: only poles with Trial Pit photos, statuses, only Sedia can be ticked
  await page.goto(base + '/#/laporan');
  await page.click('[data-act=ract][data-val=B]');
  const ids = await page.$$eval('.rrow-main b', (e) => e.map((x) => x.textContent));
  assert.deepEqual(ids, ['SSL034', 'SSL040', 'SSL041', 'SSL045'], 'only poles with Trial Pit photos, by chainage');
  const rowText = (id) => page.textContent(`.rrow:has(input[value=${id}])`);
  assert.match(await rowText('SSL034'), /Sedia/);
  assert.match(await rowText('SSL041'), /Kurang gambar/);
  assert.match(await rowText('SSL045'), /Perlu pilih gambar/);
  assert.equal(await page.isDisabled('input[data-act=rsel][value=SSL041]'), true);
  assert.equal(await page.isDisabled('input[data-act=rsel][value=SSL045]'), true);
  await page.click('[data-act=rselReady]');
  assert.equal(await page.textContent('#nSel'), '2');
  await page.fill('#rinGen', 'RIN/TP/012');
  await page.screenshot({ path: path.join(OUT, 'screen-report-v3.png'), fullPage: true });
  await page.click('[data-act=genReport]');
  await page.waitForSelector('[data-act=download][data-format=docx]');
  const rep = sheet('Reports')[0];
  assert.equal(rep.Activity, 'B');
  assert.equal(rep.PoleIDs, 'SSL034, SSL040');
  assert.deepEqual(sheet('Poles').filter((p) => p.RINTrialPit).map((p) => p.PoleID + ':' + p.RINTrialPit), ['SSL034:RIN/TP/012', 'SSL040:RIN/TP/012']);
  // reported rows hidden by default, shown with the toggle
  assert.equal(await page.locator('input[data-act=rsel][value=SSL034]').count(), 0);
  await page.check('input[data-act=rshowReported]');
  assert.match(await rowText('SSL034'), /Dah dilaporkan/);
  for (const [format, magic] of [['pdf', '%PDF-MOCK'], ['docx', 'DOCX-MOCK']]) {
    const dl = page.waitForEvent('download');
    await page.click(`[data-act=download][data-format=${format}] >> nth=0`);
    const d = await dl;
    assert.ok(d.suggestedFilename().endsWith('.' + format));
    assert.ok(fs.readFileSync(await d.path(), 'utf8').startsWith(magic), format);
  }
  // "Perlu pilih gambar" opens the choice for that pole
  await page.click('.rrow-main[data-id=SSL045]');
  await page.click('#sheet [data-act=chooseReport][data-type=B1]');
  await page.waitForSelector('.chooser');
  await page.click('.chooser [data-act=selTap] >> nth=0');
  await page.click('[data-act=selSave]');
  await page.waitForSelector('#sheet', { state: 'hidden' });
  assert.match(await rowText('SSL045'), /Sedia/);
  assert.equal(await page.isDisabled('input[data-act=rsel][value=SSL045]'), false);
  await close();
});

test('admin: activity / photo type names; users', async () => {
  const { page, base, sheet, close } = await setup('admin@example.com');
  await page.goto(base + '/#/admin');
  await page.click('text=Aktiviti & jenis gambar');
  await page.fill('input[name=type_B2]', 'Lebar lubang');
  await page.fill('input[name=spec_B]', 'Dalam 1.5m, lebar 1m, panjang 1m (semak)');
  await page.click('#namesForm button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Disimpan');
  assert.equal(sheet('PhotoTypes').find((t) => t.TypeID === 'B2').Name, 'Lebar lubang');
  await page.goto(base + '/#/tiang/SSL040');
  await page.waitForSelector('.act');
  assert.match(await page.textContent('.tile:has([data-type=B2])'), /Lebar lubang/);
  assert.match(await page.textContent('.act >> nth=1 >> .spec'), /\(semak\)/);
  await page.goto(base + '/#/admin/pengguna');
  await page.fill('#addUser input[name=email]', 'pekerja.baru@gmail.com');
  await page.click('#addUser button[type=submit]');
  await page.waitForSelector('form[data-email="pekerja.baru@gmail.com"]');
  assert.equal(sheet('Users').find((u) => u.Email === 'pekerja.baru@gmail.com').Role, 'Team');
  await page.goto(base + '/#/admin/log');
  await page.waitForSelector('.audit tr');
  assert.match(await page.textContent('.audit'), /PhotoTypeEdited/);
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
  assert.deepEqual([r.w, r.h], [2048, 1536], 'resized to 2048 long side (v3 default)');
  assert.deepEqual(r.lines, ['21/11/2026 14:05', 'GPS: 3.12346, 101.65432  ±8 m']);
  assert.equal(r.meta.capturedAt, '2026-11-21T14:05:00+08:00');
  assert.equal(r.meta.source, 'Camera');
  assert.equal(r.meta.gpsAvailable, true);
  assert.equal(r.meta.fromGalleryLabel, false);
  assert.ok(r.box.x + r.box.w === 2048 && r.box.y + r.box.h === 1536, 'stamp in bottom-right corner');
  assert.ok(r.bandMax > 200, 'white text present in band');
  assert.ok(r.fullSize < 1200000, 'jpeg size reasonable: ' + r.fullSize);
  assert.ok(r.thumbSize < 40000);

  // 2) gallery WITH EXIF date + GPS -> EXIF values, no label, device GPS not needed
  r = await runWatermark(page, 'gallery_exif.jpg', { source: 'Gallery', now, deviceGps: dev });
  save('watermark-2-gallery-exif.jpg', r);
  assert.deepEqual([r.w, r.h], [2048, 1365]);
  assert.deepEqual(r.lines, ['20/11/2026 09:15', 'GPS: 3.21235, 101.75679']);
  assert.equal(r.meta.capturedAt, '2026-11-20T09:15:30+08:00');
  assert.equal(r.meta.gpsFrom, 'exif');
  assert.equal(r.meta.fromGalleryLabel, false);
  assert.equal(r.gpsAsked, false);

  // 3) gallery WITHOUT EXIF -> upload time + current GPS + "Dari galeri"
  r = await runWatermark(page, 'gallery_noexif.jpg', { source: 'Gallery', now, deviceGps: dev });
  save('watermark-3-gallery-noexif.jpg', r);
  assert.deepEqual([r.w, r.h], [1500, 2000], 'portrait kept, never enlarged');
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
  await page.goto(base + '/#/tiang/SSL037');
  await takePhoto(page, 'SSL037', 'A1', 'camera', 'camera_noexif.jpg');
  await waitSynced(page);
  const p = sheet('Photos').find((x) => x.PoleID === 'SSL037');
  assert.equal(p.GPSAvailable, 'FALSE');
  assert.equal(p.Latitude, '');
  await close();
});

test('installed app picks up config.js edited later on GitHub (network-first), and still opens offline', async () => {
  const { page, base, ctx, srv, close } = await setup('team@example.com');
  await page.goto(base + '/#/dashboard');
  await page.waitForSelector('.stats');
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller);
  assert.equal(await page.evaluate(() => window.SOLAR_CONFIG.marker), 'v1');
  srv.flags.configMarker = 'v2';
  await page.reload();
  await page.waitForSelector('.stats');
  assert.equal(await page.evaluate(() => window.SOLAR_CONFIG.marker), 'v2');
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.stats');
  assert.equal(await page.evaluate(() => window.SOLAR_CONFIG.marker), 'v2', 'cached copy used offline');
  await ctx.setOffline(false);
  await close();
});
