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
    reportFilter: { bound: 'all', cat: 'all' },
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
  function role() { return S.data && S.data.user ? S.data.user.role : ''; }
  function isAdmin() { return role() === 'Admin'; }
  function allowed(action, pole) { return !L.denyReason(role(), action, pole); }
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
  function openSheet(html) {
    var s = $('sheet');
    s.innerHTML = '<div class="sheet-backdrop" data-act="closeSheet"></div><div class="sheet-body">' + html + '</div>';
    s.hidden = false;
  }
  function closeSheet() { $('sheet').hidden = true; $('sheet').innerHTML = ''; }

  function workBadge(ws) {
    var cls = { 'Siap': 'b-done', 'Dalam proses': 'b-prog', 'Belum mula': 'b-none', 'Tunggu kelulusan': 'b-wait' }[ws] || '';
    return '<span class="badge ' + cls + '">' + esc(ws) + '</span>';
  }
  function photoBadge(ps) {
    if (!ps.required) return '<span class="badge b-na">' + esc(ps.label) + '</span>';
    return '<span class="badge ' + (ps.complete ? 'b-done' : 'b-part') + '">📷 ' + esc(ps.complete ? 'Lengkap' : ps.done + '/' + ps.total) + '</span>';
  }
  function chBadge(p) { return L.bool(p.ChainageExact) ? '' : '<span class="badge b-warn">CH belum tepat</span>'; }

  // =================================================================
  // Merged view = server data + things still waiting in the offline queue
  // =================================================================
  function merged() {
    var d = S.data || { poles: [], photos: [], notes: [], slots: [] };
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
          PhotoID: p.photoId, PoleID: p.poleId, SlotID: p.slotId, Source: p.source, CapturedAt: p.capturedAt,
          UploadedAt: '', Latitude: p.latitude, Longitude: p.longitude, AccuracyM: p.accuracy === '' ? '' : Math.round(p.accuracy),
          GPSAvailable: p.gpsAvailable, TakenBy: me, Hidden: false, RetakeFlag: false, SelectedForReport: false,
          _pending: it.status === 'pending', _failed: it.status === 'failed', _qid: it.id,
          // a failed upload must not count toward status
          _excluded: it.status === 'failed'
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
    return { poles: poles, photos: photos, statusPhotos: statusPhotos, notes: notes, slots: d.slots };
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
        var what = it.kind === 'photo' ? '📷 Gambar ' + esc(p.poleId) + ' · ' + esc(slotName(p.slotId))
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

  function slotName(id) {
    var s = (S.data ? S.data.slots : []).filter(function (x) { return x.SlotID === id; })[0];
    return s ? s.Name : id;
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
    adminTab.hidden = !isAdmin();
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
        if (r.a) { S.filters.status = r.a; S.filters.bound = 'all'; S.filters.q = ''; history.replaceState(null, '', '#/jadual'); render._last = '#/jadual'; }
        renderJadual(); break;
      case 'tiang': r.b === 'edit' ? renderPoleEdit(r.a) : renderPole(r.a); break;
      case 'laporan': renderReports(); break;
      case 'admin':
        if (!isAdmin()) { go('#/dashboard'); return; }
        if (r.a === 'pengguna') renderUsers();
        else if (r.a === 'slot') renderSlots();
        else if (r.a === 'log') renderAudit();
        else renderAdminMenu();
        break;
      default: renderDashboard();
    }
    if (same) window.scrollTo(0, y); else window.scrollTo(0, 0);
  }

  // =================================================================
  // Screen 1 — Dashboard
  // =================================================================
  function renderDashboard() {
    setChrome('Dashboard', '', 'dashboard');
    var m = merged();
    var d = L.dashboard(m.poles, m.slots, m.statusPhotos);
    function card(label, val, sub, href) {
      return '<a class="stat" href="' + href + '"><div class="stat-val">' + val + '</div><div class="stat-label">' + label + '</div>' +
        (sub ? '<div class="stat-sub">' + sub + '</div>' : '') + '</a>';
    }
    function bar(b) {
      var x = d.bound[b] || { total: 0, done: 0 };
      var pct = x.total ? Math.round(100 * x.done / x.total) : 0;
      return '<div class="bound"><div class="bound-head"><b>' + b + '</b><span>' + x.done + ' / ' + x.total + ' siap (' + pct + '%)</span></div>' +
        '<div class="bar"><div style="width:' + pct + '%"></div></div></div>';
    }
    var incomplete = d.incomplete.map(function (x) {
      return '<li><a href="#/tiang/' + esc(x.PoleID) + '"><b>' + esc(x.PoleID) + '</b> · ' + x.done + '/' + x.total +
        '<div class="muted small">Kurang: ' + esc(x.missing.join(', ')) + '</div></a></li>';
    }).join('');
    var feed = (S.data.feed || []).map(function (f) {
      return '<li><span class="muted small">' + esc(fmtDT(f.Timestamp)) + '</span><br><b>' + esc(f.Name) + '</b> ' + feedText(f) + '</li>';
    }).join('');
    $('view').innerHTML =
      '<section class="stats">' +
      card('Kerja siap', d.done + '<small>/' + d.total + '</small>', '', '#/jadual/Siap') +
      card('Gambar lengkap', d.photoComplete + '<small>/' + d.photoRequired + '</small>', 'tiang perlu gambar', '#/jadual/Perlu pasang') +
      card('Perlu pasang', d.todo, '', '#/jadual/Perlu pasang') +
      card('Tunggu kelulusan', d.pending, '', '#/jadual/Tunggu kelulusan') +
      card('Dalam proses', d.inProgress, '', '#/jadual/Dalam proses') +
      card('Belum mula', d.notStarted, '', '#/jadual/Belum mula') +
      '</section>' +
      '<section class="card"><h3>Kemajuan mengikut bound</h3>' + bar('EB') + bar('WB') + '</section>' +
      '<a class="btn block" href="#/jadual">📋 Buka jadual kerja</a>' +
      listBlock('Gambar belum lengkap', d.incomplete.length, '<ul class="plist">' + incomplete + '</ul>') +
      listBlock('Ditanda "Ambil semula"', d.retake.length, poleLinks(d.retake)) +
      listBlock('CH belum tepat', d.chInexact.length, poleLinks(d.chInexact)) +
      '<section class="card"><h3>Aktiviti terkini</h3>' + (feed ? '<ul class="feed">' + feed + '</ul>' : '<p class="muted">Tiada aktiviti lagi.</p>') + '</section>';
  }

  function listBlock(title, n, inner) {
    return '<details class="card"' + (n && n <= 8 ? ' open' : '') + '><summary><b>' + esc(title) + '</b> <span class="count">' + n + '</span></summary>' +
      (n ? inner : '<p class="muted">Tiada.</p>') + '</details>';
  }
  function poleLinks(ids) {
    return '<div class="chips">' + ids.map(function (id) { return '<a class="chip" href="#/tiang/' + esc(id) + '">' + esc(id) + '</a>'; }).join('') + '</div>';
  }

  function feedText(f) {
    var id = '<a href="#/tiang/' + esc(String(f.NewValue || f.EntityID).split('/')[0]) + '">';
    switch (f.Action) {
      case 'PhotoAdded': {
        var pv = String(f.NewValue || '');
        var pole = pv.split('/')[0];
        var slot = (pv.split('/')[1] || '').split(' ')[0];
        return 'menambah gambar <a href="#/tiang/' + esc(pole) + '">' + esc(pole) + '</a> · ' + esc(slotName(slot));
      }
      case 'NoteAdded': return 'menulis nota ' + id + esc(f.NewValue) + '</a>';
      case 'MarkedDone': return 'menanda siap <a href="#/tiang/' + esc(f.EntityID) + '">' + esc(f.EntityID) + '</a>';
      case 'DoneCancelled': return 'membatalkan siap <a href="#/tiang/' + esc(f.EntityID) + '">' + esc(f.EntityID) + '</a>';
      case 'CategoryChanged': return 'menukar kategori <a href="#/tiang/' + esc(f.EntityID) + '">' + esc(f.EntityID) + '</a>: ' + esc(f.OldValue) + ' → ' + esc(f.NewValue);
      case 'PoleEdited': return 'mengemas kini ' + esc(f.Field) + ' <a href="#/tiang/' + esc(f.EntityID) + '">' + esc(f.EntityID) + '</a>';
      case 'RetakeFlagged': return 'menanda gambar "Ambil semula"';
      case 'RetakeCleared': return 'membuang tanda "Ambil semula"';
      case 'ReportGenerated': return 'menjana laporan PDF (' + esc(f.NewValue) + ')';
      default: return esc(f.Action);
    }
  }

  // =================================================================
  // Screen 2 — Jadual kerja
  // =================================================================
  function renderJadual() {
    setChrome('Jadual kerja', '', 'jadual');
    var m = merged();
    var f = S.filters;
    var rows = L.sortPolesByChainage(m.poles).filter(function (p) {
      if (f.bound !== 'all' && p.Bound !== f.bound) return false;
      if (f.q && p.PoleID.toLowerCase().indexOf(f.q.toLowerCase()) < 0) return false;
      var ws = L.workStatus(p, m.statusPhotos);
      if (f.status === 'Perlu pasang' && p.Category !== L.CATEGORY.TODO) return false;
      if (f.status === 'Dalam proses' && ws !== L.WORK.IN_PROGRESS) return false;
      if (f.status === 'Siap' && ws !== L.WORK.DONE) return false;
      if (f.status === 'Belum mula' && ws !== L.WORK.NOT_STARTED) return false;
      if (f.status === 'Tunggu kelulusan' && p.Category !== L.CATEGORY.PENDING) return false;
      return true;
    });
    function chip(group, val, label) {
      return '<button class="chip' + (f[group] === val ? ' on' : '') + '" data-act="filter" data-group="' + group + '" data-val="' + esc(val) + '">' + esc(label) + '</button>';
    }
    var list = rows.map(function (p) {
      var ws = L.workStatus(p, m.statusPhotos);
      var ps = L.photoStatus(p, m.slots, m.statusPhotos);
      return '<a class="prow" href="#/tiang/' + esc(p.PoleID) + '">' +
        '<div class="prow-main"><b>' + esc(p.PoleID) + '</b> <span class="muted">· ' + esc(p.Bound) + '</span>' +
        '<div class="small">' + esc(p.Chainage) + (p.PlannedDate ? ' · 📅 ' + esc(fmtDate(p.PlannedDate)) : '') + '</div></div>' +
        '<div class="prow-badges">' + workBadge(ws) + photoBadge(ps) + chBadge(p) + '</div></a>';
    }).join('');
    $('view').innerHTML =
      '<div class="filters card">' +
      '<input id="search" type="search" placeholder="Cari ID tiang (cth. SL-034)" value="' + esc(f.q) + '" autocomplete="off">' +
      '<div class="chips">' + chip('bound', 'all', 'Semua') + chip('bound', 'EB', 'EB') + chip('bound', 'WB', 'WB') + '</div>' +
      '<div class="chips">' + chip('status', 'all', 'Semua status') + chip('status', 'Perlu pasang', 'Perlu pasang') +
      chip('status', 'Dalam proses', 'Dalam proses') + chip('status', 'Siap', 'Siap') + chip('status', 'Tunggu kelulusan', 'Tunggu kelulusan') + (f.status === 'Belum mula' ? chip('status', 'Belum mula', 'Belum mula') : '') + '</div>' +
      '<div class="muted small">' + rows.length + ' tiang · disusun ikut chainage</div></div>' +
      '<div class="plist2">' + (list || '<p class="muted center">Tiada tiang.</p>') + '</div>';
    var s = $('search');
    s.oninput = function () {
      S.filters.q = s.value;
      var pos = s.selectionStart;
      renderJadual();
      var s2 = $('search'); s2.focus(); try { s2.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
    };
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
    var ps = L.photoStatus(p, m.slots, m.statusPhotos);
    var canPhoto = allowed('uploadPhoto', p);
    var canNote = allowed('addNote', p);
    var canDone = allowed('setDone', p);
    if (canPhoto) S.gps.start();
    var slots = L.activeSlots(m.slots);
    var photosOfPole = m.photos.filter(function (x) { return x.PoleID === p.PoleID && (isAdmin() || !L.bool(x.Hidden)); });
    var activeIds = slots.map(function (s) { return s.SlotID; });

    var tiles = slots.map(function (s) { return slotTile(p, s, photosOfPole, m, canPhoto); }).join('');
    var orphan = photosOfPole.filter(function (x) { return activeIds.indexOf(x.SlotID) < 0; });
    var orphanHtml = orphan.length ? '<section class="card"><h3>Gambar dalam slot tidak aktif</h3><div class="thumbs">' +
      orphan.map(function (x) { return thumbHtml(x, false); }).join('') + '</div></section>' : '';

    var notes = m.notes.filter(function (n) { return n.PoleID === p.PoleID; })
      .sort(function (a, b) { return String(a.CreatedAt) < String(b.CreatedAt) ? 1 : -1; });
    var notesHtml = notes.map(function (n) {
      return '<li><div class="note-text">' + esc(n.Text).replace(/\n/g, '<br>') + '</div><div class="muted small">' +
        esc(nameOf(n.CreatedBy)) + ' · ' + esc(fmtDT(n.CreatedAt)) + (n._pending ? ' · ⏳ menunggu line' : '') + (n._failed ? ' · ⚠️ gagal' : '') + '</div></li>';
    }).join('');
    var draft = '';
    try { draft = localStorage.getItem('solar.draft.' + p.PoleID) || ''; } catch (e) { /* ignore */ }

    var doneBtn = '';
    if (canDone) {
      doneBtn = L.bool(p.IsDone)
        ? '<button class="btn block ghost" data-act="done" data-id="' + esc(p.PoleID) + '" data-val="0">↩ Batal siap</button>'
        : '<button class="btn block success" data-act="done" data-id="' + esc(p.PoleID) + '" data-val="1">✔ Tanda kerja siap</button>';
    }
    var catNote = p.Category === L.CATEGORY.PENDING ? '<div class="info-box">Tiang ini <b>Tunggu kelulusan</b>. Gambar dan status Siap dibuka selepas admin menukar kategori kepada Perlu pasang.</div>'
      : p.Category === L.CATEGORY.INSTALLED ? '<div class="info-box">Tiang ini <b>Sudah dipasang</b>. Gambar tidak diwajibkan (boleh ditambah jika perlu).</div>' : '';

    $('view').innerHTML =
      '<section class="card pole-head">' +
      '<div class="pole-title"><h2>' + esc(p.PoleID) + '</h2>' + (isAdmin() ? '<a class="btn small ghost" href="#/tiang/' + esc(p.PoleID) + '/edit">✏️ Edit tiang</a>' : '') + '</div>' +
      '<div>' + esc(p.Chainage) + ' · <b>' + esc(p.Bound) + '</b> ' + chBadge(p) + '</div>' +
      '<div class="muted small">Kategori: ' + esc(p.Category) + (p.PlannedDate ? ' · Tarikh rancang: ' + esc(fmtDate(p.PlannedDate)) : '') + '</div>' +
      '<div class="badges">' + workBadge(ws) + (p._donePending ? '<span class="badge b-wait">⏳</span>' : '') + ' ' +
      '<span class="badge ' + (ps.required ? (ps.complete ? 'b-done' : 'b-part') : 'b-na') + '">' + esc(ps.required ? ps.label : 'Gambar: ' + ps.label) + '</span></div>' +
      (L.bool(p.IsDone) && p.DoneBy && p.Category === L.CATEGORY.TODO ? '<div class="muted small">Siap oleh ' + esc(nameOf(p.DoneBy)) + ' · ' + esc(fmtDT(p.DoneAt)) + '</div>' : '') +
      '</section>' + catNote +
      '<section class="slots">' + tiles + '</section>' + orphanHtml +
      doneBtn +
      '<section class="card"><h3>Nota</h3>' +
      (canNote ? '<textarea id="noteText" rows="3" placeholder="Cth. lokasi dianjak 5 m ke arah KL kerana paip">' + esc(draft) + '</textarea>' +
        '<button class="btn" data-act="addNote" data-id="' + esc(p.PoleID) + '">Tambah nota</button>' : '') +
      (notesHtml ? '<ul class="notes">' + notesHtml + '</ul>' : '<p class="muted">Tiada nota.</p>') + '</section>';

    var ta = $('noteText');
    if (ta) ta.oninput = function () { try { localStorage.setItem('solar.draft.' + p.PoleID, ta.value); } catch (e) { /* ignore */ } };
    loadThumbs(p.PoleID, photosOfPole);
  }

  function slotTile(p, s, photosOfPole, m, canPhoto) {
    var inSlot = photosOfPole.filter(function (x) { return x.SlotID === s.SlotID; })
      .sort(function (a, b) { return String(a.CapturedAt) < String(b.CapturedAt) ? 1 : -1; });
    var st = L.slotState(p.PoleID, s.SlotID, m.statusPhotos);
    var visibleCount = inSlot.filter(function (x) { return !L.bool(x.Hidden) && !x._failed; }).length;
    var icon = st.state === 'ok' ? '✅' : st.state === 'retake' ? '🔁' : '📷';
    var latest = inSlot.filter(function (x) { return !L.bool(x.Hidden); })[0];
    var cls = 'tile ' + (st.state === 'ok' ? 'filled' : st.state === 'retake' ? 'retake' : 'empty');
    var head = '<div class="tile-head"><span class="tile-icon">' + icon + '</span><div><b>' + s.Order + '. ' + esc(s.Name) + '</b>' +
      (s.Spec ? '<div class="muted small">' + esc(s.Spec) + '</div>' : '') + '</div></div>';
    var body = '';
    if (inSlot.length) {
      body += '<div class="thumbs">' + inSlot.map(function (x) { return thumbHtml(x, isAdmin() && visibleCount > 1); }).join('') + '</div>';
      if (latest) body += '<div class="muted small">' + esc(nameOf(latest.TakenBy)) + ' · ' + esc(fmtDT(latest.CapturedAt)) +
        (latest.Source === 'Gallery' ? ' · galeri' : '') + '</div>';
      if (st.state === 'retake') body += '<div class="err small">Ambil semula</div>';
    } else {
      body += '<div class="muted small">Belum ada gambar</div>';
    }
    var btn = canPhoto ? '<button class="btn small' + (inSlot.length ? ' ghost' : '') + '" data-act="addPhoto" data-pole="' + esc(p.PoleID) +
      '" data-slot="' + esc(s.SlotID) + '">' + (inSlot.length ? '+ Tambah gambar' : '📷 Ambil gambar') + '</button>' : '';
    return '<div class="' + cls + '" ' + (canPhoto && !inSlot.length ? 'data-act="addPhoto" data-pole="' + esc(p.PoleID) + '" data-slot="' + esc(s.SlotID) + '"' : '') + '>' +
      head + body + btn + '</div>';
  }

  function thumbHtml(x, showSelect) {
    var src = x._qid ? queueThumbUrl(x._qid) : S.thumbUrls[x.PhotoID];
    var badges = '';
    if (x.Source === 'Gallery') badges += '<span class="tb">galeri</span>';
    if (x._pending) badges += '<span class="tb wait">⏳</span>';
    if (x._failed) badges += '<span class="tb bad">⚠️ gagal</span>';
    if (L.bool(x.RetakeFlag)) badges += '<span class="tb bad">Ambil semula</span>';
    if (L.bool(x.SelectedForReport)) badges += '<span class="tb sel">★ laporan</span>';
    if (L.bool(x.Hidden)) badges += '<span class="tb hid">tersembunyi</span>';
    return '<button class="thumb' + (L.bool(x.Hidden) ? ' hidden-photo' : '') + '" data-act="viewPhoto" data-id="' + esc(x.PhotoID) + '">' +
      (src ? '<img src="' + esc(src) + '" alt="">' : '<span class="ph">🖼️</span>') + '<span class="tbs">' + badges + '</span></button>';
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
  function askPhotoSource(poleId, slotId) {
    openSheet('<h3>' + esc(poleId) + ' · ' + esc(slotName(slotId)) + '</h3>' +
      '<button class="btn block big" data-act="pick" data-mode="camera" data-pole="' + esc(poleId) + '" data-slot="' + esc(slotId) + '">📷 Kamera</button>' +
      '<button class="btn block big ghost" data-act="pick" data-mode="gallery" data-pole="' + esc(poleId) + '" data-slot="' + esc(slotId) + '">🖼️ Galeri</button>' +
      '<button class="btn block ghost" data-act="closeSheet">Batal</button>');
  }

  function pick(mode, poleId, slotId) {
    S.capture = { poleId: poleId, slotId: slotId, source: mode === 'camera' ? 'Camera' : 'Gallery' };
    S.gps.start();
    var inp = mode === 'camera' ? $('inCamera') : $('inGallery');
    inp.value = '';
    inp.click(); // must stay inside the tap handler (iPhone)
    closeSheet();
  }

  function onFileChosen(e) {
    var file = e.target.files && e.target.files[0];
    var cap = S.capture;
    e.target.value = '';
    if (!file || !cap) return;
    var now = new Date();
    overlay('Memproses gambar…');
    W.process(file, {
      source: cap.source, now: now,
      getDeviceGps: function () { overlay('Mendapatkan lokasi GPS… (maksimum 15 saat)'); return S.gps.getFix(15000, 30000); }
    }).then(function (res) {
      overlay('Menyimpan…');
      return Promise.all([SolarSync.blobToBuf(res.full), SolarSync.blobToBuf(res.thumb)]).then(function (bufs) {
        var m = res.meta;
        return SolarSync.add({
          kind: 'photo',
          payload: { photoId: SolarSync.uid(), poleId: cap.poleId, slotId: cap.slotId, source: m.source, capturedAt: m.capturedAt,
            latitude: m.latitude, longitude: m.longitude, accuracy: m.accuracy, gpsAvailable: m.gpsAvailable },
          image: bufs[0], thumb: bufs[1]
        }).then(function () { return m; });
      });
    }).then(function (m) {
      overlay(false);
      return loadQueue().then(function () {
        render();
        toast('✅ Gambar disimpan' + (m.gpsAvailable ? '' : ' (GPS tidak tersedia)') + (online() ? '' : ' — akan dihantar bila ada line'));
      });
    }).catch(function (err) {
      overlay(false);
      alert('Gambar tidak dapat diproses: ' + err.message);
    });
  }

  // ---------------- photo viewer ----------------
  function viewPhoto(photoId) {
    var m = merged();
    var x = m.photos.filter(function (p) { return p.PhotoID === photoId; })[0];
    if (!x) return;
    var p = poleById(m, x.PoleID);
    var inSlot = m.photos.filter(function (o) { return o.PoleID === x.PoleID && o.SlotID === x.SlotID && !L.bool(o.Hidden) && !o._qid; });
    var gps = L.bool(x.GPSAvailable) && x.Latitude !== ''
      ? Number(x.Latitude).toFixed(5) + ', ' + Number(x.Longitude).toFixed(5) + (x.AccuracyM !== '' ? ' (±' + x.AccuracyM + ' m)' : '') +
        ' · <a target="_blank" rel="noopener" href="https://maps.google.com/?q=' + Number(x.Latitude) + ',' + Number(x.Longitude) + '">Peta</a>'
      : 'GPS tidak tersedia';
    var adminBtns = '';
    if (isAdmin() && !x._qid) {
      adminBtns = '<div class="row-btns">' +
        '<button class="btn small ' + (L.bool(x.RetakeFlag) ? '' : 'warnbtn') + '" data-act="flag" data-id="' + esc(x.PhotoID) + '" data-field="RetakeFlag" data-val="' + (L.bool(x.RetakeFlag) ? 0 : 1) + '">' +
        (L.bool(x.RetakeFlag) ? 'Buang tanda Ambil semula' : '🔁 Ambil semula') + '</button>' +
        '<button class="btn small ghost" data-act="flag" data-id="' + esc(x.PhotoID) + '" data-field="Hidden" data-val="' + (L.bool(x.Hidden) ? 0 : 1) + '">' +
        (L.bool(x.Hidden) ? '👁 Tunjuk semula' : '🚫 Sembunyikan') + '</button>' +
        (inSlot.length > 1 && !L.bool(x.Hidden) ? '<button class="btn small ghost" data-act="select" data-id="' + esc(x.PhotoID) + '" data-val="' + (L.bool(x.SelectedForReport) ? 0 : 1) + '">' +
          (L.bool(x.SelectedForReport) ? '☆ Batal pilihan laporan' : '★ Pilih untuk laporan') + '</button>' : '') +
        '</div>';
    }
    openSheet('<div class="viewer"><div id="fullImg" class="full-img"><div class="spinner"></div></div>' +
      '<table class="kv">' +
      '<tr><th>Tiang</th><td>' + esc(x.PoleID) + (p ? ' · ' + esc(p.Chainage) + ' · ' + esc(p.Bound) : '') + '</td></tr>' +
      '<tr><th>Slot</th><td>' + esc(slotName(x.SlotID)) + '</td></tr>' +
      '<tr><th>Tarikh/masa</th><td>' + esc(fmtDT(x.CapturedAt)) + '</td></tr>' +
      '<tr><th>GPS</th><td>' + gps + '</td></tr>' +
      '<tr><th>Diambil oleh</th><td>' + esc(nameOf(x.TakenBy)) + '</td></tr>' +
      '<tr><th>Sumber</th><td>' + (x.Source === 'Gallery' ? 'Galeri' : 'Kamera') + '</td></tr>' +
      (x.UploadedAt ? '<tr><th>Dimuat naik</th><td>' + esc(fmtDT(x.UploadedAt)) + '</td></tr>' : '<tr><th>Status</th><td>' + (x._failed ? '⚠️ Gagal dihantar' : '⏳ Menunggu line') + '</td></tr>') +
      (L.bool(x.RetakeFlag) ? '<tr><th></th><td class="err">Ditanda Ambil semula</td></tr>' : '') +
      (L.bool(x.SelectedForReport) ? '<tr><th></th><td>★ Dipilih untuk laporan</td></tr>' : '') +
      (L.bool(x.Hidden) ? '<tr><th></th><td>🚫 Tersembunyi (hanya admin nampak)</td></tr>' : '') +
      '</table>' + adminBtns + '<button class="btn block ghost" data-act="closeSheet">Tutup</button></div>');
    loadFull(x).then(function (url) {
      var el = $('fullImg');
      if (el) el.innerHTML = url ? '<img src="' + esc(url) + '" alt="">' : '<p class="muted">Gambar penuh hanya boleh dilihat bila ada line.</p>';
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
      throw err;
    });
  }

  function flagPhoto(id, field, val) {
    adminCall('setPhotoFlag', { photoId: id, field: field, value: val }).then(function (r) {
      replacePhoto(r.photo); SolarDB.set('data', S.data); closeSheet(); render();
    });
  }
  function selectPhoto(id, val) {
    adminCall('selectForReport', { photoId: id, value: val }).then(function (r) {
      (r.photos || []).forEach(replacePhoto); SolarDB.set('data', S.data); closeSheet(); render();
      toast(val ? '★ Dipilih untuk laporan' : 'Pilihan laporan dibatalkan');
    });
  }

  // =================================================================
  // Admin — pole editor
  // =================================================================
  function renderPoleEdit(id) {
    var p = poleById(merged(), id);
    if (!isAdmin() || !p) return go('#/tiang/' + id);
    setChrome('Edit ' + id, '#/tiang/' + id, 'jadual');
    function opt(v, cur) { return '<option' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>'; }
    $('view').innerHTML = '<form class="card form" id="poleForm">' +
      '<label>Chainage<input name="Chainage" value="' + esc(p.Chainage) + '" required></label>' +
      '<div class="muted small">Format tepat: CH. + 5 digit, cth. CH.41450</div>' +
      '<label>Bound<select name="Bound">' + opt('EB', p.Bound) + opt('WB', p.Bound) + '</select></label>' +
      '<label>Tarikh rancang<input name="PlannedDate" type="date" value="' + esc(p.PlannedDate) + '"></label>' +
      '<label>Kategori<select name="Category">' + L.CATEGORIES.map(function (c) { return opt(c, p.Category); }).join('') + '</select></label>' +
      '<button class="btn block" type="submit">Simpan</button></form>';
    $('poleForm').onsubmit = function (ev) {
      ev.preventDefault();
      var f = ev.target;
      var changes = {};
      ['Chainage', 'Bound', 'PlannedDate', 'Category'].forEach(function (k) {
        var v = f[k].value.trim();
        if (v !== String(p[k] || '')) changes[k] = v;
      });
      if (!Object.keys(changes).length) return go('#/tiang/' + id);
      adminCall('editPole', { poleId: id, changes: changes }).then(function (r) {
        replacePole(r.pole); SolarDB.set('data', S.data); toast('Disimpan'); go('#/tiang/' + id); refresh(true);
      });
    };
  }

  // =================================================================
  // Laporan (all roles download; admin generates)
  // =================================================================
  function renderReports() {
    setChrome('Laporan PDF', '', 'laporan');
    var reps = (S.data.reports || []).map(function (r) {
      return '<li><div><b>' + esc(r.PoleIDs) + '</b><div class="muted small">' + esc(fmtDT(r.CreatedAt)) + ' · ' + esc(nameOf(r.CreatedBy)) + '</div></div>' +
        '<button class="btn small" data-act="download" data-id="' + esc(r.ReportID) + '">⬇ Muat turun</button></li>';
    }).join('');
    var gen = '';
    if (allowed('generateReport')) {
      var m = merged();
      var rf = S.reportFilter;
      var max = S.data.reportMaxPoles || 10;
      var list = L.sortPolesByChainage(m.poles).filter(function (p) {
        return (rf.bound === 'all' || p.Bound === rf.bound) && (rf.cat === 'all' || p.Category === rf.cat);
      });
      var nSel = Object.keys(S.reportSel).filter(function (k) { return S.reportSel[k]; }).length;
      var chip = function (group, val, label) {
        return '<button class="chip' + (rf[group] === val ? ' on' : '') + '" data-act="rfilter" data-group="' + group + '" data-val="' + esc(val) + '">' + esc(label) + '</button>';
      };
      gen = '<section class="card"><h3>Jana laporan baru</h3>' +
        '<div class="chips">' + chip('bound', 'all', 'Semua') + chip('bound', 'EB', 'EB') + chip('bound', 'WB', 'WB') + '</div>' +
        '<div class="chips">' + chip('cat', 'all', 'Semua kategori') + L.CATEGORIES.map(function (c) { return chip('cat', c, c); }).join('') + '</div>' +
        '<div class="muted small">Dipilih: <b id="nSel">' + nSel + '</b> / maksimum ' + max + ' tiang bagi satu laporan</div>' +
        '<div class="checklist">' + list.map(function (p) {
          var ps = L.photoStatus(p, m.slots, m.statusPhotos);
          return '<label class="check"><input type="checkbox" data-act="rsel" value="' + esc(p.PoleID) + '"' + (S.reportSel[p.PoleID] ? ' checked' : '') + '> ' +
            '<b>' + esc(p.PoleID) + '</b> <span class="small">' + esc(p.Chainage) + ' · ' + esc(p.Bound) + '</span> ' +
            workBadge(L.workStatus(p, m.statusPhotos)) + photoBadge(ps) + '</label>';
        }).join('') + '</div>' +
        '<button class="btn block" data-act="genReport">📄 Jana PDF</button>' +
        '<p class="muted small">Setiap slot menggunakan gambar yang dipilih admin (★); jika tiada, gambar terkini yang tidak ditanda Ambil semula.</p></section>';
    }
    $('view').innerHTML = gen + '<section class="card"><h3>Laporan dijana</h3>' +
      (reps ? '<ul class="replist">' + reps + '</ul>' : '<p class="muted">Belum ada laporan.</p>') + '</section>';
  }

  function generateReport() {
    var ids = Object.keys(S.reportSel).filter(function (k) { return S.reportSel[k]; });
    var max = S.data.reportMaxPoles || 10;
    if (!ids.length) { toast('Pilih sekurang-kurangnya satu tiang.'); return; }
    if (ids.length > max) { toast('Maksimum ' + max + ' tiang bagi satu laporan.'); return; }
    ids = L.sortPolesByChainage(S.data.poles.filter(function (p) { return ids.indexOf(p.PoleID) >= 0; })).map(function (p) { return p.PoleID; });
    adminCall('generateReport', { poleIds: ids }, 'Menjana PDF… (boleh ambil 1–3 minit, jangan tutup aplikasi)', 360000).then(function (r) {
      S.data.reports = [r.report].concat(S.data.reports || []);
      S.reportSel = {};
      SolarDB.set('data', S.data);
      render();
      toast('📄 Laporan siap');
    });
  }

  function downloadReport(id) {
    if (!online()) { toast('Perlu line internet untuk muat turun.'); return; }
    var parts = [];
    var name = 'laporan.pdf';
    function next(offset) {
      return SolarAPI.call('downloadReport', { reportId: id, offset: offset }, 120000).then(function (r) {
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
      var blob = new Blob(parts, { type: 'application/pdf' });
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
    $('view').innerHTML = '<div class="menu">' +
      '<a class="card menu-item" href="#/admin/pengguna">👥 <div><b>Pengguna</b><div class="muted small">Tambah / buang Gmail, tetapkan peranan</div></div></a>' +
      '<a class="card menu-item" href="#/admin/slot">🧩 <div><b>Tetapan slot gambar</b><div class="muted small">Nama, spesifikasi, susunan, aktif</div></div></a>' +
      '<a class="card menu-item" href="#/admin/log">🧾 <div><b>Log audit</b><div class="muted small">Semua perubahan</div></div></a>' +
      '<a class="card menu-item" href="#/laporan">📄 <div><b>Laporan PDF</b><div class="muted small">Jana laporan tuntutan</div></div></a>' +
      '<a class="card menu-item" href="#/jadual">✏️ <div><b>Edit tiang</b><div class="muted small">Buka tiang dari jadual, tekan "Edit tiang"</div></div></a>' +
      '</div>';
  }

  function renderUsers() {
    setChrome('Pengguna', '#/admin', 'admin');
    var users = S.data.users || [];
    var roleSel = function (cur) {
      return L.ROLES.map(function (r) { return '<option' + (r === cur ? ' selected' : '') + '>' + r + '</option>'; }).join('');
    };
    $('view').innerHTML = '<section class="card"><h3>Tambah pengguna</h3><form id="addUser" class="form">' +
      '<label>Emel Gmail<input name="email" type="email" required autocomplete="off"></label>' +
      '<label>Nama<input name="name" autocomplete="off"></label>' +
      '<label>Peranan<select name="role">' + roleSel('Team') + '</select></label>' +
      '<button class="btn" type="submit">Tambah</button></form></section>' +
      '<section class="card"><h3>Senarai pengguna</h3>' + users.map(function (u) {
        return '<form class="user-row form" data-email="' + esc(u.Email) + '">' +
          '<div><b>' + esc(u.Email) + '</b></div>' +
          '<label>Nama<input name="name" value="' + esc(u.Name) + '"></label>' +
          '<label>Peranan<select name="role">' + roleSel(u.Role) + '</select></label>' +
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

  function renderSlots() {
    setChrome('Slot gambar', '#/admin', 'admin');
    var slots = S.data.slots.slice().sort(function (a, b) { return a.Order - b.Order; });
    $('view').innerHTML = '<p class="muted small card">Menukar nama slot tidak menjejaskan gambar sedia ada (gambar dipaut kepada SlotID). ' +
      'Slot tidak aktif tidak dikira dalam status gambar. Slot tidak dipadam — nyahaktifkan sahaja.</p>' +
      slots.map(function (s, i) {
        return '<form class="card form slot-row" data-id="' + esc(s.SlotID) + '">' +
          '<div class="slot-row-head"><b>' + s.Order + '.</b> <span class="muted small">' + esc(s.SlotID) + '</span>' +
          '<span class="spacer"></span><button type="button" class="icon-btn" data-act="moveSlot" data-id="' + esc(s.SlotID) + '" data-dir="-1"' + (i === 0 ? ' disabled' : '') + '>▲</button>' +
          '<button type="button" class="icon-btn" data-act="moveSlot" data-id="' + esc(s.SlotID) + '" data-dir="1"' + (i === slots.length - 1 ? ' disabled' : '') + '>▼</button></div>' +
          '<label>Nama<input name="name" value="' + esc(s.Name) + '" required></label>' +
          '<label>Spesifikasi<input name="spec" value="' + esc(s.Spec) + '"></label>' +
          '<label class="check"><input type="checkbox" name="active"' + (s.Active ? ' checked' : '') + '> Aktif</label>' +
          '<button class="btn small" type="submit">Simpan</button></form>';
      }).join('') +
      '<form class="card form" id="addSlot"><h3>Tambah slot</h3><label>Nama<input name="name" required></label>' +
      '<label>Spesifikasi<input name="spec"></label><button class="btn" type="submit">Tambah</button></form>';
    Array.prototype.forEach.call(document.querySelectorAll('.slot-row'), function (f) {
      f.onsubmit = function (ev) {
        ev.preventDefault();
        adminCall('saveSlot', { slotId: f.dataset.id, name: f.name.value, spec: f.spec.value, active: f.active.checked })
          .then(function (r) { S.data.slots = r.slots; SolarDB.set('data', S.data); render(); toast('Disimpan'); });
      };
    });
    $('addSlot').onsubmit = function (ev) {
      ev.preventDefault();
      var f = ev.target;
      adminCall('saveSlot', { name: f.name.value, spec: f.spec.value, active: true })
        .then(function (r) { S.data.slots = r.slots; SolarDB.set('data', S.data); render(); toast('Slot ditambah'); });
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
    if (act === 'rsel') return; // checkbox, handled by change
    if (el.tagName === 'A') return;
    ev.preventDefault();
    switch (act) {
      case 'closeSheet': closeSheet(); break;
      case 'filter': S.filters[d.group] = d.val; render(); break;
      case 'rfilter': S.reportFilter[d.group] = d.val; render(); break;
      case 'addPhoto': ev.stopPropagation(); askPhotoSource(d.pole, d.slot); break;
      case 'pick': pick(d.mode, d.pole, d.slot); break;
      case 'viewPhoto': ev.stopPropagation(); viewPhoto(d.id); break;
      case 'addNote': addNote(d.id); break;
      case 'done': setDone(d.id, d.val === '1'); break;
      case 'flag': flagPhoto(d.id, d.field, d.val === '1'); break;
      case 'select': selectPhoto(d.id, d.val === '1'); break;
      case 'genReport': generateReport(); break;
      case 'download': downloadReport(d.id); break;
      case 'removeUser':
        if (confirm('Buang ' + d.email + '? Pengguna ini tidak boleh log masuk lagi.')) {
          adminCall('removeUser', { email: d.email }).then(function () { toast('Dibuang'); return refresh(true); });
        }
        break;
      case 'moveSlot':
        adminCall('moveSlot', { slotId: d.id, dir: Number(d.dir) }).then(function (r) { S.data.slots = r.slots; SolarDB.set('data', S.data); render(); });
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
    if (el.dataset && el.dataset.act === 'rsel') {
      S.reportSel[el.value] = el.checked;
      var n = Object.keys(S.reportSel).filter(function (k) { return S.reportSel[k]; }).length;
      var max = S.data.reportMaxPoles || 10;
      if (n > max) { el.checked = false; S.reportSel[el.value] = false; n--; toast('Maksimum ' + max + ' tiang.'); }
      var c = $('nSel'); if (c) c.textContent = n;
    }
  });

  function saveQueuedPhoto(id) {
    var it = S.queue.filter(function (i) { return i.id === id; })[0];
    if (!it || !it.image) return;
    var url = URL.createObjectURL(new Blob([it.image], { type: 'image/jpeg' }));
    var a = document.createElement('a');
    a.href = url; a.download = it.payload.poleId + '_' + it.payload.slotId + '_' + it.payload.photoId + '.jpg';
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
