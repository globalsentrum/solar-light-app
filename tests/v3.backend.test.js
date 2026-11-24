'use strict';
/* v3 backend tests: real apps-script code on the Apps Script mock, DUMMY poles. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { createRuntime } = require('./gas-mock');
const L = require('../shared/logic.js');

const ADMIN = 'owner@example.com', TEAM = 'team@example.com', BOSS = 'boss@example.com';
const IMG = fs.readFileSync(path.join(__dirname, 'fixtures/camera_noexif.jpg')).toString('base64');
const THUMB = fs.readFileSync(path.join(__dirname, 'fixtures/tiny.jpg')).toString('base64');
const json = (x) => JSON.parse(JSON.stringify(x));
let pid = 0;

function boot(opts) {
  const rt = createRuntime({ ownerEmail: ADMIN, ...(opts || {}) });
  rt.g.setup();
  const tok = (email) => rt.g.issueSession_(email);
  const call = (email, action, params) => json(rt.g.handle_({ action, token: tok(email), ...(params || {}) }));
  const admin = (a, p) => call(ADMIN, a, p);
  admin('saveUser', { email: TEAM, name: 'Ali', role: 'Team' });
  admin('saveUser', { email: BOSS, name: 'Bos', role: 'Boss' });
  const rows = (name) => rt.state.sheets[name].rowsAsObjects();
  const upload = (email, poleId, typeId, extra) => call(email, 'uploadPhoto', {
    photoId: 'v3_' + String(++pid).padStart(7, '0'), poleId, typeId, imageB64: IMG, thumbB64: THUMB, source: 'Camera',
    capturedAt: '2027-01-05T08:' + String(pid % 60).padStart(2, '0') + ':00+08:00', gpsAvailable: false,
    measurement: ['B2', 'B3', 'B4'].includes(typeId) ? '1.4' : undefined, ...(extra || {}),
  });
  const up = (poleId, typeId, extra) => { const r = upload(ADMIN, poleId, typeId, extra); assert.equal(r.ok, true, r.error); return r.photo.PhotoID; };
  /** Drive names of a photo's files: main / thumbnail / report copy */
  const namesOf = (photoId) => {
    const p = rt.state.sheets.Photos.rowsAsObjects().find((x) => x.PhotoID === photoId);
    const n = (id) => (id && rt.state.files[id] ? rt.state.files[id].name : '');
    return { main: n(p.DriveFileID), thumb: n(p.ThumbFileID), report: n(p.ReportFileID), folder: rt.state.folders[rt.state.files[p.DriveFileID].parent].name };
  };
  const folderOf = (name) => Object.values(rt.state.folders).find((f) => f.name === name && !f.trashed);
  const filesIn = (name) => { const f = folderOf(name); return f ? Object.values(rt.state.files).filter((x) => x.parent === f.id && !x.trashed).map((x) => x.name).sort() : []; };
  return { rt, tok, call, admin, rows, upload, up, folderOf, filesIn, namesOf };
}
/** Sheets (except the log) + Drive. Empty folders are ignored: a failed move may leave the (empty) target pole folder. */
const snapshot = (rt) => JSON.stringify({
  sheets: Object.fromEntries(Object.entries(rt.state.sheets).filter(([k]) => k !== 'AuditLog').map(([k, v]) => [k, v.data])),
  folders: Object.values(rt.state.folders).filter((f) => Object.values(rt.state.files).some((x) => x.parent === f.id) ||
    Object.values(rt.state.folders).some((x) => x.parent === f.id)).map((f) => [f.name, f.parent, !!f.trashed]),
  files: Object.values(rt.state.files).map((f) => [f.name, f.parent, !!f.trashed]) });

// ------------------------------------------------------------------ roles & permissions
/** One call per permission key that needs exactly that key. */
function keyCalls(env) {
  const { up } = env;
  let n = 0;
  return {
    capture_photo: () => ['uploadPhoto', { photoId: 'k_' + (++n) + '_abcdefgh', poleId: 'SSL035', typeId: 'A1', imageB64: IMG, source: 'Camera', gpsAvailable: false }],
    add_note: () => ['addNote', { noteId: 'kn_' + (++n), poleId: 'SSL035', text: 'x' }],
    mark_done: () => ['setDone', { poleId: 'SSL036', done: (++n) % 2 === 1 }],
    plan_work: () => ['addPlans', { poleIds: ['SSL040'], date: '2027-02-0' + ((++n % 9) + 1), activityId: 'C3' }],
    select_report_photos: () => ['setReportSelection', { poleId: 'SSL041', typeId: 'A1', photoIds: [] }],
    generate_report: () => ['reportCheck', { activityId: 'A', poleIds: ['SSL041'] }],
    record_rin: () => ['setRin', { poleId: 'SSL041', activityId: 'A', rin: 'R' + (++n) }],
    download_report: () => ['downloadReport', { reportId: env.reportId }],
    edit_pole: () => ['editPole', { poleId: 'SSL042', changes: { Chainage: 'CH.' + (50000 + (++n)) } }],
    add_pole: () => ['addPole', { poleId: 'NEW' + (++n), chainage: 'CH.' + (60000 + n), bound: 'EB', category: 'Perlu pasang' }],
    delete_pole: () => ['setPoleActive', { poleId: 'SSL043', active: (++n) % 2 === 0 }],
    import_poles: () => ['importPreview', { rows: [{ PoleID: 'IMP1', Chainage: 'CH.1', Bound: 'EB', Category: '' }] }],
    export_data: () => ['exportPoles', {}],
    edit_measurement: () => ['editMeasurement', { photoId: env.measPhoto, value: '1.' + ((++n % 9) + 1) }],
    hide_photo: () => ['setPhotoFlag', { photoId: env.flagPhoto, field: 'RetakeFlag', value: (++n) % 2 === 1 }],
    delete_photo: () => ['deletePhoto', { photoId: up('SSL044', 'A1') }],
    move_photo: () => ['movePhotos', { photoIds: [up('SSL044', 'A1')], targetPoleId: 'SSL045' }],
    override_status: () => ['overrideStatus', { poleId: 'SSL046', status: (++n) % 2 ? 'DONE' : '' }],
    manage_users: () => ['saveUser', { email: 'u' + (++n) + '@example.com', name: 'U', role: 'Team' }],
    manage_roles: () => ['saveRole', { name: 'Peranan ' + (++n), permissions: ['add_note'] }],
    edit_settings: () => ['saveLabels', { labels: { DONE: 'Siap ' + (++n) } }],
    view_audit_log: () => ['audit', {}],
    view_dashboard: null, // frontend tab only: bootstrap works for every active role (checked below)
  };
}

test('every permission key is enforced on the backend: a custom role with ONLY that key can, others cannot', () => {
  const env = boot();
  const { admin, call, up } = env;
  env.measPhoto = up('SSL034', 'B2');
  env.flagPhoto = up('SSL034', 'A1');
  ['B1', 'B3', 'B4'].forEach((t) => up('SSL034', t));
  env.reportId = admin('generateReport', { activityId: 'B', poleIds: ['SSL034'] }).report.ReportID;
  const calls = keyCalls(env);
  assert.deepEqual(Object.keys(calls).sort(), L.ALL_PERMISSIONS.slice().sort(), 'a test call for every key');
  for (const key of L.ALL_PERMISSIONS) {
    if (!calls[key]) continue;
    const email = key.replace(/_/g, '') + '@example.com';
    assert.equal(admin('saveRole', { name: 'Only ' + key, permissions: [key] }).ok, true);
    assert.equal(admin('saveUser', { email, name: key, role: 'Only ' + key }).ok, true);
    const [action, params] = calls[key]();
    const r = call(email, action, params);
    assert.equal(r.ok, true, `${key}: ${action} should be allowed: ${r.error}`);
    // a role with every OTHER key is refused
    const others = L.ALL_PERMISSIONS.filter((k) => k !== key);
    admin('saveRole', { name: 'All but ' + key, permissions: others });
    const email2 = 'not' + email;
    admin('saveUser', { email: email2, name: 'x', role: 'All but ' + key });
    const [action2, params2] = calls[key]();
    const r2 = call(email2, action2, params2);
    assert.equal(r2.code, 'FORBIDDEN', `${key}: ${action2} must be FORBIDDEN without the key, got ${JSON.stringify(r2).slice(0, 140)}`);
  }
  // no permissions at all: can still sign in and view
  admin('saveRole', { name: 'Kosong', permissions: [] });
  admin('saveUser', { email: 'empty@example.com', name: 'E', role: 'Kosong' });
  const b = call('empty@example.com', 'bootstrap');
  assert.equal(b.ok, true);
  assert.deepEqual(b.user.perms, []);
  assert.deepEqual(b.reports, [], 'no download_report -> no report list');
  assert.deepEqual(b.feed, [], 'no view_dashboard -> no feed');
  assert.equal(b.users, undefined);
});

test('migrated Team / Boss keep exactly their v2 powers', () => {
  const { call, admin, up } = boot();
  const one = up('SSL034', 'A1');
  const tryAll = (email) => {
    const r = {};
    r.upload = call(email, 'uploadPhoto', { photoId: 'tb_' + email.replace(/\W/g, '') + '_x', poleId: 'SSL035', typeId: 'A1', imageB64: IMG, source: 'Camera', gpsAvailable: false }).ok;
    r.note = call(email, 'addNote', { noteId: 'tb_' + email, poleId: 'SSL035', text: 'x' }).ok;
    r.done = call(email, 'setDone', { poleId: 'SSL036', done: true }).ok;
    r.hide = call(email, 'setPhotoFlag', { photoId: one, field: 'Hidden', value: false }).ok;
    r.select = call(email, 'setReportSelection', { poleId: 'SSL034', typeId: 'A1', photoIds: [] }).ok;
    r.plan = call(email, 'addPlans', { poleIds: ['SSL034'], date: '2027-03-03' }).ok;
    r.edit = call(email, 'editPole', { poleId: 'SSL040', changes: { Chainage: 'CH.77777' } }).ok;
    r.audit = call(email, 'audit', {}).ok;
    r.users = call(email, 'saveUser', { email: 'q@example.com', role: 'Team' }).ok;
    return r;
  };
  assert.deepEqual(tryAll(TEAM), { upload: true, note: true, done: true, hide: false, select: false, plan: false, edit: false, audit: false, users: false });
  assert.deepEqual(tryAll(BOSS), { upload: false, note: false, done: false, hide: false, select: false, plan: false, edit: false, audit: false, users: false });
  assert.equal(admin('bootstrap').user.perms.length, L.ALL_PERMISSIONS.length);
});

test('roles: create, rename (users follow), deactivate (users locked out), Admin built-in untouchable', () => {
  const { admin, call, rows } = boot();
  let r = admin('saveRole', { name: 'Supervisor', permissions: ['plan_work', 'view_dashboard', 'bogus'] });
  assert.match(r.error, /tidak dikenali: bogus/);
  r = admin('saveRole', { name: 'Supervisor', permissions: ['plan_work', 'view_dashboard'] });
  assert.equal(r.ok, true);
  assert.equal(admin('saveRole', { name: ' supervisor ', permissions: [] }).code, 'BAD', 'duplicate name (case/space)');
  admin('saveUser', { email: 'sup@example.com', name: 'Sup', role: 'supervisor' });
  assert.equal(rows('Users').find((u) => u.Email === 'sup@example.com').Role, 'Supervisor', 'stored with the role name');
  assert.equal(call('sup@example.com', 'addPlans', { poleIds: ['SSL034'], date: '2027-03-01' }).ok, true);
  r = admin('saveRole', { originalName: 'Supervisor', name: 'Penyelia', permissions: ['plan_work', 'view_dashboard', 'add_note'], active: true });
  assert.equal(r.ok, true);
  assert.equal(rows('Users').find((u) => u.Email === 'sup@example.com').Role, 'Penyelia', 'users follow the rename');
  assert.equal(call('sup@example.com', 'addNote', { noteId: 'sup1', poleId: 'SSL034', text: 'ok' }).ok, true);
  admin('saveRole', { originalName: 'Penyelia', name: 'Penyelia', permissions: ['plan_work'], active: false });
  assert.equal(call('sup@example.com', 'bootstrap').code, 'AUTH', 'inactive role -> locked out');
  assert.equal(admin('saveUser', { email: 'x@example.com', role: 'Penyelia' }).code, 'BAD', 'cannot assign an inactive role');
  for (const p of [{ name: 'Admin', permissions: [] }, { originalName: 'admin', name: 'Boss2', permissions: [] }, { originalName: 'Team', name: 'ADMIN', permissions: [] }]) {
    assert.match(admin('saveRole', p).error, /Admin terbina dalam/);
  }
  const roles = admin('bootstrap').roles;
  assert.equal(roles[0].RoleName, 'Admin');
  assert.equal(roles[0].BuiltIn, true);
  assert.equal(roles[0].Permissions.length, L.ALL_PERMISSIONS.length);
  const log = rows('AuditLog').filter((a) => a.Entity === 'Role').map((a) => a.Action + ':' + a.Field);
  assert.deepEqual(log, ['RoleAdded:Permissions', 'RoleRenamed:RoleName', 'RoleEdited:Permissions', 'RoleEdited:Permissions', 'RoleEdited:Active']);
});

test('Admin role cannot be reduced by editing the Roles sheet by hand; last active Admin is protected', () => {
  const { rt, admin, call, rows } = boot();
  const roles = rt.state.sheets.Roles;
  const i = roles.data.findIndex((r) => r[0] === 'Admin');
  roles.data[i][1] = 'view_dashboard'; roles.data[i][3] = 'FALSE';
  assert.equal(admin('bootstrap').user.perms.length, L.ALL_PERMISSIONS.length, 'built-in Admin always has every permission');
  const A2 = 'admin2@example.com';
  admin('saveUser', { email: A2, name: 'A2', role: 'Admin' });
  // two active admins: one may be demoted
  assert.equal(call(A2, 'saveUser', { email: ADMIN, name: 'A', role: 'Team' }).ok, true);
  // now A2 is the LAST active admin: nobody can deactivate, demote or remove it
  admin2Checks();
  function admin2Checks() {
    assert.match(call(A2, 'saveUser', { email: A2, role: 'Admin', active: false }).error, /sendiri/);
    // another user with manage_users (custom role) tries
    admin2Setup();
    assert.match(call('um@example.com', 'saveUser', { email: A2, name: 'A2', role: 'Team' }).error, /seorang Admin aktif/);
    assert.match(call('um@example.com', 'saveUser', { email: A2, name: 'A2', role: 'Admin', active: false }).error, /seorang Admin aktif/);
    assert.match(call('um@example.com', 'removeUser', { email: A2 }).error, /seorang Admin aktif/);
  }
  function admin2Setup() {
    call(A2, 'saveRole', { name: 'Pengurus pengguna', permissions: ['manage_users'] });
    call(A2, 'saveUser', { email: 'um@example.com', name: 'UM', role: 'Pengurus pengguna' });
  }
  assert.equal(rows('Users').filter((u) => u.Role === 'Admin' && u.Active === 'TRUE').length, 1);
  // with a second admin again, removal is allowed
  call(A2, 'saveUser', { email: ADMIN, name: 'A', role: 'Admin' });
  assert.equal(call('um@example.com', 'removeUser', { email: A2 }).ok, true);
});

// ------------------------------------------------------------------ poles
test('pole ID rename: duplicates blocked (case/space), temporary ID, every reference + Drive folder updated, old ID still works', () => {
  const { admin, call, rows, up, folderOf, filesIn, rt, namesOf } = boot();
  const a1 = up('SSL034', 'A1');
  const b2 = up('SSL034', 'B2');
  admin('setReportSelection', { poleId: 'SSL034', typeId: 'A1', photoIds: [a1] });
  call(TEAM, 'addNote', { noteId: 'rn1', poleId: 'SSL034', text: 'nota' });
  admin('addPlans', { poleIds: ['SSL034', 'SSL035'], date: '2027-02-01', activityId: 'A' });
  ['B1', 'B3', 'B4'].forEach((t) => up('SSL034', t));
  admin('generateReport', { activityId: 'A', poleIds: ['SSL034'] });
  admin('generateReport', { activityId: 'B', poleIds: ['SSL034'] });
  for (const bad of ['SSL035', 'ssl035', ' SSL035 ', 'Ssl035']) {
    const r = admin('editPole', { poleId: 'SSL034', changes: { PoleID: bad } });
    assert.equal(r.code, 'BAD', bad);
    assert.match(r.error, /sudah digunakan oleh tiang SSL035/, bad);
  }
  assert.equal(admin('editPole', { poleId: 'SSL034', changes: { PoleID: 'A,B' } }).code, 'BAD');
  const r = admin('editPole', { poleId: 'ssl034', changes: { PoleID: ' SSL999 ' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.pole.PoleID, 'SSL999');
  assert.equal(r.pole.PreviousIDs, 'SSL034');
  assert.ok(!rows('Poles').some((p) => p.PoleID === 'SSL034'));
  assert.equal(rows('Photos').filter((p) => p.PoleID === 'SSL999').length, 5);
  assert.equal(rows('Photos').find((p) => p.PhotoID === a1).ReportOrder, '1', 'selection kept');
  assert.equal(rows('Notes').find((n) => n.NoteID === 'rn1').PoleID, 'SSL999');
  assert.deepEqual(rows('WorkPlan').map((p) => p.PoleID).sort(), ['SSL035', 'SSL999']);
  assert.ok(rows('Reports').every((x) => x.PoleIDs === 'SSL999'));
  assert.ok(folderOf('SSL999') && !folderOf('SSL034'), 'Drive folder renamed');
  assert.match(namesOf(a1).main, /^SSL999_Pegging_Pegging_\d{4}-\d{2}-\d{2}_\d{4}\.jpg$/, 'v3 file names follow the new ID');
  assert.equal(namesOf(b2).thumb, namesOf(b2).main.replace('.jpg', '_thumb.jpg'), 'thumbnail follows');
  assert.equal(namesOf(b2).folder, 'SSL999');
  const log = rows('AuditLog').filter((x) => x.Action === 'PoleRenamed');
  assert.equal(log[0].OldValue, 'SSL034');
  assert.equal(log[0].NewValue, 'SSL999');
  // a photo queued on a phone with the OLD id still arrives at the renamed pole
  const late = call(TEAM, 'uploadPhoto', { photoId: 'late_0000001', poleId: 'SSL034', typeId: 'C2', imageB64: IMG, source: 'Camera', gpsAvailable: false });
  assert.equal(late.photo.PoleID, 'SSL999');
  // rename back to the old ID is allowed (it is free again)
  assert.equal(admin('editPole', { poleId: 'SSL999', changes: { PoleID: 'SSL034' } }).pole.PoleID, 'SSL034');
  assert.equal(rows('Photos').filter((p) => p.PoleID === 'SSL034').length, 6);
  void rt;
});

test('add pole, CH+bound warning, deactivate / reactivate, delete (blocked with photos, strong confirmation)', () => {
  const { admin, call, rows, up, rt } = boot();
  let r = admin('addPole', { poleId: 'ssl034', chainage: 'CH.1', bound: 'EB', category: 'Perlu pasang' });
  assert.match(r.error, /sudah digunakan oleh tiang SSL034/);
  const ch = rows('Poles').find((p) => p.PoleID === 'SSL034');
  r = admin('addPole', { poleId: 'SSL124', chainage: ch.Chainage, bound: ch.Bound, category: 'Perlu pasang', note: 'Tiang tambahan' });
  assert.equal(r.needsConfirm, true);
  assert.match(r.warnings[0], /sama dengan tiang SSL034/);
  assert.ok(!rows('Poles').some((p) => p.PoleID === 'SSL124'), 'not saved before confirmation');
  r = admin('addPole', { poleId: 'SSL124', chainage: ch.Chainage, bound: ch.Bound, category: 'Perlu pasang', note: 'Tiang tambahan', confirm: true });
  assert.equal(r.ok, true);
  assert.equal(r.pole.Active, true);
  assert.equal(rows('Notes').find((n) => n.PoleID === 'SSL124').Text, 'Tiang tambahan');
  assert.equal(admin('addPole', { poleId: 'X1', chainage: '', bound: 'EB' }).code, 'BAD');
  assert.equal(admin('addPole', { poleId: 'X1', chainage: 'CH.1', bound: 'NB' }).code, 'BAD');
  assert.equal(admin('editPole', { poleId: 'SSL035', changes: { Chainage: ch.Chainage, Bound: ch.Bound } }).needsConfirm, true, 'edit warns too');
  // deactivate
  admin('setPoleActive', { poleId: 'SSL124', active: false });
  const d = L.dashboard(admin('bootstrap').poles, L.photoTypes(), [], L.activities());
  assert.equal(d.total, 123, 'inactive pole not in totals');
  assert.equal(call(TEAM, 'uploadPhoto', { photoId: 'inact_000001', poleId: 'SSL124', typeId: 'A1', imageB64: IMG, source: 'Camera' }).code, 'FORBIDDEN');
  admin('setPoleActive', { poleId: 'SSL124', active: true });
  // delete blocked with photos
  const p = up('SSL124', 'A1');
  r = admin('deletePole', { poleId: 'SSL124', confirmId: 'SSL124' });
  assert.match(r.error, /Pindah atau padam gambar dahulu/);
  admin('deletePhoto', { photoId: p });
  assert.match(admin('deletePole', { poleId: 'SSL124', confirmId: 'SSL12' }).error, /Taip ID tiang/);
  admin('addPlans', { poleIds: ['SSL124'], date: '2027-02-02' });
  assert.equal(admin('deletePole', { poleId: 'SSL124', confirmId: 'ssl124' }).ok, true);
  assert.ok(!rows('Poles').some((x) => x.PoleID === 'SSL124'));
  assert.ok(!rows('WorkPlan').some((x) => x.PoleID === 'SSL124'), 'plans removed');
  assert.equal(rows('Notes').filter((n) => n.PoleID === 'SSL124').length, 1, 'notes kept');
  const f = Object.values(rt.state.folders).find((x) => x.name === 'SSL124');
  assert.equal(f.trashed, true, 'empty folder moved to Trash');
  assert.deepEqual(rows('AuditLog').filter((a) => a.EntityID === 'SSL124').map((a) => a.Action),
    ['PoleAdded', 'PoleDeactivated', 'PoleReactivated', 'PoleDeleted']);
});

test('import: preview with errors saves nothing; import adds new, skip / update existing, never saves error rows', () => {
  const { admin, rows } = boot();
  const input = [
    { PoleID: 'IMP01', Chainage: 'CH.91000', Bound: 'EB', Category: 'Perlu pasang' },
    { PoleID: 'imp01', Chainage: 'CH.91001', Bound: 'EB', Category: '' },
    { PoleID: '', Chainage: 'CH.9', Bound: 'EB', Category: '' },
    { PoleID: 'IMP02', Chainage: 'CH.92000', Bound: 'XX', Category: '' },
    { PoleID: 'IMP03', Chainage: 'CH.93000', Bound: 'wb', Category: 'Tunggu kelulusan' },
    { PoleID: 'SSL034', Chainage: 'CH.12345', Bound: 'WB', Category: 'Sudah dipasang' },
  ];
  const before = rows('Poles').length;
  const pv = admin('importPreview', { rows: input });
  assert.deepEqual(pv.rows.map((r) => r.status), ['error', 'error', 'error', 'error', 'new', 'exists']);
  assert.equal(rows('Poles').length, before, 'preview saves nothing');
  assert.match(admin('importPoles', { rows: input }).error, /dilangkau atau dikemas kini/);
  let r = admin('importPoles', { rows: input, onExisting: 'skip' });
  assert.deepEqual([r.added, r.updated, r.skipped, r.errors], [1, 0, 1, 4]);
  assert.equal(rows('Poles').length, before + 1);
  assert.equal(rows('Poles').find((p) => p.PoleID === 'IMP03').Bound, 'WB');
  assert.notEqual(rows('Poles').find((p) => p.PoleID === 'SSL034').Chainage, 'CH.12345', 'skip = unchanged');
  r = admin('importPoles', { rows: [input[5]], onExisting: 'update' });
  assert.deepEqual([r.added, r.updated], [0, 1]);
  const p = rows('Poles').find((x) => x.PoleID === 'SSL034');
  assert.deepEqual([p.Chainage, p.Bound, p.Category, p.ChainageExact], ['CH.12345', 'WB', 'Sudah dipasang', 'TRUE']);
  assert.ok(rows('AuditLog').some((a) => a.Action === 'PolesImported'));
});

test('export: .xlsx with category, work status, next plan date, actual date, photo progress, RIN', () => {
  const { admin, up } = boot();
  admin('addPlans', { poleIds: ['SSL034'], date: '2099-01-02', activityId: 'B' });
  admin('setRin', { poleId: 'SSL034', activityId: 'A', rin: 'RIN/PEG/01' });
  up('SSL034', 'A1');
  admin('overrideStatus', { poleId: 'SSL034', status: 'DONE', actualDate: '2027-01-04' });
  const r = admin('exportPoles');
  assert.equal(r.ok, true, r.error);
  assert.match(r.name, /^Solar_Poles_\d{8}-\d{4}\.xlsx$/);
  const wb = XLSX.read(Buffer.from(r.b64, 'base64'), { type: 'buffer' });
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  assert.equal(data.length, 123);
  const row = data.find((x) => x['Pole ID'] === 'SSL034');
  assert.equal(row['Work status'], 'Siap');
  assert.equal(row['Perlu gambar malam'], 'Ya');
  assert.equal(row['Next planned date'], '2099-01-02');
  assert.equal(row['Actual completion date'], '2027-01-04');
  assert.equal(row['Pegging'], '1/1');
  assert.equal(row['RIN Pegging'], 'RIN/PEG/01');
  assert.equal(data.find((x) => x['Pole ID'] === 'SSL001').Category, 'Sudah dipasang');
});

test('override status + actual completion date; Siap fills / Batal siap clears the date; latest action wins', () => {
  const { admin, call, rows } = boot();
  let r = admin('overrideStatus', { poleId: 'SSL040', status: 'DONE' });
  assert.equal(r.pole.StatusOverride, 'DONE');
  assert.match(r.pole.ActualDate, /^\d{4}-\d{2}-\d{2}$/, 'date filled');
  assert.equal(L.workStatus(r.pole, []), 'Siap', 'Siap without any photo');
  r = admin('overrideStatus', { poleId: 'SSL040', status: 'IN_PROGRESS', actualDate: '' });
  assert.equal(L.workStatus(r.pole, []), 'Dalam proses');
  assert.equal(r.pole.ActualDate, '');
  assert.equal(admin('overrideStatus', { poleId: 'SSL040', status: 'FINISHED' }).code, 'BAD');
  assert.equal(admin('overrideStatus', { poleId: 'SSL001', status: 'DONE' }).code, 'BAD', 'only Perlu pasang');
  assert.equal(admin('overrideStatus', { poleId: 'SSL040', status: '', actualDate: '2027-13-01' }).code, 'BAD');
  r = call(TEAM, 'setDone', { poleId: 'SSL040', done: true }).pole;
  assert.equal(r.StatusOverride, '', 'team action clears the override');
  assert.match(r.ActualDate, /^\d{4}-\d{2}-\d{2}$/);
  r = call(TEAM, 'setDone', { poleId: 'SSL040', done: false }).pole;
  assert.equal(r.ActualDate, '');
  assert.equal(admin('editPole', { poleId: 'SSL040', changes: { ActualDate: '2027-01-09' } }).pole.ActualDate, '2027-01-09');
  assert.ok(rows('AuditLog').some((a) => a.Action === 'StatusOverridden' && a.NewValue === 'DONE'));
});

// ------------------------------------------------------------------ photos
test('delete photo: row removed, photo + thumbnail moved to Drive Trash (not deleted), selection cleared, logged', () => {
  const { admin, rows, up, rt } = boot();
  const a = up('SSL034', 'C1'); const b = up('SSL034', 'C1'); const c = up('SSL034', 'C1'); const d = up('SSL034', 'C1'); up('SSL034', 'C1');
  admin('setReportSelection', { poleId: 'SSL034', typeId: 'C1', photoIds: [a, b, c, d] });
  const row = rows('Photos').find((p) => p.PhotoID === b);
  const filesBefore = Object.keys(rt.state.files).length;
  const r = admin('deletePhoto', { photoId: b });
  assert.equal(r.ok, true);
  assert.ok(!rows('Photos').some((p) => p.PhotoID === b));
  assert.equal(Object.keys(rt.state.files).length, filesBefore, 'files still exist (Trash)');
  assert.equal(rt.state.files[row.DriveFileID].trashed, true);
  assert.equal(rt.state.files[row.ThumbFileID].trashed, true, 'thumbnail in Trash');
  assert.ok(rows('Photos').filter((p) => p.PhotoTypeID === 'C1').every((p) => p.ReportOrder === ''), 'selection cleared');
  const log = rows('AuditLog').filter((x) => x.Action === 'PhotoDeleted')[0];
  assert.equal(log.OldValue, 'SSL034/C1/' + row.DriveFileID);
  assert.equal(admin('deletePhoto', { photoId: b }).code, 'NOTFOUND');
});

test('hide clears the selection of that type; edit measurement validated + logged', () => {
  const { admin, call, rows, up } = boot();
  const x = up('SSL034', 'B2'); up('SSL034', 'B2');
  admin('setReportSelection', { poleId: 'SSL034', typeId: 'B2', photoIds: [x] });
  admin('setPhotoFlag', { photoId: x, field: 'Hidden', value: true });
  assert.ok(rows('Photos').every((p) => p.ReportOrder === ''));
  for (const [v, re] of [['', /Sila masukkan/], ['abc', /tidak sah/], ['1.234', /2 titik perpuluhan/], ['0', /lebih daripada 0/]]) {
    assert.match(admin('editMeasurement', { photoId: x, value: v }).error, re, v);
  }
  assert.equal(admin('editMeasurement', { photoId: x, value: '1,25' }).photo.MeasurementM, 1.25);
  const a1 = up('SSL034', 'A1');
  assert.match(admin('editMeasurement', { photoId: a1, value: '1' }).error, /tiada ukuran/);
  assert.equal(call(TEAM, 'editMeasurement', { photoId: x, value: '2' }).code, 'FORBIDDEN');
  const log = rows('AuditLog').find((a) => a.Action === 'MeasurementEdited');
  assert.deepEqual([log.OldValue, log.NewValue], ['1.4', '1.25']);
});

test('move photos to another pole: added to target, optional type change, measurements move, Drive files move, selection cleared', () => {
  const { admin, rows, up, filesIn, namesOf } = boot();
  const t1 = up('SSL035', 'B2', { measurement: '1.1' });
  const m1 = up('SSL034', 'B2', { measurement: '1.7' });
  const m2 = up('SSL034', 'B3', { measurement: '1.9' });
  up('SSL034', 'B2');
  admin('setReportSelection', { poleId: 'SSL034', typeId: 'B2', photoIds: [m1] });
  let r = admin('movePhotos', { photoIds: [m1, m2], targetPoleId: 'ssl035' });
  assert.equal(r.ok, true, r.error);
  const ph = rows('Photos');
  assert.deepEqual([m1, m2, t1].map((id) => { const p = ph.find((x) => x.PhotoID === id); return p.PoleID + '/' + p.PhotoTypeID + '/' + p.MeasurementM; }),
    ['SSL035/B2/1.7', 'SSL035/B3/1.9', 'SSL035/B2/1.1'], 'target keeps its photo; measurements moved');
  assert.ok(ph.filter((p) => p.PoleID === 'SSL034' && p.PhotoTypeID === 'B2').every((p) => p.ReportOrder === ''), 'source selection cleared');
  assert.equal(ph.find((p) => p.PhotoID === m1).ReportOrder, '');
  assert.match(namesOf(m1).main, /^SSL035_TrialPit_Lebar_/, 'v3 name follows the new pole');
  assert.equal(namesOf(m1).folder, 'SSL035');
  assert.equal(namesOf(m1).thumb, namesOf(m1).main.replace('.jpg', '_thumb.jpg'));
  assert.ok(!filesIn('SSL034').includes(namesOf(m1).main));
  assert.notEqual(namesOf(m1).main, namesOf(t1).main, 'same pole/type/minute -> unique name');
  // with a type change (saved under the wrong type)
  r = admin('movePhotos', { photoIds: [m2], targetPoleId: 'SSL035', typeId: 'B4' });
  assert.equal(rows('Photos').find((p) => p.PhotoID === m2).PhotoTypeID, 'B4');
  assert.equal(rows('Photos').find((p) => p.PhotoID === m2).MeasurementM, '1.9');
  assert.match(namesOf(m2).main, /^SSL035_TrialPit_Dalam_/, 'type change -> new name');
  assert.match(admin('movePhotos', { photoIds: [m2], targetPoleId: 'SSL035' }).error, /sudah berada/);
  assert.equal(admin('movePhotos', { photoIds: [m2], targetPoleId: 'NOPE' }).code, 'NOTFOUND');
  assert.deepEqual(rows('AuditLog').filter((a) => a.Action === 'PhotoMoved').map((a) => a.OldValue + '>' + a.NewValue),
    ['SSL034/B2>SSL035/B2', 'SSL034/B3>SSL035/B3', 'SSL035/B3>SSL035/B4']);
});

test('move photos: Drive failure half-way -> nothing changed (rollback)', () => {
  const { admin, rt, up } = boot();
  const a = up('SSL034', 'A1'); const b = up('SSL034', 'C1'); const c = up('SSL034', 'C2');
  const before = snapshot(rt);
  rt.state.failMoveAfter = 3; // 2nd photo's thumbnail move fails
  const r = admin('movePhotos', { photoIds: [a, b, c], targetPoleId: 'SSL050' });
  assert.equal(r.code, 'SERVER');
  assert.match(r.error, /tiada perubahan dibuat/);
  assert.equal(snapshot(rt), before);
});

test('swap photos between 2 poles: all, one activity, selections follow, rollback on failure', () => {
  const { admin, rows, up, rt, filesIn, namesOf } = boot();
  const A = { A1: up('SSL034', 'A1'), B1: up('SSL034', 'B1'), C2: up('SSL034', 'C2') };
  const extra = up('SSL034', 'A1');
  const B = { A1: up('SSL035', 'A1'), C3: up('SSL035', 'C3') };
  admin('setReportSelection', { poleId: 'SSL034', typeId: 'A1', photoIds: [extra] });
  // one activity (Pegging)
  let r = admin('swapPhotos', { poleA: 'SSL034', poleB: 'SSL035', activityId: 'A' });
  assert.equal(r.ok, true, r.error);
  const pole = (id) => rows('Photos').find((p) => p.PhotoID === id).PoleID;
  assert.deepEqual([pole(A.A1), pole(extra), pole(B.A1), pole(A.B1), pole(B.C3)], ['SSL035', 'SSL035', 'SSL034', 'SSL034', 'SSL035']);
  assert.equal(rows('Photos').find((p) => p.PhotoID === extra).ReportOrder, '1', 'selection follows the photo');
  const L2 = admin('bootstrap');
  assert.deepEqual(L.reportPhotos('SSL035', 'A1', L2.photos).map((p) => p.PhotoID), [extra]);
  assert.equal(namesOf(A.A1).folder, 'SSL035');
  assert.match(namesOf(A.A1).main, /^SSL035_Pegging_Pegging_/);
  // all activities
  r = admin('swapPhotos', { poleA: 'SSL034', poleB: 'SSL035' });
  assert.deepEqual([pole(A.A1), pole(A.B1), pole(A.C2), pole(B.A1), pole(B.C3)], ['SSL034', 'SSL035', 'SSL035', 'SSL035', 'SSL034']);
  // rollback
  const before = snapshot(rt);
  rt.state.failMoveAfter = 4;
  r = admin('swapPhotos', { poleA: 'SSL034', poleB: 'SSL035' });
  assert.match(r.error, /semua perubahan dibatalkan/);
  assert.equal(snapshot(rt), before, 'nothing changed');
  assert.equal(admin('swapPhotos', { poleA: 'SSL034', poleB: 'ssl034' }).code, 'BAD');
  assert.equal(admin('swapPhotos', { poleA: 'SSL060', poleB: 'SSL061' }).code, 'BAD', 'nothing to swap');
  assert.equal(rows('AuditLog').filter((a) => a.Action === 'PhotosSwapped').length, 2);
});

// ------------------------------------------------------------------ reports, RIN, labels, plans
test('reports: generate only Sedia poles (no automatic pick when more than required), RIN saved per activity', () => {
  const { admin, call, rows, up } = boot();
  ['B1', 'B2', 'B3', 'B4'].forEach((t) => { up('SSL034', t); up('SSL035', t); });
  const extraB1 = up('SSL035', 'B1');
  let r = admin('reportCheck', { activityId: 'B', poleIds: ['SSL034', 'SSL035'] });
  assert.deepEqual(r.ready, ['SSL034']);
  assert.deepEqual(r.missing, [{ PoleID: 'SSL035', missing: ['Korek: pilih 1 daripada 2 gambar'] }]);
  assert.match(admin('generateReport', { activityId: 'B', poleIds: ['SSL034', 'SSL035'] }).error, /Hanya tiang yang Sedia/);
  admin('setReportSelection', { poleId: 'SSL035', typeId: 'B1', photoIds: [extraB1] });
  r = admin('generateReport', { activityId: 'B', poleIds: ['SSL034', 'SSL035'], rin: 'RIN/TP/007' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.poles.map((p) => p.PoleID + ':' + p.RINTrialPit), ['SSL034:RIN/TP/007', 'SSL035:RIN/TP/007']);
  assert.equal(rows('Poles').find((p) => p.PoleID === 'SSL034').RINPegging, '', 'other activities untouched');
  const b = admin('bootstrap');
  assert.equal(L.poleReportStatus('B', b.poles.find((p) => p.PoleID === 'SSL034'), b.types, b.photos).status, 'reported');
  // empty RIN never blocks; record_rin needed only when a RIN is given
  admin('saveRole', { name: 'Pembuat claim', permissions: ['generate_report', 'select_report_photos', 'download_report'] });
  admin('saveUser', { email: 'claim@example.com', name: 'C', role: 'Pembuat claim' });
  assert.equal(call('claim@example.com', 'generateReport', { activityId: 'B', poleIds: ['SSL034'] }).ok, true);
  assert.equal(call('claim@example.com', 'generateReport', { activityId: 'B', poleIds: ['SSL034'], rin: 'X' }).code, 'FORBIDDEN');
  // edit / clear RIN later
  assert.equal(admin('setRin', { poleId: 'SSL034', activityId: 'B', rin: '' }).pole.RINTrialPit, '');
  assert.equal(admin('editPole', { poleId: 'SSL035', changes: { RINTrialPit: 'RIN/TP/008' } }).pole.RINTrialPit, 'RIN/TP/008');
  assert.deepEqual(rows('AuditLog').filter((a) => a.Action === 'RinRecorded' && a.EntityID === 'SSL034').map((a) => a.OldValue + '>' + a.NewValue),
    ['>RIN/TP/007', 'RIN/TP/007>']);
});

test('labels: 20-character limit enforced on labels and activity / photo type names; stored by key', () => {
  const { admin, rows, call } = boot();
  assert.match(admin('saveLabels', { labels: { DONE: 'x'.repeat(21) } }).error, /Maksimum 20 aksara/);
  assert.match(admin('saveLabels', { labels: { WHATEVER: 'x' } }).error, /tidak dikenali/);
  const r = admin('saveLabels', { labels: { DONE: 'Siap sepenuhnya 2027', BAKI: 'Baki' } });
  assert.equal(r.labels.DONE, 'Siap sepenuhnya 2027');
  assert.equal(rows('Settings').find((s) => s.Key === 'Label.DONE').Value, 'Siap sepenuhnya 2027');
  assert.equal(call(BOSS, 'bootstrap').labels.BAKI, 'Baki');
  assert.match(admin('saveNames', { types: [{ TypeID: 'C1', Name: 'x'.repeat(21) }] }).error, /Maksimum 20 aksara/);
  assert.match(admin('saveNames', { activities: [{ ActivityID: 'A', Name: 'y'.repeat(21), Spec: '' }] }).error, /Maksimum 20 aksara/);
  assert.equal(admin('saveNames', { types: [{ TypeID: 'C1', Name: 'x'.repeat(20) }] }).ok, true);
  assert.equal(rows('AuditLog').filter((a) => a.Action === 'LabelEdited').length, 2);
});

test('work plan accepts "Ujian lampu (malam)" (C3)', () => {
  const { admin, rows } = boot();
  assert.equal(admin('addPlans', { poleIds: ['SSL034'], date: '2027-02-03', activityId: 'C3' }).ok, true);
  assert.equal(rows('WorkPlan')[0].Activity, 'C3');
  assert.equal(admin('addPlans', { poleIds: ['SSL034'], date: '2027-02-03', activityId: 'C9' }).code, 'BAD');
});

// ------------------------------------------------------------------ migration v2 -> v3 on data made by the REAL v2 code
const V2_DIR = path.join(__dirname, 'fixtures', 'v2-code');

function buildV2() {
  const v2 = createRuntime({ ownerEmail: ADMIN, codeDir: V2_DIR });
  v2.g.setup();
  const tok = (e) => v2.g.issueSession_(e);
  const call = (e, a, p) => json(v2.g.handle_({ action: a, token: tok(e), ...p }));
  call(ADMIN, 'saveUser', { email: TEAM, name: 'Ali', role: 'Team' });
  call(ADMIN, 'saveUser', { email: BOSS, name: 'Bos', role: 'Boss' });
  let k = 0;
  const up = (pole, t, m) => call(TEAM, 'uploadPhoto', { photoId: 'v2p_' + String(++k).padStart(6, '0'), poleId: pole, typeId: t, imageB64: IMG, thumbB64: THUMB,
    source: 'Camera', capturedAt: '2027-01-02T09:' + String(k % 60).padStart(2, '0') + ':00+08:00', gpsAvailable: true, latitude: 3.1, longitude: 101.6, accuracy: 5,
    measurement: m }).photo.PhotoID;
  for (const pole of ['SSL034', 'SSL035', 'SSL040']) {
    up(pole, 'A1'); up(pole, 'B1'); up(pole, 'B2', '1.3'); up(pole, 'B3', '1.6'); up(pole, 'B4', '1.5');
    for (let i = 0; i < 5; i++) up(pole, 'C1');
    up(pole, 'C2'); up(pole, 'C3');
  }
  const c1 = v2.state.sheets.Photos.rowsAsObjects().filter((p) => p.PoleID === 'SSL034' && p.PhotoTypeID === 'C1').map((p) => p.PhotoID);
  call(ADMIN, 'setReportSelection', { poleId: 'SSL034', typeId: 'C1', photoIds: [c1[4], c1[0], c1[2], c1[1]] });
  call(TEAM, 'addNote', { noteId: 'v2n1', poleId: 'SSL034', text: 'nota v2' });
  call(TEAM, 'setDone', { poleId: 'SSL034', done: true });
  call(ADMIN, 'addPlans', { poleIds: ['SSL040', 'SSL041'], date: '2027-01-10', activityId: 'B' });
  call(ADMIN, 'generateReport', { activityId: 'A', poleIds: ['SSL034', 'SSL035'] });
  call(ADMIN, 'setPhotoFlag', { photoId: 'v2p_000002', field: 'Hidden', value: true });
  return { v2, call };
}
const counts = (rt) => ({
  sheets: Object.fromEntries(['Poles', 'Photos', 'Notes', 'WorkPlan', 'Reports', 'Users', 'Activities', 'PhotoTypes']
    .map((n) => [n, rt.state.sheets[n].rowsAsObjects().length])),
  driveFiles: Object.values(rt.state.files).filter((f) => !f.trashed).length,
});
const keep = (rows, cols) => rows.map((r) => cols.map((c) => r[c]).join('|'));

test('migrateV3 on realistic v2 data: nothing lost, roles keep their powers, idempotent, one audit row, v2 queued items accepted', () => {
  const { v2 } = buildV2();
  const before = counts(v2);
  const photosBefore = keep(v2.state.sheets.Photos.rowsAsObjects(), ['PhotoID', 'PoleID', 'PhotoTypeID', 'DriveFileID', 'Hidden', 'RetakeFlag', 'ReportOrder', 'MeasurementM', 'CapturedAt']);
  const notesBefore = JSON.stringify(v2.state.sheets.Notes.rowsAsObjects());
  const plansBefore = JSON.stringify(v2.state.sheets.WorkPlan.rowsAsObjects());
  const reportsBefore = JSON.stringify(v2.state.sheets.Reports.rowsAsObjects());
  const auditBefore = JSON.stringify(v2.state.sheets.AuditLog.rowsAsObjects());
  const polesBefore = v2.state.sheets.Poles.rowsAsObjects();
  // the v3 code on the same data
  const v3 = createRuntime({ state: v2.state });
  assert.throws(() => v3.g.setup(), /migrateV3/, 'setup refuses a v2 sheet');
  const msg = v3.g.migrateV3();
  assert.match(msg, /perubahan/);
  assert.deepEqual(counts(v3), before, 'row counts and Drive file counts unchanged');
  assert.deepEqual(keep(v3.state.sheets.Photos.rowsAsObjects(), ['PhotoID', 'PoleID', 'PhotoTypeID', 'DriveFileID', 'Hidden', 'RetakeFlag', 'ReportOrder', 'MeasurementM', 'CapturedAt']), photosBefore);
  assert.equal(JSON.stringify(v3.state.sheets.Notes.rowsAsObjects()), notesBefore);
  assert.equal(JSON.stringify(v3.state.sheets.WorkPlan.rowsAsObjects()), plansBefore);
  assert.equal(JSON.stringify(v3.state.sheets.Reports.rowsAsObjects()), reportsBefore);
  const auditAfter = v3.state.sheets.AuditLog.rowsAsObjects();
  assert.equal(JSON.stringify(auditAfter.slice(0, -1)), auditBefore, 'old log untouched');
  assert.equal(auditAfter[auditAfter.length - 1].Action, 'MigrationV3');
  // every old Poles column value unchanged; new columns added
  const polesAfter = v3.state.sheets.Poles.rowsAsObjects();
  polesBefore.forEach((p, i) => Object.keys(p).forEach((k) => assert.equal(polesAfter[i][k], p[k], p.PoleID + '.' + k)));
  const done = polesAfter.find((p) => p.PoleID === 'SSL034');
  assert.equal(done.Active, 'TRUE');
  assert.equal(done.ActualDate, done.DoneAt.slice(0, 10), 'actual date from DoneAt');
  assert.equal(polesAfter.find((p) => p.PoleID === 'SSL001').ActualDate, '', 'Sudah dipasang left blank');
  assert.deepEqual(v3.state.sheets.Poles.data[0].slice(-7), ['ActualDate', 'Active', 'PreviousIDs', 'StatusOverride', 'RINPegging', 'RINTrialPit', 'RINInstallation']);
  assert.equal(v3.state.sheets.PhotoTypes.rowsAsObjects().find((t) => t.TypeID === 'C2').Name, 'Siap pasang (siang)');
  assert.ok(v3.state.sheets.Settings.rowsAsObjects().some((s) => s.Key === 'Label.BAKI'));
  // second run: nothing at all
  const snap = JSON.stringify(Object.fromEntries(Object.entries(v3.state.sheets).map(([k, v]) => [k, v.data])));
  assert.match(v3.g.migrateV3(), /tiada perubahan/);
  assert.equal(JSON.stringify(Object.fromEntries(Object.entries(v3.state.sheets).map(([k, v]) => [k, v.data]))), snap);
  // roles keep their powers; v2 admin selection still used
  const tok = (e) => v3.g.issueSession_(e);
  const call = (e, a, p) => json(v3.g.handle_({ action: a, token: tok(e), ...(p || {}) }));
  assert.deepEqual(call(TEAM, 'me').user.perms.slice().sort(), ['add_note', 'capture_photo', 'download_report', 'mark_done', 'view_dashboard']);
  assert.deepEqual(call(BOSS, 'me').user.perms.slice().sort(), ['download_report', 'view_dashboard']);
  assert.equal(call(ADMIN, 'me').user.perms.length, L.ALL_PERMISSIONS.length);
  const b = call(ADMIN, 'bootstrap');
  assert.equal(L.isAdminChoice('SSL034', 'C1', b.photos), true, 'v2 selection kept');
  assert.equal(L.poleReportStatus('C', b.poles.find((p) => p.PoleID === 'SSL034'), b.types, b.photos).status, 'ready');
  // items still queued on phones by the v2 app
  const q1 = call(TEAM, 'uploadPhoto', { photoId: 'queued_v2_001', poleId: 'SSL041', typeId: 'B2', measurement: '1,2', imageB64: IMG, thumbB64: THUMB,
    source: 'Gallery', capturedAt: '2027-01-03T10:00:00+08:00', latitude: 3.1, longitude: 101.6, accuracy: 4, gpsAvailable: true });
  assert.equal(q1.ok, true, q1.error);
  assert.equal(call(TEAM, 'addNote', { noteId: 'queued_note', poleId: 'SSL041', text: 'dari v2', createdAt: '2027-01-03T10:00:00+08:00' }).ok, true);
  assert.equal(call(TEAM, 'setDone', { poleId: 'SSL041', done: true }).ok, true);
  assert.equal(call(TEAM, 'uploadPhoto', { photoId: 'queued_v1_001', poleId: 'SL-041', slotId: 'S1', imageB64: IMG, source: 'Camera' }).photo.PoleID, 'SSL041', 'even v1 items');
});

test('migrateV3 keeps a C2 name the admin changed; migrateV3 refuses a v1 sheet', () => {
  const { v2, call } = buildV2();
  call(ADMIN, 'saveNames', { types: [{ TypeID: 'C2', Name: 'Siang (lengkap)' }] });
  const v3 = createRuntime({ state: v2.state });
  v3.g.migrateV3();
  assert.equal(v3.state.sheets.PhotoTypes.rowsAsObjects().find((t) => t.TypeID === 'C2').Name, 'Siang (lengkap)');
  const fresh = createRuntime({ ownerEmail: ADMIN });
  fresh.state.sheets.Photos = undefined;
  const ss = fresh.g.SpreadsheetApp.getActiveSpreadsheet();
  const ph = ss.insertSheet('Photos');
  ph.data = [['PhotoID', 'PoleID', 'SlotID']];
  assert.throws(() => fresh.g.migrateV3(), /migrateV2/);
});

test('fresh setup (new Sheet) creates Roles and labels; migrateV3 on it changes nothing', () => {
  const { rt, rows } = boot();
  assert.deepEqual(rows('Roles').map((r) => r.RoleName), ['Admin', 'Team', 'Boss']);
  assert.ok(rows('Poles').every((p) => p.Active === 'TRUE'));
  assert.match(rt.g.migrateV3(), /tiada perubahan/);
});

test('a retried upload / note with an existing ID still needs the permission', () => {
  const { call, up } = boot();
  const id = up('SSL034', 'A1');
  const r = call(BOSS, 'uploadPhoto', { photoId: id, poleId: 'SSL034', typeId: 'A1', imageB64: IMG, source: 'Camera' });
  assert.equal(r.code, 'FORBIDDEN');
  call(TEAM, 'addNote', { noteId: 'dupnote1', poleId: 'SSL034', text: 'x' });
  assert.equal(call(BOSS, 'addNote', { noteId: 'dupnote1', poleId: 'SSL034', text: 'x' }).code, 'FORBIDDEN');
});

test('photo quality settings: admin only (edit_settings), validated, logged, sent to phones; uploads up to 15 MB accepted', () => {
  const { admin, call, rows, rt } = boot();
  assert.deepEqual(call(TEAM, 'bootstrap').photoSettings, { maxSide: 2048, quality: 0.88 }, 'defaults from setup');
  assert.equal(rows('Settings').find((x) => x.Key === 'PhotoMaxSide').Value, '2048');
  assert.equal(call(TEAM, 'savePhotoSettings', { maxSide: 2500, quality: 0.9 }).code, 'FORBIDDEN');
  assert.match(admin('savePhotoSettings', { maxSide: 1000, quality: 0.9 }).error, /1280–3000/);
  assert.match(admin('savePhotoSettings', { maxSide: 2500, quality: 0.99 }).error, /0.6–0.95/);
  const r = admin('savePhotoSettings', { maxSide: 2500, quality: '0,9' });
  assert.deepEqual(r.photoSettings, { maxSide: 2500, quality: 0.9 });
  assert.deepEqual(call(BOSS, 'bootstrap').photoSettings, { maxSide: 2500, quality: 0.9 });
  assert.deepEqual(rows('AuditLog').filter((a) => a.Action === 'SettingEdited').map((a) => a.EntityID + ':' + a.OldValue + '>' + a.NewValue),
    ['PhotoMaxSide:2048>2500', 'PhotoQuality:0.88>0.9']);
  // value typed by hand in the Sheet outside the range -> default used
  rt.g.setSetting_('PhotoMaxSide', '12000');
  assert.deepEqual(call(TEAM, 'bootstrap').photoSettings, { maxSide: 2048, quality: 0.9 });
  // upload size limit: 12 MB accepted, 16 MB refused
  const big = (mb) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(mb * 1024 * 1024)]).toString('base64');
  assert.equal(call(TEAM, 'uploadPhoto', { photoId: 'big_12mb_0001', poleId: 'SSL034', typeId: 'A1', imageB64: big(12), source: 'Camera' }).ok, true);
  assert.match(call(TEAM, 'uploadPhoto', { photoId: 'big_16mb_0001', poleId: 'SSL034', typeId: 'A1', imageB64: big(16), source: 'Camera' }).error, /terlalu besar/);
});

test('migrateV3 adds PhotoMaxSide / PhotoQuality to a v2 sheet (defaults), second run unchanged', () => {
  const v2 = createRuntime({ ownerEmail: ADMIN, codeDir: path.join(__dirname, 'fixtures', 'v2-code') });
  v2.g.setup();
  assert.ok(!v2.state.sheets.Settings.rowsAsObjects().some((x) => x.Key === 'PhotoMaxSide'));
  const v3 = createRuntime({ state: v2.state });
  v3.g.migrateV3();
  const s = v3.state.sheets.Settings.rowsAsObjects();
  assert.equal(s.find((x) => x.Key === 'PhotoMaxSide').Value, '2048');
  assert.equal(s.find((x) => x.Key === 'PhotoQuality').Value, '0.88');
  assert.match(v3.g.migrateV3(), /tiada perubahan/);
});

// ------------------------------------------------------------------ file names + report copies (v3 addition)
const PORTRAIT = fs.readFileSync(path.join(__dirname, 'fixtures/gallery_noexif.jpg')).toString('base64'); // 1500x2000
const LANDSCAPE = IMG; // 2400x1800
const REPORT_COPY = THUMB; // stands in for the small copy made on the phone

test('new photo files: <PoleID>_<Activity>_<PhotoType>_<YYYY-MM-DD>_<HHMM>.jpg, _2/_3 when taken, thumbnail + report copy suffixes', () => {
  const { call, rows, rt, namesOf } = boot();
  const upload = (id, typeId, extra) => call(TEAM, 'uploadPhoto', { photoId: id, poleId: 'SSL034', typeId, imageB64: IMG, thumbB64: THUMB, reportB64: REPORT_COPY,
    source: 'Camera', capturedAt: '2026-11-24T10:32:15+08:00', gpsAvailable: false, measurement: '1.3', ...(extra || {}) });
  ['nm_0000001', 'nm_0000002', 'nm_0000003'].forEach((id) => assert.equal(upload(id, 'B2').ok, true));
  assert.deepEqual(['nm_0000001', 'nm_0000002', 'nm_0000003'].map((id) => namesOf(id).main),
    ['SSL034_TrialPit_Lebar_2026-11-24_1032.jpg', 'SSL034_TrialPit_Lebar_2026-11-24_1032_2.jpg', 'SSL034_TrialPit_Lebar_2026-11-24_1032_3.jpg']);
  const n = namesOf('nm_0000002');
  assert.equal(n.thumb, 'SSL034_TrialPit_Lebar_2026-11-24_1032_2_thumb.jpg');
  assert.equal(n.report, 'SSL034_TrialPit_Lebar_2026-11-24_1032_2_report.jpg');
  assert.equal(n.folder, 'SSL034', 'folder per pole kept');
  upload('nm_0000004', 'C2', { capturedAt: '2026-11-24T08:05:00+08:00', reportB64: undefined });
  assert.equal(namesOf('nm_0000004').main, 'SSL034_Installation_SiapPasangSiang_2026-11-24_0805.jpg');
  assert.equal(namesOf('nm_0000004').report, '', 'no report copy sent (e.g. queued by the v2 app) -> none stored');
  const row = rows('Photos').find((p) => p.PhotoID === 'nm_0000001');
  assert.ok(row.ThumbFileID && row.ReportFileID);
  // thumbnails are found by file ID
  const th = call(BOSS, 'getThumbs', { poleId: 'SSL034' }).thumbs;
  assert.deepEqual(Object.keys(th).sort(), ['nm_0000001', 'nm_0000002', 'nm_0000003', 'nm_0000004']);
  // names use the CURRENT activity / type names
  call(ADMIN, 'saveNames', { types: [{ TypeID: 'B2', Name: 'Lebar lubang' }] });
  upload('nm_0000005', 'B2');
  assert.equal(namesOf('nm_0000005').main, 'SSL034_TrialPit_LebarLubang_2026-11-24_1032.jpg');
  // retry of the same photo does not create files again
  const before = Object.keys(rt.state.files).length;
  upload('nm_0000005', 'B2');
  assert.equal(Object.keys(rt.state.files).length, before);
  // temporary pole IDs with spaces
  call(ADMIN, 'addPole', { poleId: 'TEMP 01', chainage: 'CH.77777', bound: 'EB', category: 'Perlu pasang' });
  call(TEAM, 'uploadPhoto', { photoId: 'nm_temp_001', poleId: 'TEMP 01', typeId: 'A1', imageB64: IMG, source: 'Camera', capturedAt: '2026-11-24T09:00:00+08:00' });
  assert.equal(namesOf('nm_temp_001').main, 'TEMP-01_Pegging_Pegging_2026-11-24_0900.jpg');
});

test('delete photo also moves the report copy to Trash', () => {
  const { call, admin, rows, rt } = boot();
  call(TEAM, 'uploadPhoto', { photoId: 'del_rc_0001', poleId: 'SSL034', typeId: 'A1', imageB64: IMG, thumbB64: THUMB, reportB64: REPORT_COPY, source: 'Camera' });
  const row = rows('Photos')[0];
  admin('deletePhoto', { photoId: 'del_rc_0001' });
  [row.DriveFileID, row.ThumbFileID, row.ReportFileID].forEach((id) => assert.equal(rt.state.files[id].trashed, true));
});

test('older photos (made by the v2 app): file names NEVER renamed on move / swap / pole rename; thumbnails still found; reports use the original', () => {
  const { v2, call } = buildV2();
  const v3 = createRuntime({ state: v2.state });
  v3.g.migrateV3();
  const tok = (e) => v3.g.issueSession_(e);
  const c = (e, a, p) => json(v3.g.handle_({ action: a, token: tok(e), ...(p || {}) }));
  const photos = () => v3.state.sheets.Photos.rowsAsObjects();
  const nameOf = (id) => v3.state.files[photos().find((p) => p.PhotoID === id).DriveFileID].name;
  const oldNames = Object.fromEntries(photos().map((p) => [p.PhotoID, nameOf(p.PhotoID)]));
  assert.ok(Object.values(oldNames).every((n) => /^SSL0\d\d_[A-C]\d_\d{8}-\d{6}_v2p_\d+\.jpg$/.test(n)), 'v2 names');
  assert.equal(Object.keys(c(BOSS, 'getThumbs', { poleId: 'SSL035' }).thumbs).length, 12, 'old thumbnails found by their old names');
  // move, swap, rename pole
  c(ADMIN, 'movePhotos', { photoIds: ['v2p_000013'], targetPoleId: 'SSL050', typeId: 'A1' });
  c(ADMIN, 'swapPhotos', { poleA: 'SSL035', poleB: 'SSL040' });
  c(ADMIN, 'editPole', { poleId: 'SSL034', changes: { PoleID: 'SSL900' } });
  photos().forEach((p) => assert.equal(nameOf(p.PhotoID), oldNames[p.PhotoID], p.PhotoID + ' not renamed'));
  assert.equal(v3.state.folders[v3.state.files[photos().find((p) => p.PhotoID === 'v2p_000013').DriveFileID].parent].name, 'SSL050', 'but moved to the right folder');
  const thumbs = c(BOSS, 'getThumbs', { poleId: 'SSL050' }).thumbs;
  assert.ok(thumbs.v2p_000013, 'moved old thumbnail still found');
  // report with old photos (no report copy): originals used
  const r = c(ADMIN, 'generateReport', { activityId: 'A', poleIds: ['SSL900', 'SSL050'] });
  assert.equal(r.ok, true, r.error);
});

/** Ten poles per activity with mixed portrait / landscape photos + report copies. */
function tenPoles(env) {
  const { call } = env;
  const ids = Array.from({ length: 10 }, (_, i) => 'SSL' + String(34 + i).padStart(3, '0'));
  let k = 0;
  const up = (pole, t, img) => {
    const r = call(TEAM, 'uploadPhoto', { photoId: 'ten_' + String(++k).padStart(6, '0'), poleId: pole, typeId: t, imageB64: img, thumbB64: THUMB,
      reportB64: img === PORTRAIT ? PORTRAIT : LANDSCAPE, source: 'Camera', capturedAt: '2027-01-05T09:' + String(k % 60).padStart(2, '0') + ':00+08:00',
      gpsAvailable: false, measurement: ['B2', 'B3', 'B4'].includes(t) ? '1.' + (k % 9 + 1) : undefined });
    assert.equal(r.ok, true, r.error);
    return r.photo.PhotoID;
  };
  ids.forEach((pole, i) => {
    const o = (j) => ((i + j) % 2 ? PORTRAIT : LANDSCAPE); // mixed orientations
    up(pole, 'A1', o(0)); ['B1', 'B2', 'B3', 'B4'].forEach((t, j) => up(pole, t, o(j)));
    [0, 1, 2, 3].forEach((j) => up(pole, 'C1', o(j))); up(pole, 'C2', o(1)); up(pole, 'C3', o(0));
  });
  return ids;
}

test('10-pole report for each activity: report copies used, equal-sized cells, photos centred and never cropped (mixed portrait / landscape)', () => {
  const env = boot();
  const { admin, rt, rows } = env;
  const ids = tenPoles(env);
  const copyIds = new Set(rows('Photos').map((p) => p.ReportFileID));
  for (const [act, nBlocks, cellsPerPole] of [['A', 1, 1], ['B', 10, 4], ['C', 20, 6]]) {
    const r = admin('generateReport', { activityId: act, poleIds: ids });
    assert.equal(r.ok, true, act + ': ' + r.error);
    const id = r.report.FileURL.match(/\/d\/([^/]+)/)[1];
    const txt = rt.state.files[id].buf.toString('utf8');
    const doc = JSON.parse(txt.slice(txt.indexOf('\n') + 1));
    const tables = doc.children.filter((n) => n.type === 'table');
    assert.equal(tables.length, nBlocks, act + ' blocks');
    let photosIn = 0;
    tables.forEach((t) => {
      const grid = t.rows[1][0].children.find((c) => c.type === 'table');
      const box = { A: { w: 160, h: 120 }, B: { w: 118, h: 157 }, C: null }[act];
      assert.equal(new Set(grid.colWidths).size, 1, 'equal column widths');
      assert.equal(grid.minHeights.length, grid.rows.length, 'every row has a fixed minimum height');
      assert.equal(new Set(grid.minHeights).size, 1, 'equal row heights');
      grid.rows.forEach((row) => row.forEach((cell) => {
        const p0 = cell.children[0];
        if (!p0.images.length) return;
        photosIn++;
        assert.equal(cell.valign, 'CENTER', 'vertically centred');
        assert.equal(p0.align, 'CENTER', 'horizontally centred');
        const img = p0.images[0];
        const ratio = img.natural.w / img.natural.h;
        assert.ok(Math.abs(img.w / img.h - ratio) < 0.02, 'aspect ratio kept (not cropped / stretched)');
        if (box) assert.ok(img.w <= box.w && img.h <= box.h && (img.w === box.w || img.h === box.h), 'fits the cell exactly on one side');
        assert.ok(/_report\.jpg$/.test(img.name), 'the report copy is inserted: ' + img.name);
      }));
    });
    assert.equal(photosIn, ids.length * cellsPerPole, act + ' photo count');
  }
  assert.equal(copyIds.size, 110, '10 poles x 11 photos, each with its own report copy');
});

test('report size guard: refuses a report whose photos together exceed 45 MB, with a clear message; nothing generated', () => {
  const env = boot();
  const { admin, call, rows } = env;
  const big = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(5 * 1024 * 1024)]).toString('base64');
  const ids = Array.from({ length: 10 }, (_, i) => 'SSL' + String(34 + i).padStart(3, '0'));
  ids.forEach((pole, i) => call(TEAM, 'uploadPhoto', { photoId: 'huge_' + String(i).padStart(6, '0'), poleId: pole, typeId: 'A1', imageB64: big, source: 'Camera' }));
  const r = admin('generateReport', { activityId: 'A', poleIds: ids });
  assert.equal(r.code, 'BAD');
  assert.match(r.error, /Laporan terlalu besar \(50 MB gambar\)/);
  assert.equal(rows('Reports').length, 0);
  assert.equal(admin('generateReport', { activityId: 'A', poleIds: ids.slice(0, 8) }).ok, true, '8 x 5 MB = 40 MB is fine');
});

test('migrateV3 adds Photos.ThumbFileID / ReportFileID (empty for old photos) without touching existing values', () => {
  const { v2 } = buildV2();
  const before = v2.state.sheets.Photos.rowsAsObjects();
  const v3 = createRuntime({ state: v2.state });
  v3.g.migrateV3();
  const after = v3.state.sheets.Photos.rowsAsObjects();
  assert.deepEqual(v3.state.sheets.Photos.data[0].slice(-2), ['ThumbFileID', 'ReportFileID']);
  before.forEach((p, i) => Object.keys(p).forEach((k) => assert.equal(after[i][k], p[k])));
  assert.ok(after.every((p) => p.ThumbFileID === '' && p.ReportFileID === ''));
});
