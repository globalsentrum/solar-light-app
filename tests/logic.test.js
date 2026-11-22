'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../shared/logic.js');
const { readPoles, DEFAULT_SLOTS } = require('../scripts/import-xlsx.js');

const XLSX_PATH = path.join(__dirname, '..', 'data', 'Solar_Street_Lighting_Installation_Planning_1.xlsx');
const slots = DEFAULT_SLOTS.map((s) => ({ ...s }));
const pole = (o) => ({ PoleID: 'SL-100', Bound: 'EB', Chainage: 'CH.40000', ChainageExact: true, Category: L.CATEGORY.TODO, IsDone: false, ...o });
let n = 0;
const photo = (o) => ({ PhotoID: 'P' + (++n), PoleID: 'SL-100', SlotID: 'S1', Hidden: false, RetakeFlag: false, SelectedForReport: false, CapturedAt: '2026-11-21T10:00:' + String(n % 60).padStart(2, '0') + '+08:00', ...o });
const allSlots = (o) => slots.map((s) => photo({ SlotID: s.SlotID, ...o }));

test('shared logic copies are identical (frontend + Apps Script)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../shared/logic.js'), 'utf8');
  assert.equal(fs.readFileSync(path.join(__dirname, '../docs/js/logic.js'), 'utf8'), src);
  assert.equal(fs.readFileSync(path.join(__dirname, '../apps-script/Logic.gs'), 'utf8'), src);
});

test('chainage exact detection', () => {
  assert.equal(L.isChainageExact('CH.40045'), true);
  assert.equal(L.isChainageExact(' CH.40045 '), true);
  assert.equal(L.isChainageExact('CH.42400 – CH.42600'), false);
  assert.equal(L.isChainageExact('CH.4004'), false);
  assert.equal(L.isChainageExact('CH.400455'), false);
  assert.equal(L.isChainageExact('ch.40045'), false);
  assert.equal(L.isChainageExact('CH 40045'), false);
  assert.equal(L.isChainageExact(''), false);
  assert.equal(L.isChainageExact(null), false);
});

test('chainage sort key uses first number', () => {
  assert.equal(L.chainageSortKey('CH.42400 – CH.42600'), 42400);
  assert.equal(L.chainageSortKey('CH.39320'), 39320);
  const sorted = L.sortPolesByChainage([pole({ PoleID: 'A', Chainage: 'CH.42000' }), pole({ PoleID: 'B', Chainage: 'CH.39000 – CH.39100' })]);
  assert.deepEqual(sorted.map((p) => p.PoleID), ['B', 'A']);
});

test('import totals from the xlsx: 123 = 33 + 44 + 46, EB 54 / WB 69', () => {
  const poles = readPoles(XLSX_PATH);
  const c = (f) => poles.filter(f).length;
  assert.equal(poles.length, 123);
  assert.equal(c((p) => p.Category === 'Sudah dipasang'), 33);
  assert.equal(c((p) => p.Category === 'Perlu pasang'), 44);
  assert.equal(c((p) => p.Category === 'Tunggu kelulusan'), 46);
  assert.equal(c((p) => p.Bound === 'EB'), 54);
  assert.equal(c((p) => p.Bound === 'WB'), 69);
  assert.equal(poles[0].PoleID, 'SL-001');
  assert.equal(poles[122].PoleID, 'SL-123');
  // SL-056..SL-060 stay in Perlu pasang but are "CH belum tepat"
  ['SL-056', 'SL-057', 'SL-058', 'SL-059', 'SL-060'].forEach((id) => {
    const p = poles.find((x) => x.PoleID === id);
    assert.equal(p.Category, 'Perlu pasang');
    assert.equal(p.ChainageExact, false);
    assert.equal(p.Chainage, 'CH.42400 – CH.42600');
  });
  assert.equal(c((p) => !p.ChainageExact), 51);
  assert.equal(c((p) => p.Category === 'Tunggu kelulusan' && p.ChainageExact), 0);
  // Installed => IsDone, dates kept as text
  assert.ok(poles.filter((p) => p.Category === 'Sudah dipasang').every((p) => p.IsDone === true));
  assert.equal(poles.find((p) => p.PoleID === 'SL-034').PlannedDate, '2026-11-18');
  assert.equal(poles.find((p) => p.PoleID === 'SL-041').PlannedDate, '');
  // Zone not imported
  assert.ok(!('Zone' in poles[0]));
  // Seed file generated from the same data
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname, '../data/poles.json'), 'utf8')), poles);
});

test('work status: categories', () => {
  assert.equal(L.workStatus(pole({ Category: 'Sudah dipasang', IsDone: false }), []), 'Siap');
  assert.equal(L.workStatus(pole({ Category: 'Tunggu kelulusan' }), [photo({})]), 'Tunggu kelulusan');
});

test('work status: Belum mula / Dalam proses / Siap / Batal siap', () => {
  assert.equal(L.workStatus(pole(), []), 'Belum mula');
  assert.equal(L.workStatus(pole(), [photo({ PoleID: 'SL-999' })]), 'Belum mula', 'photos of other poles ignored');
  assert.equal(L.workStatus(pole(), [photo({ Hidden: true })]), 'Belum mula', 'hidden photo does not count');
  assert.equal(L.workStatus(pole(), [photo({ RetakeFlag: true })]), 'Dalam proses', 'flagged photo is still visible');
  assert.equal(L.workStatus(pole(), [photo({})]), 'Dalam proses');
  assert.equal(L.workStatus(pole({ IsDone: true }), []), 'Siap', 'Siap can be pressed with no photos');
  assert.equal(L.workStatus(pole({ IsDone: 'TRUE' }), [photo({})]), 'Siap', 'sheet text TRUE');
  // cancel Siap -> back to computed state
  assert.equal(L.workStatus(pole({ IsDone: false }), [photo({})]), 'Dalam proses');
  assert.equal(L.workStatus(pole({ IsDone: 'FALSE' }), []), 'Belum mula');
});

test('photo status: Lengkap needs every active slot with a visible non-flagged photo', () => {
  assert.equal(L.photoStatus(pole(), slots, []).label, 'Belum lengkap (0/7)');
  const full = allSlots({});
  const ps = L.photoStatus(pole(), slots, full);
  assert.equal(ps.complete, true);
  assert.equal(ps.label, 'Lengkap');
  // hide one -> 6/7
  const hid = full.map((p, i) => (i === 6 ? { ...p, Hidden: true } : p));
  assert.equal(L.photoStatus(pole(), slots, hid).label, 'Belum lengkap (6/7)');
  assert.deepEqual(L.photoStatus(pole(), slots, hid).missing, ['Ujian lampu']);
  // flag one -> 6/7, listed as retake
  const flag = full.map((p, i) => (i === 2 ? { ...p, RetakeFlag: true } : p));
  const fs2 = L.photoStatus(pole(), slots, flag);
  assert.equal(fs2.label, 'Belum lengkap (6/7)');
  assert.deepEqual(fs2.retake, ['Ukuran']);
  // retake taken: flagged + new good photo in same slot -> complete again
  const fixed = flag.concat([photo({ SlotID: 'S3' })]);
  assert.equal(L.photoStatus(pole(), slots, fixed).complete, true);
  // independence: Siap with 6/7
  const p6 = pole({ IsDone: true });
  assert.equal(L.workStatus(p6, hid), 'Siap');
  assert.equal(L.photoStatus(p6, slots, hid).label, 'Belum lengkap (6/7)');
});

test('photo status uses active slots only', () => {
  const s2 = slots.map((s) => (s.SlotID === 'S7' ? { ...s, Active: false } : s));
  const six = slots.filter((s) => s.SlotID !== 'S7').map((s) => photo({ SlotID: s.SlotID }));
  assert.equal(L.photoStatus(pole(), s2, six).label, 'Lengkap');
  assert.equal(L.photoStatus(pole(), s2, []).label, 'Belum lengkap (0/6)');
  // photos in an inactive slot don't count toward completeness
  assert.equal(L.photoStatus(pole(), s2, [photo({ SlotID: 'S7' })]).done, 0);
  // Active as sheet text
  const s3 = slots.map((s) => ({ ...s, Active: s.SlotID === 'S1' ? 'TRUE' : 'FALSE' }));
  assert.equal(L.photoStatus(pole(), s3, [photo({ SlotID: 'S1' })]).label, 'Lengkap');
  // new slot added -> 7/8
  const s8 = slots.concat([{ SlotID: 'S8', Order: 8, Name: 'Baru', Spec: '', Active: true }]);
  assert.equal(L.photoStatus(pole(), s8, allSlots({})).label, 'Belum lengkap (7/8)');
});

test('photo status not required for other categories', () => {
  const ps = L.photoStatus(pole({ Category: 'Sudah dipasang' }), slots, allSlots({}));
  assert.equal(ps.required, false);
  assert.equal(ps.label, 'Tidak berkaitan');
  assert.equal(L.photoStatus(pole({ Category: 'Tunggu kelulusan' }), slots, []).required, false);
});

test('report photo selection', () => {
  const a = photo({ SlotID: 'S2', CapturedAt: '2026-11-21T08:00:00+08:00' });
  const b = photo({ SlotID: 'S2', CapturedAt: '2026-11-21T09:00:00+08:00' });
  const c = photo({ SlotID: 'S2', CapturedAt: '2026-11-21T10:00:00+08:00', RetakeFlag: true });
  const d = photo({ SlotID: 'S2', CapturedAt: '2026-11-21T11:00:00+08:00', Hidden: true });
  assert.equal(L.reportPhotoForSlot('SL-100', 'S2', [a, b, c, d]).PhotoID, b.PhotoID, 'latest visible non-flagged');
  assert.equal(L.reportPhotoForSlot('SL-100', 'S2', [{ ...a, SelectedForReport: true }, b, c]).PhotoID, a.PhotoID, 'admin choice wins');
  assert.equal(L.reportPhotoForSlot('SL-100', 'S2', [a, b, c, { ...d, SelectedForReport: true }]).PhotoID, b.PhotoID, 'hidden selection ignored');
  assert.equal(L.reportPhotoForSlot('SL-100', 'S2', [c]), null, 'only flagged -> none');
  assert.equal(L.reportPhotoForSlot('SL-100', 'S3', [a, b]), null);
});

test('dashboard numbers on imported data', () => {
  const poles = readPoles(XLSX_PATH);
  const d = L.dashboard(poles, slots, []);
  assert.equal(d.total, 123);
  assert.equal(d.done, 33);
  assert.equal(d.todo, 44);
  assert.equal(d.pending, 46);
  assert.equal(d.notStarted, 44);
  assert.equal(d.inProgress, 0);
  assert.equal(d.photoRequired, 44);
  assert.equal(d.photoComplete, 0);
  assert.equal(d.bound.EB.total + d.bound.WB.total, 123);
  assert.equal(d.chInexact.length, 51);
  const ph = slots.map((s) => photo({ PoleID: 'SL-034', SlotID: s.SlotID })).concat([photo({ PoleID: 'SL-035', RetakeFlag: true })]);
  const d2 = L.dashboard(poles, slots, ph);
  assert.equal(d2.photoComplete, 1);
  assert.equal(d2.inProgress, 2);
  assert.deepEqual(d2.retake, ['SL-035']);
});

test('permission matrix (Section 3)', () => {
  const matrix = {
    view: [1, 1, 1], viewPhotos: [1, 1, 1], downloadReport: [1, 1, 1],
    uploadPhoto: [1, 1, 0], addNote: [1, 1, 0], setDone: [1, 1, 0],
    editPole: [1, 0, 0], setCategory: [1, 0, 0], flagRetake: [1, 0, 0], hidePhoto: [1, 0, 0],
    selectReport: [1, 0, 0], generateReport: [1, 0, 0], manageUsers: [1, 0, 0], manageSlots: [1, 0, 0], viewAudit: [1, 0, 0],
  };
  Object.entries(matrix).forEach(([action, [a, t, b]]) => {
    assert.equal(L.can('Admin', action), !!a, 'Admin ' + action);
    assert.equal(L.can('Team', action), !!t, 'Team ' + action);
    assert.equal(L.can('Boss', action), !!b, 'Boss ' + action);
  });
  assert.equal(L.can('Stranger', 'view'), false);
  assert.equal(L.can('Admin', 'deletePhoto'), false, 'nobody can delete photos');
  // category rules
  assert.equal(L.denyReason('Team', 'uploadPhoto', pole({ Category: 'Tunggu kelulusan' })) !== '', true);
  assert.equal(L.denyReason('Team', 'uploadPhoto', pole({ Category: 'Sudah dipasang' })), '');
  assert.equal(L.denyReason('Team', 'setDone', pole({ Category: 'Sudah dipasang' })) !== '', true);
  assert.equal(L.denyReason('Team', 'addNote', pole({ Category: 'Tunggu kelulusan' })), '');
});
