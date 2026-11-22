/*
 * Solar Street Light — Apps Script backend (JSON API).
 * Karak Highway, Package 2A.
 *
 * Files in this Apps Script project:  Code.gs (this), Logic.gs, SeedData.gs
 * First time: run setup() once from the editor, then Deploy > New deployment > Web app
 *   Execute as: Me    Who has access: Anyone
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
  Photos: ['PhotoID', 'PoleID', 'SlotID', 'DriveFileID', 'FileURL', 'Source', 'CapturedAt', 'UploadedAt', 'Latitude', 'Longitude', 'AccuracyM', 'GPSAvailable', 'TakenBy', 'Hidden', 'RetakeFlag', 'SelectedForReport'],
  Slots: ['SlotID', 'Order', 'Name', 'Spec', 'Active'],
  Notes: ['NoteID', 'PoleID', 'Text', 'CreatedBy', 'CreatedAt'],
  Users: ['Email', 'Name', 'Role', 'Active'],
  AuditLog: ['Timestamp', 'UserEmail', 'Action', 'Entity', 'EntityID', 'Field', 'OldValue', 'NewValue'],
  Reports: ['ReportID', 'PoleIDs', 'FileURL', 'CreatedBy', 'CreatedAt'],
  Settings: ['Key', 'Value']
};

var DEFAULT_SETTINGS = {
  ProjectName: 'Cadangan Pelebaran Lebuhraya Kuala Lumpur – Karak, Seksyen 2, Package 2A — Solar Street Lighting',
  ClientID: '',
  AppURL: '',
  ReportMaxPoles: '10',
  SessionDays: '30',
  PhotosFolderID: '',
  ReportsFolderID: '',
  TemplateDocID: ''
};



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
    return header === 'PlannedDate' ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd')
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
  ['Hidden', 'RetakeFlag', 'SelectedForReport', 'GPSAvailable'].forEach(function (k) { o[k] = SolarLogic.bool(o[k]); });
  ['Latitude', 'Longitude', 'AccuracyM'].forEach(function (k) { o[k] = o[k] === '' ? '' : Number(o[k]); });
  return o;
}

function slotOut_(s) {
  return { SlotID: str_(s.SlotID), Order: Number(s.Order), Name: str_(s.Name), Spec: str_(s.Spec), Active: SolarLogic.bool(s.Active) };
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
    reportMaxPoles: Number(s.ReportMaxPoles) || 10,
    poles: readTable_('Poles').rows.map(poleOut_),
    slots: readTable_('Slots').rows.map(slotOut_),
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
    var slotId = str_(req_(b, 'slotId'));
    if (!find_(readTable_('Slots'), 'SlotID', slotId)) throw apiError_('BAD', 'Slot tidak dijumpai: ' + slotId);
    var source = b.source === 'Gallery' ? 'Gallery' : 'Camera';
    var bytes = Utilities.base64Decode(str_(req_(b, 'imageB64')));
    if (bytes.length > MAX_IMAGE_BYTES) throw apiError_('BAD', 'Gambar terlalu besar.');
    var stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss');
    var folder = poleFolder_(pole.PoleID);
    var file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg',
      pole.PoleID + '_' + slotId + '_' + stamp + '_' + photoId + '.jpg'));
    if (b.thumbB64) {
      folder.createFile(Utilities.newBlob(Utilities.base64Decode(str_(b.thumbB64)), 'image/jpeg', photoId + '_thumb.jpg'));
    }
    var gps = b.gpsAvailable === true && b.latitude !== '' && b.latitude !== null && b.latitude !== undefined;
    var row = appendObj_(photos, {
      PhotoID: photoId, PoleID: pole.PoleID, SlotID: slotId, DriveFileID: file.getId(), FileURL: file.getUrl(),
      Source: source, CapturedAt: str_(b.capturedAt) || nowIso_(), UploadedAt: nowIso_(),
      Latitude: gps ? Number(b.latitude).toFixed(6) : '', Longitude: gps ? Number(b.longitude).toFixed(6) : '',
      AccuracyM: gps && b.accuracy !== '' && b.accuracy != null ? Math.round(Number(b.accuracy)) : '',
      GPSAvailable: gps, TakenBy: user.email, Hidden: false, RetakeFlag: false, SelectedForReport: false
    });
    audit_(user, 'PhotoAdded', 'Photo', photoId, 'Pole/Slot', '', pole.PoleID + '/' + slotId + ' (' + source + ')');
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

/** Admin: choose the photo used in the PDF for its slot (only one per pole+slot). value=false clears. */
ACTIONS.selectForReport = function (user, b) {
  assert_(user, 'selectReport');
  var value = b.value !== false;
  return withLock_(function () {
    var photos = readTable_('Photos');
    var p = find_(photos, 'PhotoID', str_(req_(b, 'photoId')));
    if (!p) throw apiError_('NOTFOUND', 'Gambar tidak dijumpai.');
    var changed = [];
    photos.rows.forEach(function (o) {
      if (o.PoleID !== p.PoleID || o.SlotID !== p.SlotID) return;
      var want = value && o.PhotoID === p.PhotoID;
      if (SolarLogic.bool(o.SelectedForReport) !== want) {
        updateObj_(photos, o, { SelectedForReport: want });
        changed.push(photoOut_(o));
      }
    });
    if (changed.length) {
      audit_(user, value ? 'ReportPhotoSelected' : 'ReportPhotoUnselected', 'Photo', p.PhotoID, 'SelectedForReport',
        '', p.PoleID + '/' + p.SlotID);
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

// ---------------- Slots ----------------
/** Add (no slotId) or edit a slot: name, spec, active. Photos link to SlotID so renaming is safe. */
ACTIONS.saveSlot = function (user, b) {
  assert_(user, 'manageSlots');
  var name = str_(req_(b, 'name')).trim();
  var spec = str_(b.spec).trim();
  var active = b.active !== false;
  return withLock_(function () {
    var slots = readTable_('Slots');
    var s;
    if (b.slotId) {
      s = find_(slots, 'SlotID', str_(b.slotId));
      if (!s) throw apiError_('NOTFOUND', 'Slot tidak dijumpai.');
      var upd = {};
      if (str_(s.Name) !== name) upd.Name = name;
      if (str_(s.Spec) !== spec) upd.Spec = spec;
      if (SolarLogic.bool(s.Active) !== active) upd.Active = active;
      Object.keys(upd).forEach(function (k) { audit_(user, 'SlotEdited', 'Slot', s.SlotID, k, s[k], upd[k]); });
      if (Object.keys(upd).length) updateObj_(slots, s, upd);
    } else {
      var maxN = 0, maxOrder = 0;
      slots.rows.forEach(function (r) {
        var n = parseInt(str_(r.SlotID).replace(/^S/, ''), 10);
        if (n > maxN) maxN = n;
        if (Number(r.Order) > maxOrder) maxOrder = Number(r.Order);
      });
      s = appendObj_(slots, { SlotID: 'S' + (maxN + 1), Order: maxOrder + 1, Name: name, Spec: spec, Active: active });
      audit_(user, 'SlotAdded', 'Slot', s.SlotID, 'Name', '', name);
    }
    return { slots: slots.rows.map(slotOut_) };
  });
};

/** Move a slot up (-1) or down (+1). Orders are renumbered 1..n. */
ACTIONS.moveSlot = function (user, b) {
  assert_(user, 'manageSlots');
  var dir = Number(b.dir) < 0 ? -1 : 1;
  return withLock_(function () {
    var slots = readTable_('Slots');
    var list = slots.rows.slice().sort(function (a, c) { return Number(a.Order) - Number(c.Order); });
    var i = -1;
    list.forEach(function (r, k) { if (str_(r.SlotID) === str_(b.slotId)) i = k; });
    if (i < 0) throw apiError_('NOTFOUND', 'Slot tidak dijumpai.');
    var j = i + dir;
    if (j >= 0 && j < list.length) {
      var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
      list.forEach(function (r, k) {
        if (Number(r.Order) !== k + 1) updateObj_(slots, r, { Order: k + 1 });
      });
      audit_(user, 'SlotReordered', 'Slot', str_(b.slotId), 'Order', i + 1, j + 1);
    }
    return { slots: slots.rows.map(slotOut_) };
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

// ---------------- Reports ----------------
ACTIONS.generateReport = function (user, b) {
  assert_(user, 'generateReport');
  var ids = (b.poleIds || []).map(str_);
  var max = Number(settings_().ReportMaxPoles) || 10;
  if (!ids.length) throw apiError_('BAD', 'Pilih sekurang-kurangnya satu tiang.');
  if (ids.length > max) throw apiError_('BAD', 'Maksimum ' + max + ' tiang bagi satu laporan.');
  var poles = readTable_('Poles');
  ids.forEach(function (id) { getPole_(poles, id); });
  var reportId = 'R' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 4);
  var file = buildReportPdf_(user, ids, reportId);
  var row = withLock_(function () {
    var r = appendObj_(readTable_('Reports'), { ReportID: reportId, PoleIDs: ids.join(', '), FileURL: file.getUrl(),
      CreatedBy: user.email, CreatedAt: nowIso_() });
    audit_(user, 'ReportGenerated', 'Report', reportId, 'PoleIDs', '', ids.join(', '));
    return r;
  });
  return { report: clean_([row])[0] };
};

/** Download a generated PDF in 4 MB pieces (base64). All roles. */
ACTIONS.downloadReport = function (user, b) {
  assert_(user, 'downloadReport');
  var r = find_(readTable_('Reports'), 'ReportID', str_(req_(b, 'reportId')));
  if (!r) throw apiError_('NOTFOUND', 'Laporan tidak dijumpai.');
  var m = str_(r.FileURL).match(/\/d\/([A-Za-z0-9_-]+)/);
  if (!m) throw apiError_('SERVER', 'Pautan fail laporan rosak.');
  var f = DriveApp.getFileById(m[1]);
  var bytes = f.getBlob().getBytes();
  var offset = Math.max(0, Number(b.offset) || 0);
  var end = Math.min(bytes.length, offset + CHUNK_BYTES);
  return { name: f.getName(), size: bytes.length, offset: offset, next: end < bytes.length ? end : null,
    b64: Utilities.base64Encode(bytes.slice(offset, end)) };
};

function fmtDateTime_(iso) {
  var m = str_(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? m[3] + '/' + m[2] + '/' + m[1] + ' ' + m[4] + ':' + m[5] : str_(iso);
}

function photoCaption_(slot, photo, names) {
  var title = slot.Order + '. ' + slot.Name + (slot.Spec ? ' (' + slot.Spec + ')' : '');
  if (!photo) return [title, 'Tiada gambar'];
  var gps = SolarLogic.bool(photo.GPSAvailable)
    ? 'GPS: ' + Number(photo.Latitude).toFixed(5) + ', ' + Number(photo.Longitude).toFixed(5) +
      (photo.AccuracyM !== '' ? ' (±' + photo.AccuracyM + ' m)' : '')
    : 'GPS tidak tersedia';
  return [title, 'Tarikh/masa: ' + fmtDateTime_(photo.CapturedAt), gps,
    'Diambil oleh: ' + (names[normEmail_(photo.TakenBy)] || photo.TakenBy),
    'Sumber: ' + (photo.Source === 'Gallery' ? 'Galeri' : 'Kamera')];
}

/** Template copy -> one section per pole -> PDF in "Solar Reports". Returns the PDF Drive file. */
function buildReportPdf_(user, ids, reportId) {
  var s = settings_();
  if (!s.TemplateDocID || !s.ReportsFolderID) throw apiError_('SERVER', 'Templat laporan belum disediakan. Jalankan setup().');
  var folder = DriveApp.getFolderById(s.ReportsFolderID);
  var copy = DriveApp.getFileById(s.TemplateDocID).makeCopy('tmp_' + reportId, folder);
  var poles = readTable_('Poles');
  var slots = SolarLogic.activeSlots(readTable_('Slots').rows.map(slotOut_));
  var photos = readTable_('Photos').rows.map(photoOut_);
  var names = {};
  readTable_('Users').rows.forEach(function (u) { names[normEmail_(u.Email)] = str_(u.Name) || str_(u.Email); });
  try {
    var doc = DocumentApp.openById(copy.getId());
    var body = doc.getBody();
    var generated = Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy HH:mm');
    [body, doc.getHeader(), doc.getFooter()].forEach(function (sec) {
      if (!sec) return;
      sec.replaceText('\\{\\{PROJECT\\}\\}', s.ProjectName);
      sec.replaceText('\\{\\{GENERATED\\}\\}', generated);
      sec.replaceText('\\{\\{USER\\}\\}', user.name);
      sec.replaceText('\\{\\{REPORTID\\}\\}', reportId);
    });
    var found = body.findText('\\{\\{CONTENT\\}\\}');
    var idx;
    if (found) {
      var para = found.getElement().getParent();
      idx = body.getChildIndex(para);
      para.asParagraph().setText('');
    } else {
      // template has no {{CONTENT}}: add an empty paragraph at the end and insert before it
      idx = body.getChildIndex(body.appendParagraph(''));
    }
    ids.forEach(function (id, n) {
      var pole = getPole_(poles, id);
      if (n > 0) body.insertPageBreak(idx++);
      var h = body.insertParagraph(idx++, s.ProjectName);
      h.setHeading(DocumentApp.ParagraphHeading.HEADING3);
      var info = body.insertTable(idx++, [
        ['Tiang', pole.PoleID, 'Bound', str_(pole.Bound)],
        ['Chainage', str_(pole.Chainage), 'Status kerja', SolarLogic.workStatus(poleOut_(pole), photos)]
      ]);
      info.setBorderWidth(1);
      var cells = [];
      slots.forEach(function (slot) { cells.push(slot); });
      var rowsData = [];
      for (var i = 0; i < cells.length; i += 2) rowsData.push(['', '']);
      var grid = body.insertTable(idx++, rowsData);
      grid.setBorderWidth(0);
      cells.forEach(function (slot, k) {
        var cell = grid.getRow(Math.floor(k / 2)).getCell(k % 2);
        var photo = SolarLogic.reportPhotoForSlot(pole.PoleID, slot.SlotID, photos);
        var first = cell.getChild(0).asParagraph();
        if (photo) {
          var img = first.appendInlineImage(DriveApp.getFileById(photo.DriveFileID).getBlob());
          var w = img.getWidth(), hgt = img.getHeight();
          var scale = Math.min(215 / w, 250 / hgt, 1);
          img.setWidth(Math.round(w * scale)).setHeight(Math.round(hgt * scale));
        }
        photoCaption_(slot, photo, names).forEach(function (line, li) {
          var p;
          if (li === 0 && !photo) { first.setText(line); p = first; } else { p = cell.appendParagraph(line); }
          p.editAsText().setFontSize(li === 0 ? 10 : 8).setBold(li === 0);
        });
      });
    });
    doc.saveAndClose();
    var pdf = folder.createFile(copy.getAs('application/pdf')
      .setName('Laporan_' + reportId + '_' + ids.join('_').slice(0, 80) + '.pdf'));
    return pdf;
  } finally {
    copy.setTrashed(true);
  }
}

// =====================================================================
// One-time setup (run from the Apps Script editor). Safe to run again.
// =====================================================================
function setup() {
  var ss = ss_();
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
  if (!s.TemplateDocID) setSetting_('TemplateDocID', createTemplateDoc_());

  var me = { email: normEmail_(Session.getEffectiveUser().getEmail()) };
  var poles = readTable_('Poles');
  var log = [];
  if (!poles.rows.length) {
    var now = nowIso_();
    var data = SEED_POLES.map(function (p) {
      return SCHEMA.Poles.map(function (h) { return cell_(h === 'UpdatedAt' ? now : p[h]); });
    });
    poles.sheet.getRange(2, 1, data.length, SCHEMA.Poles.length).setValues(data);
    audit_(me, 'Setup', 'Pole', '', 'Import', '', data.length + ' poles');
    log.push(data.length + ' tiang diimport');
  }
  var slots = readTable_('Slots');
  if (!slots.rows.length) {
    SEED_SLOTS.forEach(function (x) { appendObj_(slots, x); });
    log.push(SEED_SLOTS.length + ' slot dicipta');
  }
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

function createTemplateDoc_() {
  var doc = DocumentApp.create('Solar Report Template');
  var body = doc.getBody();
  body.setMarginTop(36).setMarginBottom(36).setMarginLeft(54).setMarginRight(54);
  var first = body.getChild(0).asParagraph();
  first.setText('{{PROJECT}}'); // Paragraph.setText() returns nothing: do not chain
  first.setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('Laporan Kemajuan Pemasangan Lampu Jalan Solar').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph('No. laporan: {{REPORTID}}    Dijana: {{GENERATED}}    Oleh: {{USER}}');
  body.appendParagraph('{{CONTENT}}');
  doc.saveAndClose();
  var file = DriveApp.getFileById(doc.getId());
  var reportsId = settings_().ReportsFolderID;
  if (reportsId) file.moveTo(DriveApp.getFolderById(reportsId));
  return doc.getId();
}
