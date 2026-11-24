'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../shared/logic.js');
const { readPoles } = require('../scripts/import-xlsx.js');
const { writeDummyXlsx } = require('./fixtures/dummy-data');

const types = L.photoTypes();
const acts = L.activities();
const pole = (o) => ({ PoleID: 'SSL900', Bound: 'EB', Chainage: 'CH.99000', ChainageExact: true, Category: L.CATEGORY.TODO, IsDone: false, ...o });
let n = 0;
const photo = (o) => {
  n++;
  return { PhotoID: 'P' + String(n).padStart(4, '0'), PoleID: 'SSL900', PhotoTypeID: 'A1', Hidden: false, RetakeFlag: false, ReportOrder: 0,
    MeasurementM: '', CapturedAt: '2027-01-05T10:' + String(n % 60).padStart(2, '0') + ':00+08:00', ...o };
};
/** Every type at its minimum, with measurements. */
const complete = (o) => {
  const out = [];
  L.PHOTO_TYPES.forEach((t) => { for (let i = 0; i < t.MinPhotos; i++) out.push(photo({ PhotoTypeID: t.TypeID, MeasurementM: t.NeedsMeasurement ? 1.2 : '', ...o })); });
  return out;
};

test('shared logic copies are identical (frontend + Apps Script)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../shared/logic.js'), 'utf8');
  assert.equal(fs.readFileSync(path.join(__dirname, '../docs/js/logic.js'), 'utf8'), src);
  assert.equal(fs.readFileSync(path.join(__dirname, '../apps-script/Logic.gs'), 'utf8'), src);
});

test('activities and photo types: fixed IDs/rules, admin names override only the name/spec', () => {
  assert.deepEqual(L.PHOTO_TYPES.map((t) => t.TypeID), ['A1', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3']);
  assert.deepEqual(L.PHOTO_TYPES.map((t) => t.MinPhotos), [1, 1, 1, 1, 1, 4, 1, 1]);
  assert.deepEqual(L.PHOTO_TYPES.filter((t) => t.NeedsMeasurement).map((t) => t.TypeID), ['B2', 'B3', 'B4']);
  assert.equal(L.activities()[1].Spec, 'Dalam 1.5m, lebar 1m, panjang 1m');
  const t2 = L.photoTypes([{ TypeID: 'B2', Name: 'Lebar lubang', MinPhotos: 99 }]);
  assert.equal(t2.find((t) => t.TypeID === 'B2').Name, 'Lebar lubang');
  assert.equal(t2.find((t) => t.TypeID === 'B2').MinPhotos, 1, 'minimum cannot be changed from the sheet');
  const a2 = L.activities([{ ActivityID: 'B', Name: 'Lubang Cubaan', Spec: 'baru' }]);
  assert.equal(a2[1].Name, 'Lubang Cubaan');
  assert.equal(a2[1].Spec, 'baru');
  assert.equal(L.photoTypes([{ TypeID: 'A1', Name: '  ' }])[0].Name, 'Pegging', 'blank name keeps default');
});

test('pole IDs: SL-034 -> SSL034, search by number', () => {
  assert.equal(L.poleIdFromLegacy('SL-034'), 'SSL034');
  assert.equal(L.poleIdFromLegacy('SSL034'), 'SSL034');
  assert.equal(L.poleIdFromLegacy('SL-34'), null);
  assert.equal(L.poleIdFromLegacy('XX'), null);
  assert.equal(L.isPoleId('SSL123'), true);
  assert.equal(L.isPoleId('SL-123'), false);
  ['SSL034', 'ssl034', '34', '034', 'SL-034', 'ssl34'].forEach((q) => assert.equal(L.poleMatchesQuery('SSL034', q), true, q));
  assert.equal(L.poleMatchesQuery('SSL134', '34'), true, 'substring of digits still matches');
  assert.equal(L.poleMatchesQuery('SSL035', '34'), false);
  assert.equal(L.poleMatchesQuery('SSL050', 'SSL05'), true, 'prefix while typing');
  assert.equal(L.poleMatchesQuery('SSL005', 'SSL05'), true, 'padded form');
  assert.equal(L.poleMatchesQuery('SSL060', 'SSL05'), false);
  assert.equal(L.poleMatchesQuery('SSL034', ''), true);
});

test('chainage exact detection + sort key', () => {
  assert.equal(L.isChainageExact('CH.12345'), true);
  assert.equal(L.isChainageExact('CH.12345 – CH.12445'), false);
  assert.equal(L.isChainageExact('CH.1234'), false);
  assert.equal(L.chainageSortKey('CH.12000 – CH.12100'), 12000);
});

test('measurement validation', () => {
  const ok = (s, v) => { const r = L.parseMeasurement(s); assert.equal(r.ok, true, s); assert.equal(r.value, v, s); };
  const bad = (s, re) => { const r = L.parseMeasurement(s); assert.equal(r.ok, false, s); assert.match(r.error, re, s); };
  ok('1.3', 1.3); ok('1,3', 1.3); ok(' 1.35 ', 1.35); ok('2', 2); ok('0.5', 0.5); ok('1.3m', 1.3); ok(1.5, 1.5);
  bad('', /Sila masukkan ukuran/); bad('  ', /Sila masukkan ukuran/); bad(null, /Sila masukkan ukuran/);
  bad('1.355', /maksimum 2 titik perpuluhan/); bad('abc', /tidak sah/); bad('-1', /tidak sah/); bad('1.3.4', /tidak sah/);
  bad('.5', /tidak sah/); bad('0', /lebih daripada 0/); bad('0.00', /lebih daripada 0/);
  assert.equal(L.formatMeasurement(1.3), '1.3');
  assert.equal(L.formatMeasurement('1.50'), '1.5');
  assert.equal(L.formatMeasurement(2), '2');
});

test('photo status: all minimums, C1 counts 4, progress per activity', () => {
  let ps = L.photoStatus(pole(), types, [], acts);
  assert.equal(ps.label, 'Belum lengkap');
  assert.equal(ps.detail, 'Pegging 0/1 · Trial Pit 0/4 · Installation 0/6');
  assert.equal(ps.total, 11);
  ps = L.photoStatus(pole(), types, complete(), acts);
  assert.equal(ps.complete, true);
  assert.equal(ps.label, 'Gambar lengkap');
  assert.equal(ps.detail, 'Pegging ✓ · Trial Pit ✓ · Installation ✓');
  // the example from the change request: Pegging done, Trial Pit 3/4, Installation 2/6
  const ex = [photo({ PhotoTypeID: 'A1' }), photo({ PhotoTypeID: 'B1' }), photo({ PhotoTypeID: 'B2', MeasurementM: 1 }),
    photo({ PhotoTypeID: 'B3', MeasurementM: 1 }), photo({ PhotoTypeID: 'C1' }), photo({ PhotoTypeID: 'C2' })];
  assert.equal(L.photoStatus(pole(), types, ex, acts).detail, 'Pegging ✓ · Trial Pit 3/4 · Installation 2/6');
  // C1 needs 4: 3 progress photos -> 3/6 with C2+C3 missing; extra photos above minimum do not over-count
  const c1 = [1, 2, 3, 4, 5, 6].map(() => photo({ PhotoTypeID: 'C1' }));
  assert.equal(L.photoStatus(pole(), types, c1, acts).activities[2].done, 4);
  assert.equal(L.photoStatus(pole(), types, c1.slice(0, 3), acts).activities[2].done, 3);
  assert.ok(L.photoStatus(pole(), types, c1.slice(0, 3), acts).missing.includes('Progress pemasangan (3/4)'));
});

test('photo status: hidden, Ambil semula and missing measurement do not count', () => {
  const all = complete();
  const idx = (t) => all.findIndex((p) => p.PhotoTypeID === t);
  const variant = (t, ch) => all.map((p, i) => (i === idx(t) ? { ...p, ...ch } : p));
  assert.equal(L.photoStatus(pole(), types, variant('A1', { Hidden: true }), acts).detail, 'Pegging 0/1 · Trial Pit ✓ · Installation ✓');
  const flagged = L.photoStatus(pole(), types, variant('B1', { RetakeFlag: true }), acts);
  assert.equal(flagged.detail, 'Pegging ✓ · Trial Pit 3/4 · Installation ✓');
  assert.deepEqual(flagged.retake, ['Korek']);
  const noM = L.photoStatus(pole(), types, variant('B3', { MeasurementM: '' }), acts);
  assert.equal(noM.complete, false);
  assert.ok(noM.missing.includes('Panjang — tiada ukuran'));
  assert.equal(L.typeState('SSL900', L.typeById('B3'), variant('B3', { MeasurementM: '' })).state, 'partial');
  // flagged C1 -> 3/4; a new good C1 photo fixes it
  const c1flag = variant('C1', { RetakeFlag: true });
  assert.equal(L.photoStatus(pole(), types, c1flag, acts).activities[2].done, 5);
  assert.equal(L.photoStatus(pole(), types, c1flag.concat([photo({ PhotoTypeID: 'C1' })]), acts).complete, true);
  // retake state on a tile
  assert.equal(L.typeState('SSL900', L.typeById('A1'), [photo({ PhotoTypeID: 'A1', RetakeFlag: true })]).state, 'retake');
  assert.equal(L.typeState('SSL900', L.typeById('A1'), []).state, 'empty');
});

test('work status: unchanged rules; independent of photo status', () => {
  assert.equal(L.workStatus(pole({ Category: 'Sudah dipasang' }), []), 'Siap');
  assert.equal(L.workStatus(pole({ Category: 'Tunggu kelulusan' }), [photo({})]), 'Tunggu kelulusan');
  assert.equal(L.workStatus(pole(), []), 'Belum mula');
  assert.equal(L.workStatus(pole(), [photo({ Hidden: true })]), 'Belum mula');
  assert.equal(L.workStatus(pole(), [photo({ RetakeFlag: true })]), 'Dalam proses');
  assert.equal(L.workStatus(pole({ IsDone: 'TRUE' }), []), 'Siap');
  assert.equal(L.workStatus(pole({ IsDone: false }), [photo({})]), 'Dalam proses');
  const p = pole({ IsDone: true });
  assert.equal(L.workStatus(p, [photo({})]), 'Siap');
  assert.equal(L.photoStatus(p, types, [photo({})], acts).complete, false);
  assert.equal(L.photoStatus(pole({ Category: 'Sudah dipasang' }), types, [], acts).label, 'Tidak berkaitan');
  assert.equal(L.photoStatus(pole({ Category: 'Sudah dipasang' }), types, [], acts).required, false);
});

test('report selection v3: automatic only when exactly the required number; admin choices kept', () => {
  const t = (h) => '2027-01-05T' + h + ':00+08:00';
  const a = photo({ PhotoTypeID: 'B2', MeasurementM: 1.1, CapturedAt: t('08:00') });
  const b = photo({ PhotoTypeID: 'B2', MeasurementM: 1.2, CapturedAt: t('09:00') });
  const c = photo({ PhotoTypeID: 'B2', MeasurementM: 1.3, CapturedAt: t('10:00'), RetakeFlag: true });
  const d = photo({ PhotoTypeID: 'B2', MeasurementM: 1.4, CapturedAt: t('11:00'), Hidden: true });
  const ids = (list) => list.map((p) => p.PhotoID);
  // exactly 1 good (flagged + hidden ignored) -> automatic
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'B2', [b, c, d])), [b.PhotoID]);
  assert.equal(L.typeReportState('SSL900', 'B2', [b, c, d]).how, 'auto');
  // 2 good -> admin must choose, nothing automatic
  assert.deepEqual(L.reportPhotos('SSL900', 'B2', [a, b, c, d]), []);
  assert.equal(L.typeReportState('SSL900', 'B2', [a, b]).state, 'choose');
  // admin choice used (also a flagged photo)
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'B2', [{ ...a, ReportOrder: 1 }, b, c])), [a.PhotoID]);
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'B2', [a, b, { ...c, ReportOrder: 1 }])), [c.PhotoID]);
  // hidden choice ignored -> back to "choose" (2 good)
  assert.equal(L.typeReportState('SSL900', 'B2', [a, b, { ...d, ReportOrder: 1 }]).state, 'choose');
  // none / chosen without measurement -> short
  assert.equal(L.typeReportState('SSL900', 'B2', []).state, 'short');
  assert.equal(L.typeReportState('SSL900', 'B2', [{ ...a, MeasurementM: '', ReportOrder: 1 }]).state, 'short');
  // C1: exactly 4 -> automatic oldest->newest; 6 -> choose; 3 -> short; admin order kept
  const c1 = ['07', '08', '09', '10', '11', '12'].map((h) => photo({ PhotoTypeID: 'C1', CapturedAt: t(h + ':00') }));
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'C1', c1.slice(2))), ids(c1.slice(2)));
  assert.equal(L.typeReportState('SSL900', 'C1', c1).state, 'choose');
  assert.equal(L.typeReportState('SSL900', 'C1', c1.slice(0, 3)).state, 'short');
  const flagged = c1.map((p, i) => (i >= 4 ? { ...p, RetakeFlag: true } : p));
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'C1', flagged)), ids(c1.slice(0, 4)), '6 photos, 2 flagged -> exactly 4 good -> automatic');
  const order = [c1[4], c1[0], c1[5], c1[2]];
  const chosen = c1.map((p) => { const k = order.indexOf(p); return k >= 0 ? { ...p, ReportOrder: k + 1 } : p; });
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'C1', chosen)), ids(order));
  assert.equal(L.isAdminChoice('SSL900', 'C1', chosen), true);
  const hiddenOne = chosen.map((p) => (p.PhotoID === c1[0].PhotoID ? { ...p, Hidden: true } : p));
  assert.equal(L.typeReportState('SSL900', 'C1', hiddenOne).state, 'choose', 'incomplete choice, 5 good left -> must choose');
});

test('report missing list per activity', () => {
  const all = complete();
  ['A', 'B', 'C'].forEach((a) => assert.deepEqual(L.reportMissing(a, 'SSL900', types, all), [], a));
  assert.deepEqual(L.reportMissing('A', 'SSL900', types, []), ['Pegging (0/1 gambar)']);
  const noB4 = all.filter((p) => p.PhotoTypeID !== 'B4');
  assert.deepEqual(L.reportMissing('B', 'SSL900', types, noB4), ['Dalam (0/1 gambar)']);
  const chosenNoMeasure = all.map((p) => (p.PhotoTypeID === 'B2' ? { ...p, MeasurementM: '', ReportOrder: 1 } : p));
  assert.deepEqual(L.reportMissing('B', 'SSL900', types, chosenNoMeasure), ['Lebar (tiada ukuran)']);
  const threeC1 = all.filter((p, i) => !(p.PhotoTypeID === 'C1' && i === all.findIndex((x) => x.PhotoTypeID === 'C1')));
  assert.deepEqual(L.reportMissing('C', 'SSL900', types, threeC1), ['Progress pemasangan (3/4 gambar)']);
  assert.equal(L.reportPhotoCount('A'), 1);
  assert.equal(L.reportPhotoCount('B'), 4);
  assert.equal(L.reportPhotoCount('C'), 6);
});

test('report layout spec per activity', () => {
  const mk = (id) => complete({ PoleID: id });
  const photos = ['SSL034', 'SSL002', 'SSL010', 'SSL050'].map(mk).flat();
  const A = L.buildReportSpec('A', ['SSL034', 'SSL002', 'SSL010', 'SSL050'], types, photos);
  assert.equal(A.blocks.length, 1);
  assert.equal(A.blocks[0].title, 'PEGGING');
  assert.equal(A.blocks[0].columns, 3);
  assert.deepEqual(A.blocks[0].cells.map((c) => c.caption), ['SSL002', 'SSL010', 'SSL034', 'SSL050'], 'sorted by Pole ID');
  assert.equal(A.blocks[0].footer, 'Total pegging : 4 nos');
  const B = L.buildReportSpec('B', ['SSL034', 'SSL002', 'SSL010', 'SSL050'], types, photos);
  assert.equal(B.blocks.length, 4);
  assert.equal(B.blocks[0].title, 'TRIAL PIT EXCAVATION WORKS');
  assert.deepEqual(B.blocks[0].cells.map((c) => c.caption), ['SSL002', 'WIDTH : 1.2M', 'LENGTH : 1.2M', 'DEPTH : 1.2M']);
  assert.deepEqual(B.blocks.map((b) => b.pageBreakBefore), [false, false, false, true], '3 blocks per page');
  const C = L.buildReportSpec('C', ['SSL034', 'SSL002'], types, photos);
  assert.deepEqual(C.blocks.map((b) => b.title), ['INSTALLATION SOLAR STREET LIGHTING PROGRESS', 'INSTALLATION SOLAR STREET LIGHTING COMPLETED',
    'INSTALLATION SOLAR STREET LIGHTING PROGRESS', 'INSTALLATION SOLAR STREET LIGHTING COMPLETED']);
  assert.deepEqual(C.blocks.map((b) => b.columns), [4, 2, 4, 2]);
  assert.deepEqual(C.blocks.map((b) => b.rowCaption), ['SSL002', 'SSL002', 'SSL034', 'SSL034']);
  assert.deepEqual(C.blocks.map((b) => b.pageBreakBefore), [false, false, true, false], '1 pole per page');
  assert.ok(C.blocks[1].box.w > C.blocks[0].box.w, 'completed photos larger');
  // every block fits the usable width (523 pt)
  [A, B, C].forEach((sp) => sp.blocks.forEach((b) => assert.ok(b.columns * (b.box.w + 10) <= 595.28 - 72, b.title)));
  assert.deepEqual(L.fitBox(1600, 1200, { w: 118, h: 157 }), { w: 118, h: 89 });
  assert.deepEqual(L.fitBox(1200, 1600, { w: 118, h: 157 }), { w: 118, h: 157 });
  assert.deepEqual(L.fitBox(1200, 1600, { w: 160, h: 120 }), { w: 90, h: 120 });
});

test('Malaysia dates (UTC+8) and plans per date', () => {
  // 2027-01-05 15:59:59 UTC = 23:59:59 in Malaysia
  const before = Date.UTC(2027, 0, 5, 15, 59, 59);
  const after = Date.UTC(2027, 0, 5, 16, 0, 1); // 00:00:01 on the 6th in Malaysia
  assert.equal(L.klDate(before), '2027-01-05');
  assert.equal(L.klDate(before, 1), '2027-01-06');
  assert.equal(L.klDate(after), '2027-01-06');
  assert.equal(L.klDate(after, 1), '2027-01-07');
  assert.equal(L.klDate(Date.UTC(2027, 11, 31, 16, 0, 0)), '2028-01-01', 'year boundary');
  assert.equal(L.isIsoDate('2027-02-29'), false);
  assert.equal(L.isIsoDate('2028-02-29'), true);
  assert.equal(L.isIsoDate('06/01/2027'), false);
  const plans = [{ PlanID: '1', Date: '2027-01-06', PoleID: 'SSL001', Activity: 'A' }, { PlanID: '2', Date: '2027-01-06', PoleID: 'SSL001', Activity: 'B' },
    { PlanID: '3', Date: '2027-01-07', PoleID: 'SSL002', Activity: '' }];
  const m = L.plansForDate(plans, '2027-01-06');
  assert.deepEqual(Object.keys(m), ['SSL001']);
  assert.equal(m.SSL001.length, 2, 'several plans per pole');
});

test('import: dummy xlsx totals 123 = 33 + 44 + 46, EB 54 / WB 69, SSL IDs', () => {
  const f = writeDummyXlsx(path.join(os.tmpdir(), 'solar-test-' + process.pid + '.xlsx'));
  const poles = readPoles(f);
  const c = (fn) => poles.filter(fn).length;
  assert.equal(poles.length, 123);
  assert.equal(c((p) => p.Category === 'Sudah dipasang'), 33);
  assert.equal(c((p) => p.Category === 'Perlu pasang'), 44);
  assert.equal(c((p) => p.Category === 'Tunggu kelulusan'), 46);
  assert.equal(c((p) => p.Bound === 'EB'), 54);
  assert.equal(c((p) => p.Bound === 'WB'), 69);
  assert.equal(c((p) => !p.ChainageExact), 51);
  assert.equal(poles[0].PoleID, 'SSL001');
  assert.equal(poles[122].PoleID, 'SSL123');
  assert.ok(poles.every((p) => L.isPoleId(p.PoleID)));
  assert.ok(!('Zone' in poles[0]));
  assert.ok(poles.filter((p) => p.Category === 'Sudah dipasang').every((p) => p.IsDone === true));
});

test('import: the PRIVATE real xlsx (only if present locally — counts only)', (t) => {
  const real = path.join(__dirname, '..', 'data', 'Solar_Street_Lighting_Installation_Planning_1.xlsx');
  if (!fs.existsSync(real)) { t.skip('private xlsx not present'); return; }
  const poles = readPoles(real);
  const c = (fn) => poles.filter(fn).length;
  assert.deepEqual([poles.length, c((p) => p.Category === 'Sudah dipasang'), c((p) => p.Category === 'Perlu pasang'),
    c((p) => p.Category === 'Tunggu kelulusan'), c((p) => p.Bound === 'EB'), c((p) => p.Bound === 'WB')], [123, 33, 44, 46, 54, 69]);
  assert.ok(poles.every((p) => L.isPoleId(p.PoleID)));
});

test('dashboard numbers', () => {
  const f = writeDummyXlsx(path.join(os.tmpdir(), 'solar-test2-' + process.pid + '.xlsx'));
  const poles = readPoles(f);
  const d = L.dashboard(poles, types, [], acts);
  assert.deepEqual([d.total, d.done, d.todo, d.pending, d.notStarted, d.inProgress, d.photoRequired, d.photoComplete, d.chInexact.length],
    [123, 33, 44, 46, 44, 0, 44, 0, 51]);
  const ph = complete({ PoleID: 'SSL034' }).concat([photo({ PoleID: 'SSL035', RetakeFlag: true })]);
  const d2 = L.dashboard(poles, types, ph, acts);
  assert.equal(d2.photoComplete, 1);
  assert.equal(d2.inProgress, 2);
  assert.deepEqual(d2.retake, ['SSL035']);
});

test('permission keys + default roles = exactly the v2 powers', () => {
  const keys = ['view_dashboard', 'capture_photo', 'add_note', 'mark_done', 'plan_work', 'select_report_photos', 'generate_report', 'record_rin',
    'download_report', 'edit_pole', 'add_pole', 'delete_pole', 'import_poles', 'export_data', 'edit_measurement', 'hide_photo', 'delete_photo',
    'move_photo', 'override_status', 'manage_users', 'manage_roles', 'edit_settings', 'view_audit_log'];
  assert.deepEqual(L.ALL_PERMISSIONS, keys);
  assert.ok(L.PERMISSIONS.every((p) => p.label && p.label.length > 3), 'Malay labels');
  const role = (n) => L.DEFAULT_ROLES.find((r) => r.RoleName === n).Permissions;
  assert.deepEqual(role('Admin'), keys);
  assert.deepEqual(role('Team').sort(), ['add_note', 'capture_photo', 'download_report', 'mark_done', 'view_dashboard']);
  assert.deepEqual(role('Boss').sort(), ['download_report', 'view_dashboard']);
  assert.deepEqual(L.parsePermissions('capture_photo, add_note;bogus  mark_done,capture_photo'), ['capture_photo', 'add_note', 'mark_done']);
  assert.equal(L.can(role('Team'), 'capture_photo'), true);
  assert.equal(L.can(role('Boss'), 'capture_photo'), false);
  assert.equal(L.can(undefined, 'view_dashboard'), false);
  const T = role('Team');
  assert.notEqual(L.denyReason(T, 'capture_photo', pole({ Category: 'Tunggu kelulusan' })), '');
  assert.equal(L.denyReason(T, 'capture_photo', pole({ Category: 'Sudah dipasang' })), '');
  assert.notEqual(L.denyReason(T, 'mark_done', pole({ Category: 'Sudah dipasang' })), '');
  assert.notEqual(L.denyReason(T, 'capture_photo', pole({ Active: 'FALSE' })), '', 'inactive pole');
});

test('no real pole data in the repository test files', () => {
  const real = path.join(__dirname, '..', 'data', 'poles.json');
  if (!fs.existsSync(real)) return;
  const chainages = new Set(JSON.parse(fs.readFileSync(real, 'utf8')).map((p) => p.Chainage).filter((c) => c.length > 6));
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.js')).map((f) => path.join(__dirname, f))
    .concat(fs.readdirSync(path.join(__dirname, 'fixtures')).filter((f) => f.endsWith('.js')).map((f) => path.join(__dirname, 'fixtures', f)));
  files.forEach((f) => {
    const txt = fs.readFileSync(f, 'utf8');
    chainages.forEach((ch) => assert.ok(!txt.includes(ch), path.basename(f) + ' contains real chainage ' + ch));
  });
});

// ============================== v3 ==============================
test('v3 work status override (Perlu pasang only) and night photo status', () => {
  assert.equal(L.workStatus(pole({ StatusOverride: 'DONE' }), []), 'Siap', 'override regardless of photos');
  assert.equal(L.workStatus(pole({ StatusOverride: 'NOT_STARTED' }), [photo({})]), 'Belum mula');
  assert.equal(L.workStatus(pole({ StatusOverride: 'IN_PROGRESS', IsDone: true }), []), 'Dalam proses');
  assert.equal(L.workStatus(pole({ StatusOverride: '' , IsDone: true }), []), 'Siap');
  assert.equal(L.workStatus(pole({ Category: 'Tunggu kelulusan', StatusOverride: 'DONE' }), []), 'Tunggu kelulusan');
  // night photo
  const done = pole({ IsDone: true });
  assert.equal(L.needsNightPhoto(done, []), true);
  assert.equal(L.needsNightPhoto(done, [photo({ PhotoTypeID: 'C3' })]), false);
  assert.equal(L.needsNightPhoto(done, [photo({ PhotoTypeID: 'C3', RetakeFlag: true })]), true, 'flagged night photo does not count');
  assert.equal(L.needsNightPhoto(done, [photo({ PhotoTypeID: 'C3', Hidden: true })]), true, 'hidden does not count');
  assert.equal(L.needsNightPhoto(done, [photo({ PhotoTypeID: 'C2' })]), true, 'day photo is not a night photo');
  assert.equal(L.needsNightPhoto(pole(), []), false, 'not Siap');
  assert.equal(L.needsNightPhoto(pole({ Category: 'Sudah dipasang' }), []), false, 'Sudah dipasang never counted');
  assert.equal(L.needsNightPhoto(pole({ StatusOverride: 'DONE' }), []), true, 'override Siap counts');
});

test('v3 dashboard: card numbers always tally with the pole list, cards open exactly those poles (random data x200)', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const cats = ['Perlu pasang', 'Tunggu kelulusan', 'Sudah dipasang'];
  const ovs = ['', '', '', 'NOT_STARTED', 'IN_PROGRESS', 'DONE'];
  for (let run = 0; run < 200; run++) {
    const poles = []; const photos = [];
    const count = 5 + rnd(60);
    for (let i = 0; i < count; i++) {
      const id = 'P' + run + '_' + i;
      poles.push({ PoleID: id, Bound: rnd(2) ? 'EB' : 'WB', Chainage: 'CH.' + (10000 + rnd(9999)), ChainageExact: true, Category: cats[rnd(3)],
        IsDone: rnd(3) === 0, StatusOverride: ovs[rnd(ovs.length)], Active: rnd(8) === 0 ? 'FALSE' : 'TRUE' });
      const k = rnd(4);
      for (let j = 0; j < k; j++) photos.push(photo({ PoleID: id, PhotoTypeID: L.PHOTO_TYPES[rnd(8)].TypeID, Hidden: rnd(6) === 0, RetakeFlag: rnd(6) === 0 }));
    }
    const d = L.dashboard(poles, types, photos, acts);
    const active = poles.filter((p) => p.Active !== 'FALSE');
    assert.equal(d.total, active.length);
    assert.equal(d.done + d.notStarted + d.inProgress + d.pending, d.total, 'Siap + Belum mula + Dalam proses + Tunggu = all active');
    assert.equal(d.notStarted + d.inProgress, d.baki, 'Belum mula + Dalam proses = Baki perlu pasang');
    assert.ok(d.baki <= d.todo, 'baki daripada N');
    assert.equal(d.todo, active.filter((p) => p.Category === 'Perlu pasang').length);
    // every card opens exactly its number of poles
    const n = (key) => active.filter((p) => L.matchesFilter(p, key, photos)).length;
    assert.equal(n('BAKI'), d.baki);
    assert.equal(n('NIGHT'), d.night);
    assert.equal(n('IN_PROGRESS'), d.inProgress);
    assert.equal(n('NOT_STARTED'), d.notStarted);
    assert.equal(n('DONE'), d.done);
    assert.equal(n('PENDING'), d.pending);
    assert.equal(n('TODO'), d.todo);
    assert.equal(d.bound.EB.total + d.bound.WB.total, d.total);
  }
});

test('v3 labels: defaults, stored by key, 20-character limit', () => {
  assert.deepEqual(L.labels({}), { NOT_STARTED: 'Belum mula', IN_PROGRESS: 'Dalam proses', DONE: 'Siap', NIGHT: 'Perlu gambar malam',
    PENDING: 'Tunggu kelulusan', INSTALLED: 'Sudah dipasang', BAKI: 'Baki perlu pasang' });
  assert.equal(L.labels({ 'Label.DONE': 'Selesai' }).DONE, 'Selesai');
  assert.equal(L.labels({ 'Label.DONE': 'x'.repeat(21) }).DONE, 'Siap', 'too long -> default');
  assert.equal(L.validateLabel('x'.repeat(20)).ok, true);
  assert.match(L.validateLabel('x'.repeat(21)).error, /Maksimum 20 aksara/);
  assert.match(L.validateLabel('  ').error, /kosong/);
  assert.ok(L.photoTypes().every((t) => t.Name.length <= 20), 'default type names fit 20 chars');
  assert.equal(L.photoTypes().find((t) => t.TypeID === 'C2').Name, 'Siap pasang (siang)');
  // labels never change data: workStatus still returns the internal value
  assert.equal(L.workKey(L.workStatus(pole({ IsDone: true }), [])), 'DONE');
});

test('v3 schedule date = next work plan date (today or later), else Belum dirancang', () => {
  const plans = [{ PoleID: 'SSL001', Date: '2027-01-03' }, { PoleID: 'SSL001', Date: '2027-01-09' }, { PoleID: 'ssl001', Date: '2027-01-06' },
    { PoleID: 'SSL002', Date: '2027-01-01' }];
  assert.equal(L.nextPlanDate(plans, 'SSL001', '2027-01-05'), '2027-01-06', 'earliest upcoming, case-insensitive');
  assert.equal(L.nextPlanDate(plans, 'SSL001', '2027-01-06'), '2027-01-06', 'today counts');
  assert.equal(L.nextPlanDate(plans, 'SSL002', '2027-01-05'), '', 'only past plans -> Belum dirancang');
  assert.equal(L.nextPlanDate(plans, 'SSL003', '2027-01-05'), '');
  assert.deepEqual(L.PLAN_ACTIVITIES, ['A', 'B', 'C', 'C3']);
});

test('v3 pole ID rules', () => {
  assert.deepEqual(L.validatePoleId('  SSL999 '), { ok: true, id: 'SSL999' });
  assert.deepEqual(L.validatePoleId('TEMP 01'), { ok: true, id: 'TEMP 01' });
  assert.equal(L.validatePoleId('').ok, false);
  assert.equal(L.validatePoleId('A,B').ok, false);
  assert.equal(L.validatePoleId('A/B').ok, false);
  assert.equal(L.validatePoleId('x'.repeat(21)).ok, false);
  assert.equal(L.sameId(' ssl034', 'SSL034 '), true);
  assert.equal(L.sameId('SSL034', 'SSL035'), false);
});

test('v3 import validation: duplicates, empty IDs, bad bound / category, existing, CH+bound warning', () => {
  const existing = [{ PoleID: 'SSL001', Chainage: 'CH.10000', Bound: 'EB' }];
  const r = L.validateImport([
    { PoleID: 'NEW1', Chainage: 'CH.20000', Bound: 'eb', Category: 'Perlu pasang' },
    { PoleID: '', Chainage: 'CH.1', Bound: 'EB', Category: '' },
    { PoleID: 'NEW2', Chainage: 'CH.2', Bound: 'NB', Category: 'widening' },
    { PoleID: 'dup', Chainage: 'CH.3', Bound: 'WB', Category: 'x' },
    { PoleID: 'DUP ', Chainage: 'CH.4', Bound: 'WB', Category: 'installed' },
    { PoleID: 'ssl001', Chainage: 'CH.5', Bound: 'WB', Category: 'Tunggu kelulusan' },
    { PoleID: 'NEW3', Chainage: 'CH.10000', Bound: 'EB', Category: '' },
    { PoleID: 'NEW4', Chainage: '', Bound: 'WB', Category: 'Sudah dipasang' },
  ], existing);
  assert.deepEqual(r.map((x) => x.status), ['new', 'error', 'error', 'error', 'error', 'exists', 'new', 'error']);
  assert.equal(r[0].Bound, 'EB');
  assert.match(r[1].errors.join(), /tidak boleh kosong/);
  assert.match(r[2].errors.join(), /Bound mesti EB atau WB/);
  assert.equal(r[2].Category, 'Tunggu kelulusan', 'Widening alias');
  assert.match(r[3].errors.join(), /berulang dalam fail/);
  assert.match(r[3].errors.join(), /Kategori tidak dikenali/);
  assert.match(r[4].errors.join(), /berulang dalam fail/);
  assert.equal(r[5].existingId, 'SSL001');
  assert.equal(r[6].Category, 'Perlu pasang');
  assert.match(r[6].warnings.join(), /Kategori kosong/);
  assert.match(r[6].warnings.join(), /sama dengan SSL001/);
  assert.match(r[7].errors.join(), /CH kosong/);
});

test('v3 report row status: Sedia / Perlu pilih gambar / Kurang gambar / Dah dilaporkan', () => {
  const st = (p, list, act) => L.poleReportStatus(act || 'B', p, types, list).status;
  const trial = () => [photo({ PhotoTypeID: 'B1' }), photo({ PhotoTypeID: 'B2', MeasurementM: 1 }), photo({ PhotoTypeID: 'B3', MeasurementM: 1 }), photo({ PhotoTypeID: 'B4', MeasurementM: 1 })];
  assert.equal(st(pole(), trial()), 'ready');
  assert.equal(st(pole(), trial().concat([photo({ PhotoTypeID: 'B1' })])), 'choose');
  assert.equal(st(pole(), trial().slice(1)), 'short');
  assert.equal(st(pole(), trial().slice(1).concat([photo({ PhotoTypeID: 'B2', MeasurementM: 2 })])), 'short', 'short wins over choose');
  assert.equal(st(pole(), trial().map((p) => (p.PhotoTypeID === 'B4' ? { ...p, MeasurementM: '' } : p))), 'short', 'missing measurement');
  assert.equal(st(pole({ RINTrialPit: 'RIN-12' }), trial()), 'reported');
  assert.equal(L.poleReportStatus('B', pole({ RINTrialPit: 'RIN-12' }), types, trial()).ready, true, 'reported pole can be reported again');
  assert.equal(st(pole({ RINPegging: 'RIN-1' }), trial()), 'ready', 'RIN of another activity');
  assert.equal(L.poleReportStatus('B', pole(), types, []).hasPhotos, false);
  assert.equal(L.poleReportStatus('A', pole(), types, trial()).hasPhotos, false, 'only photos of that activity count');
  assert.deepEqual(L.reportMissing('B', 'SSL900', types, trial().concat([photo({ PhotoTypeID: 'B1' })])), ['Korek: pilih 1 daripada 2 gambar']);
});
