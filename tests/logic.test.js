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

test('report selection: defaults (latest, C1 latest 4 oldest->newest) and admin choices', () => {
  const t = (h) => '2027-01-05T' + h + ':00+08:00';
  const a = photo({ PhotoTypeID: 'B2', MeasurementM: 1.1, CapturedAt: t('08:00') });
  const b = photo({ PhotoTypeID: 'B2', MeasurementM: 1.2, CapturedAt: t('09:00') });
  const c = photo({ PhotoTypeID: 'B2', MeasurementM: 1.3, CapturedAt: t('10:00'), RetakeFlag: true });
  const d = photo({ PhotoTypeID: 'B2', MeasurementM: 1.4, CapturedAt: t('11:00'), Hidden: true });
  const e = photo({ PhotoTypeID: 'B2', MeasurementM: '', CapturedAt: t('12:00') });
  const ids = (list) => list.map((p) => p.PhotoID);
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'B2', [a, b, c, d, e])), [b.PhotoID], 'latest visible, not flagged, with measurement');
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'B2', [{ ...a, ReportOrder: 1 }, b, c])), [a.PhotoID], 'admin choice');
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'B2', [a, b, { ...c, ReportOrder: 1 }])), [c.PhotoID], 'admin may choose a flagged photo');
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'B2', [a, b, { ...d, ReportOrder: 1 }])), [b.PhotoID], 'hidden choice ignored -> default');
  assert.equal(L.isAdminChoice('SSL900', 'B2', [{ ...a, ReportOrder: 1 }]), true);
  assert.equal(L.isAdminChoice('SSL900', 'B2', [a]), false);
  // C1: six photos
  const c1 = ['07', '08', '09', '10', '11', '12'].map((h) => photo({ PhotoTypeID: 'C1', CapturedAt: t(h + ':00') }));
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'C1', c1)), ids(c1.slice(2)), 'latest 4, oldest -> newest');
  const flagged = c1.map((p, i) => (i === 5 ? { ...p, RetakeFlag: true } : p));
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'C1', flagged)), ids(c1.slice(1, 5)));
  const order = [c1[4], c1[0], c1[5], c1[2]];
  const chosen = c1.map((p) => { const k = order.indexOf(p); return k >= 0 ? { ...p, ReportOrder: k + 1 } : p; });
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'C1', chosen)), ids(order), 'admin order kept');
  const hiddenOne = chosen.map((p) => (p.PhotoID === c1[0].PhotoID ? { ...p, Hidden: true } : p));
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'C1', hiddenOne)), ids([c1[2], c1[3], c1[4], c1[5]]), 'incomplete choice -> default');
  assert.deepEqual(ids(L.reportPhotos('SSL900', 'C1', c1.slice(0, 2))), ids(c1.slice(0, 2)), 'fewer than 4 -> what exists');
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

test('permission matrix incl. new admin actions', () => {
  const matrix = {
    view: [1, 1, 1], viewPhotos: [1, 1, 1], downloadReport: [1, 1, 1], uploadPhoto: [1, 1, 0], addNote: [1, 1, 0], setDone: [1, 1, 0],
    editPole: [1, 0, 0], setCategory: [1, 0, 0], flagRetake: [1, 0, 0], hidePhoto: [1, 0, 0], selectReport: [1, 0, 0],
    generateReport: [1, 0, 0], planWork: [1, 0, 0], manageUsers: [1, 0, 0], manageTypes: [1, 0, 0], viewAudit: [1, 0, 0],
  };
  Object.entries(matrix).forEach(([action, [a, t, b]]) => {
    assert.equal(L.can('Admin', action), !!a, 'Admin ' + action);
    assert.equal(L.can('Team', action), !!t, 'Team ' + action);
    assert.equal(L.can('Boss', action), !!b, 'Boss ' + action);
  });
  assert.equal(L.can('Admin', 'deletePhoto'), false);
  assert.notEqual(L.denyReason('Team', 'uploadPhoto', pole({ Category: 'Tunggu kelulusan' })), '');
  assert.equal(L.denyReason('Team', 'uploadPhoto', pole({ Category: 'Sudah dipasang' })), '');
  assert.notEqual(L.denyReason('Team', 'setDone', pole({ Category: 'Sudah dipasang' })), '');
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
