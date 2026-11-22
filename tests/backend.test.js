'use strict';
/* Runs the real apps-script/*.gs code against the in-memory Apps Script mock. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createRuntime } = require('./gas-mock');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const ADMIN = 'owner@example.com', TEAM = 'team@example.com', BOSS = 'boss@example.com';
const IMG = fs.readFileSync(path.join(__dirname, 'fixtures/camera_noexif.jpg')).toString('base64');
const THUMB = fs.readFileSync(path.join(__dirname, 'fixtures/tiny.jpg')).toString('base64');
let pid = 0;
const json = (x) => JSON.parse(JSON.stringify(x)); // same as going over HTTP

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
  const upload = (email, poleId, slotId, extra) => call(email, 'uploadPhoto', {
    photoId: 'ph_' + (++pid).toString().padStart(6, '0'), poleId, slotId, imageB64: IMG, thumbB64: THUMB, source: 'Camera',
    capturedAt: '2026-11-21T10:' + String(pid % 60).padStart(2, '0') + ':00+08:00', latitude: 3.123456, longitude: 101.654321,
    accuracy: 7.6, gpsAvailable: true, ...(extra || {}),
  });
  return { rt, idTokens, tok, call, admin, rows, upload };
}

test('setup creates tabs, seeds 123 poles / 7 slots / admin, and is safe to run twice', () => {
  const { rt, rows } = boot();
  rt.g.setup();
  ['Poles', 'Photos', 'Slots', 'Notes', 'Users', 'AuditLog', 'Reports', 'Settings'].forEach((n) => assert.ok(rt.state.sheets[n], n));
  assert.deepEqual(rt.state.sheets.Poles.data[0], ['PoleID', 'Bound', 'Chainage', 'ChainageExact', 'Category', 'PlannedDate', 'IsDone', 'DoneBy', 'DoneAt', 'UpdatedAt']);
  assert.deepEqual(rt.state.sheets.Photos.data[0], ['PhotoID', 'PoleID', 'SlotID', 'DriveFileID', 'FileURL', 'Source', 'CapturedAt', 'UploadedAt', 'Latitude', 'Longitude', 'AccuracyM', 'GPSAvailable', 'TakenBy', 'Hidden', 'RetakeFlag', 'SelectedForReport']);
  const poles = rows('Poles');
  assert.equal(poles.length, 123);
  assert.equal(poles.filter((p) => p.Category === 'Sudah dipasang').length, 33);
  assert.equal(poles.filter((p) => p.Category === 'Perlu pasang').length, 44);
  assert.equal(poles.filter((p) => p.Category === 'Tunggu kelulusan').length, 46);
  assert.equal(poles.filter((p) => p.Bound === 'EB').length, 54);
  assert.equal(poles.filter((p) => p.Bound === 'WB').length, 69);
  assert.equal(poles.find((p) => p.PoleID === 'SL-034').PlannedDate, '2026-11-18');
  assert.equal(rows('Slots').length, 7);
  assert.equal(rows('Slots')[2].Spec, '1.5m × 1m');
  const admins = rows('Users').filter((u) => u.Role === 'Admin');
  assert.equal(admins.length, 1);
  assert.equal(admins[0].Email, ADMIN);
});

test('Google sign-in redirect: valid token -> session; wrong audience / unknown / inactive email -> error', () => {
  const { rt, idTokens, admin } = boot();
  const exp = String(Math.floor(Date.now() / 1000) + 600);
  idTokens.good = { aud: CLIENT_ID, iss: 'https://accounts.google.com', email: 'Team@Example.com', email_verified: 'true', exp, nonce: 'n123' };
  idTokens.wrongAud = { ...idTokens.good, aud: 'other' };
  idTokens.stranger = { ...idTokens.good, email: 'stranger@gmail.com' };
  idTokens.unverified = { ...idTokens.good, email_verified: 'false' };

  const html = rt.g.doPost({ parameter: { credential: 'good' } }).getContent();
  const m = html.match(/#login=([^&"]+)&amp;nonce=([^"]+)"/);
  assert.ok(m, html);
  assert.equal(decodeURIComponent(m[2]), 'n123');
  const session = decodeURIComponent(m[1]);
  const r = rt.g.handle_({ action: 'me', token: session });
  assert.equal(r.ok, true);
  assert.equal(r.user.email, TEAM);
  assert.equal(r.user.role, 'Team');

  for (const bad of ['wrongAud', 'stranger', 'unverified', 'notatoken']) {
    const h = rt.g.doPost({ parameter: { credential: bad } }).getContent();
    assert.ok(h.includes('#loginerror='), bad);
    assert.ok(!h.includes('#login='), bad);
  }
  admin('saveUser', { email: TEAM, name: 'Ali', role: 'Team', active: false });
  assert.ok(rt.g.doPost({ parameter: { credential: 'good' } }).getContent().includes('#loginerror='));
});

test('session: tampered / expired tokens rejected; deactivating or removing a user blocks the very next request', () => {
  const { rt, tok, call, admin } = boot();
  const t = tok(TEAM);
  assert.equal(call(t, 'me').ok, true);
  const [p, s] = t.split('.');
  assert.equal(call(p + '.' + s.slice(0, -2) + 'xx', 'me').code, 'AUTH');
  assert.equal(call('', 'bootstrap').code, 'AUTH');
  assert.equal(call('garbage', 'bootstrap').code, 'AUTH');
  // expired
  rt.g.setSetting_('SessionDays', '-1');
  assert.equal(call(tok(TEAM), 'me').code, 'AUTH');
  rt.g.setSetting_('SessionDays', '30');
  // deactivate -> the SAME token stops working immediately
  admin('saveUser', { email: TEAM, name: 'Ali', role: 'Team', active: false });
  const r = call(t, 'bootstrap');
  assert.equal(r.code, 'AUTH');
  assert.equal(r.poles, undefined);
  admin('saveUser', { email: TEAM, name: 'Ali', role: 'Team', active: true });
  assert.equal(call(t, 'bootstrap').ok, true);
  // role change applies immediately
  admin('saveUser', { email: TEAM, name: 'Ali', role: 'Boss', active: true });
  assert.equal(call(t, 'setDone', { poleId: 'SL-034', done: true }).code, 'FORBIDDEN');
  admin('saveUser', { email: TEAM, name: 'Ali', role: 'Team', active: true });
  // removed from the sheet -> blocked
  admin('removeUser', { email: TEAM });
  assert.equal(call(t, 'bootstrap').code, 'AUTH');
  // manual edit in the sheet (Active = FALSE typed by admin) also works
  admin('saveUser', { email: TEAM, name: 'Ali', role: 'Team' });
  const sh = rt.state.sheets.Users;
  const row = sh.data.findIndex((r) => r[0] === TEAM);
  sh.data[row][3] = 'FALSE';
  assert.equal(call(t, 'me').code, 'AUTH');
});

test('permissions are enforced on the backend for every role (Section 3)', () => {
  const env = boot();
  const { call, upload, admin } = env;
  const seed = upload(ADMIN, 'SL-034', 'S1');
  assert.equal(seed.ok, true);
  const photoId = seed.photo.PhotoID;
  let n = 0;
  const actions = {
    bootstrap: () => ({}),
    getThumbs: () => ({ poleId: 'SL-034' }),
    getPhoto: () => ({ photoId }),
    uploadPhoto: () => ({ photoId: 'perm_' + (++n) + '_xxxxxxxx', poleId: 'SL-035', slotId: 'S1', imageB64: IMG, source: 'Camera', gpsAvailable: false }),
    addNote: () => ({ noteId: 'note_' + (++n), poleId: 'SL-035', text: 'ujian' }),
    setDone: () => ({ poleId: 'SL-036', done: true }),
    editPole: () => ({ poleId: 'SL-037', changes: { PlannedDate: '2026-12-0' + ((++n % 9) + 1) } }),
    setPhotoFlag: () => ({ photoId, field: 'RetakeFlag', value: (++n) % 2 === 0 }),
    selectForReport: () => ({ photoId }),
    saveUser: () => ({ email: 'new' + (++n) + '@example.com', name: 'X', role: 'Team' }),
    saveSlot: () => ({ slotId: 'S2', name: 'Menggali', spec: 'x' + (++n) }),
    moveSlot: () => ({ slotId: 'S2', dir: 1 }),
    audit: () => ({}),
    generateReport: () => ({ poleIds: ['SL-034'] }),
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
      const allowed = expected[role].includes(action);
      if (allowed) assert.equal(r.ok, true, `${role} ${action} should be allowed: ${r.error}`);
      else assert.equal(r.code, 'FORBIDDEN', `${role} ${action} should be FORBIDDEN, got ${JSON.stringify(r).slice(0, 120)}`);
    }
  }
  // hide photo + category change specifically
  assert.equal(call(TEAM, 'setPhotoFlag', { photoId, field: 'Hidden', value: true }).code, 'FORBIDDEN');
  assert.equal(call(TEAM, 'editPole', { poleId: 'SL-078', changes: { Category: 'Perlu pasang' } }).code, 'FORBIDDEN');
  assert.equal(call(TEAM, 'editPole', { poleId: 'SL-078', changes: { Chainage: 'CH.41450' } }).code, 'FORBIDDEN');
  assert.equal(call(BOSS, 'removeUser', { email: TEAM }).code, 'FORBIDDEN');
  assert.equal(call(TEAM, 'removeUser', { email: BOSS }).code, 'FORBIDDEN');
  // download reports: all roles
  const rep = admin('generateReport', { poleIds: ['SL-034'] }).report;
  for (const e of [ADMIN, TEAM, BOSS]) assert.equal(call(e, 'downloadReport', { reportId: rep.ReportID }).ok, true, e);
  // unknown action / no delete action exists
  assert.equal(call(ADMIN, 'deletePhoto', { photoId }).code, 'BAD');
});

test('category rules: no photos/Siap on Tunggu kelulusan; Sudah dipasang allows optional photos but no Siap; notes everywhere', () => {
  const { call, upload } = boot();
  assert.equal(upload(TEAM, 'SL-078', 'S1').code, 'FORBIDDEN');
  assert.equal(call(TEAM, 'setDone', { poleId: 'SL-078', done: true }).code, 'FORBIDDEN');
  assert.equal(call(TEAM, 'addNote', { noteId: 'n-pend-1', poleId: 'SL-078', text: 'Tapak belum siap' }).ok, true);
  assert.equal(upload(TEAM, 'SL-001', 'S1').ok, true);
  assert.equal(call(TEAM, 'setDone', { poleId: 'SL-001', done: false }).code, 'FORBIDDEN');
  assert.equal(call(TEAM, 'addNote', { noteId: 'n-inst-1', poleId: 'SL-001', text: 'ok' }).ok, true);
});

test('upload is idempotent (retries never duplicate) and stores all photo data', () => {
  const { rt, call, rows } = boot();
  const params = { photoId: 'retry_00000001', poleId: 'SL-040', slotId: 'S3', imageB64: IMG, thumbB64: THUMB, source: 'Gallery',
    capturedAt: '2026-11-20T09:15:30+08:00', latitude: 3.212345, longitude: 101.756789, accuracy: 12.4, gpsAvailable: true };
  const filesBefore = Object.keys(rt.state.files).length;
  const a = call(TEAM, 'uploadPhoto', params);
  const b = call(TEAM, 'uploadPhoto', params);
  const c = call(TEAM, 'uploadPhoto', params);
  assert.equal(a.ok && b.ok && c.ok, true);
  assert.equal(b.duplicate, true);
  const ph = rows('Photos').filter((p) => p.PhotoID === 'retry_00000001');
  assert.equal(ph.length, 1);
  assert.equal(Object.keys(rt.state.files).length - filesBefore, 2, 'one photo + one thumbnail');
  assert.equal(rows('AuditLog').filter((r) => r.Action === 'PhotoAdded' && r.EntityID === 'retry_00000001').length, 1);
  const p = ph[0];
  assert.equal(p.PoleID, 'SL-040');
  assert.equal(p.SlotID, 'S3');
  assert.equal(p.Source, 'Gallery');
  assert.equal(p.CapturedAt, '2026-11-20T09:15:30+08:00');
  assert.equal(p.Latitude, '3.212345');
  assert.equal(p.Longitude, '101.756789');
  assert.equal(p.AccuracyM, '12');
  assert.equal(p.GPSAvailable, 'TRUE');
  assert.equal(p.TakenBy, TEAM);
  assert.equal(p.Hidden, 'FALSE');
  assert.match(p.FileURL, /^https:\/\/drive\.google\.com\/file\/d\//);
  // stored in "Solar Photos/SL-040/"
  const file = rt.state.files[p.DriveFileID];
  const folder = rt.state.folders[file.parent];
  assert.equal(folder.name, 'SL-040');
  assert.equal(rt.state.folders[folder.parent].name, 'Solar Photos');
  // no GPS
  const ng = call(TEAM, 'uploadPhoto', { ...params, photoId: 'nogps_0000001', gpsAvailable: false, latitude: '', longitude: '', accuracy: '' });
  assert.equal(ng.photo.GPSAvailable, false);
  assert.equal(ng.photo.Latitude, '');
  // bad input
  assert.equal(call(TEAM, 'uploadPhoto', { ...params, photoId: 'x' }).code, 'BAD');
  assert.equal(call(TEAM, 'uploadPhoto', { ...params, photoId: 'badslot_00001', slotId: 'S99' }).code, 'BAD');
  assert.equal(call(TEAM, 'uploadPhoto', { ...params, photoId: 'badpole_00001', poleId: 'SL-999' }).code, 'NOTFOUND');
});

test('hidden photos: invisible to Team/Boss, visible to Admin, can be unhidden, never deleted, all logged', () => {
  const { rt, call, upload, admin, rows } = boot();
  const id = upload(TEAM, 'SL-041', 'S1').photo.PhotoID;
  assert.equal(admin('setPhotoFlag', { photoId: id, field: 'Hidden', value: true }).ok, true);
  for (const e of [TEAM, BOSS]) {
    assert.equal(call(e, 'bootstrap').photos.some((p) => p.PhotoID === id), false, e);
    assert.equal(call(e, 'getPhoto', { photoId: id }).code, 'NOTFOUND', e);
    assert.deepEqual(call(e, 'getThumbs', { poleId: 'SL-041' }).thumbs, {}, e);
  }
  const adm = admin('bootstrap').photos.find((p) => p.PhotoID === id);
  assert.equal(adm.Hidden, true);
  assert.equal(admin('getPhoto', { photoId: id }).ok, true);
  assert.ok(admin('getThumbs', { poleId: 'SL-041' }).thumbs[id]);
  admin('setPhotoFlag', { photoId: id, field: 'Hidden', value: false });
  assert.equal(call(TEAM, 'bootstrap').photos.some((p) => p.PhotoID === id), true);
  assert.equal(rows('Photos').filter((p) => p.PhotoID === id).length, 1);
  assert.ok(Object.values(rt.state.files).every((f) => !f.trashed || f.name.startsWith('tmp_')));
  const acts = rows('AuditLog').filter((r) => r.EntityID === id).map((r) => r.Action);
  assert.deepEqual(acts, ['PhotoAdded', 'PhotoHidden', 'PhotoUnhidden']);
});

test('Siap / Batal siap and computed statuses from the server data', () => {
  const { call, upload, rows } = boot();
  const L = require('../shared/logic.js');
  const status = (id) => {
    const b = call(TEAM, 'bootstrap');
    const pole = b.poles.find((p) => p.PoleID === id);
    return [L.workStatus(pole, b.photos), L.photoStatus(pole, b.slots, b.photos).label];
  };
  assert.deepEqual(status('SL-042'), ['Belum mula', 'Belum lengkap (0/7)']);
  upload(TEAM, 'SL-042', 'S1');
  assert.deepEqual(status('SL-042'), ['Dalam proses', 'Belum lengkap (1/7)']);
  assert.equal(call(TEAM, 'setDone', { poleId: 'SL-042', done: true }).pole.IsDone, true);
  assert.deepEqual(status('SL-042'), ['Siap', 'Belum lengkap (1/7)']);
  call(TEAM, 'setDone', { poleId: 'SL-042', done: true }); // repeat = no-op
  call(TEAM, 'setDone', { poleId: 'SL-042', done: false });
  assert.deepEqual(status('SL-042'), ['Dalam proses', 'Belum lengkap (1/7)']);
  const log = rows('AuditLog').filter((r) => r.EntityID === 'SL-042').map((r) => r.Action);
  assert.deepEqual(log, ['MarkedDone', 'DoneCancelled']);
  const pole = rows('Poles').find((p) => p.PoleID === 'SL-042');
  assert.equal(pole.IsDone, 'FALSE');
  assert.equal(pole.DoneBy, '');
});

test('admin pole editor: CH exact recomputed, category change, validation, every field logged', () => {
  const { admin, rows } = boot();
  const r = admin('editPole', { poleId: 'SL-078', changes: { Chainage: 'CH.41450', Category: 'Perlu pasang', PlannedDate: '2026-12-15', Bound: 'EB' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.pole.ChainageExact, true);
  assert.equal(r.pole.Category, 'Perlu pasang');
  const p = rows('Poles').find((x) => x.PoleID === 'SL-078');
  assert.equal(p.Chainage, 'CH.41450');
  assert.equal(p.ChainageExact, 'TRUE');
  assert.equal(p.PlannedDate, '2026-12-15');
  const log = rows('AuditLog').filter((x) => x.EntityID === 'SL-078');
  assert.deepEqual(log.map((x) => x.Action + ':' + x.Field).sort(),
    ['CategoryChanged:Category', 'PoleEdited:Chainage', 'PoleEdited:ChainageExact', 'PoleEdited:PlannedDate'].sort());
  const cat = log.find((x) => x.Field === 'Category');
  assert.equal(cat.OldValue, 'Tunggu kelulusan');
  assert.equal(cat.NewValue, 'Perlu pasang');
  // back to a range -> not exact
  assert.equal(admin('editPole', { poleId: 'SL-078', changes: { Chainage: 'CH.41400 – CH.41600' } }).pole.ChainageExact, false);
  assert.equal(admin('editPole', { poleId: 'SL-078', changes: { Bound: 'NB' } }).code, 'BAD');
  assert.equal(admin('editPole', { poleId: 'SL-078', changes: { Category: 'Lain' } }).code, 'BAD');
  assert.equal(admin('editPole', { poleId: 'SL-078', changes: { PlannedDate: '15/12/2026' } }).code, 'BAD');
  assert.equal(admin('editPole', { poleId: 'SL-078', changes: { IsDone: true } }).code, 'BAD');
  assert.equal(admin('editPole', { poleId: 'SL-078', changes: { Chainage: '  ' } }).code, 'BAD');
});

test('retake flag + report selection (one selected photo per slot)', () => {
  const { admin, upload, rows } = boot();
  const a = upload(TEAM, 'SL-043', 'S2').photo.PhotoID;
  const b = upload(TEAM, 'SL-043', 'S2').photo.PhotoID;
  admin('selectForReport', { photoId: a });
  admin('selectForReport', { photoId: b });
  const sel = rows('Photos').filter((p) => p.SelectedForReport === 'TRUE').map((p) => p.PhotoID);
  assert.deepEqual(sel, [b]);
  admin('selectForReport', { photoId: b, value: false });
  assert.equal(rows('Photos').filter((p) => p.SelectedForReport === 'TRUE').length, 0);
  admin('setPhotoFlag', { photoId: a, field: 'RetakeFlag', value: true });
  assert.equal(rows('Photos').find((p) => p.PhotoID === a).RetakeFlag, 'TRUE');
  const acts = rows('AuditLog').filter((r) => [a, b].includes(r.EntityID)).map((r) => r.Action);
  assert.deepEqual(acts, ['PhotoAdded', 'PhotoAdded', 'ReportPhotoSelected', 'ReportPhotoSelected', 'ReportPhotoUnselected', 'RetakeFlagged']);
});

test('slots: rename keeps photos linked; add / deactivate / reorder; completeness follows active slots', () => {
  const { admin, call, upload, rows } = boot();
  const L = require('../shared/logic.js');
  const id = upload(TEAM, 'SL-044', 'S3').photo.PhotoID;
  let r = admin('saveSlot', { slotId: 'S3', name: 'Ukuran lubang', spec: '1.5m × 1m × 1m' });
  assert.equal(r.ok, true);
  const ph = rows('Photos').find((p) => p.PhotoID === id);
  assert.equal(ph.SlotID, 'S3', 'photo still linked by SlotID');
  r = admin('saveSlot', { name: 'Pendawaian', spec: '' });
  const s8 = r.slots.find((s) => s.Name === 'Pendawaian');
  assert.equal(s8.SlotID, 'S8');
  assert.equal(s8.Order, 8);
  let b = call(TEAM, 'bootstrap');
  assert.equal(L.photoStatus(b.poles.find((p) => p.PoleID === 'SL-044'), b.slots, b.photos).label, 'Belum lengkap (1/8)');
  admin('saveSlot', { slotId: 'S8', name: 'Pendawaian', spec: '', active: false });
  b = call(TEAM, 'bootstrap');
  assert.equal(L.photoStatus(b.poles.find((p) => p.PoleID === 'SL-044'), b.slots, b.photos).label, 'Belum lengkap (1/7)');
  r = admin('moveSlot', { slotId: 'S7', dir: -1 });
  const order = r.slots.slice().sort((x, y) => x.Order - y.Order).map((s) => s.SlotID);
  assert.deepEqual(order, ['S1', 'S2', 'S3', 'S4', 'S5', 'S7', 'S6', 'S8']);
  admin('moveSlot', { slotId: 'S1', dir: -1 }); // already first: no-op
  const acts = rows('AuditLog').filter((x) => x.Entity === 'Slot').map((x) => x.Action + ':' + x.Field);
  assert.deepEqual(acts, ['SlotEdited:Name', 'SlotEdited:Spec', 'SlotAdded:Name', 'SlotEdited:Active', 'SlotReordered:Order']);
});

test('users: add, edit role, cannot lock yourself out, remove; all logged', () => {
  const { admin, rows } = boot();
  assert.equal(admin('saveUser', { email: ADMIN, name: 'Admin', role: 'Team' }).code, 'BAD');
  assert.equal(admin('saveUser', { email: ADMIN, name: 'Admin', role: 'Admin', active: false }).code, 'BAD');
  assert.equal(admin('removeUser', { email: ADMIN }).code, 'BAD');
  assert.equal(admin('saveUser', { email: 'bad-email', role: 'Team' }).code, 'BAD');
  assert.equal(admin('saveUser', { email: 'x@example.com', role: 'Superuser' }).code, 'BAD');
  assert.equal(admin('saveUser', { email: 'New.Person@Gmail.com', name: 'Baru', role: 'Team' }).userRow.Email, 'new.person@gmail.com');
  admin('saveUser', { email: 'new.person@gmail.com', name: 'Baru', role: 'Boss' });
  assert.equal(rows('Users').find((u) => u.Email === 'new.person@gmail.com').Role, 'Boss');
  assert.equal(admin('removeUser', { email: 'new.person@gmail.com' }).ok, true);
  assert.equal(rows('Users').some((u) => u.Email === 'new.person@gmail.com'), false);
  const acts = rows('AuditLog').filter((r) => r.EntityID === 'new.person@gmail.com').map((r) => r.Action);
  assert.deepEqual(acts, ['UserAdded', 'UserEdited', 'UserRemoved']);
});

test('notes: append-only, idempotent, boss cannot write', () => {
  const { call, rows } = boot();
  assert.equal(call(TEAM, 'addNote', { noteId: 'note-1', poleId: 'SL-045', text: 'Lokasi dianjak 5m ke timur' }).ok, true);
  assert.equal(call(TEAM, 'addNote', { noteId: 'note-1', poleId: 'SL-045', text: 'Lokasi dianjak 5m ke timur' }).duplicate, true);
  assert.equal(rows('Notes').length, 1);
  assert.equal(call(BOSS, 'addNote', { noteId: 'note-2', poleId: 'SL-045', text: 'x' }).code, 'FORBIDDEN');
  assert.equal(call(TEAM, 'addNote', { noteId: 'note-3', poleId: 'SL-045', text: '   ' }).code, 'BAD');
  assert.equal(call(TEAM, 'addNote', { noteId: 'note-4', poleId: 'SL-045', text: 'x'.repeat(2001) }).code, 'BAD');
  assert.equal(rows('AuditLog').filter((r) => r.Action === 'NoteAdded').length, 1);
  // formula-looking text stays text
  call(TEAM, 'addNote', { noteId: 'note-5', poleId: 'SL-045', text: '=HYPERLINK("x")' });
  assert.equal(rows('Notes').find((n) => n.NoteID === 'note-5').Text, '=HYPERLINK("x")');
});

function reportImages(rt, reportId) {
  const rep = rt.state.sheets.Reports.rowsAsObjects().find((r) => r.ReportID === reportId);
  const id = rep.FileURL.match(/\/d\/([^/]+)/)[1];
  const doc = JSON.parse(rt.state.files[id].buf.toString('utf8').replace('%PDF-MOCK\n', ''));
  const sections = [];
  let cur = null;
  doc.body.forEach((n) => {
    if (n.type === 'table' && n.rows[0][0].paras[0].text === 'Tiang') {
      cur = { pole: n.rows[0][1].paras[0].text, status: n.rows[1][3].paras[0].text, ch: n.rows[1][1].paras[0].text, slots: [] };
      sections.push(cur);
    } else if (n.type === 'table' && cur) {
      n.rows.forEach((r) => r.forEach((c) => {
        if (!c.paras[0].text && !c.paras[0].images.length && c.paras.length === 1) return;
        const img = c.paras[0].images[0];
        const texts = c.paras.map((p) => p.text).filter(Boolean);
        cur.slots.push({ title: texts[0], img: img ? img.name : null, w: img && img.w, captions: texts.slice(1) });
      }));
    }
  });
  return { doc, sections, file: rt.state.files[id] };
}

test('PDF report: multiple photos per slot, with and without admin selection; captions; limits; download', () => {
  const { rt, admin, call, upload, rows } = boot();
  const p1 = upload(TEAM, 'SL-046', 'S3', { capturedAt: '2026-11-21T08:00:00+08:00' }).photo.PhotoID;
  const p2 = upload(TEAM, 'SL-046', 'S3', { capturedAt: '2026-11-21T09:00:00+08:00' }).photo.PhotoID;
  const p3 = upload(TEAM, 'SL-046', 'S3', { capturedAt: '2026-11-21T10:00:00+08:00' }).photo.PhotoID;
  const g = upload(TEAM, 'SL-046', 'S7', { source: 'Gallery', gpsAvailable: false }).photo.PhotoID;
  admin('setPhotoFlag', { photoId: p3, field: 'RetakeFlag', value: true });
  call(TEAM, 'setDone', { poleId: 'SL-046', done: true });

  // 1) no selection -> latest visible non-flagged (p2)
  let rep = admin('generateReport', { poleIds: ['SL-046', 'SL-047'] });
  assert.equal(rep.ok, true, rep.error);
  let out = reportImages(rt, rep.report.ReportID);
  assert.equal(out.sections.length, 2);
  assert.equal(out.sections[0].pole, 'SL-046');
  assert.equal(out.sections[0].status, 'Siap');
  assert.equal(out.sections[0].slots.length, 7);
  const s3 = out.sections[0].slots[2];
  assert.equal(s3.title, '3. Ukuran (1.5m × 1m)');
  assert.ok(s3.img.includes(p2), 'uses latest non-flagged photo p2, got ' + s3.img);
  assert.ok(s3.w <= 215);
  assert.deepEqual(s3.captions, ['Tarikh/masa: 21/11/2026 09:00', 'GPS: 3.12346, 101.65432 (±8 m)', 'Diambil oleh: Ali', 'Sumber: Kamera']);
  const s7 = out.sections[0].slots[6];
  assert.ok(s7.img.includes(g));
  assert.ok(s7.captions.includes('GPS tidak tersedia'));
  assert.ok(s7.captions.includes('Sumber: Galeri'));
  assert.equal(out.sections[0].slots[0].captions[0], 'Tiada gambar');
  assert.equal(out.sections[1].status, 'Belum mula');
  assert.ok(out.doc.body.some((n) => n.type === 'pagebreak'));
  assert.ok(out.doc.body.some((n) => n.type === 'p' && n.text.includes('Package 2A — Solar Street Lighting')));
  assert.ok(!JSON.stringify(out.doc).includes('{{'), 'all placeholders replaced');
  assert.match(out.file.name, /\.pdf$/);
  const folder = rt.state.folders[out.file.parent];
  assert.equal(folder.name, 'Solar Reports');

  // 2) admin selects p1 -> used instead
  admin('selectForReport', { photoId: p1 });
  rep = admin('generateReport', { poleIds: ['SL-046'] });
  out = reportImages(rt, rep.report.ReportID);
  assert.ok(out.sections[0].slots[2].img.includes(p1), 'admin selection p1 used');

  // temp doc copies are trashed, reports listed + logged
  assert.ok(Object.values(rt.state.files).filter((f) => f.name.startsWith('tmp_')).every((f) => f.trashed));
  assert.equal(rows('Reports').length, 2);
  assert.equal(rows('AuditLog').filter((r) => r.Action === 'ReportGenerated').length, 2);
  assert.equal(call(BOSS, 'bootstrap').reports.length, 2);

  // limit (ReportMaxPoles = 10)
  const eleven = Array.from({ length: 11 }, (_, i) => 'SL-0' + (34 + i));
  assert.equal(admin('generateReport', { poleIds: eleven }).code, 'BAD');
  assert.equal(admin('generateReport', { poleIds: [] }).code, 'BAD');
  assert.equal(admin('generateReport', { poleIds: ['SL-999'] }).code, 'NOTFOUND');

  // chunked download reassembles the exact bytes (force small chunks)
  rt.g.CHUNK_BYTES = 1000;
  let offset = 0, parts = [], first;
  do {
    const d = call(BOSS, 'downloadReport', { reportId: rep.report.ReportID, offset });
    assert.equal(d.ok, true);
    first = first || d;
    parts.push(Buffer.from(d.b64, 'base64'));
    offset = d.next;
  } while (offset !== null);
  assert.ok(parts.length > 1);
  assert.deepEqual(Buffer.concat(parts), out.file.buf);
  assert.equal(first.size, out.file.buf.length);
});

test('audit log: admin only, newest first, searchable; feed visible to all roles without user-admin entries', () => {
  const { call, admin, upload } = boot();
  upload(TEAM, 'SL-048', 'S1');
  call(TEAM, 'setDone', { poleId: 'SL-048', done: true });
  const a = admin('audit', { q: 'SL-048' });
  assert.equal(a.ok, true);
  assert.equal(a.rows[0].Action, 'MarkedDone');
  assert.equal(a.rows[1].Action, 'PhotoAdded');
  assert.equal(call(TEAM, 'audit', {}).code, 'FORBIDDEN');
  const feed = call(BOSS, 'bootstrap').feed;
  assert.equal(feed[0].Action, 'MarkedDone');
  assert.equal(feed[0].Name, 'Ali');
  assert.ok(feed.every((f) => !f.Action.startsWith('User')));
  assert.equal(call(BOSS, 'bootstrap').users, undefined, 'only admin receives the users list');
});

test('doPost JSON envelope + doGet health', () => {
  const { rt, tok } = boot();
  const out = JSON.parse(rt.g.doPost({ postData: { contents: JSON.stringify({ action: 'me', token: tok(BOSS) }) }, parameter: {} }).getContent());
  assert.equal(out.ok, true);
  assert.equal(out.user.role, 'Boss');
  assert.equal(JSON.parse(rt.g.doPost({ postData: { contents: 'not json' }, parameter: {} }).getContent()).code, 'BAD');
  assert.equal(JSON.parse(rt.g.doGet().getContent()).ok, true);
});
