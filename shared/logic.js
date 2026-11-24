/*
 * Solar Street Light — shared business logic (v2: activities + photo types).
 *
 * SOURCE OF TRUTH. This one file is used by:
 *   - the frontend (copied to docs/js/logic.js)
 *   - the Apps Script backend (copied to apps-script/Logic.gs)
 *   - the Node tests and the report preview script
 * Run `npm run build` after editing so the copies stay identical (a test fails if they differ).
 *
 * Plain ES5-style JavaScript so it runs in Apps Script V8, older iPhone Safari and Node.
 */
var SolarLogic = (function () {
  'use strict';

  var CATEGORY = { INSTALLED: 'Sudah dipasang', TODO: 'Perlu pasang', PENDING: 'Tunggu kelulusan' };
  var CATEGORIES = [CATEGORY.TODO, CATEGORY.PENDING, CATEGORY.INSTALLED];
  var WORK = { NOT_STARTED: 'Belum mula', IN_PROGRESS: 'Dalam proses', DONE: 'Siap', PENDING: 'Tunggu kelulusan' };
  var ADMIN_ROLE = 'Admin';
  var LABEL_MAX = 20;
  /** Display labels, stored by key (Settings "Label.<key>"); data always uses the keys / internal values. */
  var LABEL_DEFAULTS = {
    NOT_STARTED: 'Belum mula', IN_PROGRESS: 'Dalam proses', DONE: 'Siap', NIGHT: 'Perlu gambar malam',
    PENDING: 'Tunggu kelulusan', INSTALLED: 'Sudah dipasang', BAKI: 'Baki perlu pasang'
  };
  var WORK_KEY = { 'Belum mula': 'NOT_STARTED', 'Dalam proses': 'IN_PROGRESS', 'Siap': 'DONE', 'Tunggu kelulusan': 'PENDING' };
  var OVERRIDES = { NOT_STARTED: 'Belum mula', IN_PROGRESS: 'Dalam proses', DONE: 'Siap' };
  /** RIN column in the Poles sheet per activity. */
  var RIN_FIELD = { A: 'RINPegging', B: 'RINTrialPit', C: 'RINInstallation' };
  var WORK_AREA_TO_CATEGORY = { 'installed': CATEGORY.INSTALLED, 'non-widening': CATEGORY.TODO, 'widening': CATEGORY.PENDING };

  /*
   * Activities and photo types. IDs, order, minimums, measurement and report counts are FIXED
   * (the PDF layouts depend on them). Only Name (and the activity Spec) can be changed by admin;
   * those come from the Activities / PhotoTypes sheets and override the defaults here.
   */
  var ACTIVITIES = [
    { ActivityID: 'A', Order: 1, Name: 'Pegging', Spec: '', ReportKey: 'PEGGING' },
    { ActivityID: 'B', Order: 2, Name: 'Trial Pit', Spec: 'Dalam 1.5m, lebar 1m, panjang 1m', ReportKey: 'TRIALPIT' },
    { ActivityID: 'C', Order: 3, Name: 'Installation', Spec: '', ReportKey: 'INSTALLATION' }
  ];
  var PHOTO_TYPES = [
    { TypeID: 'A1', ActivityID: 'A', Order: 1, Name: 'Pegging', MinPhotos: 1, ReportCount: 1, NeedsMeasurement: false, MeasureLabel: '' },
    { TypeID: 'B1', ActivityID: 'B', Order: 2, Name: 'Korek', MinPhotos: 1, ReportCount: 1, NeedsMeasurement: false, MeasureLabel: '' },
    { TypeID: 'B2', ActivityID: 'B', Order: 3, Name: 'Lebar', MinPhotos: 1, ReportCount: 1, NeedsMeasurement: true, MeasureLabel: 'WIDTH' },
    { TypeID: 'B3', ActivityID: 'B', Order: 4, Name: 'Panjang', MinPhotos: 1, ReportCount: 1, NeedsMeasurement: true, MeasureLabel: 'LENGTH' },
    { TypeID: 'B4', ActivityID: 'B', Order: 5, Name: 'Dalam', MinPhotos: 1, ReportCount: 1, NeedsMeasurement: true, MeasureLabel: 'DEPTH' },
    { TypeID: 'C1', ActivityID: 'C', Order: 6, Name: 'Progress pemasangan', MinPhotos: 4, ReportCount: 4, NeedsMeasurement: false, MeasureLabel: '' },
    { TypeID: 'C2', ActivityID: 'C', Order: 7, Name: 'Siap pasang (siang)', MinPhotos: 1, ReportCount: 1, NeedsMeasurement: false, MeasureLabel: '' },
    { TypeID: 'C3', ActivityID: 'C', Order: 8, Name: 'Ujian lampu (malam)', MinPhotos: 1, ReportCount: 1, NeedsMeasurement: false, MeasureLabel: '' }
  ];
  /** Old v1 slot -> new photo type (used once by migrateV2). S3 "Ukuran" -> B2 without a measurement. */
  var OLD_C2_NAME = 'Siap dipasang (siang)'; // v2 default (21 chars) -> shortened by migrateV3 if unchanged
  var LEGACY_SLOT_MAP = { S1: 'A1', S2: 'B1', S3: 'B2', S4: 'C1', S5: 'C1', S6: 'C2', S7: 'C3' };

  // ---------- small helpers ----------
  function bool(v) {
    if (v === true) return true;
    if (v === false || v === null || v === undefined) return false;
    var s = String(v).trim().toUpperCase();
    return s === 'TRUE' || s === 'YES' || s === '1';
  }
  function copy(o) { var r = {}; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; return r; }

  // ---------- pole IDs ----------
  function isPoleId(id) { return /^SSL\d{3}$/.test(String(id == null ? '' : id)); }
  /** "SL-034" -> "SSL034"; already new -> unchanged; anything else -> null */
  function poleIdFromLegacy(id) {
    var s = String(id == null ? '' : id).trim();
    if (isPoleId(s)) return s;
    var m = s.match(/^SL-(\d{3})$/);
    return m ? 'SSL' + m[1] : null;
  }
  /** Pole ID typed by admin: trimmed, 1-20 chars, letters/digits/space . _ - (no comma or slash). */
  function validatePoleId(id) {
    var s = String(id == null ? '' : id).trim().replace(/\s+/g, ' ');
    if (!s) return { ok: false, error: 'ID tiang tidak boleh kosong.' };
    if (s.length > 20) return { ok: false, error: 'ID tiang maksimum 20 aksara.' };
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(s)) return { ok: false, error: 'ID tiang hanya boleh mengandungi huruf, nombor, ruang, titik, - dan _.' };
    return { ok: true, id: s };
  }
  function sameId(a, b) { return String(a == null ? '' : a).trim().toUpperCase() === String(b == null ? '' : b).trim().toUpperCase(); }

  /** Search: "SSL034", "ssl34", "34", "034", "SL-034" all find SSL034. */
  function poleMatchesQuery(id, q) {
    var query = String(q == null ? '' : q).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!query) return true;
    var idU = String(id).toUpperCase();
    if (/^\d+$/.test(query)) {
      var num = String(parseInt(idU.replace(/\D/g, ''), 10));
      var qn = String(parseInt(query, 10));
      return num === qn || idU.indexOf(query) >= 0;
    }
    if (idU.indexOf(query) >= 0) return true;                  // "SSL05" -> SSL050..SSL059
    var legacy = query.match(/^S?SL(\d{1,3})$/);               // "SL034", "SSL34", "SSL5" -> padded
    return !!legacy && idU === 'SSL' + ('000' + legacy[1]).slice(-3);
  }

  function isChainageExact(text) { return /^CH\.\d{5}$/.test(String(text == null ? '' : text).trim()); }

  function categoryFromWorkArea(workArea) {
    var key = String(workArea == null ? '' : workArea).trim().toLowerCase();
    if (!WORK_AREA_TO_CATEGORY.hasOwnProperty(key)) throw new Error('Unknown Work Area: "' + workArea + '"');
    return WORK_AREA_TO_CATEGORY[key];
  }

  function chainageSortKey(text) {
    var m = String(text == null ? '' : text).match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : Number.MAX_VALUE;
  }

  // ---------- activities / types with admin names ----------
  /** Merge names from the sheets over the fixed definitions. */
  function activities(sheetRows) {
    var byId = {};
    (sheetRows || []).forEach(function (r) { byId[String(r.ActivityID)] = r; });
    return ACTIVITIES.map(function (a) {
      var o = copy(a), r = byId[a.ActivityID];
      if (r) {
        if (String(r.Name || '').trim()) o.Name = String(r.Name).trim();
        if (r.Spec !== undefined && r.Spec !== null) o.Spec = String(r.Spec);
      }
      return o;
    });
  }
  function photoTypes(sheetRows) {
    var byId = {};
    (sheetRows || []).forEach(function (r) { byId[String(r.TypeID)] = r; });
    return PHOTO_TYPES.map(function (t) {
      var o = copy(t), r = byId[t.TypeID];
      if (r && String(r.Name || '').trim()) o.Name = String(r.Name).trim();
      return o;
    });
  }
  function typeById(id) {
    for (var i = 0; i < PHOTO_TYPES.length; i++) if (PHOTO_TYPES[i].TypeID === id) return PHOTO_TYPES[i];
    return null;
  }
  function typesOfActivity(types, activityId) {
    return types.filter(function (t) { return t.ActivityID === activityId; });
  }

  // ---------- measurement ----------
  /** Parse what the team typed. Accepts "1.3" and "1,3". Max 2 decimals, > 0. */
  function parseMeasurement(input) {
    var s = String(input == null ? '' : input).trim().replace(/\s/g, '').replace(/m$/i, '');
    if (!s) return { ok: false, error: 'Sila masukkan ukuran dalam meter (cth. 1.3).' };
    if (!/^\d+([.,]\d{1,2})?$/.test(s)) {
      return { ok: false, error: 'Ukuran tidak sah. Masukkan nombor dalam meter, maksimum 2 titik perpuluhan (cth. 1.35).' };
    }
    var v = parseFloat(s.replace(',', '.'));
    if (!(v > 0)) return { ok: false, error: 'Ukuran mesti lebih daripada 0.' };
    return { ok: true, value: v };
  }
  function hasMeasurement(p) { return parseMeasurement(p.MeasurementM).ok; }
  /** 1.3 -> "1.3", 2 -> "2", 1.25 -> "1.25" */
  function formatMeasurement(v) { var n = Number(v); return isFinite(n) ? String(Math.round(n * 100) / 100) : ''; }

  // ---------- photos ----------
  function photoTime(p) { return String(p.CapturedAt || '') + '|' + String(p.UploadedAt || '') + '|' + String(p.PhotoID || ''); }
  function byTime(a, b) { return photoTime(a) < photoTime(b) ? -1 : photoTime(a) > photoTime(b) ? 1 : 0; }

  function visiblePhotosOf(poleId, photos) {
    return (photos || []).filter(function (p) { return p.PoleID === poleId && !bool(p.Hidden); });
  }
  /** A photo that counts toward completeness: visible, not "Ambil semula", has a measurement if the type needs one. */
  function isGood(p, type) {
    return !bool(p.Hidden) && !bool(p.RetakeFlag) && (!type.NeedsMeasurement || hasMeasurement(p));
  }

  function typeState(poleId, type, photos) {
    var list = visiblePhotosOf(poleId, photos).filter(function (p) { return p.PhotoTypeID === type.TypeID; }).sort(byTime);
    var good = list.filter(function (p) { return isGood(p, type); });
    var noMeasure = type.NeedsMeasurement ? list.filter(function (p) { return !bool(p.RetakeFlag) && !hasMeasurement(p); }).length : 0;
    var flagged = list.some(function (p) { return bool(p.RetakeFlag); });
    // ok = minimum met; empty = no photo; retake = not met and a photo is flagged "Ambil semula"; partial = otherwise
    var state = good.length >= type.MinPhotos ? 'ok' : !list.length ? 'empty' : flagged ? 'retake' : 'partial';
    return { photos: list, goodCount: good.length, min: type.MinPhotos, complete: good.length >= type.MinPhotos, state: state, noMeasurement: noMeasure };
  }

  function needsPhotos(pole) { return pole.Category === CATEGORY.TODO; }

  /**
   * Photo status. Units: each type counts min(good, MinPhotos) -> Pegging /1, Trial Pit /4, Installation /6 (C1 = 4).
   */
  function photoStatus(pole, types, photos, acts) {
    types = types || photoTypes();
    acts = acts || activities();
    var perAct = acts.map(function (a) {
      var done = 0, total = 0;
      typesOfActivity(types, a.ActivityID).forEach(function (t) {
        var st = typeState(pole.PoleID, t, photos);
        done += Math.min(st.goodCount, t.MinPhotos);
        total += t.MinPhotos;
      });
      return { ActivityID: a.ActivityID, name: a.Name, done: done, total: total, complete: done === total };
    });
    var done = 0, total = 0;
    perAct.forEach(function (x) { done += x.done; total += x.total; });
    if (!needsPhotos(pole)) {
      return { required: false, done: done, total: total, complete: false, activities: perAct,
        label: pole.Category === CATEGORY.INSTALLED ? 'Tidak berkaitan' : '—', detail: '', missing: [], retake: [] };
    }
    var missing = [], retake = [];
    types.forEach(function (t) {
      var st = typeState(pole.PoleID, t, photos);
      if (!st.complete) {
        missing.push(t.Name + (t.MinPhotos > 1 ? ' (' + st.goodCount + '/' + t.MinPhotos + ')' : '') +
          (st.noMeasurement ? ' — tiada ukuran' : ''));
      }
      if (st.photos.some(function (p) { return bool(p.RetakeFlag); }) && !st.complete) retake.push(t.Name);
    });
    var complete = done === total;
    var detail = perAct.map(function (x) { return x.complete ? x.name + ' ✓' : x.name + ' ' + x.done + '/' + x.total; }).join(' · ');
    return { required: true, done: done, total: total, complete: complete, activities: perAct,
      label: complete ? 'Gambar lengkap' : 'Belum lengkap', detail: detail, missing: missing, retake: retake };
  }

  function workStatus(pole, photos) {
    if (pole.Category === CATEGORY.INSTALLED) return WORK.DONE;
    if (pole.Category === CATEGORY.PENDING) return WORK.PENDING;
    var ov = String(pole.StatusOverride || '').trim();
    if (OVERRIDES[ov]) return OVERRIDES[ov];
    if (bool(pole.IsDone)) return WORK.DONE;
    return visiblePhotosOf(pole.PoleID, photos).length ? WORK.IN_PROGRESS : WORK.NOT_STARTED;
  }
  function workKey(ws) { return WORK_KEY[ws] || ''; }
  function isActive(pole) { return pole.Active === undefined || pole.Active === '' || bool(pole.Active); }

  /** "Perlu gambar malam": Perlu pasang pole that is Siap but has no visible, non-flagged night (C3) photo. */
  function needsNightPhoto(pole, photos) {
    if (pole.Category !== CATEGORY.TODO || workStatus(pole, photos) !== WORK.DONE) return false;
    return !visiblePhotosOf(pole.PoleID, photos).some(function (p) { return p.PhotoTypeID === 'C3' && !bool(p.RetakeFlag); });
  }

  function hasRetakeFlag(poleId, photos) {
    return visiblePhotosOf(poleId, photos).some(function (p) { return bool(p.RetakeFlag); });
  }

  // ---------- report selection (v3) ----------
  /**
   * State of one photo type for the report:
   *  - admin choice (ReportOrder 1..n) of exactly ReportCount visible photos -> used ('ok')
   *  - otherwise exactly ReportCount good photos (visible, not flagged, measured if needed) -> used automatically ('ok')
   *  - more good photos than needed and no complete choice -> admin must choose ('choose')
   *  - fewer -> 'short'. A chosen/automatic photo without a needed measurement -> 'short'.
   */
  function typeReportState(poleId, typeId, photos) {
    var t = typeById(typeId);
    var list = visiblePhotosOf(poleId, photos).filter(function (p) { return p.PhotoTypeID === typeId; });
    var chosen = list.filter(function (p) { return Number(p.ReportOrder) > 0; })
      .sort(function (a, b) { return Number(a.ReportOrder) - Number(b.ReportOrder); });
    var good = list.filter(function (p) { return isGood(p, t); }).sort(byTime);
    var use = null, how = '';
    if (chosen.length === t.ReportCount) { use = chosen; how = 'admin'; }
    else if (good.length === t.ReportCount) { use = good; how = 'auto'; }
    var state;
    if (use) state = t.NeedsMeasurement && use.some(function (p) { return !hasMeasurement(p); }) ? 'short' : 'ok';
    else state = good.length > t.ReportCount ? 'choose' : 'short';
    return { type: t, state: state, how: how, photos: use || [], count: list.length, good: good.length, need: t.ReportCount,
      noMeasurement: !!use && state === 'short' };
  }
  /** Photos used in the report for one pole + type, in report order ([] when not decided / not enough). */
  function reportPhotos(poleId, typeId, photos) {
    var st = typeReportState(poleId, typeId, photos);
    return st.state === 'ok' ? st.photos : [];
  }
  function isAdminChoice(poleId, typeId, photos) {
    return typeReportState(poleId, typeId, photos).how === 'admin';
  }
  function hasRin(pole, activityId) { return String(pole[RIN_FIELD[activityId]] || '').trim() !== ''; }

  /**
   * Report row status for one pole + activity:
   *  'reported' (RIN recorded) · 'short' (Kurang gambar) · 'choose' (Perlu pilih gambar) · 'ready' (Sedia).
   * ready = every type ok (also true for a reported pole whose photos are complete).
   */
  function poleReportStatus(activityId, pole, types, photos) {
    var states = typesOfActivity(types || photoTypes(), activityId).map(function (t) { return typeReportState(pole.PoleID, t.TypeID, photos); });
    var hasPhotos = visiblePhotosOf(pole.PoleID, photos).some(function (p) {
      var t = typeById(p.PhotoTypeID); return t && t.ActivityID === activityId;
    });
    var short = states.filter(function (x) { return x.state === 'short'; });
    var choose = states.filter(function (x) { return x.state === 'choose'; });
    var ready = !short.length && !choose.length;
    var status = hasRin(pole, activityId) ? 'reported' : short.length ? 'short' : choose.length ? 'choose' : 'ready';
    return { status: status, ready: ready, hasPhotos: hasPhotos, types: states, short: short, choose: choose,
      rin: String(pole[RIN_FIELD[activityId]] || '') };
  }
  /** Text list of what blocks the report for this pole ([] = Sedia). */
  function reportMissing(activityId, poleId, types, photos) {
    var out = [];
    typesOfActivity(types, activityId).forEach(function (t) {
      var st = typeReportState(poleId, t.TypeID, photos);
      var name = (types.filter(function (x) { return x.TypeID === t.TypeID; })[0] || t).Name;
      if (st.state === 'choose') out.push(name + ': pilih ' + t.ReportCount + ' daripada ' + st.good + ' gambar');
      else if (st.state === 'short') out.push(st.noMeasurement ? name + ' (tiada ukuran)' : name + ' (' + st.good + '/' + t.ReportCount + ' gambar)');
    });
    return out;
  }

  function reportPhotoCount(activityId) {
    var n = 0;
    PHOTO_TYPES.forEach(function (t) { if (t.ActivityID === activityId) n += t.ReportCount; });
    return n;
  }

  /**
   * Layout of the photo pages for one activity (renderer-independent, used by Apps Script and the preview).
   * Sizes in points; A4 portrait, 36 pt margins -> 523 pt usable width.
   */
  function buildReportSpec(activityId, poleIds, types, photos) {
    var ids = poleIds.slice().sort();
    var pick = function (poleId, typeId) { return reportPhotos(poleId, typeId, photos); };
    var blocks = [];
    if (activityId === 'A') {
      var cells = ids.map(function (id) {
        var p = pick(id, 'A1')[0];
        return { photoId: p ? p.PhotoID : null, caption: id };
      });
      blocks.push({ title: 'PEGGING', columns: 3, box: { w: 160, h: 120 }, cells: cells, rowCaptions: null,
        footer: 'Total pegging : ' + ids.length + ' nos', pageBreakBefore: false });
    } else if (activityId === 'B') {
      ids.forEach(function (id, i) {
        var cell = function (typeId, label) {
          var p = pick(id, typeId)[0];
          return { photoId: p ? p.PhotoID : null,
            caption: label ? label + ' : ' + (p ? formatMeasurement(p.MeasurementM) : '?') + 'M' : id };
        };
        blocks.push({ title: 'TRIAL PIT EXCAVATION WORKS', columns: 4, box: { w: 118, h: 157 },
          cells: [cell('B1', ''), cell('B2', 'WIDTH'), cell('B3', 'LENGTH'), cell('B4', 'DEPTH')],
          rowCaptions: null, footer: '', pageBreakBefore: i > 0 && i % 3 === 0 });
      });
    } else if (activityId === 'C') {
      ids.forEach(function (id, i) {
        var prog = pick(id, 'C1');
        var cells1 = [];
        for (var k = 0; k < 4; k++) cells1.push({ photoId: prog[k] ? prog[k].PhotoID : null, caption: '' });
        blocks.push({ title: 'INSTALLATION SOLAR STREET LIGHTING PROGRESS', columns: 4, box: { w: 118, h: 157 },
          cells: cells1, rowCaption: id, footer: '', pageBreakBefore: i > 0 });
        var day = pick(id, 'C2')[0], night = pick(id, 'C3')[0];
        blocks.push({ title: 'INSTALLATION SOLAR STREET LIGHTING COMPLETED', columns: 2, box: { w: 245, h: 200 },
          cells: [{ photoId: day ? day.PhotoID : null, caption: '' }, { photoId: night ? night.PhotoID : null, caption: '' }],
          rowCaption: id, footer: '', pageBreakBefore: false });
      });
    } else {
      throw new Error('Unknown activity ' + activityId);
    }
    return { page: { w: 595.28, h: 841.89, margin: 36 }, blocks: blocks };
  }

  /** Fit an image inside a box keeping its aspect ratio. */
  function fitBox(w, h, box) {
    var s = Math.min(box.w / w, box.h / h);
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  // ---------- dates (Malaysia, UTC+8, no daylight saving) ----------
  /** YYYY-MM-DD in Malaysia for a timestamp (ms) plus addDays. */
  function klDate(ms, addDays) {
    var d = new Date(ms + 8 * 3600000 + (addDays || 0) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  function isIsoDate(s) {
    var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }
  /** PoleID -> [plan entries] for one date. */
  function plansForDate(plans, date) {
    var out = {};
    (plans || []).forEach(function (p) {
      if (p.Date === date) (out[p.PoleID] = out[p.PoleID] || []).push(p);
    });
    return out;
  }

  function sortPolesByChainage(poles) {
    return poles.slice().sort(function (a, b) {
      var d = chainageSortKey(a.Chainage) - chainageSortKey(b.Chainage);
      if (d !== 0) return d;
      return a.PoleID < b.PoleID ? -1 : a.PoleID > b.PoleID ? 1 : 0;
    });
  }

  /** Dashboard (active poles only). siap + belumMula + dalamProses + tunggu = total; belumMula + dalamProses = baki. */
  function dashboard(poles, types, photos, acts) {
    var act = poles.filter(isActive);
    var r = { total: act.length, done: 0, todo: 0, baki: 0, pending: 0, installed: 0, inProgress: 0, notStarted: 0, night: 0,
      photoComplete: 0, photoRequired: 0, bound: { EB: { total: 0, done: 0 }, WB: { total: 0, done: 0 } },
      incomplete: [], retake: [], chInexact: [], nightList: [] };
    act.forEach(function (p) {
      var ws = workStatus(p, photos);
      if (ws === WORK.DONE) r.done++;
      if (ws === WORK.IN_PROGRESS) r.inProgress++;
      if (ws === WORK.NOT_STARTED) r.notStarted++;
      if (ws === WORK.PENDING) r.pending++;
      if (p.Category === CATEGORY.TODO) { r.todo++; if (ws !== WORK.DONE) r.baki++; }
      if (p.Category === CATEGORY.INSTALLED) r.installed++;
      if (needsNightPhoto(p, photos)) { r.night++; r.nightList.push(p.PoleID); }
      var ps = photoStatus(p, types, photos, acts);
      if (ps.required) {
        r.photoRequired++;
        if (ps.complete) r.photoComplete++;
        else r.incomplete.push({ PoleID: p.PoleID, missing: ps.missing, detail: ps.detail, done: ps.done, total: ps.total });
      }
      if (hasRetakeFlag(p.PoleID, photos)) r.retake.push(p.PoleID);
      if (!bool(p.ChainageExact)) r.chInexact.push(p.PoleID);
      var b = r.bound[p.Bound] || (r.bound[p.Bound] = { total: 0, done: 0 });
      b.total++;
      if (ws === WORK.DONE) b.done++;
    });
    return r;
  }

  /** Schedule / dashboard filter keys -> does the pole match? (dashboard cards open exactly these lists) */
  function matchesFilter(pole, key, photos) {
    if (!key || key === 'all') return true;
    var ws = workStatus(pole, photos);
    switch (key) {
      case 'BAKI': return pole.Category === CATEGORY.TODO && ws !== WORK.DONE;
      case 'NIGHT': return needsNightPhoto(pole, photos);
      case 'TODO': return pole.Category === CATEGORY.TODO;
      case 'NOT_STARTED': return ws === WORK.NOT_STARTED;
      case 'IN_PROGRESS': return ws === WORK.IN_PROGRESS;
      case 'DONE': return ws === WORK.DONE;
      case 'PENDING': return ws === WORK.PENDING;
      default: return false;
    }
  }

  // ---------- photo quality (admin Settings; used by the phone for NEW photos) ----------
  var PHOTO_DEFAULTS = { maxSide: 2048, quality: 0.88 };
  var PHOTO_LIMITS = { maxSide: [1280, 3000], quality: [0.6, 0.95] };
  function validatePhotoSettings(maxSide, quality) {
    var errors = [];
    var m = Number(String(maxSide).trim()), q = Number(String(quality).trim().replace(',', '.'));
    if (String(maxSide).trim() === '' || !isFinite(m) || Math.round(m) !== m || m < PHOTO_LIMITS.maxSide[0] || m > PHOTO_LIMITS.maxSide[1]) {
      errors.push('Saiz maksimum mesti nombor bulat ' + PHOTO_LIMITS.maxSide[0] + '–' + PHOTO_LIMITS.maxSide[1] + ' px.');
    }
    if (String(quality).trim() === '' || !isFinite(q) || q < PHOTO_LIMITS.quality[0] || q > PHOTO_LIMITS.quality[1] || Math.round(q * 100) !== q * 100) {
      errors.push('Kualiti JPEG mesti ' + PHOTO_LIMITS.quality[0] + '–' + PHOTO_LIMITS.quality[1] + ' (maks 2 titik perpuluhan).');
    }
    return errors.length ? { ok: false, error: errors.join(' ') } : { ok: true, maxSide: m, quality: q };
  }
  /** Settings sheet values -> {maxSide, quality}; missing or invalid values fall back to the defaults. */
  function photoSettings(settings) {
    var s = settings || {};
    var v = validatePhotoSettings(s.PhotoMaxSide, s.PhotoQuality);
    if (v.ok) return { maxSide: v.maxSide, quality: v.quality };
    var m = validatePhotoSettings(s.PhotoMaxSide, PHOTO_DEFAULTS.quality);
    var q = validatePhotoSettings(PHOTO_DEFAULTS.maxSide, s.PhotoQuality);
    return { maxSide: m.ok ? m.maxSide : PHOTO_DEFAULTS.maxSide, quality: q.ok ? q.quality : PHOTO_DEFAULTS.quality };
  }

  // ---------- labels ----------
  /** Settings rows/object -> {key: label}; values over 20 chars or empty fall back to the default. */
  function labels(settings) {
    var out = {};
    Object.keys(LABEL_DEFAULTS).forEach(function (k) {
      var v = settings ? settings['Label.' + k] : '';
      v = String(v == null ? '' : v).trim();
      out[k] = v && v.length <= LABEL_MAX ? v : LABEL_DEFAULTS[k];
    });
    return out;
  }
  function validateLabel(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return { ok: false, error: 'Label tidak boleh kosong.' };
    if (s.length > LABEL_MAX) return { ok: false, error: 'Maksimum ' + LABEL_MAX + ' aksara (' + s.length + ').' };
    return { ok: true, value: s };
  }

  // ---------- work plan dates ----------
  /** Next plan date for a pole that is today or later ('' = Belum dirancang). */
  function nextPlanDate(plans, poleId, today) {
    var best = '';
    (plans || []).forEach(function (p) {
      if (sameId(p.PoleID, poleId) && p.Date >= today && (!best || p.Date < best)) best = p.Date;
    });
    return best;
  }
  /** Activity value for plans: '', 'A', 'B', 'C' or 'C3' (Ujian lampu malam). */
  var PLAN_ACTIVITIES = ['A', 'B', 'C', 'C3'];

  // ---------- import rows (shared by phone preview and backend) ----------
  var CATEGORY_ALIASES = { 'perlu pasang': CATEGORY.TODO, 'non-widening': CATEGORY.TODO, 'tunggu kelulusan': CATEGORY.PENDING,
    'widening': CATEGORY.PENDING, 'sudah dipasang': CATEGORY.INSTALLED, 'installed': CATEGORY.INSTALLED };
  /**
   * rows: [{PoleID, Chainage, Bound, Category}] ; existing: poles in the sheet.
   * Each result: {row, PoleID, Chainage, Bound, Category, status: 'new'|'exists'|'error', errors: [], warnings: [], existingId}
   */
  function validateImport(rows, existing) {
    var seen = {};
    (rows || []).forEach(function (r) {
      var v = validatePoleId(r.PoleID);
      if (v.ok) { var k = v.id.toUpperCase(); seen[k] = (seen[k] || 0) + 1; }
    });
    return (rows || []).map(function (r, i) {
      var out = { row: i + 1, errors: [], warnings: [], status: 'new', existingId: '' };
      var v = validatePoleId(r.PoleID);
      if (!v.ok) out.errors.push(v.error); else out.PoleID = v.id;
      if (!out.PoleID) out.PoleID = String(r.PoleID == null ? '' : r.PoleID).trim();
      out.Chainage = String(r.Chainage == null ? '' : r.Chainage).trim();
      if (!out.Chainage) out.errors.push('CH kosong.');
      out.Bound = String(r.Bound == null ? '' : r.Bound).trim().toUpperCase();
      if (out.Bound !== 'EB' && out.Bound !== 'WB') out.errors.push('Bound mesti EB atau WB.');
      var c = String(r.Category == null ? '' : r.Category).trim();
      if (!c) { out.Category = CATEGORY.TODO; out.warnings.push('Kategori kosong → Perlu pasang.'); }
      else if (CATEGORY_ALIASES[c.toLowerCase()]) out.Category = CATEGORY_ALIASES[c.toLowerCase()];
      else out.errors.push('Kategori tidak dikenali: ' + c);
      if (v.ok && seen[v.id.toUpperCase()] > 1) out.errors.push('ID berulang dalam fail.');
      if (v.ok) {
        (existing || []).forEach(function (p) { if (sameId(p.PoleID, v.id)) { out.status = 'exists'; out.existingId = p.PoleID; } });
      }
      if (!out.errors.length) {
        (existing || []).forEach(function (p) {
          if (!sameId(p.PoleID, out.PoleID) && String(p.Chainage).trim() === out.Chainage && p.Bound === out.Bound) {
            out.warnings.push('CH dan bound sama dengan ' + p.PoleID + '.');
          }
        });
      }
      if (out.errors.length) out.status = 'error';
      return out;
    });
  }

  // ---------- permissions (roles defined by admin in the Roles sheet; backend checks every action) ----------
  var PERMISSIONS = [
    { key: 'view_dashboard', label: 'Lihat dashboard' },
    { key: 'capture_photo', label: 'Ambil / muat naik gambar' },
    { key: 'add_note', label: 'Tambah nota' },
    { key: 'mark_done', label: 'Tanda kerja siap / batal siap' },
    { key: 'plan_work', label: 'Rancang kerja (pelan)' },
    { key: 'select_report_photos', label: 'Pilih gambar untuk laporan' },
    { key: 'generate_report', label: 'Jana laporan' },
    { key: 'record_rin', label: 'Rekod No. RIN' },
    { key: 'download_report', label: 'Muat turun laporan' },
    { key: 'edit_pole', label: 'Edit maklumat tiang' },
    { key: 'add_pole', label: 'Tambah tiang' },
    { key: 'delete_pole', label: 'Padam / nyahaktif tiang' },
    { key: 'import_poles', label: 'Import tiang (Excel/CSV)' },
    { key: 'export_data', label: 'Eksport data (Excel)' },
    { key: 'edit_measurement', label: 'Edit ukuran' },
    { key: 'hide_photo', label: 'Sorok gambar / Ambil semula' },
    { key: 'delete_photo', label: 'Padam gambar' },
    { key: 'move_photo', label: 'Pindah / tukar gambar' },
    { key: 'override_status', label: 'Tukar status kerja (override)' },
    { key: 'manage_users', label: 'Urus pengguna' },
    { key: 'manage_roles', label: 'Urus peranan' },
    { key: 'edit_settings', label: 'Tetapan (label & nama)' },
    { key: 'view_audit_log', label: 'Lihat log audit' }
  ];
  var ALL_PERMISSIONS = PERMISSIONS.map(function (p) { return p.key; });
  /** v2 roles -> exactly the same powers in v3. */
  var DEFAULT_ROLES = [
    { RoleName: 'Admin', Permissions: ALL_PERMISSIONS, BuiltIn: true },
    { RoleName: 'Team', Permissions: ['view_dashboard', 'capture_photo', 'add_note', 'mark_done', 'download_report'], BuiltIn: false },
    { RoleName: 'Boss', Permissions: ['view_dashboard', 'download_report'], BuiltIn: false }
  ];
  /** "a, b" or array -> clean list of known keys */
  function parsePermissions(v) {
    var list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,;]+/);
    var out = [];
    list.forEach(function (k) { k = String(k).trim(); if (ALL_PERMISSIONS.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k); });
    return out;
  }
  /** perms: array of keys (the user's role). */
  function can(perms, key) { return !!perms && perms.indexOf(key) !== -1; }
  function denyReason(perms, key, pole) {
    if (!can(perms, key)) return 'Anda tiada kebenaran untuk tindakan ini.';
    if (!pole) return '';
    if (key === 'capture_photo' && pole.Category === CATEGORY.PENDING) return 'Tiang ini masih Tunggu kelulusan — gambar belum boleh diambil.';
    if (key === 'mark_done' && pole.Category !== CATEGORY.TODO) return 'Status Siap hanya untuk tiang kategori Perlu pasang.';
    if ((key === 'capture_photo' || key === 'mark_done' || key === 'add_note') && !isActive(pole)) return 'Tiang ini tidak aktif.';
    return '';
  }

  return {
    CATEGORY: CATEGORY, CATEGORIES: CATEGORIES, WORK: WORK, ADMIN_ROLE: ADMIN_ROLE, LABEL_MAX: LABEL_MAX,
    LABEL_DEFAULTS: LABEL_DEFAULTS, OVERRIDES: OVERRIDES, RIN_FIELD: RIN_FIELD, OLD_C2_NAME: OLD_C2_NAME,
    PERMISSIONS: PERMISSIONS, ALL_PERMISSIONS: ALL_PERMISSIONS, DEFAULT_ROLES: DEFAULT_ROLES, PLAN_ACTIVITIES: PLAN_ACTIVITIES,
    ACTIVITIES: ACTIVITIES, PHOTO_TYPES: PHOTO_TYPES, LEGACY_SLOT_MAP: LEGACY_SLOT_MAP,
    bool: bool, isPoleId: isPoleId, validatePoleId: validatePoleId, sameId: sameId, isActive: isActive, workKey: workKey,
    needsNightPhoto: needsNightPhoto, typeReportState: typeReportState, poleReportStatus: poleReportStatus, hasRin: hasRin,
    matchesFilter: matchesFilter, labels: labels, validateLabel: validateLabel, nextPlanDate: nextPlanDate,
    validateImport: validateImport, parsePermissions: parsePermissions,
    PHOTO_DEFAULTS: PHOTO_DEFAULTS, PHOTO_LIMITS: PHOTO_LIMITS, validatePhotoSettings: validatePhotoSettings, photoSettings: photoSettings, poleIdFromLegacy: poleIdFromLegacy, poleMatchesQuery: poleMatchesQuery,
    isChainageExact: isChainageExact, categoryFromWorkArea: categoryFromWorkArea, chainageSortKey: chainageSortKey,
    activities: activities, photoTypes: photoTypes, typeById: typeById, typesOfActivity: typesOfActivity,
    parseMeasurement: parseMeasurement, hasMeasurement: hasMeasurement, formatMeasurement: formatMeasurement,
    typeState: typeState, photoStatus: photoStatus, workStatus: workStatus, hasRetakeFlag: hasRetakeFlag,
    reportPhotos: reportPhotos, isAdminChoice: isAdminChoice, reportMissing: reportMissing, reportPhotoCount: reportPhotoCount,
    buildReportSpec: buildReportSpec, fitBox: fitBox,
    klDate: klDate, isIsoDate: isIsoDate, plansForDate: plansForDate,
    sortPolesByChainage: sortPolesByChainage, dashboard: dashboard, can: can, denyReason: denyReason
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = SolarLogic; }
