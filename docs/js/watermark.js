/*
 * Photo processing on the phone: resize (max 1600 px), burn a watermark into the pixels,
 * make a small thumbnail, and work out date/time + GPS.
 *
 *  Camera  : current device time + current GPS (waits up to 15 s for a fix, else "GPS tidak tersedia")
 *  Gallery : EXIF original date/time and GPS if present; anything missing falls back to
 *            upload time / current GPS and the stamp gets the label "Dari galeri".
 */
var SolarWatermark = (function () {
  'use strict';
  var MAX_SIDE = 2048;   // default; the app passes the admin setting (o.maxSide)
  var THUMB_SIDE = 360;
  var REPORT_SIDE = 1200;   // reduced copy inserted in the PDF / Word reports (sharp enough for the largest report cell)
  var REPORT_QUALITY = 0.8;
  var QUALITY = 0.88;   // default; the app passes the admin setting (o.quality)
  var KL_OFFSET_MS = 8 * 3600 * 1000; // Malaysia: UTC+8, no daylight saving

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** Date -> "2026-11-21T14:05:09+08:00" (Malaysia wall time). */
  function klIso(date) {
    var k = new Date(date.getTime() + KL_OFFSET_MS);
    return k.toISOString().slice(0, 19) + '+08:00';
  }

  /** "2026-11-21T14:05:09+08:00" -> "21/11/2026 14:05" */
  function displayTime(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    return m ? m[3] + '/' + m[2] + '/' + m[1] + ' ' + m[4] + ':' + m[5] : '';
  }

  /** EXIF "2026:11:20 09:15:30" (camera local time, assumed Malaysia) -> ISO +08:00 */
  function exifToIso(v) {
    if (!v) return '';
    if (v instanceof Date) {
      // exifr revived it using the phone's own time zone; take the wall-clock parts back out.
      return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate()) + 'T' +
        pad(v.getHours()) + ':' + pad(v.getMinutes()) + ':' + pad(v.getSeconds()) + '+08:00';
    }
    var m = String(v).match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/);
    if (!m || m[1] === '0000') return '';
    return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + (m[6] || '00') + '+08:00';
  }

  function readExif(file) {
    if (typeof exifr === 'undefined') return Promise.resolve({});
    var out = {};
    return exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate', 'GPSHPositioningError'], reviveValues: false })
      .then(function (t) {
        if (t) {
          out.time = exifToIso(t.DateTimeOriginal || t.CreateDate);
          if (typeof t.GPSHPositioningError === 'number') out.acc = t.GPSHPositioningError;
        }
      }).catch(function () { /* no EXIF */ })
      .then(function () { return exifr.gps(file); })
      .then(function (g) {
        if (g && isFinite(g.latitude) && isFinite(g.longitude) && !(g.latitude === 0 && g.longitude === 0)) {
          out.lat = g.latitude; out.lng = g.longitude;
        }
        return out;
      }, function () { return out; });
  }

  /** Text lines burned into the photo. */
  function stampLines(meta) {
    var lines = [displayTime(meta.capturedAt)];
    if (meta.gpsAvailable) {
      lines.push('GPS: ' + meta.latitude.toFixed(5) + ', ' + meta.longitude.toFixed(5) +
        (meta.accuracy !== '' && meta.accuracy != null ? '  ±' + Math.round(meta.accuracy) + ' m' : ''));
    } else {
      lines.push('GPS tidak tersedia');
    }
    if (meta.fromGalleryLabel) lines.push('Dari galeri');
    return lines;
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Gambar tidak dapat dibaca.')); };
      img.src = url; // browsers apply EXIF orientation when drawing
    });
  }

  function toBlob(canvas, q) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('Gagal simpan gambar.')); }, 'image/jpeg', q);
      } else {
        var data = atob(canvas.toDataURL('image/jpeg', q).split(',')[1]);
        var arr = new Uint8Array(data.length);
        for (var i = 0; i < data.length; i++) arr[i] = data.charCodeAt(i);
        resolve(new Blob([arr], { type: 'image/jpeg' }));
      }
    });
  }

  function drawStamp(ctx, w, h, lines) {
    var fs = Math.max(16, Math.round(Math.max(w, h) * 0.024));
    var pad = Math.round(fs * 0.55);
    var lh = Math.round(fs * 1.3);
    ctx.font = '600 ' + fs + 'px -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
    var tw = 0;
    lines.forEach(function (l) { tw = Math.max(tw, ctx.measureText(l).width); });
    var bw = Math.ceil(tw + pad * 2);
    var bh = lh * lines.length + pad * 2 - (lh - fs);
    var x = w - bw, y = h - bh;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y, bw, bh);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    lines.forEach(function (l, i) { ctx.fillText(l, x + pad, y + pad + i * lh); });
    return { x: x, y: y, w: bw, h: bh };
  }

  /**
   * @param {File|Blob} file
   * @param {object} o  { source: 'Camera'|'Gallery', getDeviceGps: () => Promise<{lat,lng,acc}|null>, now?: Date,
   *                     maxSide?: px (long side), quality?: JPEG 0-1 }  — watermark text size scales with the long side
   * @returns Promise<{ full: Blob, thumb: Blob, meta, stamp: {lines, box}, width, height }>
   */
  function process(file, o) {
    var source = o.source === 'Gallery' ? 'Gallery' : 'Camera';
    var now = o.now || new Date();
    var exifP = source === 'Gallery' ? readExif(file) : Promise.resolve({});
    return exifP.then(function (ex) {
      var needDeviceGps = !(isFinite(ex.lat) && isFinite(ex.lng));
      var gpsP = needDeviceGps ? Promise.resolve(o.getDeviceGps ? o.getDeviceGps() : null).catch(function () { return null; })
        : Promise.resolve(null);
      return gpsP.then(function (dev) {
        var meta = { source: source, timeFrom: 'device', gpsFrom: 'none', fromGalleryLabel: false };
        if (source === 'Gallery' && ex.time) { meta.capturedAt = ex.time; meta.timeFrom = 'exif'; }
        else meta.capturedAt = klIso(now);
        if (!needDeviceGps) {
          meta.latitude = ex.lat; meta.longitude = ex.lng; meta.accuracy = ex.acc != null ? ex.acc : '';
          meta.gpsAvailable = true; meta.gpsFrom = 'exif';
        } else if (dev && isFinite(dev.lat) && isFinite(dev.lng)) {
          meta.latitude = dev.lat; meta.longitude = dev.lng; meta.accuracy = dev.acc != null ? dev.acc : '';
          meta.gpsAvailable = true; meta.gpsFrom = 'device';
        } else {
          meta.latitude = ''; meta.longitude = ''; meta.accuracy = ''; meta.gpsAvailable = false;
        }
        if (source === 'Gallery' && (meta.timeFrom !== 'exif' || meta.gpsFrom !== 'exif')) meta.fromGalleryLabel = true;
        return loadImage(file).then(function (li) {
          var iw = li.img.naturalWidth, ih = li.img.naturalHeight;
          var maxSide = o.maxSide || MAX_SIDE;
          var scale = Math.min(1, maxSide / Math.max(iw, ih));
          var w = Math.round(iw * scale), h = Math.round(ih * scale);
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          var ctx = c.getContext('2d');
          ctx.drawImage(li.img, 0, 0, w, h);
          URL.revokeObjectURL(li.url);
          var lines = stampLines(meta);
          var box = drawStamp(ctx, w, h, lines);
          var ts = Math.min(1, THUMB_SIDE / Math.max(w, h));
          var t = document.createElement('canvas');
          t.width = Math.round(w * ts); t.height = Math.round(h * ts);
          t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
          var rs = Math.min(1, REPORT_SIDE / Math.max(w, h));
          var rc = document.createElement('canvas');
          rc.width = Math.round(w * rs); rc.height = Math.round(h * rs);
          var rctx = rc.getContext('2d');
          rctx.imageSmoothingQuality = 'high';
          rctx.drawImage(c, 0, 0, rc.width, rc.height); // made from the watermarked photo: the stamp is in the report too
          return Promise.all([toBlob(c, o.quality || QUALITY), toBlob(t, 0.7), toBlob(rc, REPORT_QUALITY)]).then(function (b) {
            rc.width = rc.height = 0;
            c.width = c.height = 0; // free memory on iPhone
            return { full: b[0], thumb: b[1], report: b[2], meta: meta, stamp: { lines: lines, box: box }, width: w, height: h,
              reportWidth: Math.round(w * rs), reportHeight: Math.round(h * rs) };
          });
        });
      });
    });
  }

  // ---------------- GPS ----------------
  /** Keeps a GPS watch running while the pole screen is open; getFix waits up to 15 s. */
  function GpsTracker() {
    this.watchId = null;
    this.last = null;
    this.denied = false;
    this.waiters = [];
  }
  GpsTracker.prototype.start = function () {
    var self = this;
    if (this.watchId !== null || !navigator.geolocation) return;
    this.watchId = navigator.geolocation.watchPosition(function (pos) {
      self.last = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now() };
      var w = self.waiters; self.waiters = [];
      w.forEach(function (fn) { fn(self.last); });
    }, function (err) {
      if (err && err.code === 1) {
        self.denied = true;
        var w = self.waiters; self.waiters = [];
        w.forEach(function (fn) { fn(null); });
      }
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  };
  GpsTracker.prototype.stop = function () {
    if (this.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  };
  GpsTracker.prototype.getFix = function (timeoutMs, maxAgeMs) {
    var self = this;
    timeoutMs = timeoutMs || 15000;
    maxAgeMs = maxAgeMs || 30000;
    this.start();
    if (this.last && Date.now() - this.last.t <= maxAgeMs) return Promise.resolve(this.last);
    if (this.denied || !navigator.geolocation) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, timeoutMs);
      self.waiters.push(function (fix) { if (!done) { done = true; clearTimeout(timer); resolve(fix); } });
    });
  };

  return { process: process, stampLines: stampLines, klIso: klIso, displayTime: displayTime, exifToIso: exifToIso, readExif: readExif, GpsTracker: GpsTracker };
})();
