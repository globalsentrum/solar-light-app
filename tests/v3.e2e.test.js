'use strict';
/* v3 browser tests (Chromium) against the real PWA + real Code.gs on the Apps Script mock (dummy poles). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { chromium } = require('playwright');
const { start } = require('./e2e-server');
const L = require('../shared/logic.js');

const FIX = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, '..', 'test-output', 'v3-screens');
fs.mkdirSync(OUT, { recursive: true });
const IMG = fs.readFileSync(path.join(FIX, 'camera_noexif.jpg')).toString('base64');
const THUMB = fs.readFileSync(path.join(FIX, 'tiny.jpg')).toString('base64');

let browser;
const openEnvs = [];
test.before(async () => { browser = await chromium.launch(); });
test.afterEach(async () => { while (openEnvs.length) { const e = openEnvs.pop(); await e.ctx.close().catch(() => {}); e.srv.server.close(); } });
test.after(async () => { await browser.close(); });

async function setup(email, opts) {
  opts = opts || {};
  const srv = await start(0);
  const base = 'http://localhost:' + srv.port;
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 844 }, deviceScaleFactor: opts.scale || 1, acceptDownloads: true,
    geolocation: { latitude: 3.2, longitude: 101.7, accuracy: 6 }, permissions: ['geolocation'] });
  await ctx.route(/accounts\.google\.com|gstatic\.com/, (r) => r.abort());
  await ctx.addInitScript((t) => { if (!localStorage.getItem('solar.session')) localStorage.setItem('solar.session', t); }, srv.rt.g.issueSession_(email));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  const env = { ctx, srv };
  openEnvs.push(env);
  const sheet = (name) => srv.rt.state.sheets[name].rowsAsObjects();
  const api = (who, action, params) => JSON.parse(JSON.stringify(srv.rt.g.handle_({ action, token: srv.rt.g.issueSession_(who), ...(params || {}) })));
  let k = 0;
  const up = (pole, typeId, extra) => {
    const r = api('admin@example.com', 'uploadPhoto', { photoId: 'e3_' + String(++k).padStart(8, '0'), poleId: pole, typeId, imageB64: IMG, thumbB64: THUMB, source: 'Camera',
      capturedAt: '2027-01-05T08:' + String(k % 60).padStart(2, '0') + ':00+08:00', gpsAvailable: true, latitude: 3.1, longitude: 101.6, accuracy: 5,
      measurement: ['B2', 'B3', 'B4'].includes(typeId) ? '1.4' : undefined, ...(extra || {}) });
    assert.equal(r.ok, true, r.error);
    return r.photo.PhotoID;
  };
  const close = async () => { openEnvs.splice(openEnvs.indexOf(env), 1); await ctx.close(); srv.server.close(); assert.deepEqual(errors, [], 'no JS errors'); };
  return { srv, base, ctx, page, sheet, api, up, close };
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), fullPage: false });

test('dashboard: every card opens the schedule filtered to exactly its number of poles; cards tally', async () => {
  const s = await setup('admin@example.com');
  const { page, base, api, up } = s;
  // some variety: in progress, done (with/without night photo), override, inactive
  up('SSL034', 'A1');
  up('SSL035', 'A1'); api('team@example.com', 'setDone', { poleId: 'SSL035', done: true });
  up('SSL036', 'C3'); api('team@example.com', 'setDone', { poleId: 'SSL036', done: true });
  api('admin@example.com', 'overrideStatus', { poleId: 'SSL037', status: 'DONE' });
  api('admin@example.com', 'setPoleActive', { poleId: 'SSL038', active: false });
  await page.goto(base + '/#/dashboard');
  await page.waitForSelector('.stats');
  const cards = await page.$$eval('.stat', (els) => els.map((e) => ({ href: e.getAttribute('href'), val: Number(e.querySelector('.stat-val').textContent),
    sub: (e.querySelector('.stat-sub') || {}).textContent || '' })));
  const by = Object.fromEntries(cards.map((c) => [c.href.split('/').pop(), c]));
  assert.deepEqual(Object.keys(by), ['BAKI', 'NIGHT', 'IN_PROGRESS', 'NOT_STARTED', 'DONE', 'PENDING']);
  assert.equal(by.BAKI.val, 40, '43 active Perlu pasang - 3 Siap');
  assert.equal(by.BAKI.sub, 'daripada 43');
  assert.equal(by.NIGHT.val, 2, 'SSL035 and SSL037 (SSL036 has a night photo)');
  assert.equal(by.DONE.val + by.NOT_STARTED.val + by.IN_PROGRESS.val + by.PENDING.val, 122, 'all active poles');
  assert.equal(by.NOT_STARTED.val + by.IN_PROGRESS.val, by.BAKI.val);
  for (const c of cards) {
    await page.goto(base + '/#/dashboard');
    await page.waitForSelector('.stats');
    await page.click(`.stat[href="${c.href}"]`);
    await page.waitForSelector('.filters');
    const n = await page.$$eval('.prow', (e) => e.length);
    assert.equal(n, c.val, c.href + ' opens exactly ' + c.val + ' poles');
    if (c.href.endsWith('NIGHT')) {
      assert.deepEqual(await page.$$eval('.prow-main b', (e) => e.map((x) => x.textContent)), ['SSL035', 'SSL037'], 'sorted by chainage');
      await page.screenshot({ path: path.join(OUT, 'test-night-filter.png') });
    }
  }
  await s.close();
});

test('schedule shows the next work-plan date or "Belum dirancang" (Excel PlannedDate ignored)', async () => {
  const s = await setup('team@example.com');
  const { page, base, api, ctx } = s;
  await ctx.clock.setFixedTime(new Date(Date.UTC(2027, 0, 5, 4, 0, 0)));
  api('admin@example.com', 'addPlans', { poleIds: ['SSL034'], date: '2027-01-03', activityId: 'A' });
  api('admin@example.com', 'addPlans', { poleIds: ['SSL034'], date: '2027-01-09', activityId: 'B' });
  api('admin@example.com', 'addPlans', { poleIds: ['SSL034'], date: '2027-01-07', activityId: 'C3' });
  await page.goto(base + '/#/jadual');
  await page.click('[data-act=jtab][data-val=semua]');
  await page.waitForSelector('.prow');
  assert.match(await page.textContent('.prow:has(a[href="#/tiang/SSL034"])'), /📅 07\/01\/2027/);
  const r35 = await page.textContent('.prow:has(a[href="#/tiang/SSL035"])');
  assert.match(r35, /Belum dirancang/, 'SSL035 has a PlannedDate in the Excel data but no plan');
  assert.doesNotMatch(r35, /2027/);
  await page.goto(base + '/#/tiang/SSL034');
  await page.waitForSelector('.planlist');
  assert.match(await page.textContent('.planlist'), /07\/01\/2027 · Ujian lampu \(malam\)/);
  assert.match(await page.textContent('.planlist'), /03\/01\/2027 · Pegging \(lepas\)/);
  await s.close();
});

test('pole screen: each photo type is ONE horizontal swipe row; the screen does not grow with more photos', async () => {
  const s = await setup('admin@example.com', { scale: 2 });
  const { page, base, up } = s;
  up('SSL034', 'C1');
  await page.goto(base + '/#/tiang/SSL034');
  await page.waitForSelector('.tile:has([data-type=C1]) .strip');
  const h1 = await page.evaluate(() => [document.querySelector('.tile:has([data-type=C1])').offsetHeight, document.body.scrollHeight]);
  for (let i = 0; i < 9; i++) up('SSL034', 'C1');
  ['B2', 'B2', 'B3'].forEach((t) => up('SSL034', t));
  await page.evaluate(() => window.__solarTest.refresh());
  await page.waitForFunction(() => document.querySelectorAll('.tile:has([data-type=C1]) .thumb').length === 10);
  await page.waitForFunction(() => document.querySelectorAll('.tile:has([data-type=C1]) .thumb img').length === 10);
  const r = await page.evaluate(() => {
    const strip = document.querySelector('.tile:has([data-type=C1]) .strip');
    const tops = new Set(Array.from(strip.querySelectorAll('.thumb')).map((t) => t.getBoundingClientRect().top));
    return { tile: document.querySelector('.tile:has([data-type=C1])').offsetHeight, body: document.body.scrollHeight, rows: tops.size,
      scroll: strip.scrollWidth > strip.clientWidth, pageWide: document.documentElement.scrollWidth };
  });
  assert.equal(r.rows, 1, 'all thumbnails on one row');
  assert.ok(r.scroll, 'row scrolls sideways');
  assert.ok(Math.abs(r.tile - h1[0]) <= 2, `tile height unchanged (${h1[0]} -> ${r.tile})`);
  assert.ok(r.pageWide <= 390, 'no horizontal page scroll');
  assert.match(await page.textContent('.tile:has([data-type=C1])'), /Progress pemasangan\s*10 📷 \(min 4\)/);
  assert.deepEqual(await page.$$eval('.tile:has([data-type=B2]) .meas', (e) => e.map((x) => x.textContent)), ['1.4 m', '1.4 m'], 'measurement under each B2 thumbnail');
  await page.evaluate(() => { document.querySelector('.tile:has([data-type=C1])').scrollIntoView({ block: 'center' }); document.querySelector('.tile:has([data-type=C1]) .strip').scrollLeft = 140; });
  await shot(page, '3-pole-photo-strip.png');
  await s.close();
});

test('viewer actions: edit measurement, delete (confirm, Drive Trash), move with type change, swap two poles', async () => {
  const s = await setup('admin@example.com');
  const { page, base, sheet, up, srv } = s;
  const b2 = up('SSL034', 'B2');
  const c1 = up('SSL034', 'C1');
  const del = up('SSL034', 'A1');
  up('SSL035', 'A1');
  await page.goto(base + '/#/tiang/SSL034');
  await page.waitForSelector('.act');
  // edit measurement
  await page.click(`[data-act=viewPhoto][data-id="${b2}"]`);
  await page.click('text=📏 Edit ukuran');
  await page.fill('#measIn', '1.234');
  await page.click('[data-act=measEditSave]');
  assert.match(await page.textContent('#measErr'), /2 titik perpuluhan/);
  await page.fill('#measIn', '1,35');
  await page.click('[data-act=measEditSave]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Ukuran dikemas kini'));
  assert.equal(sheet('Photos').find((p) => p.PhotoID === b2).MeasurementM, '1.35');
  // delete
  await page.click(`[data-act=viewPhoto][data-id="${del}"]`);
  await page.click('#sheet [data-act=photoDelete]');
  assert.match(await page.textContent('#sheet'), /Trash Google Drive/);
  await page.click('[data-act=photoDeleteYes]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Gambar dipadam'));
  assert.ok(!sheet('Photos').some((p) => p.PhotoID === del));
  assert.equal(Object.values(srv.rt.state.files).filter((f) => f.name.includes(del)).every((f) => f.trashed), true);
  assert.equal(await page.locator(`[data-id="${del}"]`).count(), 0);
  // move one photo to another pole with a new type
  await page.click(`[data-act=viewPhoto][data-id="${c1}"]`);
  await page.click('text=🔀 Pindah ke tiang…');
  await page.fill('#moveTargetQ', '50');
  await page.selectOption('#moveTarget', 'SSL050');
  await page.selectOption('#moveType', 'C2');
  await page.click('[data-act=moveSave]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('dipindah ke SSL050'));
  const moved = sheet('Photos').find((p) => p.PhotoID === c1);
  assert.deepEqual([moved.PoleID, moved.PhotoTypeID], ['SSL050', 'C2']);
  // swap all photos with SSL035
  await page.click('[data-act=swapOpen]');
  await page.fill('#swapBQ', '35');
  await page.selectOption('#swapB', 'SSL035');
  await page.click('[data-act=swapSave]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('ditukar'));
  assert.deepEqual(sheet('Photos').filter((p) => p.PoleID === 'SSL034').map((p) => p.PhotoTypeID), ['A1']);
  assert.equal(sheet('Photos').find((p) => p.PhotoID === b2).PoleID, 'SSL035');
  await s.close();
});

test('pole admin in the UI: duplicate ID blocked in red, rename, add pole with CH warning, deactivate, delete blocked / confirmed', async () => {
  const s = await setup('admin@example.com');
  const { page, base, sheet, up } = s;
  await page.goto(base + '/#/tiang/SSL034/edit');
  await page.fill('input[name=PoleID]', ' ssl035 ');
  await page.click('button[type=submit]');
  assert.match(await page.textContent('#editErr'), /sudah digunakan oleh tiang SSL035/);
  assert.equal(await page.$eval('#editErr', (e) => getComputedStyle(e).color), 'rgb(180, 35, 24)', 'red message');
  await page.fill('input[name=PoleID]', 'SSL999');
  await page.fill('input[name=RINPegging]', 'RIN/P/1');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => location.hash === '#/tiang/SSL999');
  assert.ok(sheet('Poles').some((p) => p.PoleID === 'SSL999' && p.PreviousIDs === 'SSL034' && p.RINPegging === 'RIN/P/1'));
  await page.waitForSelector('.pole-head');
  assert.match(await page.textContent('.pole-head'), /ID lama: SSL034/);
  // add pole with the same CH + bound as SSL036 -> warning -> saved after confirm
  const p36 = sheet('Poles').find((p) => p.PoleID === 'SSL036');
  await page.goto(base + '/#/admin/tiang-baru');
  await page.fill('input[name=poleId]', 'SSL124');
  await page.fill('input[name=chainage]', p36.Chainage);
  await page.selectOption('select[name=bound]', p36.Bound);
  const dlg = page.waitForEvent('dialog');
  await page.click('button[type=submit]');
  assert.match((await dlg).message(), /sama dengan tiang SSL036/);
  await page.waitForFunction(() => location.hash === '#/tiang/SSL124');
  assert.ok(sheet('Poles').some((p) => p.PoleID === 'SSL124'));
  // deactivate -> hidden from schedule; reactivate
  await page.waitForSelector('[data-act=poleActive]');
  await page.click('[data-act=poleActive]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('dinyahaktif'));
  await page.goto(base + '/#/jadual');
  await page.click('[data-act=jtab][data-val=semua]');
  await page.waitForSelector('.prow');
  assert.equal(await page.locator('a[href="#/tiang/SSL124"]').count(), 0);
  await page.click('[data-act=filter][data-val=INACTIVE]');
  assert.equal(await page.locator('a[href="#/tiang/SSL124"]').count(), 1);
  // delete blocked with photos (reactivate first: photos cannot be added to an inactive pole)
  s.api('admin@example.com', 'setPoleActive', { poleId: 'SSL124', active: true });
  up('SSL124', 'A1');
  await page.goto(base + '/#/tiang/SSL124');
  await page.evaluate(() => window.__solarTest.refresh());
  await page.waitForSelector('.tile:has([data-type=A1]) .thumb');
  await page.click('[data-act=poleDelete]');
  assert.match(await page.textContent('#sheet'), /Pindah atau padam gambar dahulu \(1 gambar\)/);
  await page.click('#sheet [data-act=closeSheet] >> nth=-1');
  // delete a pole without photos (strong confirmation)
  await page.goto(base + '/#/tiang/SSL123');
  await page.waitForSelector('[data-act=poleDelete]');
  await page.click('[data-act=poleDelete]');
  await page.fill('#delConfirm', 'SSL12');
  await page.click('[data-act=poleDeleteYes]');
  await page.waitForFunction(() => document.querySelector('#overlay').hidden);
  assert.ok(sheet('Poles').some((p) => p.PoleID === 'SSL123'), 'wrong confirmation -> not deleted');
  await page.fill('#delConfirm', 'SSL123');
  await page.click('[data-act=poleDeleteYes]');
  await page.waitForFunction(() => location.hash === '#/jadual');
  assert.ok(!sheet('Poles').some((p) => p.PoleID === 'SSL123'));
  await s.close();
});

test('import (preview with errors, then import) and export (.xlsx) from the admin screens', async () => {
  const s = await setup('admin@example.com');
  const { page, base, sheet } = s;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Pole ID', 'CH', 'Bound', 'Category'],
    ['IMP01', 'CH.91000', 'EB', 'Perlu pasang'], ['IMP01', 'CH.91001', 'EB', ''], ['', 'CH.9', 'EB', ''], ['IMP02', 'CH.92000', 'XX', ''],
    ['IMP03', 'CH.93000', 'WB', 'Tunggu kelulusan'], ['SSL034', 'CH.12345', 'WB', '']]), 'Sheet1');
  const file = path.join(OUT, 'import-test.xlsx');
  XLSX.writeFile(wb, file);
  await page.goto(base + '/#/admin/import');
  await page.setInputFiles('#importFile', file);
  await page.waitForSelector('.imp-table');
  assert.match(await page.textContent('#view'), /Baru: 1 · Sudah ada: 1 · Ralat: 4/);
  assert.equal(sheet('Poles').length, 123, 'preview saves nothing');
  await page.screenshot({ path: path.join(OUT, 'test-import-preview.png'), fullPage: true });
  await page.click('[data-act=importSave]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('langkau') || true);
  await page.selectOption('#impExisting', 'skip');
  const dl = page.waitForEvent('dialog');
  await page.click('[data-act=importSave]');
  await dl;
  await page.waitForFunction(() => location.hash === '#/admin');
  assert.equal(sheet('Poles').length, 124);
  assert.ok(sheet('Poles').some((p) => p.PoleID === 'IMP03'));
  const exp = page.waitForEvent('download');
  await page.click('[data-act=exportData]');
  const d = await exp;
  const x = XLSX.readFile(await d.path());
  const rows = XLSX.utils.sheet_to_json(x.Sheets[x.SheetNames[0]]);
  assert.equal(rows.length, 124);
  assert.ok('Work status' in rows[0] && 'Next planned date' in rows[0] && 'RIN Installation' in rows[0]);
  await s.close();
});

test('roles screen: create a custom role in the UI; its user sees only what it may do (also on the backend)', async () => {
  const s = await setup('admin@example.com', { scale: 2 });
  const { page, base, sheet, srv } = s;
  await page.goto(base + '/#/admin/peranan');
  await page.waitForSelector('.role-form');
  assert.equal(await page.locator('.role-form').first().locator('input[name=perm]:disabled').count(), L.ALL_PERMISSIONS.length, 'Admin locked');
  const f = page.locator('.role-form').last();
  await f.locator('input[name=name]').fill('Supervisor');
  for (const k of ['view_dashboard', 'plan_work', 'add_note']) await f.locator(`input[value=${k}]`).check();
  await f.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Peranan disimpan'));
  assert.equal(sheet('Roles').find((r) => r.RoleName === 'Supervisor').Permissions, 'view_dashboard, add_note, plan_work');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, '5-roles.png');
  await page.goto(base + '/#/admin/pengguna');
  await page.fill('#addUser input[name=email]', 'sup@example.com');
  await page.selectOption('#addUser select[name=role]', 'Supervisor');
  await page.click('#addUser button[type=submit]');
  await page.waitForSelector('form[data-email="sup@example.com"]');
  // the Supervisor's view
  const p2 = await s.ctx.newPage();
  await p2.addInitScript((t) => localStorage.setItem('solar.session', t), srv.rt.g.issueSession_('sup@example.com'));
  await p2.goto(base + '/#/tiang/SSL034');
  await p2.waitForSelector('.act');
  await p2.waitForFunction(() => window.__solar.data && window.__solar.data.user.role === 'Supervisor');
  await p2.evaluate(() => window.__solarTest.refresh());
  assert.equal(await p2.locator('[data-act=addPhoto]').count(), 0, 'no camera');
  assert.equal(await p2.locator('#noteText').count(), 1, 'notes allowed');
  assert.equal(await p2.locator('[data-act=done]').count(), 0);
  assert.equal(await p2.isHidden('[data-tab=admin]'), true);
  await p2.goto(base + '/#/jadual');
  await p2.waitForSelector('.prow');
  assert.ok(await p2.locator('.pchk').count() > 0, 'can tick poles to plan');
  assert.equal(await p2.locator('.planbar [data-act=reportFromSchedule]').count(), 0, 'no report shortcut');
  assert.equal(await p2.locator('.planbar [data-act=planOpen]').count(), 1);
  const r = JSON.parse(JSON.stringify(srv.rt.g.handle_({ action: 'uploadPhoto', token: srv.rt.g.issueSession_('sup@example.com'), photoId: 'sup_photo_01', poleId: 'SSL034', typeId: 'A1', imageB64: IMG })));
  assert.equal(r.code, 'FORBIDDEN', 'backend refuses too');
  await p2.close();
  await s.close();
});

test('labels: live 20-character counter; 20-character labels do not break layouts at 360 px', async () => {
  const s = await setup('admin@example.com', { width: 360 });
  const { page, base, up, api, sheet } = s;
  await page.goto(base + '/#/admin/tetapan');
  await page.waitForSelector('#labelsForm');
  await page.fill('input[name=lab_BAKI]', 'Baki tiang perlu dipas');
  assert.equal(await page.inputValue('input[name=lab_BAKI]'), 'Baki tiang perlu dip', 'maxlength 20');
  assert.equal(await page.textContent('.counted:has(input[name=lab_BAKI]) .cnt'), '20/20');
  const twenty = { NOT_STARTED: 'Belum dimulakan lagi', IN_PROGRESS: 'Sedang dalam proses.', DONE: 'Siap sepenuhnya 2027', NIGHT: 'Perlu gambar malam!!',
    PENDING: 'Menunggu kelulusan JK', INSTALLED: 'Sudah dipasang (lama)', BAKI: 'Baki tiang perlu dip' };
  Object.keys(twenty).forEach((k) => { twenty[k] = twenty[k].slice(0, 20).padEnd(20, '.'); });
  for (const [k, v] of Object.entries(twenty)) await page.fill('input[name=lab_' + k + ']', v);
  await page.click('#labelsForm button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Label disimpan'));
  assert.equal(sheet('Settings').find((x) => x.Key === 'Label.DONE').Value, twenty.DONE);
  // data for every screen
  up('SSL034', 'A1'); up('SSL035', 'B1'); api('team@example.com', 'setDone', { poleId: 'SSL035', done: true });
  api('admin@example.com', 'saveNames', { types: [{ TypeID: 'C1', Name: 'x'.repeat(20) }], activities: [{ ActivityID: 'B', Name: 'Trial Pit Excavation', Spec: 'Dalam 1.5m, lebar 1m, panjang 1m' }] });
  await page.evaluate(() => window.__solarTest.refresh());
  for (const route of ['#/dashboard', '#/jadual/NIGHT', '#/jadual', '#/tiang/SSL035', '#/laporan', '#/admin']) {
    await page.goto(base + '/' + route);
    await page.waitForTimeout(400);
    if (route === '#/laporan') await page.click('[data-act=ract][data-val=B]');
    if (route === '#/jadual') { await page.check('input[data-act=psel] >> nth=0'); await page.waitForSelector('.planbar.show'); }
    const r = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, over: Array.from(document.querySelectorAll('#view *'))
      .concat(Array.from(document.querySelectorAll('.planbar.show *')))
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('.strip,.seg')).map((e) => e.className || e.tagName).slice(0, 5),
      barH: (document.querySelector('.planbar.show') || { offsetHeight: 0 }).offsetHeight }));
    assert.ok(r.barH < 110, route + ' selection bar height ' + r.barH);
    const cut = await page.evaluate(() => Array.from(document.querySelectorAll('.planbar.show .btn, .prow-badges .badge, .stat-label'))
      .filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
    assert.deepEqual(cut, [], route + ' text cut off');
    assert.ok(r.w <= 360, route + ' scrollWidth ' + r.w);
    assert.deepEqual(r.over, [], route + ' elements overflowing');
    await page.screenshot({ path: path.join(OUT, 'test-360-' + route.replace(/\W+/g, '_') + '.png'), fullPage: true });
  }
  assert.match(await (async () => { await page.goto(base + '/#/dashboard'); await page.waitForSelector('.stats'); return page.textContent('.stats'); })(), /Baki tiang perlu dip/);
  await s.close();
});

test('schedule shortcut: tick poles -> Jana laporan opens the report screen with only the Sedia ones ticked', async () => {
  const s = await setup('admin@example.com', { scale: 2 });
  const { page, base, up } = s;
  ['SSL034', 'SSL040'].forEach((p) => up(p, 'A1'));
  up('SSL041', 'A1'); up('SSL041', 'A1'); // two -> must choose
  await page.goto(base + '/#/jadual');
  await page.waitForSelector('.prow');
  for (const id of ['SSL034', 'SSL040', 'SSL041', 'SSL050']) await page.check(`.prow:has(a[href="#/tiang/${id}"]) input[data-act=psel]`);
  await page.click('[data-act=reportFromSchedule]');
  await page.waitForSelector('.rrow');
  const ticked = await page.$$eval('input[data-act=rsel]:checked', (e) => e.map((x) => x.value));
  assert.deepEqual(ticked.sort(), ['SSL034', 'SSL040']);
  assert.equal(await page.textContent('#nSel'), '2');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, '4-report-screen.png');
  await s.close();
});

test('phone screenshots for review: dashboard and schedule', async () => {
  const s = await setup('admin@example.com', { scale: 2 });
  const { page, base, up, api } = s;
  up('SSL034', 'A1'); up('SSL035', 'A1'); api('team@example.com', 'setDone', { poleId: 'SSL035', done: true });
  api('admin@example.com', 'addPlans', { poleIds: ['SSL036', 'SSL034'], date: L.klDate(Date.now(), 1), activityId: 'B' });
  await page.goto(base + '/#/dashboard');
  await page.waitForSelector('.stats');
  await shot(page, '1-dashboard.png');
  await page.goto(base + '/#/jadual');
  await page.waitForSelector('.prow');
  await page.check('.prow:has(a[href="#/tiang/SSL034"]) input[data-act=psel]');
  await page.evaluate(() => window.scrollTo(0, document.querySelector('.prow:has(a[href="#/tiang/SSL034"])').offsetTop - 300));
  await shot(page, '2-schedule.png');
  api('admin@example.com', 'saveLabels', { labels: { DONE: 'Siap sepenuhnya 2027' } });
  await page.goto(base + '/#/admin/tetapan');
  await page.evaluate(() => window.__solarTest.refresh());
  await page.waitForSelector('#labelsForm');
  await page.fill('input[name=lab_BAKI]', 'Baki tiang perlu dipasang');
  await shot(page, '6-settings-labels.png');
  await s.close();
});

// ------------------------------------------------------------------ photo quality (v3 addition)
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** A 12 MP phone-like test picture made in the browser: 'scene' (detailed outdoor-like) or 'noise' (worst case). */
async function makePhoto(page, kind) {
  return page.evaluate(async (kind) => {
    const c = document.createElement('canvas'); c.width = 4032; c.height = 3024;
    const x = c.getContext('2d');
    let seed = 42; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const g = x.createLinearGradient(0, 0, 0, 3024); g.addColorStop(0, '#8fb8e0'); g.addColorStop(0.45, '#d8e4ee'); g.addColorStop(0.5, '#6d7a52'); g.addColorStop(1, '#4b4030');
    x.fillStyle = g; x.fillRect(0, 0, 4032, 3024);
    for (let i = 0; i < 6000; i++) { // gravel, grass, leaves
      x.fillStyle = `hsl(${Math.floor(rnd() * 360)},${20 + rnd() * 40}%,${20 + rnd() * 50}%)`;
      const r = 2 + rnd() * 30; x.beginPath(); x.arc(rnd() * 4032, 1400 + rnd() * 1624, r, 0, 7); x.fill();
    }
    x.fillStyle = '#cfcfcf'; x.fillRect(1950, 300, 70, 2400); // pole
    const img = x.getImageData(0, 0, 4032, 3024); const d = img.data;
    const amp = kind === 'noise' ? 255 : 18; // sensor noise; 'noise' = every pixel random (worst case for JPEG)
    for (let i = 0; i < d.length; i += 4) {
      if (kind === 'noise') { d[i] = rnd() * 255; d[i + 1] = rnd() * 255; d[i + 2] = rnd() * 255; }
      else { const n = (rnd() - 0.5) * amp; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    }
    x.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    window.__testPhoto = window.__testPhoto || {};
    window.__testPhoto[kind] = blob;
    return blob.size;
  }, kind);
}
async function processSize(page, kind, maxSide, quality) {
  return page.evaluate(async ({ kind, maxSide, quality }) => {
    const res = await SolarWatermark.process(new File([window.__testPhoto[kind]], 'p.jpg', { type: 'image/jpeg' }), {
      source: 'Camera', now: new Date('2027-01-05T06:05:00Z'), maxSide, quality, getDeviceGps: async () => ({ lat: 3.1, lng: 101.6, acc: 5 }) });
    const b64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1].length); fr.readAsDataURL(res.full); });
    return { w: res.width, h: res.height, bytes: res.full.size, b64, thumb: res.thumb.size, box: res.stamp.box };
  }, { kind, maxSide, quality });
}

test('photo quality: 12 MP photo -> 2048 px / 0.88 by default; upload sizes measured; watermark scales; max setting stays under the upload limit', async () => {
  const s = await setup('team@example.com');
  const { page, base } = s;
  await page.goto(base + '/#/jadual');
  await page.waitForSelector('.seg');
  await makePhoto(page, 'scene');
  await makePhoto(page, 'noise');
  const oldV2 = await processSize(page, 'scene', 1600, 0.8);
  const def = await processSize(page, 'scene', undefined, undefined);
  const max = await processSize(page, 'scene', 3000, 0.95);
  const min = await processSize(page, 'scene', 1280, 0.6);
  const worst = await processSize(page, 'noise', 3000, 0.95);
  const kb = (n) => Math.round(n / 1024) + ' KB';
  const table = { 'v2 (1600 / 0.8)': oldV2, 'v3 default (2048 / 0.88)': def, 'minimum (1280 / 0.6)': min, 'maximum (3000 / 0.95)': max, 'worst case noise (3000 / 0.95)': worst };
  fs.writeFileSync(path.join(OUT, 'photo-sizes.json'), JSON.stringify(Object.fromEntries(Object.entries(table).map(([k, v]) => [k, { size: v.w + 'x' + v.h, jpeg: kb(v.bytes), upload_base64: kb(v.b64) }])), null, 1));
  assert.deepEqual([def.w, def.h], [2048, 1536]);
  assert.deepEqual([max.w, max.h], [3000, 2250]);
  assert.deepEqual([min.w, min.h], [1280, 960]);
  assert.ok(def.bytes > oldV2.bytes, 'higher quality = bigger file');
  assert.ok(def.bytes < 2.5 * 1024 * 1024, 'default photo < 2.5 MB: ' + kb(def.bytes));
  assert.ok(worst.bytes < 15 * 1024 * 1024, 'even the worst case at the maximum setting fits the 15 MB server limit: ' + kb(worst.bytes));
  assert.ok(def.thumb < 40000 && max.thumb < 40000, 'thumbnail size unchanged');
  // watermark text scales with the photo: same share of the long side at every size
  const share = (r) => r.box.h / Math.max(r.w, r.h);
  assert.ok(Math.abs(share(def) - share(oldV2)) < 0.004 && Math.abs(share(max) - share(oldV2)) < 0.004, [share(oldV2), share(def), share(max)].join(' / '));
  assert.ok(def.box.h > oldV2.box.h && max.box.h > def.box.h, 'bigger photo -> bigger stamp');
  await s.close();
});

test('photo quality setting: admin edits in Settings (range enforced); new photos use it, existing photos unchanged; offline queue still works', async () => {
  const s = await setup('admin@example.com');
  const { page, base, ctx, srv, sheet } = s;
  const fileDims = (photoId) => {
    const p = sheet('Photos').find((x) => x.PhotoID === photoId);
    return jpegSize(srv.rt.state.files[p.DriveFileID].buf);
  };
  const take = async (pole, typeId) => {
    const chooser = page.waitForEvent('filechooser');
    await page.locator(`button[data-act=addPhoto][data-type="${typeId}"]`).click();
    await page.click('text=📷 Kamera');
    (await chooser).setFiles(path.join(FIX, 'big-photo.jpg'));
    await page.waitForFunction(() => { const t = document.querySelector('#toast'); return !t.hidden && t.textContent.includes('Gambar disimpan'); }, null, { timeout: 60000 });
    await page.evaluate(() => { document.querySelector('#toast').hidden = true; });
  };
  // a 12 MP source file on disk for the file chooser
  await page.goto(base + '/#/jadual');
  await page.waitForSelector('.seg');
  await makePhoto(page, 'scene');
  const b64 = await page.evaluate(async () => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(window.__testPhoto.scene); }));
  fs.writeFileSync(path.join(FIX, 'big-photo.jpg'), Buffer.from(b64, 'base64'));
  try {
    // photo with the default setting
    await page.goto(base + '/#/tiang/SSL034');
    await page.waitForSelector('.act');
    await take('SSL034', 'A1');
    await page.waitForFunction(() => document.querySelector('#syncBtn').textContent.includes('Semua disimpan'), null, { timeout: 60000 });
    const first = sheet('Photos')[0].PhotoID;
    assert.deepEqual(fileDims(first), { w: 2048, h: 1536 });
    // settings screen: out-of-range refused, then 2600 / 0.9
    await page.goto(base + '/#/admin/tetapan');
    await page.waitForSelector('#photoForm');
    assert.equal(await page.inputValue('#photoForm input[name=maxSide]'), '2048');
    assert.equal(await page.inputValue('#photoForm input[name=quality]'), '0.88');
    await page.fill('#photoForm input[name=maxSide]', '3500');
    await page.click('#photoForm button[type=submit]');
    assert.match(await page.textContent('#photoErr'), /1280–3000/);
    await page.fill('#photoForm input[name=maxSide]', '2600');
    await page.fill('#photoForm input[name=quality]', '0.9');
    await page.click('#photoForm button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Tetapan gambar disimpan'));
    assert.equal(sheet('Settings').find((x) => x.Key === 'PhotoMaxSide').Value, '2600');
    await page.evaluate(() => { document.querySelector('#toast').hidden = true; window.scrollTo(0, document.querySelector('#photoForm').offsetTop - 70); });
    await page.screenshot({ path: path.join(OUT, '7-photo-quality-settings.png') });
    // OFFLINE: the phone uses the setting it already has; queue 2 big photos + reload while offline
    await page.goto(base + '/#/tiang/SSL035');
    await page.waitForSelector('.act');
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller);
    await ctx.setOffline(true);
    await take('SSL035', 'C1');
    await take('SSL035', 'C1');
    assert.equal(await page.textContent('#syncBtn'), '⏳ 2 item menunggu line');
    const queued = await page.evaluate(async () => (await SolarDB.queueAll()).map((i) => i.image.byteLength));
    assert.equal(queued.length, 2);
    await page.reload();
    await page.waitForSelector('.act');
    assert.equal(await page.textContent('#syncBtn'), '⏳ 2 item menunggu line');
    assert.equal(await page.locator('.tile:has([data-type=C1]) .tb.wait').count(), 2);
    assert.equal(sheet('Photos').filter((p) => p.PoleID === 'SSL035').length, 0);
    srv.flags.dropNextResponse = 1; // a lost reply: retried, never duplicated
    await ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => document.querySelector('#syncBtn').textContent.includes('Semua disimpan'), null, { timeout: 60000 });
    const newOnes = sheet('Photos').filter((p) => p.PoleID === 'SSL035');
    assert.equal(newOnes.length, 2, 'no duplicate');
    newOnes.forEach((p) => assert.deepEqual(fileDims(p.PhotoID), { w: 2600, h: 1950 }, 'new photos use the new setting'));
    const sizes = newOnes.map((p) => srv.rt.state.files[p.DriveFileID].buf.length);
    assert.deepEqual(sizes.slice().sort(), queued.slice().sort(), 'uploaded bytes = queued bytes');
    assert.deepEqual(fileDims(first), { w: 2048, h: 1536 }, 'existing photo unchanged');
    // Team cannot see / change it
    const r = JSON.parse(JSON.stringify(srv.rt.g.handle_({ action: 'savePhotoSettings', token: srv.rt.g.issueSession_('team@example.com'), maxSide: 3000, quality: 0.95 })));
    assert.equal(r.code, 'FORBIDDEN');
  } finally {
    fs.unlinkSync(path.join(FIX, 'big-photo.jpg'));
  }
  await s.close();
});
