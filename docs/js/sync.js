/*
 * Offline queue. Every photo / note / Siap change is written to IndexedDB FIRST, then sent.
 *  - Sent one by one, oldest first. An item is deleted from the phone only after the server says OK.
 *  - Each item carries its own ID (PhotoID / NoteID) so a retry can never create a duplicate.
 *  - Sign-in expired  -> sync pauses, user is asked to sign in, then it continues.
 *  - No connection    -> retry later (and when the phone comes back online).
 *  - Server refuses   -> item is kept as "gagal" (never silently dropped); user can retry or save the photo.
 */
var SolarSync = (function () {
  'use strict';
  var running = false;
  var needLogin = false;
  var retryTimer = null;
  var backoff = 5000;
  var listeners = [];

  function emit(evt) { listeners.forEach(function (fn) { try { fn(evt); } catch (e) { console.error(e); } }); }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }

  function bufToB64(buf) {
    var bytes = new Uint8Array(buf);
    var chunk = 0x8000, parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  function blobToBuf(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(blob);
    });
  }

  function add(item) {
    item.createdAt = SolarWatermark.klIso(new Date());
    item.status = 'pending';
    item.tries = 0;
    return SolarDB.queueAdd(item).then(function (id) {
      item.id = id;
      emit({ type: 'changed' });
      kick();
      return item;
    });
  }

  function request(item) {
    var p = item.payload;
    if (item.kind === 'photo') {
      return SolarAPI.call('uploadPhoto', Object.assign({}, p, {
        imageB64: bufToB64(item.image), thumbB64: item.thumb ? bufToB64(item.thumb) : '',
        reportB64: item.report ? bufToB64(item.report) : ''
      }), 180000);
    }
    if (item.kind === 'note') return SolarAPI.call('addNote', p, 60000);
    if (item.kind === 'done') return SolarAPI.call('setDone', p, 60000);
    return Promise.reject(SolarAPI.ApiError('BAD', 'Jenis item tidak dikenali.'));
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(kick, backoff);
    backoff = Math.min(backoff * 2, 60000);
  }

  function kick() {
    if (running) return Promise.resolve();
    if (!SolarAPI.hasSession()) { setNeedLogin(true); return Promise.resolve(); }
    if (needLogin) return Promise.resolve();
    running = true;
    emit({ type: 'running' });
    return loop().then(function () { running = false; emit({ type: 'changed' }); },
      function (e) { running = false; console.error(e); emit({ type: 'changed' }); });
  }

  function loop() {
    return SolarDB.queueAll().then(function (items) {
      var next = items.filter(function (i) { return i.status === 'pending'; })[0];
      if (!next) { backoff = 5000; emit({ type: 'drained' }); return; }
      return request(next).then(function (res) {
        return SolarDB.queueDel(next.id).then(function () {
          emit({ type: 'sent', item: next, result: res });
          backoff = 5000;
          return loop();
        });
      }, function (err) {
        if (err.code === 'AUTH') { setNeedLogin(true); return; }
        if (err.code === 'NETWORK' || err.code === 'SERVER') {
          next.tries = (next.tries || 0) + 1;
          next.lastError = err.message;
          return SolarDB.queuePut(next).then(function () { scheduleRetry(); });
        }
        // FORBIDDEN / BAD / NOTFOUND: keep it, mark failed, carry on with the rest
        next.status = 'failed';
        next.lastError = err.message;
        return SolarDB.queuePut(next).then(function () { emit({ type: 'failed', item: next }); return loop(); });
      });
    });
  }

  function setNeedLogin(v) {
    if (needLogin === v) return;
    needLogin = v;
    emit({ type: 'needLogin', value: v });
  }

  function retryFailed(id) {
    return SolarDB.queueAll().then(function (items) {
      var it = items.filter(function (i) { return i.id === id; })[0];
      if (!it) return;
      it.status = 'pending';
      return SolarDB.queuePut(it);
    }).then(function () { emit({ type: 'changed' }); return kick(); });
  }

  function discard(id) {
    return SolarDB.queueDel(id).then(function () { emit({ type: 'changed' }); });
  }

  function counts() {
    return SolarDB.queueAll().then(function (items) {
      return {
        pending: items.filter(function (i) { return i.status === 'pending'; }).length,
        failed: items.filter(function (i) { return i.status === 'failed'; }).length,
        items: items
      };
    });
  }

  window.addEventListener('online', function () { backoff = 5000; kick(); });

  return {
    uid: uid,
    add: add,
    kick: kick,
    counts: counts,
    retryFailed: retryFailed,
    discard: discard,
    blobToBuf: blobToBuf,
    bufToB64: bufToB64,
    needLogin: function () { return needLogin; },
    loggedIn: function () { setNeedLogin(false); return kick(); },
    isRunning: function () { return running; },
    on: function (fn) { listeners.push(fn); }
  };
})();
