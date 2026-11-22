/*
 * IndexedDB storage. Photos are stored as ArrayBuffer (not Blob) for older iPhone Safari.
 *   kv     : key/value (session, cached data, settings)
 *   queue  : offline actions waiting to be sent (auto-increment id keeps the order)
 *   thumbs : PhotoID -> { buf: ArrayBuffer }
 */
var SolarDB = (function () {
  'use strict';
  var DB_NAME = 'solar-karak';
  var VERSION = 1;
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var s = t.objectStore(store);
        var result;
        var r = fn(s);
        if (r && 'onsuccess' in r) r.onsuccess = function () { result = r.result; };
        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('IndexedDB aborted')); };
      });
    });
  }

  function all(store) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var out = [];
        var t = db.transaction(store, 'readonly');
        var req = t.objectStore(store).openCursor();
        req.onsuccess = function () {
          var c = req.result;
          if (c) { out.push(c.value); c.continue(); }
        };
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  return {
    get: function (key) { return tx('kv', 'readonly', function (s) { return s.get(key); }); },
    set: function (key, val) { return tx('kv', 'readwrite', function (s) { return s.put(val, key); }); },
    del: function (key) { return tx('kv', 'readwrite', function (s) { return s.delete(key); }); },
    queueAdd: function (item) { return tx('queue', 'readwrite', function (s) { return s.add(item); }); },
    queuePut: function (item) { return tx('queue', 'readwrite', function (s) { return s.put(item); }); },
    queueDel: function (id) { return tx('queue', 'readwrite', function (s) { return s.delete(id); }); },
    queueAll: function () { return all('queue'); },
    thumbGet: function (id) { return tx('thumbs', 'readonly', function (s) { return s.get(id); }); },
    thumbSet: function (id, buf) { return tx('thumbs', 'readwrite', function (s) { return s.put({ buf: buf }, id); }); }
  };
})();
