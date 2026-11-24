'use strict';
/* Runs the real apps-script/*.gs code against the in-memory Apps Script mock, with DUMMY poles. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createRuntime } = require('./gas-mock');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const ADMIN = 'owner@example.com', TEAM = 'team@example.com', BOSS = 'boss@example.com';
const IMG = fs.readFileSync(path.join(__dirname, 'fixtures/camera_noexif.jpg')).toString('base64');
const IMG_PORTRAIT = fs.readFileSync(path.join(__dirname, 'fixtures/gallery_noexif.jpg')).toString('base64');
const THUMB = fs.readFileSync(path.join(__dirname, 'fixtures/tiny.jpg')).toString('base64');
const json = (x) => JSON.parse(JSON.stringify(x)); // same as going over HTTP
const MEASURED = { B2: '1.3', B3: '1.6', B4: '1.5' };
let pid = 0;
let minute = 0;

function boot() {
  const idTokens = {};
  const rt = createRuntime({
    ownerEmail: ADMIN,
    urlFetch: (url) => {
      const tok = decodeURIComponent(url.split('id_token=')[1]);
      return idTokens[tok] ? { code: 200, body: JSON.stringify(idTokens[tok]) } : { code: 400, body: '{"error":"invalid_token"}' };
    },
  });
  rt.g.setup();
  rt.g.setSetting_('ClientID', CLIENT_ID);
  rt.g.setSetting_('AppURL', 'https://example.github.io/solar-light-app/');
  const tok = (email) => rt.g.issueSession_(email);
  const call = (email, action, params) => json(rt.g.handle_({ action, token: typeof email === 'string' && email.includes('@') ? tok(email) : email, ...(params || {}) }));
  const admin = (a, p) => call(ADMIN, a, p);
  assert.equal(admin('saveUser', { email: TEAM, name: 'Ali', role: 'Team' }).ok, true);
  assert.equal(admin('saveUser', { email: BOSS, name: 'Bos', role: 'Boss' }).ok, true);
  const rows = (name) => rt.state.sheets[name].rowsAsObjects();
  const upload = (email, poleId, typeId, extra) => {
    minute++;
    return call(email, 'uploadPhoto', {
      photoId: 'ph_' + (++pid).toString().padStart(6, '0'), poleId, typeId, imageB64: IMG, thumbB64: THUMB, source: 'Camera',
      capturedAt: '2027-01-05T' + String(8 + Math.floor(minute / 60) % 12).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0') + ':00+08:00',
      latitude: 3.123456, longitude: 101.654321, accuracy: 7.6, gpsAvailable: true,
      measurement: MEASURED[typeId], ...(extra || {}),
    });
  };
  /** Upload every photo type at its minimum for a pole. */
  const fill = (poleId, activity) => {
    const out = {};
    [['A1', 1], ['B1', 1], ['B2', 1], ['B3', 1], ['B4', 1], ['C1', 4], ['C2', 1], ['C3', 1]]
      .filter(([t]) => !activity || t[0] === activity)
      .forEach(([t, k]) => { out[t] = []; for (let i = 0; i < k; i++) { const r = upload(TEAM, poleId, t); assert.equal(r.ok, true, r.error); out[t].push(r.photo.PhotoID); } });
    return out;
  };
  return { rt, idTokens, tok, call, admin, rows, upload, fill };
}

function reportDoc(rt, report, which) {
  const url = which === 'docx' ? report.DocxURL : report.FileURL;
  const id = url.match(/\/d\/([^/]+)/)[1];
  const f = rt.state.files[id];
  const txt = f.buf.toString('utf8');
  return { file: f, doc: JSON.parse(txt.slice(txt.indexOf('\n') + 1)), magic: txt.slice(0, txt.indexOf('\n')) };
}
/** Flatten blocks: [{title, cells:[{img, caption}], extra:[texts]}] */
/** Drive file name of a photo (what the report inserts when there is no report copy). */
let currentRt = null;
const fileNameOf = (photoId) => {
  const p = currentRt.state.sheets.Photos.rowsAsObjects().find((x) => x.PhotoID === photoId);
  return currentRt.state.files[p.DriveFileID].name;
};
function blocksOf(doc) {
  const out = [];
  let breaks = 0;
  doc.children.forEach((n) => {
    if (n.type === 'pagebreak') breaks++;
    if (n.type !== 'table') return;
    const title = n.rows[0][0].children[0].text;
    const cell = n.rows[1][0];
    const grid = cell.children.find((c) => c.type === 'table');
    const cells = [];
    grid.rows.forEach((r) => r.forEach((c) => {
      const p0 = c.children[0];
      cells.push({ img: p0.images[0] ? p0.images[0].name : null, w: p0.images[0] && p0.images[0].w, h: p0.images[0] && p0.images[0].h,
        caption: (c.children[1] || {}).text || '', align: p0.align });
    }));
    const extra = cell.children.slice(cell.children.indexOf(grid) + 1).filter((c) => c.type === 'p' && c.text).map((c) => c.text);
    out.push({ title, bg: n.rows[0][0].bg, border: n.border, gridBorder: grid.border, cells, extra, pageBreaksBefore: breaks });
  });
  return out;
}

test('setup: tabs incl. Activities / PhotoTypes / WorkPlan, dummy poles with SSL IDs, safe to run twice', () => {
  const { rt, rows } = boot();
  rt.g.setup();
  ['Poles', 'Photos', 'Activities', 'PhotoTypes', 'WorkPlan', 'Notes', 'Users', 'AuditLog', 'Reports', 'Settings'].forEach((n) => assert.ok(rt.state.sheets[n], n));
  assert.ok(!rt.state.sheets.Slots, 'no Slots tab in v2');
  assert.deepEqual(rt.state.sheets.Photos.data[0], ['PhotoID', 'PoleID', 'PhotoTypeID', 'DriveFileID', 'FileURL', 'Source', 'CapturedAt', 'UploadedAt', 'Latitude', 'Longitude', 'AccuracyM', 'GPSAvailable', 'TakenBy', 'Hidden', 'RetakeFlag', 'ReportOrder', 'MeasurementM', 'ThumbFileID', 'ReportFileID']);
  assert.deepEqual(rt.state.sheets.WorkPlan.data[0], ['PlanID', 'Date', 'PoleID', 'Activity', 'CreatedBy', 'CreatedAt']);
  assert.deepEqual(rt.state.sheets.Reports.data[0], ['ReportID', 'PoleIDs', 'Activity', 'FileURL', 'DocxURL', 'CreatedBy', 'CreatedAt']);
  const poles = rows('Poles');
  assert.equal(poles.length, 123);
  assert.equal(poles[0].PoleID, 'SSL001');
  assert.equal(poles[122].PoleID, 'SSL123');
  assert.deepEqual(rows('Activities').map((a) => a.Name), ['Pegging', 'Trial Pit', 'Installation']);
  assert.equal(rows('Activities')[1].Spec, 'Dalam 1.5m, lebar 1m, panjang 1m');
  assert.equal(rows('PhotoTypes').length, 8);
  assert.equal(rows('Settings').find((r) => r.Key === 'ReportMaxPhotos').Value, '60');
  assert.equal(rows('Users').filter((u) => u.Role === 'Admin').length, 1);
});

test('Google sign-in redirect + sessions (Active = FALSE / removed -> blocked at once)', () => {
  const { rt, idTokens, tok, call, admin } = boot();
  const exp = String(Math.floor(Date.now() / 1000) + 600);
  idTokens.good = { aud: CLIENT_ID, iss: 'https://accounts.google.com', email: 'Team@Example.com', email_verified: 'true', exp, nonce: 'n1' };
  idTokens.wrongAud = { ...idTokens.good, aud: 'x' };
  idTokens.stranger = { ...idTokens.good, email: 'stranger@gmail.com' };
  const html = rt.g.doPost({ parameter: { credential: 'good' } }).getContent();
  const m = html.match(/#login=([^&"]+)&amp;nonce=([^"]+)"/);
  assert.ok(m);
  assert.equal(call(decodeURIComponent(m[1]), 'me').user.role, 'Team');
  for (const bad of ['wrongAud', 'stranger', 'nope']) assert.ok(rt.g.doPost({ parameter: { credential: bad } }).getContent().includes('#loginerror='), bad);
  const t = tok(TEAM);
  const [p, s] = t.split('.');
  assert.equal(call(p + '.' + s.slice(0, -2) + 'xx', 'me').code, 'AUTH');
  rt.g.setSetting_('SessionDays', '-1');
  assert.equal(call(tok(TEAM), 'me').code, 'AUTH');
  rt.g.setSetting_('SessionDays', '30');
  admin('saveUser', { email: TEAM, name: 'Ali', role: 'Team', active: false });
  assert.equal(call(t, 'bootstrap').code, 'AUTH');
  admin('saveUser', { email: TEAM, name: 'Ali', role: 'Team', active: true });
  assert.equal(call(t, 'bootstrap').ok, true);
  admin('removeUser', { email: TEAM });
  assert.equal(call(t, 'bootstrap').code, 'AUTH');
});

test('permissions enforced on the backend for every action incl. plan, photo selection, report by activity', () => {
  const { call, upload, admin, fill } = boot();
  const ph = fill('SSL034');
  const one = ph.A1[0];
  let n = 0;
  const actions = {
    bootstrap: () => ({}),
    getThumbs: () => ({ poleId: 'SSL034' }),
    getPhoto: () => ({ photoId: one }),
    uploadPhoto: () => ({ photoId: 'perm_' + (++n) + '_xxxxxxxx', poleId: 'SSL035', typeId: 'A1', imageB64: IMG, source: 'Camera', gpsAvailable: false }),
    addNote: () => ({ noteId: 'note_' + (++n), poleId: 'SSL035', text: 'ujian' }),
    setDone: () => ({ poleId: 'SSL036', done: true }),
    editPole: () => ({ poleId: 'SSL037', changes: { PlannedDate: '2027-02-0' + ((++n % 9) + 1) } }),
    setPhotoFlag: () => ({ photoId: one, field: 'RetakeFlag', value: (++n) % 2 === 0 }),
    setReportSelection: () => ({ poleId: 'SSL034', typeId: 'A1', photoIds: (++n) % 2 ? [one] : [] }),
    saveNames: () => ({ types: [{ TypeID: 'B1', Name: 'Korek ' + (++n) }] }),
    addPlans: () => ({ poleIds: ['SSL040'], date: '2027-01-0' + ((++n % 9) + 1), activityId: 'B' }),
    editPlan: () => ({ planId: 'NOPE', date: '2027-01-09', activityId: '' }),
    removePlan: () => ({ planId: 'NOPE' }),
    saveUser: () => ({ email: 'new' + (++n) + '@example.com', name: 'X', role: 'Team' }),
    audit: () => ({}),
    reportCheck: () => ({ activityId: 'A', poleIds: ['SSL034'] }),
    generateReport: () => ({ activityId: 'A', poleIds: ['SSL034'] }),
  };
  const expected = {
    Admin: Object.keys(actions),
    Team: ['bootstrap', 'getThumbs', 'getPhoto', 'uploadPhoto', 'addNote', 'setDone'],
    Boss: ['bootstrap', 'getThumbs', 'getPhoto'],
  };
  const who = { Admin: ADMIN, Team: TEAM, Boss: BOSS };
  for (const role of Object.keys(who)) {
    for (const [action, params] of Object.entries(actions)) {
      const r = call(who[role], action, params());
      if (expected[role].includes(action)) {
        // editPlan/removePlan with an unknown id: permission passed, then NOTFOUND
        if (['editPlan', 'removePlan'].includes(action)) assert.equal(r.code, 'NOTFOUND', `${role} ${action}: ${r.error}`);
        else assert.equal(r.ok, true, `${role} ${action} should be allowed: ${r.error}`);
      } else {
        assert.equal(r.code, 'FORBIDDEN', `${role} ${action} should be FORBIDDEN, got ${JSON.stringify(r).slice(0, 120)}`);
      }
    }
  }
  const rep = admin('generateReport', { activityId: 'B', poleIds: ['SSL034'] }).report;
  for (const e of [ADMIN, TEAM, BOSS]) {
    assert.equal(call(e, 'downloadReport', { reportId: rep.ReportID }).ok, true, e);
    assert.equal(call(e, 'downloadReport', { reportId: rep.ReportID, format: 'docx' }).ok, true, e);
  }
  assert.equal(call(TEAM, 'deletePhoto', { photoId: one }).code, 'FORBIDDEN', 'v3: delete exists, admin only by default');
  assert.equal(call(ADMIN, 'saveSlot', { name: 'x' }).code, 'BAD', 'old slot actions removed');
  void upload;
});

test('upload: photo types, measurement required + validated for B2-B4, idempotent', () => {
  const { rt, call, rows, upload } = boot();
  const base = { poleId: 'SSL040', imageB64: IMG, thumbB64: THUMB, source: 'Gallery', capturedAt: '2027-01-04T09:15:30+08:00',
    latitude: 3.212345, longitude: 101.756789, accuracy: 12.4, gpsAvailable: true };
  const up = (id, typeId, measurement) => call(TEAM, 'uploadPhoto', { ...base, photoId: id, typeId, measurement });
  assert.match(up('m_empty_0001', 'B2', '').error, /Sila masukkan ukuran/);
  assert.match(up('m_bad_00001', 'B3', 'abc').error, /tidak sah/);
  assert.match(up('m_dec_00001', 'B4', '1.555').error, /2 titik perpuluhan/);
  assert.match(up('m_zero_0001', 'B4', '0').error, /lebih daripada 0/);
  assert.equal(up('m_none_0001', 'B2').code, 'BAD');
  assert.equal(rows('Photos').length, 0, 'rejected photos not stored');
  const ok = up('m_ok_000001', 'B2', '1,3');
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.photo.MeasurementM, 1.3);
  assert.equal(rows('Photos')[0].MeasurementM, '1.3');
  assert.equal(rows('Photos')[0].PhotoTypeID, 'B2');
  const noNeed = up('m_a1_000001', 'A1', '9.99');
  assert.equal(noNeed.photo.MeasurementM, '', 'measurement ignored for types without one');
  assert.equal(up('m_type_0001', 'S3', '').code, 'BAD', 'old slot IDs rejected');
  // idempotent
  const filesBefore = Object.keys(rt.state.files).length;
  up('m_ok_000001', 'B2', '1,3'); up('m_ok_000001', 'B2', '1,3');
  assert.equal(rows('Photos').filter((p) => p.PhotoID === 'm_ok_000001').length, 1);
  assert.equal(Object.keys(rt.state.files).length, filesBefore);
  assert.equal(rows('AuditLog').filter((r) => r.Action === 'PhotoAdded').length, 2);
  assert.match(rows('AuditLog').find((r) => r.EntityID === 'm_ok_000001').NewValue, /SSL040\/B2 \(Gallery\) 1\.3m/);
  // stored in Solar Photos/SSL040/ with the type in the file name
  const f = rt.state.files[rows('Photos')[0].DriveFileID];
  assert.equal(rt.state.folders[f.parent].name, 'SSL040');
  assert.equal(f.name, 'SSL040_TrialPit_Lebar_2027-01-04_0915.jpg', 'v3 file name');
  // category rules unchanged
  assert.equal(upload(TEAM, 'SSL078', 'A1').code, 'FORBIDDEN', 'Tunggu kelulusan');
  assert.equal(upload(TEAM, 'SSL001', 'A1').ok, true, 'Sudah dipasang: optional photos');
  assert.equal(call(TEAM, 'setDone', { poleId: 'SSL001', done: true }).code, 'FORBIDDEN');
  assert.equal(call(TEAM, 'addNote', { noteId: 'n-pend-1', poleId: 'SSL078', text: 'ok' }).ok, true);
});

test('statuses from server data: Belum mula -> Dalam proses -> Siap / Batal siap; photo progress per activity', () => {
  const { call, upload, fill } = boot();
  const L = require('../shared/logic.js');
  const status = (id) => {
    const b = call(TEAM, 'bootstrap');
    const pole = b.poles.find((p) => p.PoleID === id);
    const ps = L.photoStatus(pole, b.types, b.photos, b.activities);
    return [L.workStatus(pole, b.photos), ps.label, ps.detail];
  };
  assert.deepEqual(status('SSL042'), ['Belum mula', 'Belum lengkap', 'Pegging 0/1 · Trial Pit 0/4 · Installation 0/6']);
  upload(TEAM, 'SSL042', 'A1');
  upload(TEAM, 'SSL042', 'C1'); upload(TEAM, 'SSL042', 'C1');
  assert.deepEqual(status('SSL042'), ['Dalam proses', 'Belum lengkap', 'Pegging ✓ · Trial Pit 0/4 · Installation 2/6']);
  call(TEAM, 'setDone', { poleId: 'SSL042', done: true });
  assert.equal(status('SSL042')[0], 'Siap');
  call(TEAM, 'setDone', { poleId: 'SSL042', done: false });
  assert.equal(status('SSL042')[0], 'Dalam proses');
  fill('SSL043');
  assert.deepEqual(status('SSL043').slice(1), ['Gambar lengkap', 'Pegging ✓ · Trial Pit ✓ · Installation ✓']);
});

test('hidden photos: Team/Boss cannot see, Admin can, unhide, never deleted', () => {
  const { call, upload, admin, rows } = boot();
  const id = upload(TEAM, 'SSL041', 'A1').photo.PhotoID;
  admin('setPhotoFlag', { photoId: id, field: 'Hidden', value: true });
  for (const e of [TEAM, BOSS]) {
    assert.equal(call(e, 'bootstrap').photos.some((p) => p.PhotoID === id), false);
    assert.equal(call(e, 'getPhoto', { photoId: id }).code, 'NOTFOUND');
  }
  assert.equal(admin('bootstrap').photos.find((p) => p.PhotoID === id).Hidden, true);
  admin('setPhotoFlag', { photoId: id, field: 'Hidden', value: false });
  assert.equal(call(TEAM, 'bootstrap').photos.some((p) => p.PhotoID === id), true);
  assert.deepEqual(rows('AuditLog').filter((r) => r.EntityID === id).map((r) => r.Action), ['PhotoAdded', 'PhotoHidden', 'PhotoUnhidden']);
});

test('report selection: exactly 1 (C1 exactly 4 in order), validation, clear, audit', () => {
  const { admin, upload, rows, fill } = boot();
  const L = require('../shared/logic.js');
  const ph = fill('SSL044');
  const extraB2 = upload(TEAM, 'SSL044', 'B2', { measurement: '1.1' }).photo.PhotoID;
  const extraC1 = [upload(TEAM, 'SSL044', 'C1').photo.PhotoID, upload(TEAM, 'SSL044', 'C1').photo.PhotoID];
  const c1 = ph.C1.concat(extraC1); // 6 photos
  const sel = (typeId, photoIds) => admin('setReportSelection', { poleId: 'SSL044', typeId, photoIds });
  assert.match(sel('B2', [ph.B2[0], extraB2]).error, /tepat 1 gambar/);
  assert.match(sel('C1', c1.slice(0, 3)).error, /tepat 4 gambar/);
  assert.match(sel('C1', [c1[0], c1[0], c1[1], c1[2]]).error, /berulang/);
  assert.match(sel('B2', [ph.B3[0]]).error, /bukan dari tiang\/jenis ini/);
  assert.equal(sel('B2', [ph.B2[0]]).ok, true);
  const order = [c1[5], c1[0], c1[3], c1[1]];
  assert.equal(sel('C1', order).ok, true);
  const photos = rows('Photos');
  assert.deepEqual(order.map((id) => photos.find((p) => p.PhotoID === id).ReportOrder), ['1', '2', '3', '4']);
  assert.equal(photos.filter((p) => p.PhotoTypeID === 'C1' && p.ReportOrder).length, 4);
  const b = admin('bootstrap');
  assert.deepEqual(L.reportPhotos('SSL044', 'C1', b.photos).map((p) => p.PhotoID), order);
  assert.deepEqual(L.reportPhotos('SSL044', 'B2', b.photos).map((p) => p.PhotoID), [ph.B2[0]], 'older photo chosen over newer default');
  // re-choose: old marks cleared
  sel('C1', [c1[0], c1[1], c1[2], c1[3]]);
  assert.equal(rows('Photos').find((p) => p.PhotoID === c1[5]).ReportOrder, '');
  // clear -> automatic
  assert.equal(sel('C1', []).ok, true);
  assert.equal(rows('Photos').filter((p) => p.ReportOrder).length, 1);
  // hidden photo cannot be chosen
  admin('setPhotoFlag', { photoId: extraB2, field: 'Hidden', value: true });
  assert.match(sel('B2', [extraB2]).error, /tersembunyi/);
  assert.deepEqual(rows('AuditLog').filter((r) => r.Action.startsWith('ReportSelection')).map((r) => r.Action + ':' + r.Field),
    ['ReportSelectionSet:B2', 'ReportSelectionSet:C1', 'ReportSelectionSet:C1', 'ReportSelectionCleared:C1']);
});

test('activity / photo type names: rename keeps photos linked; rules fixed', () => {
  const { admin, call, upload, rows } = boot();
  const id = upload(TEAM, 'SSL045', 'B2', { measurement: '1' }).photo.PhotoID;
  const r = admin('saveNames', { activities: [{ ActivityID: 'B', Name: 'Lubang Cubaan', Spec: 'Dalam 1.5m' }], types: [{ TypeID: 'B2', Name: 'Lebar lubang' }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(rows('Photos').find((p) => p.PhotoID === id).PhotoTypeID, 'B2');
  const b = call(TEAM, 'bootstrap');
  assert.equal(b.activities[1].Name, 'Lubang Cubaan');
  assert.equal(b.types.find((t) => t.TypeID === 'B2').Name, 'Lebar lubang');
  assert.equal(b.types.find((t) => t.TypeID === 'B2').NeedsMeasurement, true);
  assert.equal(admin('saveNames', { types: [{ TypeID: 'B2', Name: ' ' }] }).code, 'BAD');
  assert.equal(admin('saveNames', { types: [{ TypeID: 'Z9', Name: 'x' }] }).code, 'BAD');
  assert.deepEqual(rows('AuditLog').filter((x) => x.Action.endsWith('Edited') && ['Activity', 'PhotoType'].includes(x.Entity)).map((x) => x.Action + ':' + x.Field),
    ['ActivityEdited:Name', 'ActivityEdited:Spec', 'PhotoTypeEdited:Name']);
});

test('work plan: add several poles, several plans per pole, duplicates skipped, edit, remove, validation, audit', () => {
  const { admin, call, rows } = boot();
  let r = admin('addPlans', { poleIds: ['SSL050', 'SSL034'], date: '2027-01-06', activityId: 'B' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.added, 2);
  r = admin('addPlans', { poleIds: ['SSL034'], date: '2027-01-06', activityId: 'C' });
  assert.equal(r.added, 1, 'same pole, other activity -> new entry');
  r = admin('addPlans', { poleIds: ['SSL034'], date: '2027-01-07', activityId: '' });
  assert.equal(r.added, 1, 'same pole, other date');
  r = admin('addPlans', { poleIds: ['SSL034', 'SSL050'], date: '2027-01-06', activityId: 'B' });
  assert.deepEqual([r.added, r.skipped], [0, 2], 'exact duplicates skipped');
  const plans = rows('WorkPlan');
  assert.equal(plans.length, 4);
  assert.deepEqual(plans.filter((p) => p.PoleID === 'SSL034').map((p) => p.Date + '/' + p.Activity).sort(), ['2027-01-06/B', '2027-01-06/C', '2027-01-07/']);
  assert.equal(call(BOSS, 'bootstrap').plans.length, 4, 'everyone receives plans (offline cache)');
  assert.equal(admin('addPlans', { poleIds: ['SSL034'], date: '2027-02-30' }).code, 'BAD');
  assert.equal(admin('addPlans', { poleIds: ['SSL034'], date: '2027-02-03', activityId: 'X' }).code, 'BAD');
  assert.equal(admin('addPlans', { poleIds: ['SSL999'], date: '2027-02-03' }).code, 'NOTFOUND');
  assert.equal(admin('addPlans', { poleIds: [], date: '2027-02-03' }).code, 'BAD');
  const target = plans.find((p) => p.PoleID === 'SSL034' && p.Activity === 'C');
  assert.equal(admin('editPlan', { planId: target.PlanID, date: '2027-01-06', activityId: 'B' }).code, 'BAD', 'edit into a duplicate refused');
  assert.equal(admin('editPlan', { planId: target.PlanID, date: '2027-01-08', activityId: 'A' }).ok, true);
  assert.equal(rows('WorkPlan').find((p) => p.PlanID === target.PlanID).Date, '2027-01-08');
  assert.equal(admin('removePlan', { planId: target.PlanID }).ok, true);
  assert.equal(rows('WorkPlan').length, 3);
  const log = rows('AuditLog').filter((x) => x.Entity === 'WorkPlan').map((x) => x.Action);
  assert.deepEqual(log, ['PlanAdded', 'PlanAdded', 'PlanAdded', 'PlanAdded', 'PlanEdited', 'PlanEdited', 'PlanRemoved']);
  assert.equal(rows('AuditLog').find((x) => x.Action === 'PlanRemoved').OldValue, 'SSL034 2027-01-08 A');
});

test('reports: check lists missing poles; generate refuses incomplete poles; limit by photo count', () => {
  const { admin, upload, fill, rt } = boot();
  fill('SSL034');
  fill('SSL035', 'A');
  upload(TEAM, 'SSL036', 'B1'); upload(TEAM, 'SSL036', 'B2', { measurement: '1.2' });
  let r = admin('reportCheck', { activityId: 'B', poleIds: ['SSL036', 'SSL034', 'SSL035'] });
  assert.deepEqual(r.ready, ['SSL034']);
  assert.deepEqual(r.missing, [
    { PoleID: 'SSL035', missing: ['Korek (0/1 gambar)', 'Lebar (0/1 gambar)', 'Panjang (0/1 gambar)', 'Dalam (0/1 gambar)'] },
    { PoleID: 'SSL036', missing: ['Panjang (0/1 gambar)', 'Dalam (0/1 gambar)'] }]);
  assert.equal(r.maxPoles, 15);
  assert.equal(admin('reportCheck', { activityId: 'A', poleIds: ['SSL034'] }).maxPoles, 60);
  assert.equal(admin('reportCheck', { activityId: 'C', poleIds: ['SSL034'] }).maxPoles, 10);
  r = admin('generateReport', { activityId: 'B', poleIds: ['SSL034', 'SSL036'] });
  assert.equal(r.code, 'BAD');
  assert.match(r.error, /SSL036: Panjang \(0\/1 gambar\), Dalam \(0\/1 gambar\)/);
  assert.equal(rt.state.sheets.Reports.rowsAsObjects().length, 0);
  const sixteen = Array.from({ length: 16 }, (_, i) => 'SSL' + String(34 + i).padStart(3, '0'));
  assert.match(admin('generateReport', { activityId: 'B', poleIds: sixteen }).error, /Maksimum 15 tiang/);
  assert.equal(admin('generateReport', { activityId: 'Z', poleIds: ['SSL034'] }).code, 'BAD');
  assert.equal(admin('generateReport', { activityId: 'A', poleIds: ['SSL034', 'SSL034'] }).code, 'BAD');
  rt.g.setSetting_('ReportMaxPhotos', '8');
  assert.match(admin('generateReport', { activityId: 'B', poleIds: ['SSL034', 'SSL035', 'SSL036'] }).error, /Maksimum 2 tiang/);
});

test('reports: PEGGING / TRIAL PIT / INSTALLATION layouts, PDF + Word in Solar Reports, selection used, download', () => {
  const { rt, admin, call, upload, fill, rows } = boot();
  currentRt = rt;
  const ids = ['SSL050', 'SSL034', 'SSL040', 'SSL041'];
  const ph = {};
  ids.forEach((id) => { ph[id] = fill(id); });
  // a portrait progress photo + admin order for SSL034 C1
  const portrait = upload(TEAM, 'SSL034', 'C1', { imageB64: IMG_PORTRAIT }).photo.PhotoID;
  const order = [portrait, ph.SSL034.C1[2], ph.SSL034.C1[0], ph.SSL034.C1[3]];
  admin('setReportSelection', { poleId: 'SSL034', typeId: 'C1', photoIds: order });
  // SSL040: a newer B2 photo with another width, admin keeps the old one
  upload(TEAM, 'SSL040', 'B2', { measurement: '2.05' });
  admin('setReportSelection', { poleId: 'SSL040', typeId: 'B2', photoIds: [ph.SSL040.B2[0]] });

  // PEGGING
  let rep = admin('generateReport', { activityId: 'A', poleIds: ids }).report;
  assert.equal(rep.Activity, 'A');
  assert.equal(rep.PoleIDs, 'SSL034, SSL040, SSL041, SSL050', 'sorted by Pole ID');
  let { doc, file } = reportDoc(rt, rep);
  assert.equal(doc.pageWidth, 595.28);
  assert.equal(doc.pageHeight, 841.89);
  let blocks = blocksOf(doc);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, 'PEGGING');
  assert.equal(blocks[0].bg, '#D9D9D9');
  assert.equal(blocks[0].border, 1);
  assert.equal(blocks[0].gridBorder, 0);
  assert.deepEqual(blocks[0].cells.map((c) => c.caption), ['SSL034', 'SSL040', 'SSL041', 'SSL050', '', '']);
  assert.ok(blocks[0].cells[0].img === fileNameOf(ph.SSL034.A1[0]));
  assert.deepEqual(blocks[0].extra, ['Total pegging : 4 nos']);
  assert.ok(blocks[0].cells.slice(0, 4).every((c) => c.w <= 160 && c.h <= 120 && c.align === 'CENTER'));
  assert.match(file.name, /^Laporan_PEGGING_\d{8}-\d{4}_SSL034-SSL050\.pdf$/);
  assert.equal(rt.state.folders[file.parent].name, 'Solar Reports');
  const w = reportDoc(rt, rep, 'docx');
  assert.equal(w.magic, 'DOCX-MOCK');
  assert.match(w.file.name, /\.docx$/);
  assert.equal(rt.state.folders[w.file.parent].name, 'Solar Reports');
  assert.deepEqual(blocksOf(w.doc), blocks, 'Word export = same document');

  // TRIAL PIT
  rep = admin('generateReport', { activityId: 'B', poleIds: ids }).report;
  blocks = blocksOf(reportDoc(rt, rep).doc);
  assert.equal(blocks.length, 4);
  assert.ok(blocks.every((b) => b.title === 'TRIAL PIT EXCAVATION WORKS'));
  assert.deepEqual(blocks.map((b) => b.pageBreaksBefore), [0, 0, 0, 1], '3 blocks per page');
  assert.deepEqual(blocks[0].cells.map((c) => c.caption), ['SSL034', 'WIDTH : 1.3M', 'LENGTH : 1.6M', 'DEPTH : 1.5M']);
  assert.deepEqual(blocks[1].cells.map((c) => c.caption), ['SSL040', 'WIDTH : 1.3M', 'LENGTH : 1.6M', 'DEPTH : 1.5M'], 'admin choice (old 1.3 m photo)');
  assert.ok(blocks[1].cells[1].img === fileNameOf(ph.SSL040.B2[0]));
  assert.ok(blocks[0].cells.every((c) => c.img && c.w <= 118 && c.h <= 157));

  // INSTALLATION
  rep = admin('generateReport', { activityId: 'C', poleIds: ['SSL041', 'SSL034'] }).report;
  blocks = blocksOf(reportDoc(rt, rep).doc);
  assert.deepEqual(blocks.map((b) => b.title), ['INSTALLATION SOLAR STREET LIGHTING PROGRESS', 'INSTALLATION SOLAR STREET LIGHTING COMPLETED',
    'INSTALLATION SOLAR STREET LIGHTING PROGRESS', 'INSTALLATION SOLAR STREET LIGHTING COMPLETED']);
  assert.deepEqual(blocks.map((b) => b.pageBreaksBefore), [0, 0, 1, 1], 'one pole per page');
  assert.deepEqual(blocks.map((b) => b.extra), [['SSL034'], ['SSL034'], ['SSL041'], ['SSL041']]);
  assert.equal(blocks[0].cells.length, 4);
  order.forEach((id, k) => assert.ok(blocks[0].cells[k].img === fileNameOf(id), 'C1 in admin order ' + k));
  assert.deepEqual([blocks[0].cells[0].w, blocks[0].cells[0].h], [118, 157], 'portrait fits the cell');
  assert.deepEqual([blocks[0].cells[1].w, blocks[0].cells[1].h], [118, 89], 'landscape keeps aspect ratio');
  assert.ok(blocks[1].cells[0].img === fileNameOf(ph.SSL034.C2[0]) && blocks[1].cells[1].img === fileNameOf(ph.SSL034.C3[0]));
  assert.ok(blocks[1].cells[0].w > blocks[0].cells[1].w, 'completed photos larger');
  assert.ok(!JSON.stringify(blocks).includes('Package 2A'), 'no form headers');

  // temporary Google Docs trashed; 3 reports x (pdf + docx)
  const docsLeft = Object.values(rt.state.files).filter((f) => f.mime === 'application/vnd.google-apps.document' && !f.trashed);
  assert.equal(docsLeft.length, 0);
  assert.equal(Object.values(rt.state.files).filter((f) => !f.trashed && /\.(pdf|docx)$/.test(f.name)).length, 6);
  assert.deepEqual(rows('AuditLog').filter((r) => r.Action === 'ReportGenerated').map((r) => r.Field), ['PEGGING', 'TRIALPIT', 'INSTALLATION']);
  // chunked download of both formats reassembles the exact bytes
  rt.g.CHUNK_BYTES = 1000;
  for (const format of ['pdf', 'docx']) {
    let offset = 0; const parts = [];
    do {
      const d = call(BOSS, 'downloadReport', { reportId: rep.ReportID, offset, format });
      assert.equal(d.ok, true, d.error);
      parts.push(Buffer.from(d.b64, 'base64'));
      offset = d.next;
    } while (offset !== null);
    assert.ok(parts.length > 1);
    assert.deepEqual(Buffer.concat(parts), reportDoc(rt, rep, format).file.buf, format);
  }
});

// ---------------------------------------------------------------- migration v1 -> v2
function buildV1(rt) {
  const ss = rt.g.SpreadsheetApp.getActiveSpreadsheet();
  const sheet = (name, rowsArr) => { const sh = ss.getSheetByName(name) || ss.insertSheet(name); sh.data = rowsArr.map((r) => r.slice()); return sh; };
  // remove v2 tabs made by boot()/setup to mimic the v1 state exactly
  ['Activities', 'PhotoTypes', 'WorkPlan'].forEach((n) => delete rt.state.sheets[n]);
  sheet('Poles', [['PoleID', 'Bound', 'Chainage', 'ChainageExact', 'Category', 'PlannedDate', 'IsDone', 'DoneBy', 'DoneAt', 'UpdatedAt'],
    ['SL-001', 'EB', 'CH.11111', 'TRUE', 'Sudah dipasang', '', 'TRUE', 'Import', '', ''],
    ['SL-002', 'WB', 'CH.22222', 'TRUE', 'Perlu pasang', '2027-01-02', 'FALSE', '', '', ''],
    ['SL-003', 'WB', 'CH.33300 – CH.33400', 'FALSE', 'Tunggu kelulusan', '', 'FALSE', '', '', '']]);
  sheet('Photos', [['PhotoID', 'PoleID', 'SlotID', 'DriveFileID', 'FileURL', 'Source', 'CapturedAt', 'UploadedAt', 'Latitude', 'Longitude', 'AccuracyM', 'GPSAvailable', 'TakenBy', 'Hidden', 'RetakeFlag', 'SelectedForReport'],
    ['p1', 'SL-002', 'S1', 'X', 'u', 'Camera', '2027-01-01T08:00:00+08:00', '', '', '', '', 'FALSE', TEAM, 'FALSE', 'FALSE', 'TRUE'],
    ['p2', 'SL-002', 'S3', 'X', 'u', 'Camera', '2027-01-01T08:01:00+08:00', '', '', '', '', 'FALSE', TEAM, 'FALSE', 'FALSE', 'FALSE'],
    ['p3', 'SL-002', 'S4', 'X', 'u', 'Camera', '2027-01-01T08:02:00+08:00', '', '', '', '', 'FALSE', TEAM, 'FALSE', 'FALSE', 'FALSE'],
    ['p4', 'SL-002', 'S5', 'X', 'u', 'Camera', '2027-01-01T08:03:00+08:00', '', '', '', '', 'FALSE', TEAM, 'FALSE', 'FALSE', 'FALSE'],
    ['p5', 'SL-002', 'S7', 'X', 'u', 'Camera', '2027-01-01T08:04:00+08:00', '', '', '', '', 'FALSE', TEAM, 'FALSE', 'FALSE', 'FALSE']]);
  sheet('Slots', [['SlotID', 'Order', 'Name', 'Spec', 'Active'], ['S1', '1', 'Peg / lokasi', '', 'TRUE']]);
  sheet('Notes', [['NoteID', 'PoleID', 'Text', 'CreatedBy', 'CreatedAt'], ['n1', 'SL-002', 'nota SL-002 lama', TEAM, '2027-01-01T08:00:00+08:00']]);
  sheet('Reports', [['ReportID', 'PoleIDs', 'FileURL', 'CreatedBy', 'CreatedAt'], ['R1', 'SL-001, SL-002', 'https://drive.google.com/file/d/OLD/view', ADMIN, '']]);
  sheet('AuditLog', [['Timestamp', 'UserEmail', 'Action', 'Entity', 'EntityID', 'Field', 'OldValue', 'NewValue'],
    ['2027-01-01T08:00:00+08:00', TEAM, 'PhotoAdded', 'Photo', 'p1', 'Pole/Slot', '', 'SL-002/S1 (Camera)']]);
  const settings = rt.state.sheets.Settings;
  const photosRoot = rt.state.folders[settings.rowsAsObjects().find((r) => r.Key === 'PhotosFolderID').Value];
  const f2 = photosRoot.createFolder('SL-002');
  f2.createFile(new rt.Blob(Buffer.from('jpg'), 'image/jpeg', 'SL-002_S1_20270101-080000_p1.jpg'));
  f2.createFile(new rt.Blob(Buffer.from('jpg'), 'image/jpeg', 'p1_thumb.jpg'));
  // both an old and a new folder for SSL003 (e.g. a photo taken after a half-finished manual rename)
  photosRoot.createFolder('SL-003').createFile(new rt.Blob(Buffer.from('jpg'), 'image/jpeg', 'SL-003_S1_x_p9.jpg'));
  photosRoot.createFolder('SSL003');
  return photosRoot;
}
const snapshot = (rt) => JSON.stringify({ sheets: Object.fromEntries(Object.entries(rt.state.sheets).map(([k, v]) => [k, v.data])),
  folders: Object.values(rt.state.folders).map((f) => [f.name, f.parent, !!f.trashed]),
  files: Object.values(rt.state.files).map((f) => [f.name, f.parent, !!f.trashed]) });

test('migrateV2: renames IDs in every sheet + Drive, maps old slots, adds new tabs, idempotent, one audit entry', () => {
  const { rt, rows, call } = boot();
  const root = buildV1(rt);
  assert.throws(() => rt.g.setup(), /migrateV2/, 'setup refuses a v1 sheet');
  const msg = rt.g.migrateV2();
  assert.match(msg, /perubahan/);
  assert.deepEqual(rows('Poles').map((p) => p.PoleID), ['SSL001', 'SSL002', 'SSL003']);
  const photos = rows('Photos');
  assert.deepEqual(rt.state.sheets.Photos.data[0], ['PhotoID', 'PoleID', 'PhotoTypeID', 'DriveFileID', 'FileURL', 'Source', 'CapturedAt', 'UploadedAt', 'Latitude', 'Longitude', 'AccuracyM', 'GPSAvailable', 'TakenBy', 'Hidden', 'RetakeFlag', 'ReportOrder', 'MeasurementM', 'ThumbFileID', 'ReportFileID']);
  assert.deepEqual(photos.map((p) => p.PoleID + '/' + p.PhotoTypeID), ['SSL002/A1', 'SSL002/B2', 'SSL002/C1', 'SSL002/C1', 'SSL002/C3']);
  assert.ok(photos.every((p) => p.ReportOrder === '' && p.MeasurementM === ''));
  assert.equal(rows('Notes')[0].PoleID, 'SSL002');
  assert.equal(rows('Notes')[0].Text, 'nota SL-002 lama', 'free text untouched');
  assert.equal(rows('Reports')[0].PoleIDs, 'SSL001, SSL002');
  assert.ok('Activity' in rows('Reports')[0] && 'DocxURL' in rows('Reports')[0]);
  assert.ok(rt.state.sheets.Slots_old && !rt.state.sheets.Slots);
  ['Activities', 'PhotoTypes', 'WorkPlan'].forEach((n) => assert.ok(rt.state.sheets[n], n));
  assert.equal(rows('AuditLog')[0].NewValue, 'SL-002/S1 (Camera)', 'old history not rewritten');
  assert.equal(rows('AuditLog').filter((r) => r.Action === 'MigrationV2').length, 1);
  const live = Object.values(rt.state.folders).filter((f) => f.parent === root.id && !f.trashed).map((f) => f.name).sort();
  assert.deepEqual(live, ['SSL002', 'SSL003']);
  const fileNames = Object.values(rt.state.files).filter((f) => !f.trashed && rt.state.folders[f.parent] && rt.state.folders[f.parent].parent === root.id)
    .map((f) => rt.state.folders[f.parent].name + '/' + f.name).sort();
  assert.deepEqual(fileNames, ['SSL002/SSL002_S1_20270101-080000_p1.jpg', 'SSL002/p1_thumb.jpg', 'SSL003/SSL003_S1_x_p9.jpg']);
  // the app works on the migrated data
  const L = require('../shared/logic.js');
  const b = call(TEAM, 'bootstrap');
  assert.equal(b.ok, true, b.error);
  const pole = b.poles.find((p) => p.PoleID === 'SSL002');
  assert.equal(L.photoStatus(pole, b.types, b.photos, b.activities).detail, 'Pegging ✓ · Trial Pit 0/4 · Installation 3/6',
    'S4+S5 -> 2x C1, S7 -> C3; S3 -> B2 without measurement does not count');
  // second run: nothing changes at all
  const before = snapshot(rt);
  assert.match(rt.g.migrateV2(), /tiada perubahan/);
  assert.equal(snapshot(rt), before);
});

test('migrateV2: stops before changing anything if a pole ID is unexpected', () => {
  const { rt } = boot();
  buildV1(rt);
  rt.state.sheets.Poles.data.push(['XYZ-9', 'EB', 'CH.1', 'FALSE', 'Perlu pasang', '', 'FALSE', '', '', '']);
  const before = snapshot(rt);
  assert.throws(() => rt.g.migrateV2(), /ID tiang tidak dikenali: "XYZ-9"/);
  assert.equal(snapshot(rt), before);
});

test('migrateV2 on a v2 sheet (fresh setup) changes nothing', () => {
  const { rt } = boot();
  const before = snapshot(rt);
  assert.match(rt.g.migrateV2(), /tiada perubahan/);
  assert.equal(snapshot(rt), before);
});

test('items queued by the old v1 app (SL-034, slot S1) still sync after the migration', () => {
  const { call, rows } = boot();
  const up = call(TEAM, 'uploadPhoto', { photoId: 'legacy_000001', poleId: 'SL-040', slotId: 'S1', imageB64: IMG, source: 'Camera', gpsAvailable: false });
  assert.equal(up.ok, true, up.error);
  assert.deepEqual([up.photo.PoleID, up.photo.PhotoTypeID], ['SSL040', 'A1']);
  assert.equal(call(TEAM, 'addNote', { noteId: 'legacy-note', poleId: 'SL-040', text: 'nota lama' }).note.PoleID, 'SSL040');
  assert.equal(call(TEAM, 'setDone', { poleId: 'SL-040', done: true }).pole.IsDone, true);
  const s3 = call(TEAM, 'uploadPhoto', { photoId: 'legacy_000002', poleId: 'SL-040', slotId: 'S3', imageB64: IMG, source: 'Camera', gpsAvailable: false });
  assert.match(s3.error, /Sila masukkan ukuran/, 'old "Ukuran" slot -> B2 needs a measurement: kept on the phone as failed, not lost');
  assert.equal(rows('Photos').length, 1);
});

test('notes, users, audit, feed, doPost', () => {
  const { rt, call, admin, upload, rows, tok } = boot();
  assert.equal(call(TEAM, 'addNote', { noteId: 'note-1', poleId: 'SSL045', text: 'Lokasi dianjak' }).ok, true);
  assert.equal(call(TEAM, 'addNote', { noteId: 'note-1', poleId: 'SSL045', text: 'Lokasi dianjak' }).duplicate, true);
  assert.equal(call(BOSS, 'addNote', { noteId: 'note-2', poleId: 'SSL045', text: 'x' }).code, 'FORBIDDEN');
  assert.equal(admin('saveUser', { email: ADMIN, name: 'Admin', role: 'Team' }).code, 'BAD');
  assert.equal(admin('removeUser', { email: ADMIN }).code, 'BAD');
  upload(TEAM, 'SSL048', 'A1');
  call(TEAM, 'setDone', { poleId: 'SSL048', done: true });
  assert.deepEqual(admin('audit', { q: 'SSL048' }).rows.slice(0, 2).map((r) => r.Action).sort(), ['MarkedDone', 'PoleEdited'], 'v3: Siap also records the actual date');
  assert.equal(call(TEAM, 'audit', {}).code, 'FORBIDDEN');
  const feed = call(BOSS, 'bootstrap').feed;
  assert.equal(feed[0].Action, 'MarkedDone');
  assert.ok(feed.every((f) => !f.Action.startsWith('User') && !f.Action.startsWith('Plan')));
  const out = JSON.parse(rt.g.doPost({ postData: { contents: JSON.stringify({ action: 'me', token: tok(BOSS) }) }, parameter: {} }).getContent());
  assert.equal(out.user.role, 'Boss');
  assert.equal(JSON.parse(rt.g.doGet().getContent()).ok, true);
  assert.equal(rows('Notes').length, 1);
});
