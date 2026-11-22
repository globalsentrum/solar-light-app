/*
 * Solar Street Light — shared business logic.
 *
 * SOURCE OF TRUTH. This one file is used by:
 *   - the frontend (copied to docs/js/logic.js)
 *   - the Apps Script backend (copied to apps-script/Logic.gs)
 *   - the Node unit tests
 * Run `npm run build` after editing so the copies stay identical
 * (a test fails if they differ).
 *
 * Plain ES5-style JavaScript so it runs in Apps Script V8, old iOS Safari and Node.
 */
var SolarLogic = (function () {
  'use strict';

  var CATEGORY = {
    INSTALLED: 'Sudah dipasang',
    TODO: 'Perlu pasang',
    PENDING: 'Tunggu kelulusan'
  };
  var CATEGORIES = [CATEGORY.TODO, CATEGORY.PENDING, CATEGORY.INSTALLED];

  var WORK = {
    NOT_STARTED: 'Belum mula',
    IN_PROGRESS: 'Dalam proses',
    DONE: 'Siap',
    PENDING: 'Tunggu kelulusan'
  };

  var ROLES = ['Admin', 'Team', 'Boss'];

  var WORK_AREA_TO_CATEGORY = {
    'installed': CATEGORY.INSTALLED,
    'non-widening': CATEGORY.TODO,
    'widening': CATEGORY.PENDING
  };

  // ---------- small helpers ----------
  function bool(v) {
    if (v === true) return true;
    if (v === false || v === null || v === undefined) return false;
    var s = String(v).trim().toUpperCase();
    return s === 'TRUE' || s === 'YES' || s === '1';
  }

  function isChainageExact(text) {
    return /^CH\.\d{5}$/.test(String(text == null ? '' : text).trim());
  }

  function categoryFromWorkArea(workArea) {
    var key = String(workArea == null ? '' : workArea).trim().toLowerCase();
    if (!WORK_AREA_TO_CATEGORY.hasOwnProperty(key)) {
      throw new Error('Unknown Work Area: "' + workArea + '"');
    }
    return WORK_AREA_TO_CATEGORY[key];
  }

  /** Numeric sort key: first number in the chainage text (CH.42400 – CH.42600 -> 42400). */
  function chainageSortKey(text) {
    var m = String(text == null ? '' : text).match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : Number.MAX_VALUE;
  }

  function activeSlots(slots) {
    return (slots || []).filter(function (s) { return bool(s.Active); })
      .slice().sort(function (a, b) { return Number(a.Order) - Number(b.Order); });
  }

  function photoTime(p) {
    return String(p.CapturedAt || '') + '|' + String(p.UploadedAt || '');
  }

  function visiblePhotosOf(poleId, photos) {
    return (photos || []).filter(function (p) {
      return p.PoleID === poleId && !bool(p.Hidden);
    });
  }

  /** State of one slot on one pole. */
  function slotState(poleId, slotId, photos) {
    var list = visiblePhotosOf(poleId, photos).filter(function (p) { return p.SlotID === slotId; })
      .sort(function (a, b) { return photoTime(a) < photoTime(b) ? -1 : photoTime(a) > photoTime(b) ? 1 : 0; });
    var good = list.filter(function (p) { return !bool(p.RetakeFlag); });
    var state = 'empty';
    if (good.length) state = 'ok';
    else if (list.length) state = 'retake';
    return { photos: list, goodCount: good.length, state: state };
  }

  function needsPhotos(pole) { return pole.Category === CATEGORY.TODO; }

  /** Photo status of a pole. Counts ACTIVE slots only. */
  function photoStatus(pole, slots, photos) {
    var act = activeSlots(slots);
    if (!needsPhotos(pole)) {
      return {
        required: false, done: 0, total: act.length, complete: false,
        label: pole.Category === CATEGORY.INSTALLED ? 'Tidak berkaitan' : '—',
        missing: [], retake: []
      };
    }
    var done = 0, missing = [], retake = [];
    act.forEach(function (s) {
      var st = slotState(pole.PoleID, s.SlotID, photos);
      if (st.state === 'ok') done++;
      else {
        missing.push(s.Name);
        if (st.state === 'retake') retake.push(s.Name);
      }
    });
    var complete = act.length > 0 && done === act.length;
    return {
      required: true, done: done, total: act.length, complete: complete,
      label: complete ? 'Lengkap' : 'Belum lengkap (' + done + '/' + act.length + ')',
      missing: missing, retake: retake
    };
  }

  /** Work status of a pole (computed, never stored). */
  function workStatus(pole, photos) {
    if (pole.Category === CATEGORY.INSTALLED) return WORK.DONE;
    if (pole.Category === CATEGORY.PENDING) return WORK.PENDING;
    if (bool(pole.IsDone)) return WORK.DONE;
    return visiblePhotosOf(pole.PoleID, photos).length ? WORK.IN_PROGRESS : WORK.NOT_STARTED;
  }

  /** Any visible photo on the pole flagged "Ambil semula"? */
  function hasRetakeFlag(poleId, photos) {
    return visiblePhotosOf(poleId, photos).some(function (p) { return bool(p.RetakeFlag); });
  }

  /**
   * Photo used in the PDF for a slot: the admin-selected visible photo,
   * otherwise the latest visible photo that is not flagged "Ambil semula".
   */
  function reportPhotoForSlot(poleId, slotId, photos) {
    var list = visiblePhotosOf(poleId, photos).filter(function (p) { return p.SlotID === slotId; });
    var sel = list.filter(function (p) { return bool(p.SelectedForReport); });
    if (sel.length) return sel[sel.length - 1];
    var good = list.filter(function (p) { return !bool(p.RetakeFlag); })
      .sort(function (a, b) { return photoTime(a) < photoTime(b) ? -1 : photoTime(a) > photoTime(b) ? 1 : 0; });
    return good.length ? good[good.length - 1] : null;
  }

  function sortPolesByChainage(poles) {
    return poles.slice().sort(function (a, b) {
      var d = chainageSortKey(a.Chainage) - chainageSortKey(b.Chainage);
      if (d !== 0) return d;
      return a.PoleID < b.PoleID ? -1 : a.PoleID > b.PoleID ? 1 : 0;
    });
  }

  /** All dashboard numbers. */
  function dashboard(poles, slots, photos) {
    var r = {
      total: poles.length, done: 0, photoComplete: 0, photoRequired: 0,
      todo: 0, pending: 0, installed: 0, inProgress: 0, notStarted: 0,
      bound: { EB: { total: 0, done: 0 }, WB: { total: 0, done: 0 } },
      incomplete: [], retake: [], chInexact: []
    };
    poles.forEach(function (p) {
      var ws = workStatus(p, photos);
      var ps = photoStatus(p, slots, photos);
      if (ws === WORK.DONE) r.done++;
      if (ws === WORK.IN_PROGRESS) r.inProgress++;
      if (ws === WORK.NOT_STARTED) r.notStarted++;
      if (p.Category === CATEGORY.TODO) r.todo++;
      if (p.Category === CATEGORY.PENDING) r.pending++;
      if (p.Category === CATEGORY.INSTALLED) r.installed++;
      if (ps.required) {
        r.photoRequired++;
        if (ps.complete) r.photoComplete++;
        else r.incomplete.push({ PoleID: p.PoleID, missing: ps.missing, done: ps.done, total: ps.total });
      }
      if (hasRetakeFlag(p.PoleID, photos)) r.retake.push(p.PoleID);
      if (!bool(p.ChainageExact)) r.chInexact.push(p.PoleID);
      var b = r.bound[p.Bound] || (r.bound[p.Bound] = { total: 0, done: 0 });
      b.total++;
      if (ws === WORK.DONE) b.done++;
    });
    return r;
  }

  // ---------- permissions (Section 3). Backend calls this for EVERY action. ----------
  var PERMS = {
    view:           ['Admin', 'Team', 'Boss'],
    viewPhotos:     ['Admin', 'Team', 'Boss'],
    downloadReport: ['Admin', 'Team', 'Boss'],
    uploadPhoto:    ['Admin', 'Team'],
    addNote:        ['Admin', 'Team'],
    setDone:        ['Admin', 'Team'],
    editPole:       ['Admin'],
    setCategory:    ['Admin'],
    flagRetake:     ['Admin'],
    hidePhoto:      ['Admin'],
    selectReport:   ['Admin'],
    generateReport: ['Admin'],
    manageUsers:    ['Admin'],
    manageSlots:    ['Admin'],
    viewAudit:      ['Admin'],
    viewHidden:     ['Admin']
  };

  /** Role allowed to do action? */
  function can(role, action) {
    var allowed = PERMS[action];
    return !!allowed && allowed.indexOf(role) !== -1;
  }

  /**
   * Role + pole-category rule. Returns '' if allowed, otherwise a Malay reason.
   *  - photos: Perlu pasang (required) and Sudah dipasang (optional); not Tunggu kelulusan
   *  - Siap / Batal siap: Perlu pasang only
   *  - notes: any category
   */
  function denyReason(role, action, pole) {
    if (!can(role, action)) return 'Anda tiada kebenaran untuk tindakan ini.';
    if (!pole) return '';
    if (action === 'uploadPhoto' && pole.Category === CATEGORY.PENDING) {
      return 'Tiang ini masih Tunggu kelulusan — gambar belum boleh diambil.';
    }
    if (action === 'setDone' && pole.Category !== CATEGORY.TODO) {
      return 'Status Siap hanya untuk tiang kategori Perlu pasang.';
    }
    return '';
  }

  return {
    CATEGORY: CATEGORY, CATEGORIES: CATEGORIES, WORK: WORK, ROLES: ROLES, PERMS: PERMS,
    bool: bool,
    isChainageExact: isChainageExact,
    categoryFromWorkArea: categoryFromWorkArea,
    chainageSortKey: chainageSortKey,
    activeSlots: activeSlots,
    slotState: slotState,
    photoStatus: photoStatus,
    workStatus: workStatus,
    hasRetakeFlag: hasRetakeFlag,
    reportPhotoForSlot: reportPhotoForSlot,
    sortPolesByChainage: sortPolesByChainage,
    dashboard: dashboard,
    can: can,
    denyReason: denyReason
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = SolarLogic; }
