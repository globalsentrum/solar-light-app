/*
 * Solar Street Light — main app (screens, routing, offline overlay).
 * UI text: Bahasa Malaysia.
 */
(function () {
  'use strict';
  var L = SolarLogic;
  var W = SolarWatermark;
  var CFG = window.SOLAR_CONFIG || {};

  var S = {
    data: null,            // last bootstrap from server (cached in IndexedDB)
    queue: [],             // offline queue items
    filters: { bound: 'all', status: 'all', q: '' },
    gps: new W.GpsTracker(),
    thumbUrls: {},         // PhotoID -> object URL
    thumbLoading: {},
    queueUrls: {},         // queue id -> object URL (thumb)
    fullUrls: {},          // PhotoID -> object URL (full)
    capture: null,
    refreshing: false,
    reportSel: {},
    planSel: {},
    jtab: null,
    rAct: 'A',
    sel: null,
    measResolve: null,
    rf: { bound: 'all', q: '', from: '', to: '', showReported: false },
    moveSel: {},
    imp: null,
    rinDraft: '',
    audit: { q: '', rows: [], total: 0 }
  };
  window.__solar = S; // for debugging / tests

  // =================================================================
  // Helpers
  // =================================================================
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDT(iso) { return W.displayTime(iso) || ''; }
  function fmtDate(d) {
    var m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }
  function nameOf(email) {
    if (!email) return '';
    var n = S.data && S.data.names && S.data.names[String(email).toLowerCase()];
    return n || email;
  }
  function perms() { return S.data && S.data.user ? (S.data.user.perms || []) : []; }
  /** permission key (roles are defined by admin; the backend checks every action again) */
  function has(key) { return L.can(perms(), key); }
  function allowed(key, pole) { return !L.denyReason(perms(), key, pole); }
  function lab(key) { return (S.data && S.data.labels && S.data.labels[key]) || L.LABEL_DEFAULTS[key]; }
  function wsLabel(ws) { var k = L.workKey(ws); return k ? lab(k) : ws; }
  function catLabel(c) { return c === L.CATEGORY.INSTALLED ? lab('INSTALLED') : c === L.CATEGORY.PENDING ? lab('PENDING') : c; }
  function today() { return L.klDate(Date.now(), 0); }
  var ADMIN_KEYS = ['manage_users', 'manage_roles', 'edit_settings', 'view_audit_log', 'add_pole', 'import_poles', 'export_data'];
  function hasAdminTab() { return ADMIN_KEYS.some(has); }
  function online() { return navigator.onLine !== false; }

  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, ms || 3000);
  }
  function overlay(text) {
    if (text === false) { $('overlay').hidden = true; return; }
    $('overlayText').textContent = text;
    $('overlay').hidden = false;
  }
  function openSheet(html, opts) {
    var s = $('sheet');
    s.innerHTML = '<div class="sheet-backdrop"' + (opts && opts.modal ? '' : ' data-act="closeSheet"') + '></div><div class="sheet-body">' + html + '</div>';
    s.hidden = false;
  }
  function closeSheet() { $('sheet').hidden = true; $('sheet').innerHTML = ''; }

  function workBadge(ws) {
    var cls = { 'Siap': 'b-done', 'Dalam proses': 'b-prog', 'Belum mula': 'b-none', 'Tunggu kelulusan': 'b-wait' }[ws] || '';
    return '<span class="badge ' + cls + '">' + esc(wsLabel(ws)) + '</span>';
  }
  function nightBadge(p, photos) { return L.needsNightPhoto(p, photos) ? '<span class="badge b-night">🌙 ' + esc(lab('NIGHT')) + '</span>' : ''; }
  function photoBadge(ps) {
    if (!ps.required) return '<span class="badge b-na">' + esc(ps.label) + '</span>';
    return '<span class="badge ' + (ps.complete ? 'b-done' : 'b-part') + '">📷 ' + esc(ps.complete ? 'Lengkap' : ps.done + '/' + ps.total) + '</span>';
  }
  function chBadge(p) { return L.bool(p.ChainageExact) ? '' : '<span class="badge b-warn">CH belum tepat</span>'; }

  // =================================================================
  // Merged view = server data + things still waiting in the offline queue
  // =================================================================
  function merged() {
    var d = S.data || { poles: [], photos: [], notes: [], plans: [] };
    var me = d.user ? d.user.email : '';
    var photos = d.photos.slice();
    var notes = d.notes.slice();
    var doneOverride = {};
    var known = {};
    photos.forEach(function (p) { known[p.PhotoID] = true; });
    S.queue.forEach(function (it) {
      var p = it.payload;
      if (it.kind === 'photo' && !known[p.photoId]) {
        photos.push({
          PhotoID: p.photoId, PoleID: p.poleId, PhotoTypeID: p.typeId, Source: p.source, CapturedAt: p.capturedAt,
          UploadedAt: '', Latitude: p.latitude, Longitude: p.longitude, AccuracyM: p.accuracy === '' ? '' : Math.round(p.accuracy),
          GPSAvailable: p.gpsAvailable, TakenBy: me, Hidden: false, RetakeFlag: false, ReportOrder: 0,
          MeasurementM: p.measurement === undefined ? '' : p.measurement,
          _pending: it.status === 'pending', _failed: it.status === 'failed', _qid: it.id,
          _excluded: it.status === 'failed' // a failed upload must not count toward status
        });
      } else if (it.kind === 'note') {
        if (!notes.some(function (n) { return n.NoteID === p.noteId; })) {
          notes.push({ NoteID: p.noteId, PoleID: p.poleId, Text: p.text, CreatedBy: me, CreatedAt: p.createdAt,
            _pending: it.status === 'pending', _failed: it.status === 'failed' });
        }
      } else if (it.kind === 'done' && it.status === 'pending') {
        doneOverride[p.poleId] = p.done;
      }
    });
    var poles = d.poles.map(function (p) {
      if (p.PoleID in doneOverride) return Object.assign({}, p, { IsDone: doneOverride[p.PoleID], _donePending: true });
      return p;
    });
    var statusPhotos = photos.filter(function (p) { return !p._excluded; });
    return { poles: poles, photos: photos, statusPhotos: statusPhotos, notes: notes,
      types: L.photoTypes(d.types), acts: L.activities(d.activities), plans: d.plans || [] };
  }

  function poleById(m, id) { for (var i = 0; i < m.poles.length; i++) if (m.poles[i].PoleID === id) return m.poles[i]; return null; }

  // =================================================================
  // Data loading
  // =================================================================
  function loadQueue() {
    return SolarDB.queueAll().then(function (items) { S.queue = items; updateSyncBtn(); });
  }

  function refresh(silent) {
    if (S.refreshing || !SolarAPI.hasSession()) return Promise.resolve();
    S.refreshing = true;
    return SolarAPI.call('bootstrap', {}, 60000).then(function (d) {
      S.data = d;
      S.refreshing = false;
      return SolarDB.set('data', d).then(function () { render(); });
    }, function (err) {
      S.refreshing = false;
      if (err.code === 'AUTH') {
        if (!S.data) { SolarAPI.setSession(null); go('#/login'); }
        else showNeedLogin(true);
      } else if (!silent && !S.data) {
        $('view').innerHTML = '<div class="card center">' + esc(err.message) + '<br><br><button class="btn" data-act="reload">Cuba lagi</button></div>';
      }
    });
  }

  function applySent(item, res) {
    if (!S.data) return;
    if (item.kind === 'photo' && res.photo) {
      if (!S.data.photos.some(function (p) { return p.PhotoID === res.photo.PhotoID; })) S.data.photos.push(res.photo);
      if (item.thumb) {
        SolarDB.thumbSet(res.photo.PhotoID, item.thumb);
        if (!S.thumbUrls[res.photo.PhotoID]) S.thumbUrls[res.photo.PhotoID] = URL.createObjectURL(new Blob([item.thumb], { type: 'image/jpeg' }));
      }
    } else if (item.kind === 'note' && res.note) {
      if (!S.data.notes.some(function (n) { return n.NoteID === res.note.NoteID; })) S.data.notes.push(res.note);
    } else if (item.kind === 'done' && res.pole) {
      replacePole(res.pole);
    }
    SolarDB.set('data', S.data);
  }

  function replacePole(pole) {
    S.data.poles = S.data.poles.map(function (p) { return p.PoleID === pole.PoleID ? pole : p; });
  }
  function replacePhoto(photo) {
    S.data.photos = S.data.photos.map(function (p) { return p.PhotoID === photo.PhotoID ? photo : p; });
  }

  // =================================================================
  // Sync indicator / banner
  // =================================================================
  function updateSyncBtn() {
    var pending = S.queue.filter(function (i) { return i.status === 'pending'; }).length;
    var failed = S.queue.filter(function (i) { return i.status === 'failed'; }).length;
    var b = $('syncBtn');
    if (pending) { b.textContent = '⏳ ' + pending + ' item menunggu line'; b.className = 'sync wait'; }
    else if (failed) { b.textContent = '⚠️ ' + failed + ' item gagal'; b.className = 'sync fail'; }
    else { b.textContent = '✅ Semua disimpan'; b.className = 'sync ok'; }
    showBanner();
  }

  var needLoginShown = false;
  function showNeedLogin(v) { needLoginShown = v; showBanner(); }
  function showBanner() {
    var el = $('banner');
    var pending = S.queue.filter(function (i) { return i.status === 'pending'; }).length;
    if (needLoginShown || SolarSync.needLogin()) {
      el.innerHTML = '⚠️ Sesi log masuk tamat' + (pending ? ' — ' + pending + ' item belum dihantar (selamat dalam telefon)' : '') +
        '. <button class="btn small" data-act="relogin">Log masuk semula</button>';
      el.className = 'warn';
      el.hidden = false;
    } else if (!online()) {
      el.textContent = '📴 Tiada line — kerja anda disimpan dalam telefon dan akan dihantar automatik.';
      el.className = 'info';
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  function openSyncSheet() {
    loadQueue().then(function () {
      var rows = S.queue.map(function (it) {
        var p = it.payload;
        var what = it.kind === 'photo' ? '📷 Gambar ' + esc(p.poleId) + ' · ' + esc(typeName(p.typeId)) + (p.measurement ? ' (' + esc(p.measurement) + ' m)' : '')
          : it.kind === 'note' ? '📝 Nota ' + esc(p.poleId) : (p.done ? '✔ Siap ' : '↩ Batal siap ') + esc(p.poleId);
        var st = it.status === 'failed'
          ? '<div class="err">Gagal: ' + esc(it.lastError || '') + '</div>' +
            '<div class="row-btns"><button class="btn small" data-act="qretry" data-id="' + it.id + '">Cuba lagi</button>' +
            (it.kind === 'photo' ? '<button class="btn small ghost" data-act="qsave" data-id="' + it.id + '">Simpan gambar ke telefon</button>' : '') +
            '<button class="btn small danger" data-act="qdiscard" data-id="' + it.id + '">Buang</button></div>'
          : '<div class="muted small">Menunggu' + (it.tries ? ' · cubaan ' + it.tries + (it.lastError ? ' (' + esc(it.lastError) + ')' : '') : '') + '</div>';
        return '<li><div>' + what + ' <span class="muted small">' + esc(fmtDT(it.createdAt)) + '</span></div>' + st + '</li>';
      }).join('');
      openSheet('<h3>Status simpanan</h3>' +
        (S.queue.length ? '<ul class="qlist">' + rows + '</ul>' : '<p>✅ Semua kerja telah dihantar ke pelayan.</p>') +
        '<div class="row-btns">' + (S.queue.length ? '<button class="btn" data-act="qkick">Hantar sekarang</button>' : '') +
        '<button class="btn ghost" data-act="closeSheet">Tutup</button></div>');
    });
  }

  function typeName(id) {
    var t = L.photoTypes(S.data ? S.data.types : null).filter(function (x) { return x.TypeID === id; })[0];
    return t ? t.Name : id;
  }
  function actName(id) {
    var a = L.activities(S.data ? S.data.activities : null).filter(function (x) { return x.ActivityID === id; })[0];
    return a ? a.Name : '';
  }

  // =================================================================
  // Login (Google Identity Services, redirect mode -> Apps Script -> back here with our session)
  // =================================================================
  function configured() {
    return CFG.API_URL && CFG.API_URL.indexOf('http') === 0 && CFG.CLIENT_ID && CFG.CLIENT_ID.indexOf('PASTE') < 0;
  }

  function handleLoginHash() {
    var h = location.hash || '';
    if (h.indexOf('#login=') === 0) {
      var params = {};
      h.slice(1).split('&').forEach(function (kv) { var i = kv.indexOf('='); params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
      var expected = null;
      try { expected = localStorage.getItem('solar.nonce'); } catch (e) { /* ignore */ }
      history.replaceState(null, '', location.pathname + location.search + '#/dashboard');
      if (!expected || expected !== params.nonce) {
        S.loginError = 'Log masuk tidak sah. Sila cuba lagi.';
        return Promise.resolve(false);
      }
      try { localStorage.removeItem('solar.nonce'); } catch (e) { /* ignore */ }
      return SolarAPI.setSession(params.login).then(function () { return true; });
    }
    if (h.indexOf('#loginerror=') === 0) {
      S.loginError = decodeURIComponent(h.slice('#loginerror='.length));
      history.replaceState(null, '', location.pathname + location.search + '#/login');
    }
    return Promise.resolve(false);
  }

  function renderLogin() {
    $('tabs').hidden = true;
    $('backBtn').hidden = true;
    $('title').textContent = 'Lampu Solar';
    var pending = S.queue.filter(function (i) { return i.status === 'pending'; }).length;
    $('view').innerHTML = '<div class="login card">' +
      '<img src="icons/icon-192.png" alt="" width="84" height="84">' +
      '<h2>Lampu Jalan Solar</h2><p class="muted">Lebuhraya KL–Karak · Package 2A</p>' +
      (S.loginError ? '<div class="err">' + esc(S.loginError) + '</div>' : '') +
      (pending ? '<div class="info-box">' + pending + ' item masih disimpan dalam telefon. Log masuk untuk menghantarnya.</div>' : '') +
      (configured() ? '<div id="gbtn" class="gbtn"></div><p class="muted small">Gunakan akaun Gmail yang didaftarkan oleh admin.</p>'
        : '<div class="err">Konfigurasi belum lengkap: isi API_URL dan CLIENT_ID dalam js/config.js (lihat Panduan Setup).</div>') +
      (!online() ? '<p class="muted">Perlu sambungan internet untuk log masuk.</p>' : '') +
      '</div>';
    if (!configured() || !online()) return;
    var nonce = SolarSync.uid();
    try { localStorage.setItem('solar.nonce', nonce); } catch (e) { /* ignore */ }
    loadGis(function () {
      google.accounts.id.initialize({
        client_id: CFG.CLIENT_ID, ux_mode: 'redirect', login_uri: CFG.API_URL, nonce: nonce,
        auto_select: false, itp_support: true, use_fedcm_for_prompt: false
      });
      var el = $('gbtn');
      if (el) google.accounts.id.renderButton(el, { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ms', width: 260 });
    });
  }

  function loadGis(cb) {
    if (window.google && google.accounts && google.accounts.id) return cb();
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = cb;
    s.onerror = function () { toast('Gagal memuatkan Google Sign-In. Semak line internet.'); };
    document.head.appendChild(s);
  }

  // =================================================================
  // Router
  // =================================================================
  function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }

  function route() {
    var h = (location.hash || '#/dashboard').replace(/^#\/?/, '');
    var parts = h.split('/');
    return { name: parts[0] || 'dashboard', a: parts[1] ? decodeURIComponent(parts[1]) : '', b: parts[2] || '' };
  }

  function setChrome(title, back, tab) {
    $('title').textContent = title;
    $('backBtn').hidden = !back;
    $('backBtn').dataset.back = back || '';
    $('tabs').hidden = false;
    var adminTab = document.querySelector('[data-tab="admin"]');
    adminTab.hidden = !hasAdminTab();
    document.querySelector('[data-tab="dashboard"]').hidden = !has('view_dashboard');
    Array.prototype.forEach.call(document.querySelectorAll('#tabs a'), function (a) {
      a.classList.toggle('active', a.dataset.tab === tab);
    });
  }

  function render() {
    var r = route();
    if (r.name !== 'tiang') S.gps.stop();
    if (!SolarAPI.hasSession() || r.name === 'login') {
      if (SolarAPI.hasSession() && r.name === 'login') return go('#/dashboard');
      return renderLogin();
    }
    if (!S.data) { $('view').innerHTML = '<div class="center muted">Memuatkan data…</div>'; return; }
    var y = window.scrollY;
    var same = render._last === location.hash;
    render._last = location.hash;
    switch (r.name) {
      case 'jadual':
        if (r.a) { S.filters.status = r.a; S.filters.bound = 'all'; S.filters.q = ''; S.jtab = 'semua'; history.replaceState(null, '', '#/jadual'); render._last = '#/jadual'; }
        renderJadual(); break;
      case 'tiang': r.b === 'edit' ? renderPoleEdit(r.a) : renderPole(r.a); break;
      case 'laporan': renderReports(); break;
      case 'admin':
        if (!hasAdminTab()) { go('#/jadual'); return; }
        if (r.a === 'pengguna' && has('manage_users')) renderUsers();
        else if (r.a === 'peranan' && has('manage_roles')) renderRoles();
        else if (r.a === 'tetapan' && has('edit_settings')) renderNames();
        else if (r.a === 'log' && has('view_audit_log')) renderAudit();
        else if (r.a === 'tiang-baru' && has('add_pole')) renderAddPole();
        else if (r.a === 'import' && has('import_poles')) renderImport();
        else renderAdminMenu();
        break;
      default: if (has('view_dashboard')) renderDashboard(); else { go('#/jadual'); return; }
    }
    if (same) window.scrollTo(0, y); else window.scrollTo(0, 0);
  }

  // =================================================================
  // Screen 1 — Dashboard
  // =================================================================
  function renderDashboard() {
    setChrome('Dashboard', '', 'dashboard');
    var m = merged();
    var d = L.dashboard(m.poles, m.types, m.statusPhotos, m.acts);
    function card(key, val, sub, cls) {
      return '<a class="stat' + (cls ? ' ' + cls : '') + '" href="#/jadual/' + key + '"><div class="stat-val">' + val + '</div>' +
        '<div class="stat-label">' + esc(lab(key)) + '</div>' + (sub ? '<div class="stat-sub">' + sub + '</div>' : '') + '</a>';
    }
    function bar(b) {
      var x = d.bound[b] || { total: 0, done: 0 };
      var pct = x.total ? Math.round(100 * x.done / x.total) : 0;
      return '<div class="bound"><div class="bound-head"><b>' + b + '</b><span>' + x.done + ' / ' + x.total + ' ' + esc(lab('DONE')).toLowerCase() + ' (' + pct + '%)</span></div>' +
        '<div class="bar"><div style="width:' + pct + '%"></div></div></div>';
    }
    var feed = (S.data.feed || []).map(function (f) {
      return '<li><span class="muted small">' + esc(fmtDT(f.Timestamp)) + '</span><br><b>' + esc(f.Name) + '</b> ' + feedText(f) + '</li>';
    }).join('');
    $('view').innerHTML =
      '<section class="stats">' +
      card('BAKI', d.baki, 'daripada ' + d.todo, 'big') +
      card('NIGHT', d.night, '🌙') +
      card('IN_PROGRESS', d.inProgress) +
      card('NOT_STARTED', d.notStarted) +
      card('DONE', d.done, 'daripada ' + d.total) +
      card('PENDING', d.pending) +
      '</section>' +
      '<section class="card"><h3>Kemajuan mengikut bound</h3>' + bar('EB') + bar('WB') + '</section>' +
      '<a class="btn block" href="#/jadual">📋 Buka jadual kerja</a>' +
      '<section class="card"><h3>Aktiviti terkini</h3>' + (feed ? '<ul class="feed">' + feed + '</ul>' : '<p class="muted">Tiada aktiviti lagi.</p>') + '</section>';
  }

  function feedText(f) {
    var id = '<a href="#/tiang/' + esc(String(f.NewValue || f.EntityID).split('/')[0]) + '">';
    switch (f.Action) {
      case 'PhotoAdded': {
        var pv = String(f.NewValue || '');
        var pole = pv.split('/')[0];
        var typ = (pv.split('/')[1] || '').split(' ')[0];
        var meas = pv.match(/ ([\d.]+)m$/);
        return 'menambah gambar <a href="#/tiang/' + esc(pole) + '">' + esc(pole) + '</a> · ' + esc(typeName(typ)) + (meas ? ' (' + esc(meas[1]) + ' m)' : '');
      }
      case 'NoteAdded': return 'menulis nota ' + id + esc(f.NewValue) + '</a>';
      case 'MarkedDone': return 'menanda siap <a href="#/tiang/' + esc(f.EntityID) + '">' + esc(f.EntityID) + '</a>';
      case 'DoneCancelled': return 'membatalkan siap <a href="#/tiang/' + esc(f.EntityID) + '">' + esc(f.EntityID) + '</a>';
      case 'CategoryChanged': return 'menukar kategori <a href="#/tiang/' + esc(f.EntityID) + '">' + esc(f.EntityID) + '</a>: ' + esc(f.OldValue) + ' → ' + esc(f.NewValue);
      case 'PoleEdited': return 'mengemas kini ' + esc(f.Field) + ' <a href="#/tiang/' + esc(f.EntityID) + '">' + esc(f.EntityID) + '</a>';
      case 'RetakeFlagged': return 'menanda gambar "Ambil semula"';
      case 'RetakeCleared': return 'membuang tanda "Ambil semula"';
      case 'ReportGenerated': return 'menjana laporan ' + esc({ PEGGING: actName('A'), TRIALPIT: actName('B'), INSTALLATION: actName('C') }[f.Field] || 'PDF') + ' (' + esc(f.NewValue) + ')';
      default: return esc(f.Action);
    }
  }

  // =================================================================
  // Screen 2 — Jadual kerja
  // =================================================================
  var STATUS_FILTERS = ['BAKI', 'NIGHT', 'NOT_STARTED', 'IN_PROGRESS', 'DONE', 'PENDING'];

  function renderJadual() {
    setChrome('Jadual kerja', '', 'jadual');
    var m = merged();
    if (!S.jtab) S.jtab = has('plan_work') ? 'semua' : 'esok';
    var tabs = '<div class="seg">' + [['hari', 'Hari ini'], ['esok', 'Esok'], ['semua', 'Semua']].map(function (t) {
      return '<button class="seg-btn' + (S.jtab === t[0] ? ' on' : '') + '" data-act="jtab" data-val="' + t[0] + '">' + t[1] + '</button>';
    }).join('') + '</div>';
    var active = m.poles.filter(L.isActive);
    var body;
    if (S.jtab !== 'semua') {
      var date = L.klDate(Date.now(), S.jtab === 'esok' ? 1 : 0);
      var byPole = L.plansForDate(m.plans, date);
      var rows = L.sortPolesByChainage(active.filter(function (p) { return byPole[p.PoleID]; }));
      body = '<div class="card"><b>Pelan kerja ' + (S.jtab === 'esok' ? 'esok' : 'hari ini') + '</b> · ' + esc(fmtDate(date)) +
        ' <span class="muted small">(' + rows.length + ' tiang)</span></div>' +
        (rows.length ? '<div class="plist2">' + rows.map(function (p) {
          var acts = [];
          byPole[p.PoleID].forEach(function (pl) { var n = planActName(pl.Activity); if (n && acts.indexOf(n) < 0) acts.push(n); });
          return poleRow(p, m, acts.join(' · '));
        }).join('') + '</div>'
          : '<p class="card center muted empty-plan">Tiada kerja dirancang untuk ' + (S.jtab === 'esok' ? 'esok' : 'hari ini') + '.</p>');
    } else {
      var f = S.filters;
      var showInactive = f.status === 'INACTIVE';
      var list = L.sortPolesByChainage(showInactive ? m.poles.filter(function (p) { return !L.isActive(p); }) : active).filter(function (p) {
        if (f.bound !== 'all' && p.Bound !== f.bound) return false;
        if (f.q && !L.poleMatchesQuery(p.PoleID, f.q)) return false;
        return showInactive || L.matchesFilter(p, f.status, m.statusPhotos);
      });
      var chip = function (group, val, label) {
        return '<button class="chip' + (f[group] === val ? ' on' : '') + '" data-act="filter" data-group="' + group + '" data-val="' + esc(val) + '">' + esc(label) + '</button>';
      };
      body = '<div class="filters card">' +
        '<input id="search" type="search" placeholder="Cari ID tiang (cth. SSL034 atau 34)" value="' + esc(f.q) + '" autocomplete="off">' +
        '<div class="chips">' + chip('bound', 'all', 'Semua') + chip('bound', 'EB', 'EB') + chip('bound', 'WB', 'WB') + '</div>' +
        '<div class="chips">' + chip('status', 'all', 'Semua status') + STATUS_FILTERS.map(function (k) { return chip('status', k, lab(k)); }).join('') +
        (has('delete_pole') ? chip('status', 'INACTIVE', 'Tidak aktif') : '') + '</div>' +
        '<div class="muted small">' + list.length + ' tiang · disusun ikut chainage</div></div>' +
        '<div class="plist2">' + (list.map(function (p) { return poleRow(p, m, ''); }).join('') || '<p class="muted center">Tiada tiang.</p>') + '</div>';
    }
    var nSel = selCount();
    var canTick = has('plan_work') || has('generate_report');
    var planBar = canTick ? '<div class="planbar' + (nSel ? ' show' : '') + '"><span>' + nSel + ' tiang dipilih</span>' +
      '<button class="btn small ghost x-btn" data-act="planClear" aria-label="Kosongkan pilihan" title="Kosongkan">✕</button>' +
      (has('plan_work') ? '<button class="btn small" data-act="planOpen"' + (nSel ? '' : ' disabled') + '>📅 Rancang</button>' : '') +
      (has('generate_report') ? '<button class="btn small" data-act="reportFromSchedule"' + (nSel ? '' : ' disabled') + '>📄 Jana laporan</button>' : '') +
      '</div>' : '';
    $('view').innerHTML = tabs + body + planBar;
    var s = $('search');
    if (s) s.oninput = function () {
      S.filters.q = s.value;
      var pos = s.selectionStart;
      renderJadual();
      var s2 = $('search'); s2.focus(); try { s2.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
    };
  }
  function selCount() { return Object.keys(S.planSel).filter(function (k) { return S.planSel[k]; }).length; }
  function planActName(v) { return v === 'C3' ? typeName('C3') : v ? actName(v) : ''; }

  function poleRow(p, m, planLabel) {
    var ws = L.workStatus(p, m.statusPhotos);
    var ps = L.photoStatus(p, m.types, m.statusPhotos, m.acts);
    var next = L.nextPlanDate(m.plans, p.PoleID, today());
    var canTick = has('plan_work') || has('generate_report');
    return '<div class="prow' + (L.isActive(p) ? '' : ' inactive') + '">' +
      (canTick ? '<label class="pchk"><input type="checkbox" data-act="psel" value="' + esc(p.PoleID) + '"' + (S.planSel[p.PoleID] ? ' checked' : '') + '></label>' : '') +
      '<a class="prow-link" href="#/tiang/' + encodeURIComponent(p.PoleID) + '">' +
      '<div class="prow-main"><b>' + esc(p.PoleID) + '</b> <span class="muted">· ' + esc(p.Bound) + '</span>' +
      (planLabel ? ' <span class="badge b-plan">' + esc(planLabel) + '</span>' : '') +
      '<div class="small">' + esc(p.Chainage) + '</div>' +
      '<div class="small ' + (next ? '' : 'muted') + '">📅 ' + (next ? esc(fmtDate(next)) : 'Belum dirancang') + '</div></div>' +
      '<div class="prow-badges">' + workBadge(ws) + nightBadge(p, m.statusPhotos) + photoBadge(ps) + chBadge(p) +
      (L.isActive(p) ? '' : '<span class="badge b-warn">Tidak aktif</span>') + '</div></a></div>';
  }

  function activityOptions(cur) {
    var opts = [['', '— tiada —']].concat(L.activities(S.data.activities).map(function (a) { return [a.ActivityID, a.Name]; }))
      .concat([['C3', typeName('C3')]]);
    return opts.map(function (o) { return '<option value="' + o[0] + '"' + ((cur || '') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
  }

  function openPlanSheet() {
    var ids = Object.keys(S.planSel).filter(function (k) { return S.planSel[k]; }).sort();
    if (!ids.length) return;
    openSheet('<h3>📅 Rancang kerja</h3><p class="small">' + esc(ids.join(', ')) + '</p>' +
      '<div class="form"><label>Tarikh<input id="planDate" type="date" value="' + L.klDate(Date.now(), 1) + '"></label>' +
      '<label>Aktiviti (pilihan)<select id="planAct">' + activityOptions('') + '</select></label></div>' +
      '<button class="btn block" data-act="planSave">Simpan</button><button class="btn block ghost" data-act="closeSheet">Batal</button>');
  }

  function savePlans() {
    var ids = Object.keys(S.planSel).filter(function (k) { return S.planSel[k]; }).sort();
    var date = $('planDate').value;
    if (!L.isIsoDate(date)) { toast('Pilih tarikh.'); return; }
    adminCall('addPlans', { poleIds: ids, date: date, activityId: $('planAct').value }).then(function (r) {
      S.data.plans = r.plans; S.planSel = {}; SolarDB.set('data', S.data); closeSheet(); render();
      toast(r.added + ' pelan ditambah' + (r.skipped ? ', ' + r.skipped + ' sudah ada' : ''));
    });
  }

  function editPlanSheet(planId) {
    var pl = (S.data.plans || []).filter(function (x) { return x.PlanID === planId; })[0];
    if (!pl) return;
    openSheet('<h3>Ubah pelan ' + esc(pl.PoleID) + '</h3><div class="form">' +
      '<label>Tarikh<input id="planDate" type="date" value="' + esc(pl.Date) + '"></label>' +
      '<label>Aktiviti (pilihan)<select id="planAct">' + activityOptions(pl.Activity) + '</select></label></div>' +
      '<button class="btn block" data-act="planEditSave" data-id="' + esc(planId) + '">Simpan</button>' +
      '<button class="btn block danger" data-act="planRemove" data-id="' + esc(planId) + '">🗑 Buang pelan</button>' +
      '<button class="btn block ghost" data-act="closeSheet">Batal</button>');
  }

  // =================================================================
  // Screen 3 — Pole detail
  // =================================================================
  function renderPole(id) {
    var m = merged();
    var p = poleById(m, id);
    if (!p) { setChrome(id, '#/jadual', 'jadual'); $('view').innerHTML = '<p class="center">Tiang tidak dijumpai.</p>'; return; }
    setChrome(p.PoleID, '#/jadual', 'jadual');
    var ws = L.workStatus(p, m.statusPhotos);
    var ps = L.photoStatus(p, m.types, m.statusPhotos, m.acts);
    var canPhoto = allowed('capture_photo', p);
    var canNote = allowed('add_note', p);
    var canDone = allowed('mark_done', p);
    if (canPhoto) S.gps.start();
    var photosOfPole = m.photos.filter(function (x) { return x.PoleID === p.PoleID && (has('hide_photo') || !L.bool(x.Hidden)); });

    var groups = m.acts.map(function (a) {
      var st = ps.activities.filter(function (x) { return x.ActivityID === a.ActivityID; })[0];
      var rin = String(p[L.RIN_FIELD[a.ActivityID]] || '');
      return '<section class="act"><div class="act-head"><h3>' + esc(a.Name) + '</h3>' +
        (ps.required ? '<span class="badge ' + (st.complete ? 'b-done' : 'b-part') + '">' + (st.complete ? '✓' : st.done + '/' + st.total) + '</span>' : '') +
        (rin || has('record_rin') ? '<button class="rin' + (rin ? ' set' : '') + '"' + (has('record_rin') ? ' data-act="rinEdit" data-pole="' + esc(p.PoleID) + '" data-act-id="' + a.ActivityID + '"' : ' disabled') +
          '>📄 RIN: ' + esc(rin || '—') + '</button>' : '') + '</div>' +
        (a.Spec ? '<div class="spec">📐 ' + esc(a.Spec) + '</div>' : '') +
        L.typesOfActivity(m.types, a.ActivityID).map(function (t) { return typeTile(p, t, photosOfPole, m, canPhoto); }).join('') +
        '</section>';
    }).join('');

    var notes = m.notes.filter(function (n) { return n.PoleID === p.PoleID; })
      .sort(function (a, b) { return String(a.CreatedAt) < String(b.CreatedAt) ? 1 : -1; });
    var notesHtml = notes.map(function (n) {
      return '<li><div class="note-text">' + esc(n.Text).replace(/\n/g, '<br>') + '</div><div class="muted small">' +
        esc(nameOf(n.CreatedBy)) + ' · ' + esc(fmtDT(n.CreatedAt)) + (n._pending ? ' · ⏳ menunggu line' : '') + (n._failed ? ' · ⚠️ gagal' : '') + '</div></li>';
    }).join('');
    var draft = '';
    try { draft = localStorage.getItem('solar.draft.' + p.PoleID) || ''; } catch (e) { /* ignore */ }
    var plans = m.plans.filter(function (x) { return x.PoleID === p.PoleID; }).sort(function (a, b) { return a.Date < b.Date ? -1 : 1; });
    var plansHtml = plans.map(function (x) {
      return '<li><span>📅 ' + esc(fmtDate(x.Date)) + (x.Activity ? ' · ' + esc(planActName(x.Activity)) : '') + (x.Date < today() ? ' <span class="muted small">(lepas)</span>' : '') + '</span>' +
        (has('plan_work') ? '<button class="btn small ghost" data-act="planEdit" data-id="' + esc(x.PlanID) + '">✏️</button>' : '') + '</li>';
    }).join('');
    var next = L.nextPlanDate(m.plans, p.PoleID, today());

    var doneBtn = '';
    if (canDone) {
      doneBtn = ws === L.WORK.DONE && L.bool(p.IsDone)
        ? '<button class="btn block ghost" data-act="done" data-id="' + esc(p.PoleID) + '" data-val="0">↩ Batal siap</button>'
        : ws === L.WORK.DONE ? ''
          : '<button class="btn block success" data-act="done" data-id="' + esc(p.PoleID) + '" data-val="1">✔ Tanda kerja siap</button>';
    }
    var tools = [];
    if (has('edit_pole')) tools.push('<a class="btn small ghost" href="#/tiang/' + encodeURIComponent(p.PoleID) + '/edit">✏️ Edit tiang</a>');
    if (has('override_status') && p.Category === L.CATEGORY.TODO) tools.push('<button class="btn small ghost" data-act="overrideOpen" data-id="' + esc(p.PoleID) + '">⚙️ Status</button>');
    if (has('move_photo')) {
      tools.push('<button class="btn small ghost" data-act="moveOpen" data-id="' + esc(p.PoleID) + '">🔀 Pindah gambar</button>');
      tools.push('<button class="btn small ghost" data-act="swapOpen" data-id="' + esc(p.PoleID) + '">⇄ Tukar dengan tiang lain</button>');
    }
    if (has('delete_pole')) {
      tools.push(L.isActive(p) ? '<button class="btn small ghost" data-act="poleActive" data-id="' + esc(p.PoleID) + '" data-val="0">⏸ Nyahaktif</button>'
        : '<button class="btn small ghost" data-act="poleActive" data-id="' + esc(p.PoleID) + '" data-val="1">▶ Aktifkan semula</button>');
      tools.push('<button class="btn small danger" data-act="poleDelete" data-id="' + esc(p.PoleID) + '">🗑 Padam tiang</button>');
    }
    var catNote = !L.isActive(p) ? '<div class="info-box warn-box">Tiang ini <b>tidak aktif</b> — tidak dipaparkan dalam senarai dan jumlah.</div>'
      : p.Category === L.CATEGORY.PENDING ? '<div class="info-box">Tiang ini <b>' + esc(lab('PENDING')) + '</b>. Gambar dan status Siap dibuka selepas admin menukar kategori kepada Perlu pasang.</div>'
      : p.Category === L.CATEGORY.INSTALLED ? '<div class="info-box">Tiang ini <b>' + esc(lab('INSTALLED')) + '</b>. Gambar tidak diwajibkan (boleh ditambah jika perlu).</div>' : '';

    $('view').innerHTML =
      '<section class="card pole-head">' +
      '<div class="pole-title"><h2>' + esc(p.PoleID) + '</h2></div>' +
      '<div>' + esc(p.Chainage) + ' · <b>' + esc(p.Bound) + '</b> ' + chBadge(p) + '</div>' +
      '<div class="muted small">Kategori: ' + esc(catLabel(p.Category)) + ' · 📅 ' + (next ? esc(fmtDate(next)) : 'Belum dirancang') +
      (p.ActualDate ? ' · Siap sebenar: ' + esc(fmtDate(p.ActualDate)) : '') + '</div>' +
      (p.PreviousIDs ? '<div class="muted small">ID lama: ' + esc(p.PreviousIDs) + '</div>' : '') +
      '<div class="badges">' + workBadge(ws) + (p.StatusOverride ? '<span class="badge b-wait">⚙️ admin</span>' : '') +
      (p._donePending ? '<span class="badge b-wait">⏳</span>' : '') + nightBadge(p, m.statusPhotos) + ' ' +
      '<span class="badge ' + (ps.required ? (ps.complete ? 'b-done' : 'b-part') : 'b-na') + '">' + esc(ps.required ? ps.label : 'Gambar: ' + ps.label) + '</span></div>' +
      (ps.required && !ps.complete ? '<div class="small progress-line">' + esc(ps.detail) + '</div>' : '') +
      (L.bool(p.IsDone) && p.DoneBy && p.Category === L.CATEGORY.TODO && !p.StatusOverride ? '<div class="muted small">Siap oleh ' + esc(nameOf(p.DoneBy)) + ' · ' + esc(fmtDT(p.DoneAt)) + '</div>' : '') +
      (tools.length ? '<div class="row-btns tools">' + tools.join('') + '</div>' : '') +
      '</section>' + catNote +
      (plansHtml ? '<section class="card"><h3>Pelan kerja</h3><ul class="planlist">' + plansHtml + '</ul></section>' : '') +
      groups + doneBtn +
      '<section class="card"><h3>Nota</h3>' +
      (canNote ? '<textarea id="noteText" rows="3" placeholder="Cth. lokasi dianjak 5 m ke arah KL kerana paip">' + esc(draft) + '</textarea>' +
        '<button class="btn" data-act="addNote" data-id="' + esc(p.PoleID) + '">Tambah nota</button>' : '') +
      (notesHtml ? '<ul class="notes">' + notesHtml + '</ul>' : '<p class="muted">Tiada nota.</p>') + '</section>';

    var ta = $('noteText');
    if (ta) ta.oninput = function () { try { localStorage.setItem('solar.draft.' + p.PoleID, ta.value); } catch (e) { /* ignore */ } };
    loadThumbs(p.PoleID, photosOfPole);
  }

  /** One photo type = one line: name, "6 📷 (min 4)", one horizontal swipe strip of thumbnails, buttons. */
  function typeTile(p, t, photosOfPole, m, canPhoto) {
    var inType = photosOfPole.filter(function (x) { return x.PhotoTypeID === t.TypeID; })
      .sort(function (a, b) { return String(a.CapturedAt) < String(b.CapturedAt) ? 1 : -1; });
    var st = L.typeState(p.PoleID, t, m.statusPhotos);
    var visible = inType.filter(function (x) { return !L.bool(x.Hidden) && !x._failed; });
    var icon = st.state === 'ok' ? '✅' : st.state === 'retake' ? '🔁' : st.state === 'partial' ? '◐' : '📷';
    var cls = 'tile ' + (st.state === 'ok' ? 'filled' : st.state === 'retake' ? 'retake' : st.state === 'partial' ? 'partial' : 'empty');
    var rs = L.typeReportState(p.PoleID, t.TypeID, m.photos.filter(function (x) { return !x._qid; }));
    var btns = '';
    if (canPhoto) {
      btns += '<button class="btn small' + (inType.length ? ' ghost' : '') + '" data-act="addPhoto" data-pole="' + esc(p.PoleID) +
        '" data-type="' + esc(t.TypeID) + '">' + (inType.length ? '+ Tambah' : '📷 Ambil gambar') + '</button>';
    }
    if (has('select_report_photos') && visible.some(function (x) { return !x._qid; })) {
      btns += '<button class="btn small ghost" data-act="chooseReport" data-pole="' + esc(p.PoleID) + '" data-type="' + esc(t.TypeID) + '">★ Laporan</button>';
    }
    var repNote = rs.state === 'ok' ? (rs.how === 'admin' ? '★ pilihan admin' : '★ automatik') : rs.state === 'choose' ? '⚠️ perlu pilih' : '';
    return '<div class="' + cls + '">' +
      '<div class="tile-head"><span class="tile-icon">' + icon + '</span><div class="tile-title"><b class="tile-name">' + esc(t.Name) + '</b>' +
      '<div class="tile-sub"><span class="count-pill">' + visible.length + ' 📷 (min ' + t.MinPhotos + ')</span>' +
      (t.NeedsMeasurement ? ' <span class="muted small">· ukuran (m)</span>' : '') +
      (repNote && (has('select_report_photos') || has('generate_report')) ? ' <span class="muted small">· ' + repNote + '</span>' : '') + '</div></div></div>' +
      (inType.length ? '<div class="strip">' + inType.map(function (x) { return thumbHtml(x, t); }).join('') + '</div>' : '') +
      (st.state === 'retake' ? '<div class="err small">Ambil semula</div>' : '') +
      (st.noMeasurement ? '<div class="err small">Ada gambar tanpa ukuran</div>' : '') +
      (btns ? '<div class="row-btns">' + btns + '</div>' : '') + '</div>';
  }

  function thumbHtml(x, t, selNo) {
    var src = x._qid ? queueThumbUrl(x._qid) : S.thumbUrls[x.PhotoID];
    var badges = '';
    if (selNo) badges += '<span class="tb selno">' + selNo + '</span>';
    if (x.Source === 'Gallery') badges += '<span class="tb">galeri</span>';
    if (x._pending) badges += '<span class="tb wait">⏳</span>';
    if (x._failed) badges += '<span class="tb bad">⚠️ gagal</span>';
    if (L.bool(x.RetakeFlag)) badges += '<span class="tb bad">Ambil semula</span>';
    if (!selNo && Number(x.ReportOrder) > 0) badges += '<span class="tb sel">★' + (t && t.ReportCount > 1 ? ' #' + x.ReportOrder : ' laporan') + '</span>';
    if (L.bool(x.Hidden)) badges += '<span class="tb hid">tersembunyi</span>';
    var meas = t && t.NeedsMeasurement ? '<span class="meas' + (L.hasMeasurement(x) ? '' : ' bad') + '">' +
      (L.hasMeasurement(x) ? esc(L.formatMeasurement(x.MeasurementM)) + ' m' : 'tiada ukuran') + '</span>' : '';
    return '<div class="thumb-wrap"><button class="thumb' + (L.bool(x.Hidden) ? ' hidden-photo' : '') + (selNo ? ' selected' : '') + '" data-act="' +
      (selNo !== undefined ? 'selTap' : 'viewPhoto') + '" data-id="' + esc(x.PhotoID) + '">' +
      (src ? '<img src="' + esc(src) + '" alt="">' : '<span class="ph">🖼️</span>') + '<span class="tbs">' + badges + '</span></button>' + meas + '</div>';
  }

  function queueThumbUrl(qid) {
    if (S.queueUrls[qid]) return S.queueUrls[qid];
    var it = S.queue.filter(function (i) { return i.id === qid; })[0];
    if (!it || !it.thumb) return '';
    S.queueUrls[qid] = URL.createObjectURL(new Blob([it.thumb], { type: 'image/jpeg' }));
    return S.queueUrls[qid];
  }

  function loadThumbs(poleId, photos) {
    var need = photos.filter(function (x) { return !x._qid && !S.thumbUrls[x.PhotoID]; });
    if (!need.length) return;
    Promise.all(need.map(function (x) {
      return SolarDB.thumbGet(x.PhotoID).then(function (t) {
        if (t && t.buf) { S.thumbUrls[x.PhotoID] = URL.createObjectURL(new Blob([t.buf], { type: 'image/jpeg' })); return null; }
        return x.PhotoID;
      });
    })).then(function (missing) {
      missing = missing.filter(Boolean);
      var key = poleId + ':' + missing.join(',');
      if (!missing.length || !online() || S.thumbLoading[key]) return missing.length ? null : 'local';
      S.thumbLoading[key] = true;
      return SolarAPI.call('getThumbs', { poleId: poleId, photoIds: missing }, 90000).then(function (r) {
        Object.keys(r.thumbs || {}).forEach(function (pid) {
          var bin = atob(r.thumbs[pid]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          SolarDB.thumbSet(pid, arr.buffer);
          S.thumbUrls[pid] = URL.createObjectURL(new Blob([arr], { type: 'image/jpeg' }));
        });
        return 'net';
      }).catch(function () { delete S.thumbLoading[key]; return null; });
    }).then(function (res) {
      if (res && route().name === 'tiang' && route().a === poleId) render();
    });
  }

  // ---------------- photo capture ----------------
  function askPhotoSource(poleId, typeId) {
    var t = L.typeById(typeId);
    openSheet('<h3>' + esc(poleId) + ' · ' + esc(typeName(typeId)) + '</h3>' +
      (t && t.NeedsMeasurement ? '<p class="small">Selepas gambar, anda perlu masukkan ukuran sebenar (meter).</p>' : '') +
      '<button class="btn block big" data-act="pick" data-mode="camera" data-pole="' + esc(poleId) + '" data-type="' + esc(typeId) + '">📷 Kamera</button>' +
      '<button class="btn block big ghost" data-act="pick" data-mode="gallery" data-pole="' + esc(poleId) + '" data-type="' + esc(typeId) + '">🖼️ Galeri</button>' +
      '<button class="btn block ghost" data-act="closeSheet">Batal</button>');
  }

  function pick(mode, poleId, typeId) {
    S.capture = { poleId: poleId, typeId: typeId, source: mode === 'camera' ? 'Camera' : 'Gallery' };
    S.gps.start();
    var inp = mode === 'camera' ? $('inCamera') : $('inGallery');
    inp.value = '';
    inp.click(); // must stay inside the tap handler (iPhone)
    closeSheet();
  }

  /** Ask the measured value (metres). Resolves the number, or null if the user discards the photo. */
  function askMeasurement(typeId, thumbBlob) {
    var t = L.typeById(typeId);
    var url = URL.createObjectURL(thumbBlob);
    return new Promise(function (resolve) {
      S.measResolve = function (v) { URL.revokeObjectURL(url); S.measResolve = null; closeSheet(); resolve(v); };
      openSheet('<h3>Ukuran: ' + esc(typeName(typeId)) + '</h3>' +
        '<img class="meas-preview" src="' + url + '" alt="">' +
        '<div class="form"><label>Ukuran sebenar ' + esc(({ WIDTH: 'lebar', LENGTH: 'panjang', DEPTH: 'dalam' })[t.MeasureLabel] || '') +
        ' (meter)<input id="measIn" type="text" inputmode="decimal" autocomplete="off" placeholder="cth. 1.3"></label></div>' +
        '<div id="measErr" class="err" hidden></div>' +
        '<button class="btn block" data-act="measOk">Simpan gambar</button>' +
        '<button class="btn block ghost" data-act="measCancel">Buang gambar ini</button>', { modal: true });
      setTimeout(function () { var i = $('measIn'); if (i) i.focus(); }, 50);
    });
  }

  function onFileChosen(e) {
    var file = e.target.files && e.target.files[0];
    var cap = S.capture;
    e.target.value = '';
    if (!file || !cap) return;
    var now = new Date();
    var type = L.typeById(cap.typeId);
    overlay('Memproses gambar…');
    W.process(file, {
      source: cap.source, now: now,
      getDeviceGps: function () { overlay('Mendapatkan lokasi GPS… (maksimum 15 saat)'); return S.gps.getFix(15000, 30000); }
    }).then(function (res) {
      overlay(false);
      var measP = type && type.NeedsMeasurement ? askMeasurement(cap.typeId, res.thumb) : Promise.resolve('');
      return measP.then(function (measurement) {
        if (measurement === null) return null; // discarded by the user
        overlay('Menyimpan…');
        return Promise.all([SolarSync.blobToBuf(res.full), SolarSync.blobToBuf(res.thumb)]).then(function (bufs) {
          var m = res.meta;
          return SolarSync.add({
            kind: 'photo',
            payload: { photoId: SolarSync.uid(), poleId: cap.poleId, typeId: cap.typeId, source: m.source, capturedAt: m.capturedAt,
              latitude: m.latitude, longitude: m.longitude, accuracy: m.accuracy, gpsAvailable: m.gpsAvailable,
              measurement: measurement === '' ? undefined : L.formatMeasurement(measurement) },
            image: bufs[0], thumb: bufs[1]
          }).then(function () { return m; });
        });
      });
    }).then(function (m) {
      overlay(false);
      if (!m) { toast('Gambar dibuang.'); return; }
      return loadQueue().then(function () {
        render();
        toast('✅ Gambar disimpan' + (m.gpsAvailable ? '' : ' (GPS tidak tersedia)') + (online() ? '' : ' — akan dihantar bila ada line'));
      });
    }).catch(function (err) {
      overlay(false);
      alert('Gambar tidak dapat diproses: ' + err.message);
    });
  }

  function confirmMeasurement() {
    var r = L.parseMeasurement($('measIn').value);
    if (!r.ok) { var el = $('measErr'); el.textContent = r.error; el.hidden = false; return; }
    if (S.measResolve) S.measResolve(r.value);
  }

  // ---------------- photo viewer ----------------
  function viewPhoto(photoId) {
    var m = merged();
    var x = m.photos.filter(function (p) { return p.PhotoID === photoId; })[0];
    if (!x) return;
    var p = poleById(m, x.PoleID);
    var t = L.typeById(x.PhotoTypeID);
    var gps = L.bool(x.GPSAvailable) && x.Latitude !== ''
      ? Number(x.Latitude).toFixed(5) + ', ' + Number(x.Longitude).toFixed(5) + (x.AccuracyM !== '' ? ' (±' + x.AccuracyM + ' m)' : '') +
        ' · <a target="_blank" rel="noopener" href="https://maps.google.com/?q=' + Number(x.Latitude) + ',' + Number(x.Longitude) + '">Peta</a>'
      : 'GPS tidak tersedia';
    var adminBtns = '';
    if (!x._qid) {
      var bt = [];
      if (has('select_report_photos') && !L.bool(x.Hidden)) bt.push('<button class="btn small ghost" data-act="chooseReport" data-pole="' + esc(x.PoleID) + '" data-type="' + esc(x.PhotoTypeID) + '">★ Pilih untuk laporan</button>');
      if (has('hide_photo')) {
        bt.push('<button class="btn small ' + (L.bool(x.RetakeFlag) ? 'ghost' : 'warnbtn') + '" data-act="flag" data-id="' + esc(x.PhotoID) + '" data-field="RetakeFlag" data-val="' + (L.bool(x.RetakeFlag) ? 0 : 1) + '">' +
          (L.bool(x.RetakeFlag) ? 'Buang tanda Ambil semula' : '🔁 Ambil semula') + '</button>');
        bt.push('<button class="btn small ghost" data-act="flag" data-id="' + esc(x.PhotoID) + '" data-field="Hidden" data-val="' + (L.bool(x.Hidden) ? 0 : 1) + '">' +
          (L.bool(x.Hidden) ? '👁 Tunjuk semula' : '🚫 Sorok') + '</button>');
      }
      if (has('edit_measurement') && t && t.NeedsMeasurement) bt.push('<button class="btn small ghost" data-act="measEdit" data-id="' + esc(x.PhotoID) + '">📏 Edit ukuran</button>');
      if (has('move_photo')) bt.push('<button class="btn small ghost" data-act="moveOne" data-id="' + esc(x.PhotoID) + '">🔀 Pindah ke tiang…</button>');
      if (has('delete_photo')) bt.push('<button class="btn small danger" data-act="photoDelete" data-id="' + esc(x.PhotoID) + '">🗑 Padam</button>');
      if (bt.length) adminBtns = '<div class="row-btns">' + bt.join('') + '</div>';
    }
    openSheet('<div class="viewer"><div id="fullImg" class="full-img"><div class="spinner"></div></div>' +
      '<table class="kv">' +
      '<tr><th>Tiang</th><td>' + esc(x.PoleID) + (p ? ' · ' + esc(p.Chainage) + ' · ' + esc(p.Bound) : '') + '</td></tr>' +
      '<tr><th>Jenis</th><td>' + esc(actName(t ? t.ActivityID : '')) + ' · ' + esc(typeName(x.PhotoTypeID)) + '</td></tr>' +
      (t && t.NeedsMeasurement ? '<tr><th>Ukuran</th><td>' + (L.hasMeasurement(x) ? esc(L.formatMeasurement(x.MeasurementM)) + ' m' : '<span class="err small">tiada ukuran</span>') + '</td></tr>' : '') +
      '<tr><th>Tarikh/masa</th><td>' + esc(fmtDT(x.CapturedAt)) + '</td></tr>' +
      '<tr><th>GPS</th><td>' + gps + '</td></tr>' +
      '<tr><th>Diambil oleh</th><td>' + esc(nameOf(x.TakenBy)) + '</td></tr>' +
      '<tr><th>Sumber</th><td>' + (x.Source === 'Gallery' ? 'Galeri' : 'Kamera') + '</td></tr>' +
      (x.UploadedAt ? '<tr><th>Dimuat naik</th><td>' + esc(fmtDT(x.UploadedAt)) + '</td></tr>' : '<tr><th>Status</th><td>' + (x._failed ? '⚠️ Gagal dihantar' : '⏳ Menunggu line') + '</td></tr>') +
      (L.bool(x.RetakeFlag) ? '<tr><th></th><td class="err">Ditanda Ambil semula</td></tr>' : '') +
      (Number(x.ReportOrder) > 0 ? '<tr><th></th><td>★ Dipilih untuk laporan' + (t && t.ReportCount > 1 ? ' (#' + x.ReportOrder + ')' : '') + '</td></tr>' : '') +
      (L.bool(x.Hidden) ? '<tr><th></th><td>🚫 Tersembunyi (hanya admin nampak)</td></tr>' : '') +
      '</table>' + adminBtns + '<button class="btn block ghost" data-act="closeSheet">Tutup</button></div>');
    loadFull(x).then(function (url) {
      var el = $('fullImg');
      if (el) el.innerHTML = url ? '<img src="' + esc(url) + '" alt="">' : '<p class="muted">Gambar penuh hanya boleh dilihat bila ada line.</p>';
    });
  }

  // ---------------- admin: choose report photos (1, or 4 in order for C1) ----------------
  function openChooser(poleId, typeId) {
    var m = merged();
    var current = L.isAdminChoice(poleId, typeId, m.photos)
      ? L.reportPhotos(poleId, typeId, m.photos).map(function (p) { return p.PhotoID; }) : [];
    S.sel = { poleId: poleId, typeId: typeId, ids: current };
    renderChooser();
  }

  function renderChooser() {
    var m = merged();
    var sel = S.sel;
    var t = L.typeById(sel.typeId);
    var list = m.photos.filter(function (x) {
      return x.PoleID === sel.poleId && x.PhotoTypeID === sel.typeId && !L.bool(x.Hidden) && !x._qid;
    }).sort(function (a, b) { return String(a.CapturedAt) < String(b.CapturedAt) ? -1 : 1; });
    var auto = L.reportPhotos(sel.poleId, sel.typeId, m.photos.filter(function (x) { return !x._qid; }).map(function (x) {
      return Object.assign({}, x, { ReportOrder: 0 });
    })).map(function (x) { return x.PhotoID; });
    var need = t.ReportCount;
    openSheet('<h3>★ Pilih untuk laporan</h3><p><b>' + esc(sel.poleId) + ' · ' + esc(typeName(sel.typeId)) + '</b></p>' +
      '<p class="small">' + (need === 1 ? 'Ketik <b>1</b> gambar.' : 'Ketik <b>' + need + '</b> gambar mengikut susunan dalam laporan (1 → ' + need + ').') + '</p>' +
      '<div class="thumbs chooser">' + list.map(function (x) {
        var k = sel.ids.indexOf(x.PhotoID);
        return thumbHtml(x, t, k >= 0 ? (need > 1 ? String(k + 1) : '★') : '');
      }).join('') + '</div>' +
      '<p class="small">Dipilih: <b id="selCount">' + sel.ids.length + '</b> / ' + need +
      ' · Automatik: ' + auto.length + ' gambar terkini (tanpa tanda Ambil semula)</p>' +
      '<button class="btn block" data-act="selSave"' + (sel.ids.length === need ? '' : ' disabled') + '>Simpan pilihan</button>' +
      '<button class="btn block ghost" data-act="selAuto">Guna pilihan automatik</button>' +
      '<button class="btn block ghost" data-act="closeSheet">Batal</button>');
    loadThumbs(sel.poleId, list);
  }

  function chooserTap(photoId) {
    var sel = S.sel;
    var need = L.typeById(sel.typeId).ReportCount;
    var k = sel.ids.indexOf(photoId);
    if (k >= 0) sel.ids.splice(k, 1);
    else if (need === 1) sel.ids = [photoId];
    else if (sel.ids.length < need) sel.ids.push(photoId);
    else { toast('Sudah ' + need + ' dipilih. Ketik gambar bernombor untuk buang.'); return; }
    renderChooser();
  }

  function saveChooser(clear) {
    var sel = S.sel;
    adminCall('setReportSelection', { poleId: sel.poleId, typeId: sel.typeId, photoIds: clear ? [] : sel.ids }).then(function (r) {
      (r.photos || []).forEach(replacePhoto); SolarDB.set('data', S.data); closeSheet(); render();
      toast(clear ? 'Laporan guna pilihan automatik' : '★ Pilihan laporan disimpan');
    });
  }

  function loadFull(x) {
    if (S.fullUrls[x.PhotoID]) return Promise.resolve(S.fullUrls[x.PhotoID]);
    if (x._qid) {
      var it = S.queue.filter(function (i) { return i.id === x._qid; })[0];
      if (!it) return Promise.resolve('');
      S.fullUrls[x.PhotoID] = URL.createObjectURL(new Blob([it.image], { type: 'image/jpeg' }));
      return Promise.resolve(S.fullUrls[x.PhotoID]);
    }
    return SolarAPI.call('getPhoto', { photoId: x.PhotoID }, 90000).then(function (r) {
      var bin = atob(r.b64);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      S.fullUrls[x.PhotoID] = URL.createObjectURL(new Blob([arr], { type: 'image/jpeg' }));
      return S.fullUrls[x.PhotoID];
    }).catch(function () { return S.thumbUrls[x.PhotoID] || ''; });
  }

  // ---------------- notes / done ----------------
  function addNote(poleId) {
    var ta = $('noteText');
    var text = (ta.value || '').trim();
    if (!text) { toast('Tulis nota dahulu.'); return; }
    SolarSync.add({ kind: 'note', payload: { noteId: SolarSync.uid(), poleId: poleId, text: text, createdAt: W.klIso(new Date()) } })
      .then(function () {
        try { localStorage.removeItem('solar.draft.' + poleId); } catch (e) { /* ignore */ }
        return loadQueue();
      }).then(function () { render(); toast('📝 Nota disimpan'); });
  }

  function setDone(poleId, done) {
    if (!done && !confirm('Batal status Siap untuk ' + poleId + '?')) return;
    SolarSync.add({ kind: 'done', payload: { poleId: poleId, done: done } })
      .then(loadQueue).then(function () { render(); toast(done ? '✔ Ditanda siap' : '↩ Status siap dibatalkan'); });
  }

  // ---------------- admin online actions ----------------
  function adminCall(action, params, msg, timeout) {
    if (!online()) { toast('Perlu line internet untuk tindakan admin.'); return Promise.reject(new Error('offline')); }
    overlay(msg || 'Menyimpan…');
    return SolarAPI.call(action, params, timeout).then(function (r) { overlay(false); return r; }, function (err) {
      overlay(false);
      if (err.code === 'AUTH') showNeedLogin(true);
      alert(err.message);
      err.shown = true; // already shown to the user: not an unhandled error
      throw err;
    });
  }

  function flagPhoto(id, field, val) {
    adminCall('setPhotoFlag', { photoId: id, field: field, value: val }).then(function (r) {
      replacePhoto(r.photo); (r.photos || []).forEach(replacePhoto); SolarDB.set('data', S.data); closeSheet(); render();
    });
  }
  // ---------------- photo / pole admin dialogs (v3) ----------------
  function apiDone(r, msg) {
    if (r.pole) replacePole(r.pole);
    (r.photos || []).forEach(function (ph) {
      if (S.data.photos.some(function (o) { return o.PhotoID === ph.PhotoID; })) replacePhoto(ph); else S.data.photos.push(ph);
    });
    SolarDB.set('data', S.data);
    closeSheet(); render();
    if (msg) toast(msg);
    return r;
  }

  function deletePhotoDialog(photoId) {
    var x = S.data.photos.filter(function (p) { return p.PhotoID === photoId; })[0];
    if (!x) return;
    openSheet('<h3>🗑 Padam gambar?</h3><p>' + esc(x.PoleID) + ' · ' + esc(typeName(x.PhotoTypeID)) + ' · ' + esc(fmtDT(x.CapturedAt)) + '</p>' +
      '<p class="small">Gambar dibuang dari aplikasi dan dipindah ke <b>Trash Google Drive</b> (boleh dipulihkan dari Drive dalam 30 hari). ' +
      (Number(x.ReportOrder) > 0 ? '<b>Pilihan laporan untuk jenis ini akan dikosongkan.</b> ' : '') + 'Dicatat dalam log.</p>' +
      '<button class="btn block danger" data-act="photoDeleteYes" data-id="' + esc(photoId) + '">Ya, padam gambar</button>' +
      '<button class="btn block ghost" data-act="closeSheet">Batal</button>');
  }

  function measEditDialog(photoId) {
    var x = S.data.photos.filter(function (p) { return p.PhotoID === photoId; })[0];
    if (!x) return;
    openSheet('<h3>📏 Edit ukuran: ' + esc(typeName(x.PhotoTypeID)) + '</h3><p class="small">' + esc(x.PoleID) + ' · sekarang: ' +
      (L.hasMeasurement(x) ? esc(L.formatMeasurement(x.MeasurementM)) + ' m' : 'tiada') + '</p>' +
      '<div class="form"><label>Ukuran baru (meter)<input id="measIn" type="text" inputmode="decimal" value="' + esc(x.MeasurementM === '' ? '' : L.formatMeasurement(x.MeasurementM)) + '"></label></div>' +
      '<div id="measErr" class="err" hidden></div>' +
      '<button class="btn block" data-act="measEditSave" data-id="' + esc(photoId) + '">Simpan</button><button class="btn block ghost" data-act="closeSheet">Batal</button>');
  }
  function measEditSave(photoId) {
    var r = L.parseMeasurement($('measIn').value);
    if (!r.ok) { var el = $('measErr'); el.textContent = r.error; el.hidden = false; return; }
    adminCall('editMeasurement', { photoId: photoId, value: $('measIn').value }).then(function (res) { apiDone({ photos: [res.photo] }, 'Ukuran dikemas kini'); });
  }

  /** Searchable pole picker used by move / swap. */
  function polePicker(idAttr, exclude) {
    return '<input id="' + idAttr + 'Q" type="search" placeholder="Cari ID tiang (cth. 35)" autocomplete="off">' +
      '<select id="' + idAttr + '" size="6" class="picker">' + pickerOptions('', exclude) + '</select>';
  }
  function pickerOptions(q, exclude) {
    return L.sortPolesByChainage(S.data.poles).filter(function (p) {
      return !L.sameId(p.PoleID, exclude) && L.poleMatchesQuery(p.PoleID, q);
    }).map(function (p) {
      return '<option value="' + esc(p.PoleID) + '">' + esc(p.PoleID) + ' · ' + esc(p.Chainage) + ' · ' + esc(p.Bound) + (L.isActive(p) ? '' : ' (tidak aktif)') + '</option>';
    }).join('');
  }
  function wirePicker(idAttr, exclude) {
    var q = $(idAttr + 'Q');
    if (q) q.oninput = function () { $(idAttr).innerHTML = pickerOptions(q.value, exclude); };
  }

  function moveDialog(poleId, preselect) {
    var list = S.data.photos.filter(function (x) { return x.PoleID === poleId; })
      .sort(function (a, b) { return (L.typeById(a.PhotoTypeID) || {}).Order - (L.typeById(b.PhotoTypeID) || {}).Order || (a.CapturedAt < b.CapturedAt ? -1 : 1); });
    if (!list.length) { toast('Tiada gambar pada tiang ini.'); return; }
    S.moveSel = {};
    (preselect || []).forEach(function (id) { S.moveSel[id] = true; });
    var types = L.photoTypes(S.data.types);
    openSheet('<h3>🔀 Pindah gambar dari ' + esc(poleId) + '</h3><p class="small">1. Tanda gambar</p>' +
      '<div class="move-list">' + list.map(function (x) {
        var t = L.typeById(x.PhotoTypeID);
        return '<label class="check"><input type="checkbox" data-act="msel" value="' + esc(x.PhotoID) + '"' + (S.moveSel[x.PhotoID] ? ' checked' : '') + '>' +
          '<span class="mini">' + (S.thumbUrls[x.PhotoID] ? '<img src="' + esc(S.thumbUrls[x.PhotoID]) + '" alt="">' : '🖼️') + '</span>' +
          '<span>' + esc(typeName(x.PhotoTypeID)) + (t && t.NeedsMeasurement && L.hasMeasurement(x) ? ' · ' + esc(L.formatMeasurement(x.MeasurementM)) + ' m' : '') +
          (Number(x.ReportOrder) > 0 ? ' · ★' : '') + (L.bool(x.Hidden) ? ' · tersorok' : '') + '<br><span class="muted small">' + esc(fmtDT(x.CapturedAt)) + '</span></span></label>';
      }).join('') + '</div>' +
      '<p class="small">2. Tiang tujuan</p>' + polePicker('moveTarget', poleId) +
      '<div class="form"><label>3. Jenis gambar di tiang tujuan<select id="moveType"><option value="">Sama seperti sekarang</option>' +
      types.map(function (t) { return '<option value="' + t.TypeID + '">' + esc(actName(t.ActivityID)) + ' · ' + esc(t.Name) + '</option>'; }).join('') + '</select></label></div>' +
      '<p class="muted small">Gambar ditambah kepada gambar sedia ada di tiang tujuan. Ukuran ikut sekali. Pilihan laporan bagi jenis yang terlibat dikosongkan.</p>' +
      '<button class="btn block" data-act="moveSave" data-id="' + esc(poleId) + '">Pindah</button><button class="btn block ghost" data-act="closeSheet">Batal</button>');
    wirePicker('moveTarget', poleId);
  }
  function moveSave() {
    var ids = Object.keys(S.moveSel).filter(function (k) { return S.moveSel[k]; });
    var target = $('moveTarget').value;
    if (!ids.length) { toast('Tanda sekurang-kurangnya satu gambar.'); return; }
    if (!target) { toast('Pilih tiang tujuan.'); return; }
    if (!confirm('Pindah ' + ids.length + ' gambar ke ' + target + '?')) return;
    adminCall('movePhotos', { photoIds: ids, targetPoleId: target, typeId: $('moveType').value }, 'Memindah gambar…', 120000).then(function (r) {
      apiDone(r, ids.length + ' gambar dipindah ke ' + target);
      refresh(true);
    });
  }

  function swapDialog(poleId) {
    openSheet('<h3>⇄ Tukar gambar antara 2 tiang</h3><p>Tiang A: <b>' + esc(poleId) + '</b></p><p class="small">Tiang B</p>' + polePicker('swapB', poleId) +
      '<div class="form"><label>Aktiviti<select id="swapAct"><option value="">Semua aktiviti</option>' +
      L.activities(S.data.activities).map(function (a) { return '<option value="' + a.ActivityID + '">' + esc(a.Name) + '</option>'; }).join('') + '</select></label></div>' +
      '<p class="muted small">Semua gambar A pergi ke B dan B ke A dalam satu tindakan. Jika gagal, tiada apa berubah. Pilihan laporan ikut gambar.</p>' +
      '<button class="btn block" data-act="swapSave" data-id="' + esc(poleId) + '">Tukar</button><button class="btn block ghost" data-act="closeSheet">Batal</button>');
    wirePicker('swapB', poleId);
  }
  function swapSave(a) {
    var b = $('swapB').value;
    if (!b) { toast('Pilih tiang B.'); return; }
    var act = $('swapAct').value;
    if (!confirm('Tukar ' + (act ? 'gambar ' + actName(act) : 'SEMUA gambar') + ' antara ' + a + ' dan ' + b + '?')) return;
    adminCall('swapPhotos', { poleA: a, poleB: b, activityId: act }, 'Menukar gambar…', 120000).then(function (r) {
      apiDone(r, 'Gambar ' + a + ' ⇄ ' + b + ' ditukar');
      refresh(true);
    });
  }

  function overrideDialog(poleId) {
    var p = poleById(merged(), poleId);
    var cur = p.StatusOverride || '';
    var opt = function (v, t) { return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + esc(t) + '</option>'; };
    openSheet('<h3>⚙️ Status kerja ' + esc(poleId) + '</h3><p class="small">Status kerja tidak bergantung pada gambar. Gambar hanya untuk tuntutan.</p>' +
      '<div class="form"><label>Status<select id="ovStatus">' + opt('', 'Ikut automatik') + opt('NOT_STARTED', lab('NOT_STARTED')) +
      opt('IN_PROGRESS', lab('IN_PROGRESS')) + opt('DONE', lab('DONE')) + '</select></label>' +
      '<label>Tarikh siap sebenar<input id="ovDate" type="date" value="' + esc(p.ActualDate || '') + '"></label></div>' +
      '<button class="btn block" data-act="overrideSave" data-id="' + esc(poleId) + '">Simpan</button><button class="btn block ghost" data-act="closeSheet">Batal</button>');
  }

  function rinDialog(poleId, act) {
    var p = poleById(merged(), poleId);
    openSheet('<h3>📄 No. RIN · ' + esc(actName(act)) + '</h3><p>' + esc(poleId) + '</p>' +
      '<div class="form"><label>No. RIN (kosongkan untuk buang)<input id="rinIn" maxlength="60" value="' + esc(p[L.RIN_FIELD[act]] || '') + '"></label></div>' +
      '<button class="btn block" data-act="rinSave" data-pole="' + esc(poleId) + '" data-act-id="' + act + '">Simpan</button><button class="btn block ghost" data-act="closeSheet">Batal</button>');
  }

  function poleDeleteDialog(poleId) {
    var n = S.data.photos.filter(function (x) { return x.PoleID === poleId; }).length;
    if (n) {
      openSheet('<h3>🗑 Padam tiang ' + esc(poleId) + '</h3><p class="err">Pindah atau padam gambar dahulu (' + n + ' gambar).</p>' +
        '<button class="btn block ghost" data-act="closeSheet">Tutup</button>');
      return;
    }
    openSheet('<h3>🗑 Padam tiang ' + esc(poleId) + '?</h3><p class="small">Tiang dibuang dari senarai. Pelan kerja tiang ini dibuang; nota disimpan dalam Sheet. ' +
      'Tindakan ini dicatat dalam log. Jika hanya mahu sembunyikan, guna <b>Nyahaktif</b>.</p>' +
      '<div class="form"><label>Taip <b>' + esc(poleId) + '</b> untuk sahkan<input id="delConfirm" autocomplete="off"></label></div>' +
      '<button class="btn block danger" data-act="poleDeleteYes" data-id="' + esc(poleId) + '">Padam tiang</button><button class="btn block ghost" data-act="closeSheet">Batal</button>');
  }

  /** Save with "same CH + bound" warning: server answers {needsConfirm, warnings}; ask, then resend with confirm. */
  function saveWithWarning(action, params, doneFn) {
    return adminCall(action, params).then(function (r) {
      if (r.needsConfirm) {
        if (!confirm('⚠️ ' + r.warnings.join('\n') + '\n\nSimpan juga?')) return null;
        return adminCall(action, Object.assign({}, params, { confirm: true })).then(doneFn);
      }
      return doneFn(r);
    });
  }

  // =================================================================
  // Admin — pole editor
  // =================================================================
  function renderPoleEdit(id) {
    var p = poleById(merged(), id);
    if (!has('edit_pole') || !p) return go('#/tiang/' + encodeURIComponent(id));
    setChrome('Edit ' + id, '#/tiang/' + encodeURIComponent(id), 'jadual');
    function opt(v, cur, label) { return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label || v) + '</option>'; }
    $('view').innerHTML = '<form class="card form" id="poleForm">' +
      '<label>ID tiang<input name="PoleID" value="' + esc(p.PoleID) + '" maxlength="20" required></label>' +
      '<div class="muted small">Menukar ID mengemas kini semua gambar, nota, pelan, laporan dan folder Drive. ID tidak boleh sama dengan tiang lain.</div>' +
      '<label>Chainage<input name="Chainage" value="' + esc(p.Chainage) + '" required></label>' +
      '<div class="muted small">Format tepat: CH. + 5 digit, cth. CH.41450</div>' +
      '<label>Bound<select name="Bound">' + opt('EB', p.Bound) + opt('WB', p.Bound) + '</select></label>' +
      '<label>Kategori<select name="Category">' + L.CATEGORIES.map(function (c) { return opt(c, p.Category, catLabel(c)); }).join('') + '</select></label>' +
      '<label>Tarikh siap sebenar<input name="ActualDate" type="date" value="' + esc(p.ActualDate || '') + '"></label>' +
      L.activities(S.data.activities).map(function (a) {
        var f = L.RIN_FIELD[a.ActivityID];
        return '<label>No. RIN · ' + esc(a.Name) + '<input name="' + f + '" maxlength="60" value="' + esc(p[f] || '') + '"></label>';
      }).join('') +
      '<div id="editErr" class="err" hidden></div>' +
      '<button class="btn block" type="submit">Simpan</button></form>';
    $('poleForm').onsubmit = function (ev) {
      ev.preventDefault();
      var f = ev.target;
      var changes = {};
      ['PoleID', 'Chainage', 'Bound', 'Category', 'ActualDate', 'RINPegging', 'RINTrialPit', 'RINInstallation'].forEach(function (k) {
        var v = f[k].value.trim();
        if (v !== String(p[k] || '')) changes[k] = v;
      });
      if (!Object.keys(changes).length) return go('#/tiang/' + encodeURIComponent(id));
      if ('PoleID' in changes) {
        var v = L.validatePoleId(changes.PoleID);
        var dup = v.ok && S.data.poles.filter(function (o) { return o.PoleID !== p.PoleID && L.sameId(o.PoleID, v.id); })[0];
        var err = !v.ok ? v.error : dup ? 'ID tiang "' + v.id + '" sudah digunakan oleh tiang ' + dup.PoleID + '.' : '';
        if (err) { var el = $('editErr'); el.textContent = err; el.hidden = false; return; }
        if (!confirm('Tukar ID ' + p.PoleID + ' → ' + v.id + '? Semua rujukan akan dikemas kini.')) return;
      }
      saveWithWarning('editPole', { poleId: id, changes: changes }, function (r) {
        if (!r) return;
        refresh(true);
        toast('Disimpan');
        go('#/tiang/' + encodeURIComponent(r.pole.PoleID));
      }).catch(function () { /* shown */ });
    };
  }

  function renderAddPole() {
    setChrome('Tambah tiang', '#/admin', 'admin');
    $('view').innerHTML = '<form class="card form" id="addPole">' +
      '<label>ID tiang<input name="poleId" maxlength="20" required placeholder="cth. SSL124 atau SSL999 (sementara)"></label>' +
      '<label>Chainage<input name="chainage" required placeholder="CH.41450"></label>' +
      '<label>Bound<select name="bound"><option>EB</option><option>WB</option></select></label>' +
      '<label>Kategori<select name="category">' + L.CATEGORIES.map(function (c) { return '<option value="' + esc(c) + '">' + esc(catLabel(c)) + '</option>'; }).join('') + '</select></label>' +
      '<label>Nota (pilihan)<textarea name="note" rows="2"></textarea></label>' +
      '<div id="addErr" class="err" hidden></div><button class="btn block" type="submit">Tambah tiang</button></form>';
    $('addPole').onsubmit = function (ev) {
      ev.preventDefault();
      var f = ev.target;
      var v = L.validatePoleId(f.poleId.value);
      var dup = v.ok && S.data.poles.filter(function (o) { return L.sameId(o.PoleID, v.id); })[0];
      var err = !v.ok ? v.error : dup ? 'ID tiang "' + v.id + '" sudah digunakan oleh tiang ' + dup.PoleID + '.' : '';
      if (err) { var el = $('addErr'); el.textContent = err; el.hidden = false; return; }
      saveWithWarning('addPole', { poleId: v.id, chainage: f.chainage.value, bound: f.bound.value, category: f.category.value, note: f.note.value }, function (r) {
        if (!r) return;
        S.data.poles.push(r.pole); SolarDB.set('data', S.data); refresh(true);
        toast('Tiang ' + r.pole.PoleID + ' ditambah');
        go('#/tiang/' + encodeURIComponent(r.pole.PoleID));
      }).catch(function () { /* shown */ });
    };
  }

  // ---------------- import / export ----------------
  function loadXlsxLib() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'lib/xlsx.full.min.js';
      s.onload = function () { resolve(window.XLSX); };
      s.onerror = function () { reject(new Error('Gagal memuatkan pembaca Excel. Semak line internet.')); };
      document.head.appendChild(s);
    });
  }
  /** first sheet -> [{PoleID, Chainage, Bound, Category}] using flexible header names */
  function rowsFromSheet(XLSX, wb) {
    var raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
    var hi = raw.findIndex(function (r) { return r.some(function (c) { return /pole\s*id|light\s*id|id\s*tiang/i.test(String(c)); }); });
    if (hi < 0) throw new Error('Lajur "Pole ID" tidak dijumpai di baris tajuk.');
    var head = raw[hi].map(function (h) { return String(h).trim().toLowerCase(); });
    var col = function (re) { for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; };
    var c = { id: col(/pole\s*id|light\s*id|id\s*tiang/), ch: col(/^ch|chainage/), b: col(/bound/), cat: col(/categ|kategori|work\s*area/) };
    if (c.ch < 0 || c.b < 0) throw new Error('Lajur CH / Chainage dan Bound diperlukan.');
    return raw.slice(hi + 1).filter(function (r) { return r.some(function (x) { return String(x).trim(); }); }).map(function (r) {
      return { PoleID: r[c.id], Chainage: r[c.ch], Bound: r[c.b], Category: c.cat >= 0 ? r[c.cat] : '' };
    });
  }

  function renderImport() {
    setChrome('Import tiang', '#/admin', 'admin');
    var imp = S.imp || {};
    var rows = imp.preview || [];
    var cnt = function (st) { return rows.filter(function (r) { return r.status === st; }).length; };
    $('view').innerHTML = '<section class="card"><p class="small">Fail Excel (.xlsx) atau CSV dengan lajur <b>Pole ID, CH, Bound, Category</b>. ' +
      'Category: Perlu pasang / Tunggu kelulusan / Sudah dipasang (kosong = Perlu pasang).</p>' +
      '<button class="btn small ghost" data-act="importTemplate">⬇ Templat</button>' +
      '<input id="importFile" type="file" accept=".xlsx,.xls,.csv"></section>' +
      (rows.length ? '<section class="card"><h3>Pratonton (belum disimpan)</h3>' +
        '<p class="small">Baru: <b>' + cnt('new') + '</b> · Sudah ada: <b>' + cnt('exists') + '</b> · Ralat: <b class="err-text">' + cnt('error') + '</b> (tidak akan disimpan)</p>' +
        '<div class="imp-table"><table class="audit"><tbody>' + rows.map(function (r) {
          return '<tr class="imp-' + r.status + '"><td>' + r.row + '</td><td><b>' + esc(r.PoleID || '—') + '</b><br><span class="small">' + esc(r.Chainage) + ' · ' + esc(r.Bound) + ' · ' + esc(r.Category || '') + '</span>' +
            (r.errors.length ? '<div class="err small">' + esc(r.errors.join(' ')) + '</div>' : '') +
            (r.warnings.length ? '<div class="small warn-text">⚠️ ' + esc(r.warnings.join(' ')) + '</div>' : '') + '</td><td>' +
            ({ new: 'Baru', exists: 'Sudah ada', error: 'Ralat' })[r.status] + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        (cnt('exists') ? '<div class="form"><label>Tiang yang sudah ada<select id="impExisting"><option value="">— pilih —</option>' +
          '<option value="skip">Langkau (jangan ubah)</option><option value="update">Kemas kini CH / Bound / Kategori</option></select></label></div>' : '') +
        '<button class="btn block" data-act="importSave"' + (cnt('new') + cnt('exists') ? '' : ' disabled') + '>Import ' + (cnt('new') + cnt('exists')) + ' baris</button>' +
        '<button class="btn block ghost" data-act="importReset">Batal</button></section>' : '');
    $('importFile').onchange = function (e) {
      var file = e.target.files[0];
      if (!file) return;
      overlay('Membaca fail…');
      loadXlsxLib().then(function (XLSX) {
        return file.arrayBuffer().then(function (buf) { return rowsFromSheet(XLSX, XLSX.read(buf, { type: 'array' })); });
      }).then(function (input) {
        overlay(false);
        return adminCall('importPreview', { rows: input }, 'Menyemak…').then(function (r) { S.imp = { input: input, preview: r.rows }; render(); });
      }).catch(function (err) { overlay(false); alert(err.message); });
    };
  }

  function importSave() {
    var imp = S.imp;
    var onEx = $('impExisting') ? $('impExisting').value : 'skip';
    if ($('impExisting') && !onEx) { toast('Pilih: langkau atau kemas kini tiang yang sudah ada.'); return; }
    if (!confirm('Import sekarang?')) return;
    adminCall('importPoles', { rows: imp.input, onExisting: onEx }, 'Mengimport…', 120000).then(function (r) {
      S.imp = null; S.data.poles = r.poles; SolarDB.set('data', S.data);
      alert('Import selesai: ' + r.added + ' baru, ' + r.updated + ' dikemas kini, ' + r.skipped + ' dilangkau, ' + r.errors + ' ralat (tidak disimpan).');
      go('#/admin');
    });
  }

  function downloadB64(b64, name, mime) {
    var bin = atob(b64); var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([arr], { type: mime }));
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  function exportData() {
    adminCall('exportPoles', {}, 'Menyediakan fail Excel…', 120000).then(function (r) {
      downloadB64(r.b64, r.name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      toast(r.count + ' tiang dieksport');
    });
  }

  // =================================================================
  // Laporan (all roles download; admin generates)
  // =================================================================
  function reportMax(act) { return Math.max(1, Math.floor((S.data.reportMaxPhotos || 60) / L.reportPhotoCount(act))); }

  var REPORT_STATUS = {
    ready: ['✅', 'Sedia', 'ok-text'], choose: ['⚠️', 'Perlu pilih gambar', 'warn-text'],
    short: ['⚠️', 'Kurang gambar', 'err-text'], reported: ['📄', 'Dah dilaporkan', 'muted']
  };

  function renderReports() {
    setChrome('Laporan', '', 'laporan');
    var reps = (S.data.reports || []).map(function (r) {
      var label = r.Activity ? actName(r.Activity) : 'Laporan lama';
      return '<li><div><b>' + esc(label) + '</b> · ' + esc(r.PoleIDs) +
        '<div class="muted small">' + esc(fmtDT(r.CreatedAt)) + ' · ' + esc(nameOf(r.CreatedBy)) + '</div></div>' +
        (has('download_report') ? '<div class="row-btns"><button class="btn small" data-act="download" data-id="' + esc(r.ReportID) + '" data-format="pdf">⬇ PDF</button>' +
          (r.DocxURL ? '<button class="btn small ghost" data-act="download" data-id="' + esc(r.ReportID) + '" data-format="docx">⬇ Word</button>' : '') + '</div>' : '') + '</li>';
    }).join('');
    var gen = has('generate_report') ? reportGenerator() : '';
    $('view').innerHTML = gen + (has('download_report') || reps ? '<section class="card"><h3>Laporan dijana</h3>' +
      (reps ? '<ul class="replist">' + reps + '</ul>' : '<p class="muted">Belum ada laporan.</p>') + '</section>' : '');
    var q = $('rq');
    if (q) q.oninput = function () {
      S.rf.q = q.value;
      var pos = q.selectionStart;
      render();
      var q2 = $('rq'); q2.focus(); try { q2.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
    };
    ['rfrom', 'rto'].forEach(function (id) { var el = $(id); if (el) el.onchange = function () { S.rf[id === 'rfrom' ? 'from' : 'to'] = el.value; render(); }; });
  }

  /** Poles for the chosen activity that have at least one photo of it, with their report status (sorted by chainage). */
  function reportRows(act) {
    var m = merged();
    var server = m.photos.filter(function (x) { return !x._qid; });
    var rf = S.rf;
    var inAct = function (x) { var t = L.typeById(x.PhotoTypeID); return t && t.ActivityID === act && !L.bool(x.Hidden); };
    return L.sortPolesByChainage(m.poles.filter(L.isActive)).map(function (p) {
      var st = L.poleReportStatus(act, p, m.types, server);
      return { pole: p, st: st };
    }).filter(function (r) {
      if (!r.st.hasPhotos) return false;
      if (rf.bound !== 'all' && r.pole.Bound !== rf.bound) return false;
      if (rf.q && !L.poleMatchesQuery(r.pole.PoleID, rf.q)) return false;
      if (r.st.status === 'reported' && !rf.showReported) return false;
      if (rf.from || rf.to) {
        var ok = server.some(function (x) {
          if (x.PoleID !== r.pole.PoleID || !inAct(x)) return false;
          var d = String(x.CapturedAt).slice(0, 10);
          return (!rf.from || d >= rf.from) && (!rf.to || d <= rf.to);
        });
        if (!ok) return false;
      }
      return true;
    });
  }

  function reportGenerator() {
    var m = merged();
    var act = S.rAct || 'A';
    var max = reportMax(act);
    var rf = S.rf;
    var rows = reportRows(act);
    Object.keys(S.reportSel).forEach(function (id) {   // a pole that is no longer Sedia cannot stay ticked
      if (S.reportSel[id] && !rows.some(function (r) { return r.pole.PoleID === id && r.st.ready; })) delete S.reportSel[id];
    });
    var nSel = Object.keys(S.reportSel).filter(function (k) { return S.reportSel[k]; }).length;
    var chip = function (val, label) {
      return '<button class="chip' + (rf.bound === val ? ' on' : '') + '" data-act="rbound" data-val="' + val + '">' + label + '</button>';
    };
    var counts = { ready: 0, choose: 0, short: 0, reported: 0 };
    rows.forEach(function (r) { counts[r.st.status]++; });
    return '<section class="card"><h3>Jana laporan gambar</h3>' +
      '<div class="seg">' + m.acts.map(function (a) {
        return '<button class="seg-btn' + (act === a.ActivityID ? ' on' : '') + '" data-act="ract" data-val="' + a.ActivityID + '">' + esc(a.Name) + '</button>';
      }).join('') + '</div>' +
      '<input id="rq" type="search" placeholder="Cari ID tiang (cth. 34)" value="' + esc(rf.q) + '" autocomplete="off">' +
      '<div class="chips">' + chip('all', 'Semua') + chip('EB', 'EB') + chip('WB', 'WB') + '</div>' +
      '<div class="daterange"><label>Gambar dari<input id="rfrom" type="date" value="' + esc(rf.from) + '"></label>' +
      '<label>hingga<input id="rto" type="date" value="' + esc(rf.to) + '"></label></div>' +
      '<label class="check small"><input type="checkbox" data-act="rshowReported"' + (rf.showReported ? ' checked' : '') + '> Tunjuk yang dah dilaporkan</label>' +
      '<div class="small muted">✅ ' + counts.ready + ' sedia · ⚠️ ' + counts.choose + ' perlu pilih · ⚠️ ' + counts.short + ' kurang' +
      (rf.showReported ? ' · 📄 ' + counts.reported + ' dah dilaporkan' : '') + '</div>' +
      '<div class="row-btns"><button class="btn small ghost" data-act="rselReady">Pilih semua yang sedia</button>' +
      '<button class="btn small ghost" data-act="rselNone">Kosongkan</button></div>' +
      '<div class="muted small">Dipilih: <b id="nSel">' + nSel + '</b> / maksimum ' + max + ' tiang</div>' +
      '<div class="checklist rlist">' + (rows.map(function (r) {
        var s = REPORT_STATUS[r.st.status];
        var detail = r.st.status === 'reported' ? 'RIN ' + r.st.rin + (r.st.ready ? ' · gambar sedia' : '')
          : r.st.status === 'ready' ? '' : L.reportMissing(act, r.pole.PoleID, m.types, m.photos.filter(function (x) { return !x._qid; })).join(', ');
        return '<div class="rrow">' +
          '<input type="checkbox" data-act="rsel" value="' + esc(r.pole.PoleID) + '"' + (S.reportSel[r.pole.PoleID] ? ' checked' : '') + (r.st.ready ? '' : ' disabled') + '>' +
          '<div class="rrow-main"' + (r.st.status === 'choose' && has('select_report_photos') ? ' data-act="rchoose" data-id="' + esc(r.pole.PoleID) + '"' : '') + '>' +
          '<b>' + esc(r.pole.PoleID) + '</b> <span class="small">' + esc(r.pole.Chainage) + ' · ' + esc(r.pole.Bound) + '</span><br>' +
          '<span class="small ' + s[2] + '">' + s[0] + ' ' + s[1] + '</span>' + (detail ? ' <span class="small muted">— ' + esc(detail) + '</span>' : '') +
          (r.st.status === 'choose' && has('select_report_photos') ? ' <span class="small link">Pilih ›</span>' : '') + '</div></div>';
      }).join('') || '<p class="muted center">Tiada tiang dengan gambar ' + esc(actName(act)) + '.</p>') + '</div>' +
      (has('record_rin') ? '<div class="form"><label>No. RIN (pilihan)<input id="rinGen" maxlength="60" placeholder="cth. RIN/TP/012" value="' + esc(S.rinDraft || '') + '"></label></div>' : '') +
      '<button class="btn block" data-act="genReport"' + (nSel ? '' : ' disabled') + '>📄 Jana laporan ' + esc(actName(act)) + ' (PDF + Word)</button>' +
      '<p class="muted small">Hanya tiang <b>Sedia</b> boleh ditanda. Gambar dipilih automatik hanya jika bilangan tepat; jika lebih, pilih dahulu. ' +
      'Hanya halaman gambar — borang RIN ditambah sendiri.</p></section>';
  }

  /** "Perlu pilih gambar": list the photo types of that pole that need a choice. */
  function chooseForReport(poleId) {
    var act = S.rAct || 'A';
    var m = merged();
    var p = poleById(m, poleId);
    var st = L.poleReportStatus(act, p, m.types, m.photos.filter(function (x) { return !x._qid; }));
    S.afterChoose = '#/laporan';
    openSheet('<h3>Pilih gambar · ' + esc(poleId) + '</h3>' + st.choose.map(function (x) {
      return '<button class="btn block ghost" data-act="chooseReport" data-pole="' + esc(poleId) + '" data-type="' + x.type.TypeID + '">' +
        esc(typeName(x.type.TypeID)) + ' — pilih ' + x.need + ' daripada ' + x.good + '</button>';
    }).join('') + '<button class="btn block ghost" data-act="closeSheet">Tutup</button>');
  }

  function generateReport() {
    var act = S.rAct || 'A';
    var ids = Object.keys(S.reportSel).filter(function (k) { return S.reportSel[k]; }).sort();
    var max = reportMax(act);
    if (!ids.length) { toast('Pilih sekurang-kurangnya satu tiang yang Sedia.'); return; }
    if (ids.length > max) { toast('Maksimum ' + max + ' tiang bagi satu laporan ' + actName(act) + '.'); return; }
    var rin = $('rinGen') ? $('rinGen').value.trim() : '';
    var msg = 'Jana laporan ' + actName(act) + ' untuk ' + ids.length + ' tiang' + (rin ? ' dan simpan No. RIN "' + rin + '"' : '') + '?';
    if (!confirm(msg)) return;
    adminCall('reportCheck', { activityId: act, poleIds: ids }, 'Menyemak gambar…').then(function (r) {
      if (r.missing.length) {
        openSheet('<h3>⚠️ Tidak sedia</h3><ul class="warnlist">' + r.missing.map(function (x) {
          return '<li><b>' + esc(x.PoleID) + '</b> — ' + esc(x.missing.join(', ')) + '</li>';
        }).join('') + '</ul><p class="small">Gambar mungkin berubah. Muat semula dan semak semula.</p><button class="btn block ghost" data-act="closeSheet">Tutup</button>');
        refresh(true);
        return;
      }
      return adminCall('generateReport', { activityId: act, poleIds: ids, rin: rin }, 'Menjana laporan… (boleh ambil 1–3 minit, jangan tutup aplikasi)', 360000).then(function (res) {
        S.data.reports = [res.report].concat(S.data.reports || []);
        (res.poles || []).forEach(replacePole);
        S.reportSel = {}; S.rinDraft = '';
        SolarDB.set('data', S.data);
        render();
        toast('📄 Laporan siap (PDF + Word)' + (rin ? ' · RIN disimpan' : ''));
      });
    }, function () { /* message already shown */ });
  }

  function downloadReport(id, format) {
    if (!online()) { toast('Perlu line internet untuk muat turun.'); return; }
    var parts = [];
    var name = 'laporan';
    format = format === 'docx' ? 'docx' : 'pdf';
    function next(offset) {
      return SolarAPI.call('downloadReport', { reportId: id, offset: offset, format: format }, 120000).then(function (r) {
        name = r.name;
        var bin = atob(r.b64);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        parts.push(arr);
        overlay('Memuat turun… ' + Math.round(100 * (r.next || r.size) / r.size) + '%');
        return r.next !== null ? next(r.next) : null;
      });
    }
    overlay('Memuat turun…');
    next(0).then(function () {
      overlay(false);
      var blob = new Blob(parts, { type: format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }, function (err) { overlay(false); alert(err.message); });
  }

  // =================================================================
  // Admin screens
  // =================================================================
  function renderAdminMenu() {
    setChrome('Admin', '', 'admin');
    var item = function (key, href, icon, title, sub, act) {
      if (!has(key)) return '';
      return (act ? '<button class="card menu-item" data-act="' + act + '">' : '<a class="card menu-item" href="' + href + '">') + icon +
        ' <div><b>' + title + '</b><div class="muted small">' + sub + '</div></div>' + (act ? '</button>' : '</a>');
    };
    $('view').innerHTML = '<div class="menu">' +
      item('manage_users', '#/admin/pengguna', '👥', 'Pengguna', 'Tambah / buang Gmail, tetapkan peranan') +
      item('manage_roles', '#/admin/peranan', '🛡️', 'Peranan', 'Cipta peranan dan pilih kebenaran') +
      item('edit_settings', '#/admin/tetapan', '🏷️', 'Tetapan & label', 'Label status, kad dashboard, aktiviti & jenis gambar') +
      item('add_pole', '#/admin/tiang-baru', '➕', 'Tambah tiang', 'ID, CH, bound, kategori') +
      item('import_poles', '#/admin/import', '📥', 'Import tiang', 'Excel / CSV dengan pratonton') +
      item('export_data', '', '📤', 'Eksport data (Excel)', 'Semua tiang, status, tarikh, RIN', 'exportData') +
      item('view_audit_log', '#/admin/log', '🧾', 'Log audit', 'Semua perubahan') +
      '</div>';
  }

  function roleOptions(cur) {
    return (S.data.roles || []).filter(function (r) { return r.Active || L.sameId(r.RoleName, cur); }).map(function (r) {
      return '<option value="' + esc(r.RoleName) + '"' + (L.sameId(r.RoleName, cur) ? ' selected' : '') + '>' + esc(r.RoleName) + (r.Active ? '' : ' (tidak aktif)') + '</option>';
    }).join('');
  }

  function renderUsers() {
    setChrome('Pengguna', '#/admin', 'admin');
    var users = S.data.users || [];
    $('view').innerHTML = '<section class="card"><h3>Tambah pengguna</h3><form id="addUser" class="form">' +
      '<label>Emel Gmail<input name="email" type="email" required autocomplete="off"></label>' +
      '<label>Nama<input name="name" autocomplete="off"></label>' +
      '<label>Peranan<select name="role">' + roleOptions('Team') + '</select></label>' +
      '<button class="btn" type="submit">Tambah</button></form></section>' +
      '<section class="card"><h3>Senarai pengguna</h3>' + users.map(function (u) {
        return '<form class="user-row form" data-email="' + esc(u.Email) + '">' +
          '<div><b>' + esc(u.Email) + '</b></div>' +
          '<label>Nama<input name="name" value="' + esc(u.Name) + '"></label>' +
          '<label>Peranan<select name="role">' + roleOptions(u.Role) + '</select></label>' +
          '<label class="check"><input type="checkbox" name="active"' + (u.Active ? ' checked' : '') + '> Aktif</label>' +
          '<div class="row-btns"><button class="btn small" type="submit">Simpan</button>' +
          '<button class="btn small danger" type="button" data-act="removeUser" data-email="' + esc(u.Email) + '">Buang</button></div></form>';
      }).join('') + '</section>';
    $('addUser').onsubmit = function (ev) {
      ev.preventDefault();
      var f = ev.target;
      adminCall('saveUser', { email: f.email.value, name: f.name.value, role: f.role.value, active: true }).then(function () {
        toast('Pengguna ditambah'); return refresh(true);
      });
    };
    Array.prototype.forEach.call(document.querySelectorAll('.user-row'), function (f) {
      f.onsubmit = function (ev) {
        ev.preventDefault();
        adminCall('saveUser', { email: f.dataset.email, name: f.name.value, role: f.role.value, active: f.active.checked })
          .then(function () { toast('Disimpan'); return refresh(true); });
      };
    });
  }

  function renderRoles() {
    setChrome('Peranan', '#/admin', 'admin');
    var roles = S.data.roles || [];
    var users = S.data.users || [];
    var form = function (r, isNew) {
      var builtIn = r && r.BuiltIn;
      var permsOf = r ? r.Permissions : [];
      var n = r ? users.filter(function (u) { return L.sameId(u.Role, r.RoleName); }).length : 0;
      return '<form class="card form role-form" data-orig="' + esc(r ? r.RoleName : '') + '">' +
        (isNew ? '<h3>➕ Peranan baru</h3>' : '<div class="role-head"><b>' + esc(r.RoleName) + '</b> <span class="muted small">' + n + ' pengguna' +
          (builtIn ? ' · terbina dalam, semua kebenaran' : r.Active ? '' : ' · <span class="err-text">tidak aktif</span>') + '</span></div>') +
        (builtIn ? '' : '<label>Nama peranan<input name="name" maxlength="30" value="' + esc(r ? r.RoleName : '') + '" required></label>') +
        '<div class="perm-grid">' + L.PERMISSIONS.map(function (p) {
          return '<label class="check"><input type="checkbox" name="perm" value="' + p.key + '"' + (builtIn || permsOf.indexOf(p.key) >= 0 ? ' checked' : '') +
            (builtIn ? ' disabled' : '') + '> ' + esc(p.label) + '</label>';
        }).join('') + '</div>' +
        (builtIn ? '' : '<label class="check"><input type="checkbox" name="active"' + (!r || r.Active ? ' checked' : '') + '> Aktif' +
          (n ? ' <span class="muted small">(nyahaktif = ' + n + ' pengguna tidak boleh log masuk)</span>' : '') + '</label>' +
          '<button class="btn small" type="submit">' + (isNew ? 'Cipta peranan' : 'Simpan') + '</button>') + '</form>';
    };
    $('view').innerHTML = roles.map(function (r) { return form(r, false); }).join('') + form(null, true);
    Array.prototype.forEach.call(document.querySelectorAll('.role-form'), function (f) {
      f.onsubmit = function (ev) {
        ev.preventDefault();
        var permsSel = Array.prototype.filter.call(f.querySelectorAll('input[name=perm]'), function (c) { return c.checked; }).map(function (c) { return c.value; });
        if (f.dataset.orig && !f.active.checked && !confirm('Nyahaktif peranan ' + f.dataset.orig + '? Pengguna dengan peranan ini tidak boleh log masuk.')) return;
        adminCall('saveRole', { originalName: f.dataset.orig, name: f.name.value, permissions: permsSel, active: f.active.checked }).then(function (r) {
          S.data.roles = r.roles; SolarDB.set('data', S.data); render(); toast('Peranan disimpan'); refresh(true);
        });
      };
    });
  }

  function counted(name, value, extra) {
    return '<span class="counted"><input name="' + name + '" value="' + esc(value) + '" maxlength="' + L.LABEL_MAX + '" data-count="1"' + (extra || '') + '>' +
      '<span class="cnt">' + String(value).length + '/' + L.LABEL_MAX + '</span></span>';
  }
  function renderNames() {
    setChrome('Tetapan & label', '#/admin', 'admin');
    var acts = L.activities(S.data.activities);
    var types = L.photoTypes(S.data.types);
    var labelsDesc = { BAKI: 'Kad dashboard', NIGHT: 'Status & kad', NOT_STARTED: 'Status', IN_PROGRESS: 'Status', DONE: 'Status', PENDING: 'Status & kategori', INSTALLED: 'Kategori' };
    $('view').innerHTML = '<p class="muted small card">Label disimpan mengikut kunci — menukar label tidak mengubah data atau penapis. Maksimum ' + L.LABEL_MAX + ' aksara.</p>' +
      '<form id="labelsForm" class="card form"><h3>Label status & kad</h3>' + Object.keys(L.LABEL_DEFAULTS).map(function (k) {
        return '<label>' + esc(labelsDesc[k]) + ' <span class="muted small">(asal: ' + esc(L.LABEL_DEFAULTS[k]) + ')</span>' + counted('lab_' + k, lab(k), ' required') + '</label>';
      }).join('') + '<button class="btn" type="submit">Simpan label</button></form>' +
      '<form id="namesForm">' + acts.map(function (a) {
        return '<section class="card form"><div class="muted small">Aktiviti ' + a.ActivityID + '</div>' +
          '<label>Nama aktiviti' + counted('act_' + a.ActivityID, a.Name, ' required') + '</label>' +
          '<label>Spesifikasi (dipaparkan kepada pasukan)<input name="spec_' + a.ActivityID + '" value="' + esc(a.Spec) + '"></label>' +
          L.typesOfActivity(types, a.ActivityID).map(function (t) {
            return '<label>' + t.TypeID + ' <span class="muted small">(min ' + t.MinPhotos + (t.NeedsMeasurement ? ', perlu ukuran' : '') +
              (t.ReportCount > 1 ? ', ' + t.ReportCount + ' dalam laporan' : '') + ')</span>' + counted('type_' + t.TypeID, t.Name, ' required') + '</label>';
          }).join('') + '</section>';
      }).join('') + '<button class="btn block" type="submit">Simpan nama aktiviti & jenis gambar</button></form>';
    Array.prototype.forEach.call(document.querySelectorAll('input[data-count]'), function (i) {
      i.oninput = function () {
        var c = i.parentNode.querySelector('.cnt');
        c.textContent = i.value.length + '/' + L.LABEL_MAX;
        c.classList.toggle('full', i.value.length >= L.LABEL_MAX);
      };
    });
    $('labelsForm').onsubmit = function (ev) {
      ev.preventDefault();
      var f = ev.target, labels = {};
      Object.keys(L.LABEL_DEFAULTS).forEach(function (k) { labels[k] = f['lab_' + k].value; });
      adminCall('saveLabels', { labels: labels }).then(function (r) { S.data.labels = r.labels; SolarDB.set('data', S.data); render(); toast('Label disimpan'); });
    };
    $('namesForm').onsubmit = function (ev) {
      ev.preventDefault();
      var f = ev.target;
      adminCall('saveNames', {
        activities: acts.map(function (a) { return { ActivityID: a.ActivityID, Name: f['act_' + a.ActivityID].value, Spec: f['spec_' + a.ActivityID].value }; }),
        types: types.map(function (t) { return { TypeID: t.TypeID, Name: f['type_' + t.TypeID].value }; })
      }).then(function (r) {
        S.data.activities = r.activities; S.data.types = r.types; SolarDB.set('data', S.data); render(); toast('Disimpan');
      });
    };
  }

  function renderAudit() {
    setChrome('Log audit', '#/admin', 'admin');
    var a = S.audit;
    $('view').innerHTML = '<div class="card"><input id="auditQ" type="search" placeholder="Cari (cth. SL-034, emel, PhotoAdded)" value="' + esc(a.q) + '">' +
      '<div class="muted small">' + a.rows.length + ' / ' + a.total + ' rekod</div></div>' +
      '<div class="card"><table class="audit"><tbody>' + a.rows.map(function (r) {
        return '<tr><td class="small">' + esc(fmtDT(r.Timestamp)) + '<br><span class="muted">' + esc(nameOf(r.UserEmail)) + '</span></td>' +
          '<td><b>' + esc(r.Action) + '</b> ' + esc(r.Entity) + ' ' + esc(r.EntityID) +
          (r.Field ? '<div class="small muted">' + esc(r.Field) + ': ' + esc(r.OldValue) + ' → ' + esc(r.NewValue) + '</div>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      (a.rows.length < a.total ? '<button class="btn block ghost" data-act="auditMore">Muat lagi</button>' : '') + '</div>';
    var q = $('auditQ');
    q.onchange = function () { S.audit = { q: q.value, rows: [], total: 0 }; loadAudit(); };
    if (!a.loaded) loadAudit();
  }

  function loadAudit() {
    var a = S.audit;
    SolarAPI.call('audit', { q: a.q, offset: a.rows.length, limit: 100 }).then(function (r) {
      a.rows = a.rows.concat(r.rows); a.total = r.total; a.loaded = true;
      if (route().a === 'log') render();
    }, function (err) { toast(err.message); });
  }

  // =================================================================
  // Events
  // =================================================================
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]');
    if (!el) return;
    var act = el.dataset.act;
    var d = el.dataset;
    if (act === 'rsel' || act === 'psel' || act === 'msel' || act === 'rshowReported') return; // checkboxes, handled by change
    if (el.tagName === 'A') return;
    ev.preventDefault();
    switch (act) {
      case 'closeSheet': closeSheet(); break;
      case 'filter': S.filters[d.group] = d.val; render(); break;
      case 'rbound': S.rf.bound = d.val; render(); break;
      case 'addPhoto': ev.stopPropagation(); askPhotoSource(d.pole, d.type); break;
      case 'pick': pick(d.mode, d.pole, d.type); break;
      case 'measOk': confirmMeasurement(); break;
      case 'measCancel': if (confirm('Buang gambar ini? Gambar tidak akan disimpan.') && S.measResolve) S.measResolve(null); break;
      case 'chooseReport': ev.stopPropagation(); openChooser(d.pole, d.type); break;
      case 'selTap': chooserTap(d.id); break;
      case 'selSave': saveChooser(false); break;
      case 'selAuto': saveChooser(true); break;
      case 'jtab': S.jtab = d.val; render(); break;
      case 'planClear': S.planSel = {}; render(); break;
      case 'planOpen': openPlanSheet(); break;
      case 'planSave': savePlans(); break;
      case 'planEdit': editPlanSheet(d.id); break;
      case 'planEditSave': {
        var date = $('planDate').value;
        if (!L.isIsoDate(date)) { toast('Pilih tarikh.'); break; }
        adminCall('editPlan', { planId: d.id, date: date, activityId: $('planAct').value }).then(function (r) {
          S.data.plans = r.plans; SolarDB.set('data', S.data); closeSheet(); render(); toast('Pelan dikemas kini');
        });
        break;
      }
      case 'planRemove':
        if (confirm('Buang pelan ini?')) {
          adminCall('removePlan', { planId: d.id }).then(function (r) {
            S.data.plans = r.plans; SolarDB.set('data', S.data); closeSheet(); render(); toast('Pelan dibuang');
          });
        }
        break;
      case 'ract': S.rAct = d.val; render(); break;
      case 'rselReady': {
        var act = S.rAct || 'A', max = reportMax(act), n = 0;
        S.reportSel = {};
        reportRows(act).forEach(function (r) { if (r.st.ready && n < max) { S.reportSel[r.pole.PoleID] = true; n++; } });
        render();
        break;
      }
      case 'rselNone': S.reportSel = {}; render(); break;
      case 'rchoose': chooseForReport(d.id); break;
      case 'reportFromSchedule': {
        var picked = Object.keys(S.planSel).filter(function (k) { return S.planSel[k]; });
        var ra = S.rAct || 'A';
        S.reportSel = {};
        S.rf = { bound: 'all', q: '', from: '', to: '', showReported: true };
        var rr = reportRows(ra);
        picked.forEach(function (id) { if (rr.some(function (r) { return r.pole.PoleID === id && r.st.ready; })) S.reportSel[id] = true; });
        S.planSel = {};
        toast(Object.keys(S.reportSel).length + ' daripada ' + picked.length + ' tiang sedia untuk ' + actName(ra));
        go('#/laporan');
        break;
      }
      case 'photoDelete': deletePhotoDialog(d.id); break;
      case 'photoDeleteYes':
        adminCall('deletePhoto', { photoId: d.id }).then(function (r) {
          S.data.photos = S.data.photos.filter(function (x) { return x.PhotoID !== r.deleted; });
          apiDone(r, 'Gambar dipadam (dalam Trash Drive)');
        });
        break;
      case 'measEdit': measEditDialog(d.id); break;
      case 'measEditSave': measEditSave(d.id); break;
      case 'moveOne': {
        var ph = S.data.photos.filter(function (x) { return x.PhotoID === d.id; })[0];
        if (ph) moveDialog(ph.PoleID, [d.id]);
        break;
      }
      case 'moveOpen': moveDialog(d.id, []); break;
      case 'moveSave': moveSave(); break;
      case 'swapOpen': swapDialog(d.id); break;
      case 'swapSave': swapSave(d.id); break;
      case 'overrideOpen': overrideDialog(d.id); break;
      case 'overrideSave':
        adminCall('overrideStatus', { poleId: d.id, status: $('ovStatus').value, actualDate: $('ovDate').value }).then(function (r) { apiDone(r, 'Status disimpan'); });
        break;
      case 'rinEdit': rinDialog(d.pole, d.actId); break;
      case 'rinSave':
        adminCall('setRin', { poleId: d.pole, activityId: d.actId, rin: $('rinIn').value }).then(function (r) { apiDone(r, 'No. RIN disimpan'); });
        break;
      case 'poleActive':
        if (d.val === '1' || confirm('Nyahaktif ' + d.id + '? Tiang disembunyikan dari senarai dan jumlah; data disimpan.')) {
          adminCall('setPoleActive', { poleId: d.id, active: d.val === '1' }).then(function (r) { apiDone(r, d.val === '1' ? 'Tiang diaktifkan semula' : 'Tiang dinyahaktif'); });
        }
        break;
      case 'poleDelete': poleDeleteDialog(d.id); break;
      case 'poleDeleteYes':
        adminCall('deletePole', { poleId: d.id, confirmId: $('delConfirm').value }).then(function () {
          S.data.poles = S.data.poles.filter(function (x) { return x.PoleID !== d.id; });
          SolarDB.set('data', S.data); closeSheet(); toast('Tiang ' + d.id + ' dipadam'); go('#/jadual'); refresh(true);
        });
        break;
      case 'exportData': exportData(); break;
      case 'importTemplate':
        downloadB64(btoa('Pole ID,CH,Bound,Category\r\nSSL124,CH.41450,EB,Perlu pasang\r\n'), 'templat_import_tiang.csv', 'text/csv');
        break;
      case 'importSave': importSave(); break;
      case 'importReset': S.imp = null; render(); break;
      case 'viewPhoto': ev.stopPropagation(); viewPhoto(d.id); break;
      case 'addNote': addNote(d.id); break;
      case 'done': setDone(d.id, d.val === '1'); break;
      case 'flag': flagPhoto(d.id, d.field, d.val === '1'); break;
      case 'genReport': generateReport(); break;
      case 'download': downloadReport(d.id, d.format); break;
      case 'removeUser':
        if (confirm('Buang ' + d.email + '? Pengguna ini tidak boleh log masuk lagi.')) {
          adminCall('removeUser', { email: d.email }).then(function () { toast('Dibuang'); return refresh(true); });
        }
        break;
      case 'auditMore': loadAudit(); break;
      case 'relogin':
        SolarAPI.setSession(null).then(function () { showNeedLogin(false); go('#/login'); });
        break;
      case 'reload': location.reload(); break;
      case 'qkick': closeSheet(); SolarSync.kick(); break;
      case 'qretry': SolarSync.retryFailed(Number(d.id)).then(loadQueue).then(function () { closeSheet(); render(); }); break;
      case 'qsave': saveQueuedPhoto(Number(d.id)); break;
      case 'qdiscard':
        if (confirm('Buang item ini dari telefon? Ia TIDAK akan dihantar. (Simpan gambar ke telefon dahulu jika perlu.)')) {
          SolarSync.discard(Number(d.id)).then(loadQueue).then(function () { openSyncSheet(); render(); });
        }
        break;
    }
  });

  document.addEventListener('change', function (ev) {
    var el = ev.target;
    if (el.dataset && el.dataset.act === 'psel') {
      S.planSel[el.value] = el.checked;
      var bar = document.querySelector('.planbar');
      var cnt = selCount();
      if (bar) {
        bar.classList.toggle('show', cnt > 0);
        bar.querySelector('span').textContent = cnt + ' tiang dipilih';
        Array.prototype.forEach.call(bar.querySelectorAll('[data-act=planOpen],[data-act=reportFromSchedule]'), function (b) { b.disabled = !cnt; });
      }
    }
    if (el.dataset && el.dataset.act === 'msel') S.moveSel[el.value] = el.checked;
    if (el.dataset && el.dataset.act === 'rshowReported') { S.rf.showReported = el.checked; render(); }
    if (el.id === 'rinGen') S.rinDraft = el.value;
    if (el.dataset && el.dataset.act === 'rsel') {
      S.reportSel[el.value] = el.checked;
      var n = Object.keys(S.reportSel).filter(function (k) { return S.reportSel[k]; }).length;
      var max = reportMax(S.rAct || 'A');
      if (n > max) { el.checked = false; S.reportSel[el.value] = false; n--; toast('Maksimum ' + max + ' tiang.'); }
      var c = $('nSel'); if (c) c.textContent = n;
      var g = document.querySelector('[data-act=genReport]'); if (g) g.disabled = !n;
    }
  });

  function saveQueuedPhoto(id) {
    var it = S.queue.filter(function (i) { return i.id === id; })[0];
    if (!it || !it.image) return;
    var url = URL.createObjectURL(new Blob([it.image], { type: 'image/jpeg' }));
    var a = document.createElement('a');
    a.href = url; a.download = it.payload.poleId + '_' + it.payload.typeId + '_' + it.payload.photoId + '.jpg';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  $('syncBtn').onclick = openSyncSheet;
  $('backBtn').onclick = function () { go($('backBtn').dataset.back || '#/dashboard'); };
  $('inCamera').addEventListener('change', onFileChosen);
  $('inGallery').addEventListener('change', onFileChosen);
  window.addEventListener('hashchange', function () { if ((location.hash || '').indexOf('#login') === 0) return; render(); });
  window.addEventListener('online', function () { showBanner(); refresh(true); });
  window.addEventListener('offline', showBanner);
  window.addEventListener('unhandledrejection', function (e) { if (e.reason && e.reason.shown) e.preventDefault(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && online()) { SolarSync.kick(); refresh(true); }
  });

  var refreshAfterDrain = false;
  SolarSync.on(function (evt) {
    if (evt.type === 'sent') { applySent(evt.item, evt.result); refreshAfterDrain = true; }
    if (evt.type === 'needLogin') { showNeedLogin(evt.value); }
    loadQueue().then(function () {
      if (evt.type === 'sent' || evt.type === 'failed') render();
      if (evt.type === 'drained' && refreshAfterDrain) { refreshAfterDrain = false; refresh(true); }
    });
  });

  setInterval(function () { if (online() && document.visibilityState === 'visible') { SolarSync.kick(); refresh(true); } }, 120000);

  // =================================================================
  // Start
  // =================================================================
  function start() {
    var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (secure && navigator.serviceWorker) {
      {
        navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW', e); });
        var hadController = !!navigator.serviceWorker.controller;
        navigator.serviceWorker.addEventListener('controllerchange', function () {
          if (hadController) toast('Versi baru aplikasi dipasang. Tutup & buka semula aplikasi untuk guna versi baru.', 6000);
        });
      }
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { /* ignore */ });
    var justLoggedIn = false;
    handleLoginHash().then(function (li) { justLoggedIn = li; return SolarAPI.loadSession(); })
      .then(loadQueue)
      .then(function () { return SolarDB.get('data'); })
      .then(function (cached) {
        if (cached) S.data = cached;
        if (!SolarAPI.hasSession()) { render(); return; }
        if (!location.hash || location.hash === '#/login') history.replaceState(null, '', location.pathname + location.search + '#/dashboard');
        render();
        if (justLoggedIn) { showNeedLogin(false); SolarSync.loggedIn(); }
        return refresh().then(function () { SolarSync.kick(); });
      });
  }

  // test hooks (used by automated tests only)
  window.__solarTest = { merged: merged, refresh: refresh, loadQueue: loadQueue, render: render };
  start();
})();
