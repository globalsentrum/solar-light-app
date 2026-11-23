/*
 * Solar Street Light — Apps Script backend (JSON API).
 * Karak Highway, Package 2A.
 *
 * Files in this Apps Script project:  Code.gs (this), Logic.gs, SeedData.gs (private)
 * New Google Sheet: run setup() once from the editor, then Deploy > New deployment > Web app
 *   Execute as: Me    Who has access: Anyone
 * Existing v1 Sheet (slots, SL-xxx IDs): run migrateV2() once (safe to run again).
 *
 * Every request: POST, body = JSON text (Content-Type text/plain to avoid CORS preflight):
 *   { "action": "...", "token": "<session token>", ...params }
 * Reply: { ok: true, ...data }  or  { ok: false, code: "AUTH|FORBIDDEN|NOTFOUND|BAD|SERVER", error: "<Malay message>" }
 *
 * Google sign-in uses Google Identity Services in REDIRECT mode: Google posts the ID token
 * (form field "credential") to this web app's URL; we verify it, check the Users sheet and send the
 * user back to the app with our own 30-day session token. The session is re-checked against the
 * Users sheet on EVERY request, so setting Active = FALSE (or deleting the row) locks a user out at once.
 */

var TZ = 'Asia/Kuala_Lumpur';
var CHUNK_BYTES = 4 * 1024 * 1024;
var MAX_IMAGE_BYTES = 8 * 1024 * 1024;

var SCHEMA = {
  Poles: ['PoleID', 'Bound', 'Chainage', 'ChainageExact', 'Category', 'PlannedDate', 'IsDone', 'DoneBy', 'DoneAt', 'UpdatedAt'],
  Photos: ['PhotoID', 'PoleID', 'PhotoTypeID', 'DriveFileID', 'FileURL', 'Source', 'CapturedAt', 'UploadedAt', 'Latitude', 'Longitude', 'AccuracyM', 'GPSAvailable', 'TakenBy', 'Hidden', 'RetakeFlag', 'ReportOrder', 'MeasurementM'],
  Activities: ['ActivityID', 'Name', 'Spec'],
  PhotoTypes: ['TypeID', 'ActivityID', 'Name'],
  WorkPlan: ['PlanID', 'Date', 'PoleID', 'Activity', 'CreatedBy', 'CreatedAt'],
  Notes: ['NoteID', 'PoleID', 'Text', 'CreatedBy', 'CreatedAt'],
  Users: ['Email', 'Name', 'Role', 'Active'],
  AuditLog: ['Timestamp', 'UserEmail', 'Action', 'Entity', 'EntityID', 'Field', 'OldValue', 'NewValue'],
  Reports: ['ReportID', 'PoleIDs', 'Activity', 'FileURL', 'DocxURL', 'CreatedBy', 'CreatedAt'],
  Settings: ['Key', 'Value']
};

var DEFAULT_SETTINGS = {
  ProjectName: 'Cadangan Pelebaran Lebuhraya Kuala Lumpur – Karak, Seksyen 2, Package 2A — Solar Street Lighting',
  ClientID: '',
  AppURL: '',
  ReportMaxPhotos: '60',
  SessionDays: '30',
  PhotosFolderID: '',
  ReportsFolderID: ''
};
var REPORT_KEYS = { A: 'PEGGING', B: 'TRIALPIT', C: 'INSTALLATION' };



// =====================================================================
// Errors / small utils
// =====================================================================
function apiError_(code, msg) { var e = new Error(msg); e.apiCode = code; return e; }
function nowIso_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function str_(v) { return v === null || v === undefined ? '' : String(v); }
function cell_(v) {
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  if (v === null || v === undefined) return '';
  return String(v);
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function normEmail_(e) { return str_(e).trim().toLowerCase(); }
function req_(params, key) {
  var v = params[key];
  if (v === undefined || v === null || v === '') throw apiError_('BAD', 'Maklumat "' + key + '" tiada.');
  return v;
}
function escHtml_(s) {
  return str_(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// =====================================================================
// Sheet table helpers (columns found by header name; all cells stored as plain text)
// =====================================================================
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw apiError_('SERVER', 'Tab "' + name + '" tiada dalam Google Sheet. Jalankan setup().');
  return sh;
}

function normValue_(v, header) {
  if (v instanceof Date) {
    return header === 'PlannedDate' || header === 'Date' ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd')
      : Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
  }
  if (typeof v === 'string') return v.trim();
  return v;
}

function readTable_(name, tailRows) {
  var sh = sheet_(name);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return str_(h).trim(); });
  var cols = {};
  SCHEMA[name].forEach(function (h) {
    var i = headerRow.indexOf(h);
    if (i < 0) throw apiError_('SERVER', 'Lajur "' + h + '" tiada dalam tab ' + name + '.');
    cols[h] = i + 1;
  });
  var last = sh.getLastRow();
  var rows = [];
  var start = 2;
  if (tailRows && last - tailRows + 1 > start) start = last - tailRows + 1;
  if (last >= start) {
    var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
    values.forEach(function (v, i) {
      var o = { _row: i + start };
      SCHEMA[name].forEach(function (h) { o[h] = normValue_(v[cols[h] - 1], h); });
      if (str_(o[SCHEMA[name][0]]) !== '') rows.push(o);
    });
  }
  return { name: name, sheet: sh, cols: cols, width: lastCol, rows: rows };
}

function appendObj_(t, obj) {
  var arr = [];
  for (var i = 0; i < t.width; i++) arr.push('');
  SCHEMA[t.name].forEach(function (h) { arr[t.cols[h] - 1] = cell_(obj[h]); });
  var r = t.sheet.getLastRow() + 1;
  var range = t.sheet.getRange(r, 1, 1, t.width);
  range.setNumberFormat('@');
  range.setValues([arr]);
  var copy = { _row: r };
  SCHEMA[t.name].forEach(function (h) { copy[h] = obj[h] === undefined ? '' : obj[h]; });
  t.rows.push(copy);
  return copy;
}

function updateObj_(t, row, changes) {
  Object.keys(changes).forEach(function (h) {
    if (!t.cols[h]) throw apiError_('SERVER', 'Lajur tidak dikenali: ' + h);
    var range = t.sheet.getRange(row._row, t.cols[h], 1, 1);
    range.setNumberFormat('@');
    range.setValue(cell_(changes[h]));
    row[h] = changes[h];
  });
}

function findUser_(t, email) {
  var e = normEmail_(email);
  for (var i = 0; i < t.rows.length; i++) if (normEmail_(t.rows[i].Email) === e) return t.rows[i];
  return null;
}

function find_(t, key, value) {
  for (var i = 0; i < t.rows.length; i++) if (str_(t.rows[i][key]) === str_(value)) return t.rows[i];
  return null;
}

function clean_(rows) {
  return rows.map(function (r) {
    var o = {};
    Object.keys(r).forEach(function (k) { if (k !== '_row') o[k] = r[k]; });
    return o;
  });
}

function settings_() {
  var t = readTable_('Settings');
  var s = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { s[k] = DEFAULT_SETTINGS[k]; });
  t.rows.forEach(function (r) { s[str_(r.Key)] = str_(r.Value); });
  return s;
}

function setSetting_(key, value) {
  var t = readTable_('Settings');
  var r = find_(t, 'Key', key);
  if (r) updateObj_(t, r, { Value: value }); else appendObj_(t, { Key: key, Value: value });
}

function audit_(user, action, entity, entityId, field, oldValue, newValue) {
  appendObj_(readTable_('AuditLog', 1), {
    Timestamp: nowIso_(), UserEmail: user ? user.email : '', Action: action, Entity: entity,
    EntityID: entityId, Field: field || '', OldValue: cell_(oldValue), NewValue: cell_(newValue)
  });
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// =====================================================================
// Sessions
// =====================================================================
function b64url_(bytesOrString) {
  return Utilities.base64EncodeWebSafe(bytesOrString).replace(/=+$/, '');
}
function sessionSecret_() {
  var s = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  if (!s) throw apiError_('SERVER', 'SESSION_SECRET belum ditetapkan. Jalankan setup().');
  return s;
}
function sign_(payloadB64) {
  return b64url_(Utilities.computeHmacSha256Signature(payloadB64, sessionSecret_()));
}
function issueSession_(email) {
  var days = Number(settings_().SessionDays) || 30;
  var payload = { e: normEmail_(email), i: Date.now(), x: Date.now() + days * 86400000 };
  var p = b64url_(JSON.stringify(payload));
  return p + '.' + sign_(p);
}
function verifySession_(token) {
  var parts = str_(token).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw apiError_('AUTH', 'Sila log masuk.');
  if (sign_(parts[0]) !== parts[1]) throw apiError_('AUTH', 'Sesi tidak sah. Sila log masuk semula.');
  var payload;
  try {
    var padded = parts[0] + '==='.slice((parts[0].length + 3) % 4);
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString());
  } catch (err) { throw apiError_('AUTH', 'Sesi tidak sah. Sila log masuk semula.'); }
  if (!payload.x || payload.x < Date.now()) throw apiError_('AUTH', 'Sesi telah tamat. Sila log masuk semula.');
  return payload;
}

/** Session -> current user from the Users sheet (checked on every request). */
function userFromToken_(token) {
  var p = verifySession_(token);
  var u = findUser_(readTable_('Users'), p.e);
  if (!u || !SolarLogic.bool(u.Active)) {
    throw apiError_('AUTH', 'Akaun anda tiada dalam senarai pengguna atau tidak aktif. Hubungi admin.');
  }
  var role = str_(u.Role);
  if (SolarLogic.ROLES.indexOf(role) < 0) throw apiError_('FORBIDDEN', 'Peranan akaun anda tidak sah. Hubungi admin.');
  return { email: p.e, name: str_(u.Name) || p.e, role: role };
}

function verifyGoogleIdToken_(idToken) {
  var clientId = settings_().ClientID;
  if (!clientId) throw apiError_('SERVER', 'ClientID belum diisi dalam tab Settings.');
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw apiError_('AUTH', 'Log masuk Google gagal. Cuba lagi.');
  var info = JSON.parse(res.getContentText());
  if (info.aud !== clientId) throw apiError_('AUTH', 'Log masuk Google gagal (Client ID tidak sepadan).');
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') {
    throw apiError_('AUTH', 'Log masuk Google gagal.');
  }
  if (String(info.email_verified) !== 'true') throw apiError_('AUTH', 'Emel Google belum disahkan.');
  if (Number(info.exp) * 1000 < Date.now()) throw apiError_('AUTH', 'Log masuk Google tamat tempoh. Cuba lagi.');
  return { email: normEmail_(info.email), nonce: str_(info.nonce) };
}

// =====================================================================
// Entry points
// =====================================================================
function doGet() {
  return json_({ ok: true, service: 'solar-api', time: nowIso_() });
}

function doPost(e) {
  // Google Identity Services redirect: form post with "credential"
  if (e && e.parameter && e.parameter.credential) return handleGoogleRedirect_(e.parameter.credential);
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, code: 'BAD', error: 'Permintaan tidak sah.' });
  }
  return json_(handle_(body));
}

/** Pure dispatcher (also used by the tests). */
function handle_(body) {
  try {
    var action = str_(body.action);
    var fn = ACTIONS[action];
    if (!fn) throw apiError_('BAD', 'Tindakan tidak dikenali: ' + action);
    var user = userFromToken_(body.token);
    // Items queued on a phone by the old v1 app (pole "SL-034", slot "S1") still sync after the migration.
    if (body.poleId) body.poleId = SolarLogic.poleIdFromLegacy(body.poleId) || body.poleId;
    if (action === 'uploadPhoto' && !body.typeId && body.slotId) body.typeId = SolarLogic.LEGACY_SLOT_MAP[str_(body.slotId)] || '';
    var out = fn(user, body) || {};
    out.ok = true;
    return out;
  } catch (err) {
    var code = err.apiCode || 'SERVER';
    if (!err.apiCode) console.error(err && err.stack ? err.stack : err);
    return { ok: false, code: code, error: err.apiCode ? err.message : 'Ralat pelayan: ' + err.message };
  }
}

function handleGoogleRedirect_(credential) {
  var appUrl = settings_().AppURL;
  var target, label, message;
  try {
    var info = verifyGoogleIdToken_(credential);
    var u = findUser_(readTable_('Users'), info.email);
    if (!u || !SolarLogic.bool(u.Active)) {
      throw apiError_('AUTH', 'Emel ' + info.email + ' tiada dalam senarai pengguna. Minta admin tambah emel anda.');
    }
    var session = issueSession_(info.email);
    withLock_(function () { audit_({ email: info.email }, 'Login', 'User', info.email, '', '', ''); });
    target = appUrl + '#login=' + encodeURIComponent(session) + '&nonce=' + encodeURIComponent(info.nonce);
    label = 'Teruskan ke aplikasi';
    message = 'Log masuk berjaya.';
  } catch (err) {
    message = err.apiCode ? err.message : 'Ralat: ' + err.message;
    target = appUrl + '#loginerror=' + encodeURIComponent(message);
    label = 'Kembali ke aplikasi';
  }
  var html = '<!doctype html><html><head><meta charset="utf-8"></head>' +
    '<body style="font-family:sans-serif;text-align:center;padding:40px 16px;background:#f4f6f8">' +
    '<h2 style="color:#0b5d3b">Solar Street Light</h2><p>' + escHtml_(message) + '</p>' +
    '<p><a id="go" target="_top" href="' + escHtml_(target) + '" style="display:inline-block;padding:16px 28px;' +
    'background:#0b5d3b;color:#fff;border-radius:10px;text-decoration:none;font-size:18px">' +
    escHtml_(label) + '</a></p>' +
    '<script>try{window.top.location.href=document.getElementById("go").href;}catch(e){}</script>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('Log masuk')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function assert_(user, action, pole) {
  var reason = SolarLogic.denyReason(user.role, action, pole);
  if (reason) throw apiError_('FORBIDDEN', reason);
}

function getPole_(t, poleId) {
  var p = find_(t, 'PoleID', poleId);
  if (!p) throw apiError_('NOTFOUND', 'Tiang ' + poleId + ' tidak dijumpai.');
  return p;
}

function poleOut_(p) {
  var o = clean_([p])[0];
  o.ChainageExact = SolarLogic.bool(o.ChainageExact);
  o.IsDone = SolarLogic.bool(o.IsDone);
  return o;
}

function photoOut_(p) {
  var o = clean_([p])[0];
  ['Hidden', 'RetakeFlag', 'GPSAvailable'].forEach(function (k) { o[k] = SolarLogic.bool(o[k]); });
  ['Latitude', 'Longitude', 'AccuracyM', 'MeasurementM'].forEach(function (k) { o[k] = o[k] === '' || o[k] === undefined ? '' : Number(o[k]); });
  o.ReportOrder = Number(o.ReportOrder) > 0 ? Number(o.ReportOrder) : 0;
  return o;
}

function typesNow_() { return SolarLogic.photoTypes(readTable_('PhotoTypes').rows); }
function activitiesNow_() { return SolarLogic.activities(readTable_('Activities').rows); }
function activityArg_(v) {
  var a = str_(v);
  if (!REPORT_KEYS[a]) throw apiError_('BAD', 'Aktiviti tidak sah.');
  return a;
}
function poleIdsArg_(list, poles) {
  var ids = (list || []).map(str_);
  if (!ids.length) throw apiError_('BAD', 'Pilih sekurang-kurangnya satu tiang.');
  var seen = {};
  ids.forEach(function (id) {
    if (seen[id]) throw apiError_('BAD', 'Tiang berulang: ' + id);
    seen[id] = true;
    getPole_(poles, id);
  });
  return ids.sort();
}

// =====================================================================
// Actions
// =====================================================================
var ACTIONS = {};

/** Who am I. */
ACTIONS.me = function (user) { return { user: user }; };

/** Everything the app needs in one call. */
ACTIONS.bootstrap = function (user) {
  assert_(user, 'view');
  var isAdmin = SolarLogic.can(user.role, 'viewHidden');
  var users = readTable_('Users').rows;
  var names = {};
  users.forEach(function (u) { names[normEmail_(u.Email)] = str_(u.Name) || str_(u.Email); });
  var photos = readTable_('Photos').rows.map(photoOut_).filter(function (p) { return isAdmin || !p.Hidden; });
  var audit = readTable_('AuditLog', 400).rows;
  var feedActions = ['PhotoAdded', 'NoteAdded', 'MarkedDone', 'DoneCancelled', 'CategoryChanged', 'PoleEdited',
    'RetakeFlagged', 'RetakeCleared', 'ReportGenerated'];
  var feed = audit.filter(function (a) { return feedActions.indexOf(a.Action) >= 0; }).slice(-30).reverse()
    .map(function (a) {
      return { Timestamp: a.Timestamp, Name: names[normEmail_(a.UserEmail)] || a.UserEmail, Action: a.Action,
        EntityID: a.EntityID, Field: a.Field, OldValue: a.OldValue, NewValue: a.NewValue };
    });
  var s = settings_();
  var out = {
    user: user,
    serverTime: nowIso_(),
    projectName: s.ProjectName,
    reportMaxPhotos: Number(s.ReportMaxPhotos) || 60,
    poles: readTable_('Poles').rows.map(poleOut_),
    activities: activitiesNow_(),
    types: typesNow_(),
    plans: clean_(readTable_('WorkPlan').rows),
    photos: photos,
    notes: clean_(readTable_('Notes').rows),
    reports: clean_(readTable_('Reports').rows).reverse(),
    names: names,
    feed: feed
  };
  if (SolarLogic.can(user.role, 'manageUsers')) out.users = clean_(users).map(function (u) { u.Active = SolarLogic.bool(u.Active); return u; });
  return out;
};

function poleFolder_(poleId) {
  var rootId = settings_().PhotosFolderID;
  if (!rootId) throw apiError_('SERVER', 'PhotosFolderID belum ditetapkan. Jalankan setup().');
  var root = DriveApp.getFolderById(rootId);
  var it = root.getFoldersByName(poleId);
  return it.hasNext() ? it.next() : root.createFolder(poleId);
}

/**
 * Save one photo (already watermarked on the phone). Idempotent: the phone generates PhotoID,
 * so a retried upload of the same photo is accepted once and never duplicated.
 */
ACTIONS.uploadPhoto = function (user, b) {
  var photoId = str_(req_(b, 'photoId'));
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(photoId)) throw apiError_('BAD', 'PhotoID tidak sah.');
  return withLock_(function () {
    var photos = readTable_('Photos');
    var existing = find_(photos, 'PhotoID', photoId);
    if (existing) return { duplicate: true, photo: photoOut_(existing) };
    var pole = getPole_(readTable_('Poles'), str_(req_(b, 'poleId')));
    assert_(user, 'uploadPhoto', pole);
    var typeId = str_(req_(b, 'typeId'));
    var type = SolarLogic.typeById(typeId);
    if (!type) throw apiError_('BAD', 'Jenis gambar tidak dijumpai: ' + typeId);
    var measurement = '';
    if (type.NeedsMeasurement) {
      var m = SolarLogic.parseMeasurement(b.measurement);
      if (!m.ok) throw apiError_('BAD', m.error);
      measurement = SolarLogic.formatMeasurement(m.value);
    }
    var source = b.source === 'Gallery' ? 'Gallery' : 'Camera';
    var bytes = Utilities.base64Decode(str_(req_(b, 'imageB64')));
    if (bytes.length > MAX_IMAGE_BYTES) throw apiError_('BAD', 'Gambar terlalu besar.');
    var stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss');
    var folder = poleFolder_(pole.PoleID);
    var file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg',
      pole.PoleID + '_' + typeId + '_' + stamp + '_' + photoId + '.jpg'));
    if (b.thumbB64) {
      folder.createFile(Utilities.newBlob(Utilities.base64Decode(str_(b.thumbB64)), 'image/jpeg', photoId + '_thumb.jpg'));
    }
    var gps = b.gpsAvailable === true && b.latitude !== '' && b.latitude !== null && b.latitude !== undefined;
    var row = appendObj_(photos, {
      PhotoID: photoId, PoleID: pole.PoleID, PhotoTypeID: typeId, DriveFileID: file.getId(), FileURL: file.getUrl(),
      Source: source, CapturedAt: str_(b.capturedAt) || nowIso_(), UploadedAt: nowIso_(),
      Latitude: gps ? Number(b.latitude).toFixed(6) : '', Longitude: gps ? Number(b.longitude).toFixed(6) : '',
      AccuracyM: gps && b.accuracy !== '' && b.accuracy != null ? Math.round(Number(b.accuracy)) : '',
      GPSAvailable: gps, TakenBy: user.email, Hidden: false, RetakeFlag: false, ReportOrder: '', MeasurementM: measurement
    });
    audit_(user, 'PhotoAdded', 'Photo', photoId, 'Pole/Type', '', pole.PoleID + '/' + typeId + ' (' + source + ')' +
      (measurement ? ' ' + measurement + 'm' : ''));
    return { photo: photoOut_(row) };
  });
};

/** Small thumbnails for one pole, as base64 (photos stay private in Drive). */
ACTIONS.getThumbs = function (user, b) {
  assert_(user, 'viewPhotos');
  var poleId = str_(req_(b, 'poleId'));
  var isAdmin = SolarLogic.can(user.role, 'viewHidden');
  var allowed = {};
  readTable_('Photos').rows.forEach(function (p) {
    if (p.PoleID === poleId && (isAdmin || !SolarLogic.bool(p.Hidden))) allowed[p.PhotoID] = true;
  });
  var wanted = b.photoIds ? b.photoIds : null;
  var thumbs = {};
  if (!Object.keys(allowed).length) return { thumbs: thumbs };
  var folder = poleFolder_(poleId);
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    var m = f.getName().match(/^(.+)_thumb\.jpg$/);
    if (m && allowed[m[1]] && (!wanted || wanted.indexOf(m[1]) >= 0)) {
      thumbs[m[1]] = Utilities.base64Encode(f.getBlob().getBytes());
    }
  }
  return { thumbs: thumbs };
};

/** Full-size watermarked photo as base64. */
ACTIONS.getPhoto = function (user, b) {
  assert_(user, 'viewPhotos');
  var p = find_(readTable_('Photos'), 'PhotoID', str_(req_(b, 'photoId')));
  if (!p || (SolarLogic.bool(p.Hidden) && !SolarLogic.can(user.role, 'viewHidden'))) throw apiError_('NOTFOUND', 'Gambar tidak dijumpai.');
  var blob = DriveApp.getFileById(p.DriveFileID).getBlob();
  return { mime: 'image/jpeg', b64: Utilities.base64Encode(blob.getBytes()) };
};

/** Append a note (idempotent on noteId). Allowed for every category. */
ACTIONS.addNote = function (user, b) {
  var noteId = str_(req_(b, 'noteId'));
  var text = str_(req_(b, 'text')).trim();
  if (!text) throw apiError_('BAD', 'Nota kosong.');
  if (text.length > 2000) throw apiError_('BAD', 'Nota terlalu panjang (maksimum 2000 aksara).');
  return withLock_(function () {
    var notes = readTable_('Notes');
    var ex = find_(notes, 'NoteID', noteId);
    if (ex) return { duplicate: true, note: clean_([ex])[0] };
    var pole = getPole_(readTable_('Poles'), str_(req_(b, 'poleId')));
    assert_(user, 'addNote', pole);
    var row = appendObj_(notes, { NoteID: noteId, PoleID: pole.PoleID, Text: text, CreatedBy: user.email,
      CreatedAt: str_(b.createdAt) || nowIso_() });
    audit_(user, 'NoteAdded', 'Note', noteId, 'PoleID', '', pole.PoleID);
    return { note: clean_([row])[0] };
  });
};

/** Tanda kerja siap / Batal siap. Setting the same state twice is a no-op (safe for retries). */
ACTIONS.setDone = function (user, b) {
  var done = b.done === true;
  return withLock_(function () {
    var poles = readTable_('Poles');
    var pole = getPole_(poles, str_(req_(b, 'poleId')));
    assert_(user, 'setDone', pole);
    var was = SolarLogic.bool(pole.IsDone);
    if (was !== done) {
      var now = nowIso_();
      updateObj_(poles, pole, done ? { IsDone: true, DoneBy: user.email, DoneAt: now, UpdatedAt: now }
        : { IsDone: false, DoneBy: '', DoneAt: '', UpdatedAt: now });
      audit_(user, done ? 'MarkedDone' : 'DoneCancelled', 'Pole', pole.PoleID, 'IsDone', was, done);
    }
    return { pole: poleOut_(pole) };
  });
};

/** Admin: edit chainage, bound, planned date, category. Each changed field is logged. */
ACTIONS.editPole = function (user, b) {
  var ch = b.changes || {};
  var allowedFields = ['Chainage', 'Bound', 'PlannedDate', 'Category'];
  Object.keys(ch).forEach(function (k) {
    if (allowedFields.indexOf(k) < 0) throw apiError_('BAD', 'Medan tidak boleh diubah: ' + k);
  });
  assert_(user, 'editPole');
  if ('Category' in ch) assert_(user, 'setCategory');
  if ('Bound' in ch && ['EB', 'WB'].indexOf(ch.Bound) < 0) throw apiError_('BAD', 'Bound mesti EB atau WB.');
  if ('Category' in ch && SolarLogic.CATEGORIES.indexOf(ch.Category) < 0) throw apiError_('BAD', 'Kategori tidak sah.');
  if ('PlannedDate' in ch && ch.PlannedDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(str_(ch.PlannedDate))) {
    throw apiError_('BAD', 'Tarikh mesti dalam format YYYY-MM-DD.');
  }
  if ('Chainage' in ch && !str_(ch.Chainage).trim()) throw apiError_('BAD', 'Chainage tidak boleh kosong.');
  return withLock_(function () {
    var poles = readTable_('Poles');
    var pole = getPole_(poles, str_(req_(b, 'poleId')));
    var upd = {};
    allowedFields.forEach(function (k) {
      if (!(k in ch)) return;
      var nv = k === 'Chainage' ? str_(ch[k]).trim() : str_(ch[k]);
      if (nv === str_(pole[k])) return;
      audit_(user, k === 'Category' ? 'CategoryChanged' : 'PoleEdited', 'Pole', pole.PoleID, k, pole[k], nv);
      upd[k] = nv;
    });
    if ('Chainage' in upd) {
      var exact = SolarLogic.isChainageExact(upd.Chainage);
      if (exact !== SolarLogic.bool(pole.ChainageExact)) {
        audit_(user, 'PoleEdited', 'Pole', pole.PoleID, 'ChainageExact', SolarLogic.bool(pole.ChainageExact), exact);
      }
      upd.ChainageExact = exact;
    }
    if (Object.keys(upd).length) {
      upd.UpdatedAt = nowIso_();
      updateObj_(poles, pole, upd);
    }
    return { pole: poleOut_(pole) };
  });
};

/** Admin: Hidden / RetakeFlag on/off. Photos are never deleted. */
ACTIONS.setPhotoFlag = function (user, b) {
  var field = str_(b.field);
  var value = b.value === true;
  var map = {
    Hidden: { perm: 'hidePhoto', on: 'PhotoHidden', off: 'PhotoUnhidden' },
    RetakeFlag: { perm: 'flagRetake', on: 'RetakeFlagged', off: 'RetakeCleared' }
  };
  if (!map[field]) throw apiError_('BAD', 'Medan tidak sah.');
  assert_(user, map[field].perm);
  return withLock_(function () {
    var photos = readTable_('Photos');
    var p = find_(photos, 'PhotoID', str_(req_(b, 'photoId')));
    if (!p) throw apiError_('NOTFOUND', 'Gambar tidak dijumpai.');
    var was = SolarLogic.bool(p[field]);
    if (was !== value) {
      var upd = {};
      upd[field] = value;
      updateObj_(photos, p, upd);
      audit_(user, value ? map[field].on : map[field].off, 'Photo', p.PhotoID, field, was, value);
    }
    return { photo: photoOut_(p) };
  });
};

/**
 * Admin: choose the photo(s) used in the report for one pole + photo type.
 * photoIds in report order: exactly 1 (C1: exactly 4). An empty list clears the choice (automatic default).
 */
ACTIONS.setReportSelection = function (user, b) {
  assert_(user, 'selectReport');
  var typeId = str_(req_(b, 'typeId'));
  var type = SolarLogic.typeById(typeId);
  if (!type) throw apiError_('BAD', 'Jenis gambar tidak sah.');
  var ids = (b.photoIds || []).map(str_);
  if (ids.length && ids.length !== type.ReportCount) {
    throw apiError_('BAD', 'Pilih tepat ' + type.ReportCount + ' gambar untuk ' + type.Name + '.');
  }
  var seen = {};
  ids.forEach(function (id) { if (seen[id]) throw apiError_('BAD', 'Gambar berulang.'); seen[id] = true; });
  return withLock_(function () {
    var poleId = str_(req_(b, 'poleId'));
    getPole_(readTable_('Poles'), poleId);
    var photos = readTable_('Photos');
    ids.forEach(function (id) {
      var p = find_(photos, 'PhotoID', id);
      if (!p || p.PoleID !== poleId || p.PhotoTypeID !== typeId) throw apiError_('BAD', 'Gambar bukan dari tiang/jenis ini.');
      if (SolarLogic.bool(p.Hidden)) throw apiError_('BAD', 'Gambar tersembunyi tidak boleh dipilih.');
    });
    var changed = [];
    photos.rows.forEach(function (o) {
      if (o.PoleID !== poleId || o.PhotoTypeID !== typeId) return;
      var want = ids.indexOf(o.PhotoID) + 1;
      var have = Number(o.ReportOrder) > 0 ? Number(o.ReportOrder) : 0;
      if (want !== have) {
        updateObj_(photos, o, { ReportOrder: want || '' });
        changed.push(photoOut_(o));
      }
    });
    if (changed.length) {
      audit_(user, ids.length ? 'ReportSelectionSet' : 'ReportSelectionCleared', 'Pole', poleId, typeId, '', ids.join(', '));
    }
    return { photos: changed };
  });
};

// ---------------- Users ----------------
ACTIONS.saveUser = function (user, b) {
  assert_(user, 'manageUsers');
  var email = normEmail_(req_(b, 'email'));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw apiError_('BAD', 'Emel tidak sah.');
  var role = str_(req_(b, 'role'));
  if (SolarLogic.ROLES.indexOf(role) < 0) throw apiError_('BAD', 'Peranan tidak sah.');
  var active = b.active !== false;
  var name = str_(b.name).trim();
  return withLock_(function () {
    var users = readTable_('Users');
    var u = findUser_(users, email);
    if (u) {
      if (email === user.email && (role !== 'Admin' || !active)) {
        throw apiError_('BAD', 'Anda tidak boleh membuang peranan Admin atau menyahaktifkan akaun anda sendiri.');
      }
      var upd = {};
      if (str_(u.Name) !== name) upd.Name = name;
      if (str_(u.Role) !== role) upd.Role = role;
      if (SolarLogic.bool(u.Active) !== active) upd.Active = active;
      Object.keys(upd).forEach(function (k) { audit_(user, 'UserEdited', 'User', email, k, u[k], upd[k]); });
      if (Object.keys(upd).length) updateObj_(users, u, upd);
    } else {
      u = appendObj_(users, { Email: email, Name: name, Role: role, Active: active });
      audit_(user, 'UserAdded', 'User', email, 'Role', '', role);
    }
    var o = clean_([u])[0];
    o.Active = SolarLogic.bool(o.Active);
    return { userRow: o };
  });
};

ACTIONS.removeUser = function (user, b) {
  assert_(user, 'manageUsers');
  var email = normEmail_(req_(b, 'email'));
  if (email === user.email) throw apiError_('BAD', 'Anda tidak boleh membuang akaun anda sendiri.');
  return withLock_(function () {
    var users = readTable_('Users');
    var u = findUser_(users, email);
    if (!u) throw apiError_('NOTFOUND', 'Pengguna tidak dijumpai.');
    users.sheet.deleteRow(u._row);
    audit_(user, 'UserRemoved', 'User', email, 'Role', u.Role, '');
    return {};
  });
};

// ---------------- Activity / photo type names (IDs and rules are fixed) ----------------
/** { activities: [{ActivityID, Name, Spec}], types: [{TypeID, Name}] } — only names and the activity spec change. */
ACTIONS.saveNames = function (user, b) {
  assert_(user, 'manageTypes');
  return withLock_(function () {
    var at = readTable_('Activities'), tt = readTable_('PhotoTypes');
    (b.activities || []).forEach(function (x) {
      var row = find_(at, 'ActivityID', str_(x.ActivityID));
      if (!row) throw apiError_('BAD', 'Aktiviti tidak sah: ' + x.ActivityID);
      var name = str_(x.Name).trim(), spec = str_(x.Spec).trim();
      if (!name) throw apiError_('BAD', 'Nama aktiviti tidak boleh kosong.');
      var upd = {};
      if (str_(row.Name) !== name) upd.Name = name;
      if (str_(row.Spec) !== spec) upd.Spec = spec;
      Object.keys(upd).forEach(function (k) { audit_(user, 'ActivityEdited', 'Activity', row.ActivityID, k, row[k], upd[k]); });
      if (Object.keys(upd).length) updateObj_(at, row, upd);
    });
    (b.types || []).forEach(function (x) {
      var row = find_(tt, 'TypeID', str_(x.TypeID));
      if (!row) throw apiError_('BAD', 'Jenis gambar tidak sah: ' + x.TypeID);
      var name = str_(x.Name).trim();
      if (!name) throw apiError_('BAD', 'Nama jenis gambar tidak boleh kosong.');
      if (str_(row.Name) !== name) {
        audit_(user, 'PhotoTypeEdited', 'PhotoType', row.TypeID, 'Name', row.Name, name);
        updateObj_(tt, row, { Name: name });
      }
    });
    return { activities: SolarLogic.activities(at.rows), types: SolarLogic.photoTypes(tt.rows) };
  });
};

// ---------------- Work plan (Pelan kerja) ----------------
function planArgs_(b) {
  var date = str_(req_(b, 'date'));
  if (!SolarLogic.isIsoDate(date)) throw apiError_('BAD', 'Tarikh tidak sah.');
  var act = str_(b.activityId);
  if (act && !REPORT_KEYS[act]) throw apiError_('BAD', 'Aktiviti tidak sah.');
  return { date: date, act: act };
}
function planText_(p) { return p.PoleID + ' ' + p.Date + (p.Activity ? ' ' + p.Activity : ''); }
function planDup_(t, poleId, date, act, exceptId) {
  return t.rows.some(function (r) {
    return r.PlanID !== exceptId && r.PoleID === poleId && r.Date === date && str_(r.Activity) === act;
  });
}

/** Admin: plan one or more poles for a date (+ optional activity). Exact duplicates are skipped. */
ACTIONS.addPlans = function (user, b) {
  assert_(user, 'planWork');
  var a = planArgs_(b);
  return withLock_(function () {
    var ids = poleIdsArg_(b.poleIds, readTable_('Poles'));
    var t = readTable_('WorkPlan');
    var added = 0, skipped = 0;
    ids.forEach(function (id) {
      if (planDup_(t, id, a.date, a.act, '')) { skipped++; return; }
      var row = appendObj_(t, { PlanID: 'P' + Utilities.getUuid().replace(/-/g, '').slice(0, 12), Date: a.date, PoleID: id,
        Activity: a.act, CreatedBy: user.email, CreatedAt: nowIso_() });
      audit_(user, 'PlanAdded', 'WorkPlan', row.PlanID, 'Pole/Date/Activity', '', planText_(row));
      added++;
    });
    return { added: added, skipped: skipped, plans: clean_(t.rows) };
  });
};

ACTIONS.editPlan = function (user, b) {
  assert_(user, 'planWork');
  var a = planArgs_(b);
  return withLock_(function () {
    var t = readTable_('WorkPlan');
    var row = find_(t, 'PlanID', str_(req_(b, 'planId')));
    if (!row) throw apiError_('NOTFOUND', 'Pelan tidak dijumpai.');
    if (planDup_(t, row.PoleID, a.date, a.act, row.PlanID)) throw apiError_('BAD', 'Pelan yang sama sudah wujud.');
    var upd = {};
    if (row.Date !== a.date) upd.Date = a.date;
    if (str_(row.Activity) !== a.act) upd.Activity = a.act;
    Object.keys(upd).forEach(function (k) { audit_(user, 'PlanEdited', 'WorkPlan', row.PlanID, k, row[k], upd[k]); });
    if (Object.keys(upd).length) updateObj_(t, row, upd);
    return { plans: clean_(t.rows) };
  });
};

ACTIONS.removePlan = function (user, b) {
  assert_(user, 'planWork');
  return withLock_(function () {
    var t = readTable_('WorkPlan');
    var row = find_(t, 'PlanID', str_(req_(b, 'planId')));
    if (!row) throw apiError_('NOTFOUND', 'Pelan tidak dijumpai.');
    t.sheet.deleteRow(row._row);
    audit_(user, 'PlanRemoved', 'WorkPlan', row.PlanID, 'Pole/Date/Activity', planText_(row), '');
    return { plans: clean_(readTable_('WorkPlan').rows) };
  });
};

// ---------------- Audit ----------------
ACTIONS.audit = function (user, b) {
  assert_(user, 'viewAudit');
  var q = str_(b.q).toLowerCase();
  var rows = clean_(readTable_('AuditLog').rows).reverse();
  if (q) {
    rows = rows.filter(function (r) {
      return SCHEMA.AuditLog.some(function (h) { return str_(r[h]).toLowerCase().indexOf(q) >= 0; });
    });
  }
  var offset = Number(b.offset) || 0, limit = Math.min(Number(b.limit) || 100, 500);
  return { total: rows.length, rows: rows.slice(offset, offset + limit) };
};

// ---------------- Reports (photo pages per activity; PDF + Word) ----------------
function reportLimit_(activityId) {
  var max = Number(settings_().ReportMaxPhotos) || 60;
  return Math.max(1, Math.floor(max / SolarLogic.reportPhotoCount(activityId)));
}

/** Before generating: which ticked poles are missing photos/measurements for this activity. */
ACTIONS.reportCheck = function (user, b) {
  assert_(user, 'generateReport');
  var act = activityArg_(b.activityId);
  var ids = poleIdsArg_(b.poleIds, readTable_('Poles'));
  var photos = readTable_('Photos').rows.map(photoOut_);
  var types = typesNow_();
  var missing = [], ready = [];
  ids.forEach(function (id) {
    var m = SolarLogic.reportMissing(act, id, types, photos);
    if (m.length) missing.push({ PoleID: id, missing: m }); else ready.push(id);
  });
  return { ready: ready, missing: missing, maxPoles: reportLimit_(act) };
};

ACTIONS.generateReport = function (user, b) {
  assert_(user, 'generateReport');
  var act = activityArg_(b.activityId);
  var ids = poleIdsArg_(b.poleIds, readTable_('Poles'));
  var max = reportLimit_(act);
  if (ids.length > max) throw apiError_('BAD', 'Maksimum ' + max + ' tiang bagi satu laporan ' + activitiesNow_()[act.charCodeAt(0) - 65].Name + '.');
  var photos = readTable_('Photos').rows.map(photoOut_);
  var types = typesNow_();
  var bad = [];
  ids.forEach(function (id) {
    var m = SolarLogic.reportMissing(act, id, types, photos);
    if (m.length) bad.push(id + ': ' + m.join(', '));
  });
  if (bad.length) throw apiError_('BAD', 'Tiang tidak lengkap untuk laporan ini — ' + bad.join('; '));
  var reportId = 'R' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 4);
  var spec = SolarLogic.buildReportSpec(act, ids, types, photos);
  var name = 'Laporan_' + REPORT_KEYS[act] + '_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmm') + '_' +
    (ids.length > 1 ? ids[0] + '-' + ids[ids.length - 1] : ids[0]);
  var files = renderReport_(name, spec, photos);
  var row = withLock_(function () {
    var r = appendObj_(readTable_('Reports'), { ReportID: reportId, PoleIDs: ids.join(', '), Activity: act,
      FileURL: files.pdf.getUrl(), DocxURL: files.docx.getUrl(), CreatedBy: user.email, CreatedAt: nowIso_() });
    audit_(user, 'ReportGenerated', 'Report', reportId, REPORT_KEYS[act], '', ids.join(', '));
    return r;
  });
  return { report: clean_([row])[0] };
};

/** Download a generated PDF (format "pdf") or Word file ("docx") in 4 MB pieces (base64). All roles. */
ACTIONS.downloadReport = function (user, b) {
  assert_(user, 'downloadReport');
  var r = find_(readTable_('Reports'), 'ReportID', str_(req_(b, 'reportId')));
  if (!r) throw apiError_('NOTFOUND', 'Laporan tidak dijumpai.');
  var url = b.format === 'docx' ? r.DocxURL : r.FileURL;
  var m = str_(url).match(/\/d\/([A-Za-z0-9_-]+)/);
  if (!m) throw apiError_('NOTFOUND', b.format === 'docx' ? 'Tiada fail Word untuk laporan ini.' : 'Pautan fail laporan rosak.');
  var f = DriveApp.getFileById(m[1]);
  var bytes = f.getBlob().getBytes();
  var offset = Math.max(0, Number(b.offset) || 0);
  var end = Math.min(bytes.length, offset + CHUNK_BYTES);
  return { name: f.getName(), size: bytes.length, offset: offset, next: end < bytes.length ? end : null,
    b64: Utilities.base64Encode(bytes.slice(offset, end)) };
};

/**
 * Build a Google Doc from the layout spec (SolarLogic.buildReportSpec), export PDF + Word into "Solar Reports",
 * then trash the temporary Doc. Each block = a boxed table: grey title row + a borderless grid of photos.
 */
function renderReport_(name, spec, photos) {
  var folder = DriveApp.getFolderById(settings_().ReportsFolderID);
  var byId = {};
  photos.forEach(function (p) { byId[p.PhotoID] = p; });
  var doc = DocumentApp.create(name);
  var docFile = DriveApp.getFileById(doc.getId());
  try {
    var body = doc.getBody();
    var m = spec.page.margin;
    body.setPageWidth(spec.page.w).setPageHeight(spec.page.h);
    body.setMarginTop(m).setMarginBottom(m).setMarginLeft(m).setMarginRight(m);
    var width = spec.page.w - 2 * m;
    var CENTER = DocumentApp.HorizontalAlignment.CENTER;
    var first = body.getChild(0).asParagraph();
    first.editAsText().setFontSize(2);
    spec.blocks.forEach(function (blk, bi) {
      if (blk.pageBreakBefore) body.appendPageBreak();
      else if (bi > 0) body.appendParagraph('').editAsText().setFontSize(6);
      var outer = body.appendTable([[blk.title], ['']]);
      outer.setBorderWidth(1);
      outer.setColumnWidth(0, width);
      var titleCell = outer.getRow(0).getCell(0);
      titleCell.setBackgroundColor('#D9D9D9');
      var tp = titleCell.getChild(0).asParagraph();
      tp.setAlignment(CENTER);
      tp.editAsText().setBold(true).setFontSize(10);
      var cell = outer.getRow(1).getCell(0);
      cell.getChild(0).asParagraph().editAsText().setFontSize(2);
      var rows = [];
      for (var i = 0; i < blk.cells.length; i += blk.columns) {
        var r = [];
        for (var k = 0; k < blk.columns; k++) r.push('');
        rows.push(r);
      }
      var grid = cell.appendTable(rows);
      grid.setBorderWidth(0);
      for (var c = 0; c < blk.columns; c++) grid.setColumnWidth(c, Math.floor((width - 12) / blk.columns));
      blk.cells.forEach(function (x, idx) {
        var gc = grid.getRow(Math.floor(idx / blk.columns)).getCell(idx % blk.columns);
        var p0 = gc.getChild(0).asParagraph();
        p0.setAlignment(CENTER);
        var photo = x.photoId ? byId[x.photoId] : null;
        if (photo) {
          var img = p0.appendInlineImage(DriveApp.getFileById(photo.DriveFileID).getBlob());
          var f = SolarLogic.fitBox(img.getWidth(), img.getHeight(), blk.box);
          img.setWidth(f.w).setHeight(f.h);
        } else {
          p0.appendText('(tiada gambar)');
        }
        if (x.caption) {
          var cp = gc.appendParagraph(x.caption.toUpperCase());
          cp.setAlignment(CENTER);
          cp.editAsText().setBold(true).setFontSize(8);
        }
      });
      if (blk.rowCaption) {
        var rc = cell.appendParagraph(blk.rowCaption.toUpperCase());
        rc.setAlignment(CENTER);
        rc.editAsText().setBold(true).setFontSize(9);
      }
      if (blk.footer) {
        var fp = cell.appendParagraph(blk.footer); // e.g. "Total pegging : 12 nos" (as written)
        fp.editAsText().setBold(true).setFontSize(9);
      }
    });
    doc.saveAndClose();
    var pdf = folder.createFile(docFile.getAs('application/pdf').setName(name + '.pdf'));
    var res = UrlFetchApp.fetch('https://docs.google.com/document/d/' + doc.getId() + '/export?format=docx', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) throw apiError_('SERVER', 'Gagal membuat fail Word (' + res.getResponseCode() + ').');
    var docx = folder.createFile(res.getBlob().setName(name + '.docx'));
    return { pdf: pdf, docx: docx };
  } finally {
    docFile.setTrashed(true);
  }
}

// =====================================================================
// One-time setup for a NEW Google Sheet (run from the Apps Script editor). Safe to run again.
// =====================================================================
function setup() {
  var ss = ss_();
  var oldPhotos = ss.getSheetByName('Photos');
  if (oldPhotos && headerIndex_(oldPhotos, 'SlotID')) {
    throw new Error('Sheet ini masih format lama (v1). Jalankan migrateV2() dahulu.');
  }
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = SCHEMA[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    }
    sh.getRange(1, 1, sh.getMaxRows(), Math.max(sh.getMaxColumns(), headers.length)).setNumberFormat('@');
  });

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SESSION_SECRET')) {
    props.setProperty('SESSION_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }

  var st = readTable_('Settings');
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (!find_(st, 'Key', k)) appendObj_(st, { Key: k, Value: DEFAULT_SETTINGS[k] });
  });
  var s = settings_();
  if (!s.PhotosFolderID) setSetting_('PhotosFolderID', DriveApp.createFolder('Solar Photos').getId());
  if (!s.ReportsFolderID) setSetting_('ReportsFolderID', DriveApp.createFolder('Solar Reports').getId());

  var me = { email: normEmail_(Session.getEffectiveUser().getEmail()) };
  var log = [];
  var poles = readTable_('Poles');
  if (!poles.rows.length) {
    var now = nowIso_();
    var data = SEED_POLES.map(function (p) {
      return SCHEMA.Poles.map(function (h) { return cell_(h === 'UpdatedAt' ? now : p[h]); });
    });
    poles.sheet.getRange(2, 1, data.length, SCHEMA.Poles.length).setValues(data);
    audit_(me, 'Setup', 'Pole', '', 'Import', '', data.length + ' poles');
    log.push(data.length + ' tiang diimport');
  }
  var at = readTable_('Activities');
  SolarLogic.ACTIVITIES.forEach(function (a) {
    if (!find_(at, 'ActivityID', a.ActivityID)) appendObj_(at, { ActivityID: a.ActivityID, Name: a.Name, Spec: a.Spec });
  });
  var tt = readTable_('PhotoTypes');
  SolarLogic.PHOTO_TYPES.forEach(function (t) {
    if (!find_(tt, 'TypeID', t.TypeID)) appendObj_(tt, { TypeID: t.TypeID, ActivityID: t.ActivityID, Name: t.Name });
  });
  var users = readTable_('Users');
  if (!users.rows.length) {
    appendObj_(users, { Email: me.email, Name: 'Admin', Role: 'Admin', Active: true });
    audit_(me, 'UserAdded', 'User', me.email, 'Role', '', 'Admin');
    log.push('Admin: ' + me.email);
  }
  var msg = 'Setup selesai. ' + log.join('; ');
  console.log(msg);
  return msg;
}

// =====================================================================
// One-time migration of a v1 Sheet (7 slots, IDs "SL-034") to v2 (activities, IDs "SSL034").
// Run once from the editor while nobody is using the app. Running it again changes nothing.
// =====================================================================
function headerIndex_(sh, name) {
  var lc = sh.getLastColumn();
  if (!lc) return 0;
  var h = sh.getRange(1, 1, 1, lc).getValues()[0].map(function (x) { return str_(x).trim(); });
  return h.indexOf(name) + 1;
}

/** Apply fn to every data cell of one column; returns how many cells changed. */
function mapColumn_(sh, header, fn) {
  var c = headerIndex_(sh, header);
  var last = sh.getLastRow();
  if (!c || last < 2) return 0;
  var range = sh.getRange(2, c, last - 1, 1);
  var n = 0;
  var out = range.getValues().map(function (r) {
    var v = str_(r[0]).trim();
    var nv = fn(v);
    if (nv !== v) n++;
    return [nv];
  });
  if (n) { range.setNumberFormat('@'); range.setValues(out); }
  return n;
}

function migrateV2() {
  var ss = ss_();
  var done = [];
  var poles = ss.getSheetByName('Poles');
  if (!poles) throw new Error('Tab Poles tiada. Untuk Sheet baru, jalankan setup().');

  // 1) Check every pole ID first — stop before changing anything if one is unexpected.
  var idMap = {};
  var seenNew = {};
  var pc = headerIndex_(poles, 'PoleID');
  if (poles.getLastRow() >= 2) {
    poles.getRange(2, pc, poles.getLastRow() - 1, 1).getValues().forEach(function (r) {
      var id = str_(r[0]).trim();
      if (!id) return;
      var nid = SolarLogic.poleIdFromLegacy(id);
      if (!nid) throw new Error('ID tiang tidak dikenali: "' + id + '". Tiada perubahan dibuat.');
      if (seenNew[nid]) throw new Error('ID tiang berulang selepas tukar: ' + nid + '. Tiada perubahan dibuat.');
      seenNew[nid] = true;
      if (nid !== id) idMap[id] = nid;
    });
  }
  var mapId = function (v) { return idMap[v] || v; };

  // 2) Photos: SlotID -> PhotoTypeID (S1..S7 -> A1..C3), SelectedForReport -> ReportOrder (cleared), + MeasurementM
  var ph = ss.getSheetByName('Photos');
  if (ph) {
    var sc = headerIndex_(ph, 'SlotID');
    if (sc && !headerIndex_(ph, 'PhotoTypeID')) { ph.getRange(1, sc).setValue('PhotoTypeID'); done.push('Photos.SlotID→PhotoTypeID'); }
    var n = mapColumn_(ph, 'PhotoTypeID', function (v) { return SolarLogic.LEGACY_SLOT_MAP[v] || v; });
    if (n) done.push(n + ' gambar dipetakan ke jenis baru');
    var rc = headerIndex_(ph, 'SelectedForReport');
    if (rc && !headerIndex_(ph, 'ReportOrder')) {
      mapColumn_(ph, 'SelectedForReport', function () { return ''; });
      ph.getRange(1, rc).setValue('ReportOrder');
      done.push('Photos.SelectedForReport→ReportOrder (pilihan lama dikosongkan)');
    }
    if (!headerIndex_(ph, 'MeasurementM')) {
      var mc = ph.getLastColumn() + 1;
      ph.getRange(1, mc).setNumberFormat('@');
      ph.getRange(1, mc).setValue('MeasurementM');
      done.push('Photos.MeasurementM ditambah');
    }
  }

  // 3) Pole IDs in every sheet that references a pole (AuditLog history is NOT rewritten)
  var renamed = 0;
  renamed += mapColumn_(poles, 'PoleID', mapId);
  ['Photos', 'Notes', 'WorkPlan'].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) renamed += mapColumn_(sh, 'PoleID', mapId);
  });
  var rep = ss.getSheetByName('Reports');
  if (rep) {
    renamed += mapColumn_(rep, 'PoleIDs', function (v) {
      return v ? v.split(/\s*,\s*/).map(mapId).join(', ') : v;
    });
    ['Activity', 'DocxURL'].forEach(function (h) {
      if (!headerIndex_(rep, h)) {
        var c = rep.getLastColumn() + 1;
        rep.getRange(1, c).setNumberFormat('@');
        rep.getRange(1, c).setValue(h);
        done.push('Reports.' + h + ' ditambah');
      }
    });
  }
  if (renamed) done.push(renamed + ' sel ID tiang ditukar');

  // 4) Old Slots tab kept for reference
  var slots = ss.getSheetByName('Slots');
  if (slots && !ss.getSheetByName('Slots_old')) { slots.setName('Slots_old'); done.push('Slots→Slots_old'); }

  // 5) Drive: Solar Photos/SL-034 -> SSL034, and files "SL-034_..." -> "SSL034_..."
  var rootId = '';
  var st = ss.getSheetByName('Settings');
  if (st && st.getLastRow() >= 2) {
    st.getRange(2, 1, st.getLastRow() - 1, 2).getValues().forEach(function (r) { if (str_(r[0]) === 'PhotosFolderID') rootId = str_(r[1]); });
  }
  if (rootId) {
    var root = DriveApp.getFolderById(rootId);
    var folders = [];
    var it = root.getFolders();
    while (it.hasNext()) folders.push(it.next());
    folders.forEach(function (f) {
      var nid = SolarLogic.poleIdFromLegacy(f.getName());
      var target = f;
      if (nid && nid !== f.getName()) {
        var ex = root.getFoldersByName(nid);
        if (ex.hasNext()) {           // target already exists: move files across, trash the old folder
          target = ex.next();
          var fi = f.getFiles();
          while (fi.hasNext()) fi.next().moveTo(target);
          f.setTrashed(true);
        } else {
          f.setName(nid);
        }
        done.push('Folder ' + nid);
      }
      var files = target.getFiles();
      while (files.hasNext()) {
        var file = files.next();
        var mm = file.getName().match(/^SL-(\d{3})_(.*)$/);
        if (mm) { file.setName('SSL' + mm[1] + '_' + mm[2]); done.push('Fail ' + file.getName()); }
      }
    });
  }

  // 6) New tabs, defaults, activity/type names
  setup();

  var summary = done.length ? done.length + ' perubahan' : 'tiada perubahan (sudah dimigrasi)';
  if (done.length) {
    var me = { email: normEmail_(Session.getEffectiveUser().getEmail()) };
    audit_(me, 'MigrationV2', 'Sheet', '', 'v1→v2', '', Object.keys(idMap).length + ' tiang; ' + done.slice(0, 20).join('; '));
  }
  var msg = 'migrateV2 selesai: ' + summary + '.';
  console.log(msg + (done.length ? '\n' + done.join('\n') : ''));
  return msg;
}

