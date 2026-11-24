/*
 * In-memory imitation of the Google Apps Script services used by apps-script/Code.gs,
 * so the real backend code can be run and tested in Node (unit tests + browser E2E server).
 * Only the methods the backend actually calls are implemented.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function toBuf(x) {
  if (Buffer.isBuffer(x)) return x;
  if (typeof x === 'string') return Buffer.from(x, 'utf8');
  return Buffer.from(x.map((b) => b & 255));
}

class Blob {
  constructor(bytes, mime, name) { this.buf = toBuf(bytes || []); this.mime = mime || 'application/octet-stream'; this.name = name || ''; }
  getBytes() { return Array.from(this.buf); }
  getDataAsString() { return this.buf.toString('utf8'); }
  getContentType() { return this.mime; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
}

let dummySeedCache = null;
function dummySeed() { return dummySeedCache || (dummySeedCache = require('./fixtures/dummy-data').dummySeedGs()); }

function makeIter(arr) { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; }

function createRuntime(opts) {
  opts = opts || {};
  if (opts.state) return attachCode(opts.state, opts);
  const state = { sheets: {}, files: {}, folders: {}, props: {}, docs: {}, seq: 0, urlFetch: opts.urlFetch || null, ownerEmail: opts.ownerEmail || 'owner@example.com' };
  const nextId = (p) => p + (++state.seq).toString().padStart(6, '0') + crypto.randomBytes(3).toString('hex');

  // ---------------- Spreadsheet ----------------
  class Range {
    constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = this.sh.data[this.r - 1 + i] || [];
        const o = [];
        for (let j = 0; j < this.nc; j++) { const v = row[this.c - 1 + j]; o.push(v === undefined ? '' : v); }
        out.push(o);
      }
      return out;
    }
    getValue() { return this.getValues()[0][0]; }
    setValues(vals) {
      if (vals.length !== this.nr || vals.some((r) => r.length !== this.nc)) throw new Error('setValues dimension mismatch');
      vals.forEach((row, i) => {
        const ri = this.r - 1 + i;
        while (this.sh.data.length <= ri) this.sh.data.push([]);
        row.forEach((v, j) => { this.sh.data[ri][this.c - 1 + j] = v; });
      });
      return this;
    }
    setValue(v) { return this.setValues([[v]]); }
    setNumberFormat() { return this; }
  }
  class Sheet {
    constructor(name) { this.name = name; this.data = []; this.frozen = 0; }
    getName() { return this.name; }
    setName(n) { delete state.sheets[this.name]; this.name = n; state.sheets[n] = this; return this; }
    getLastRow() {
      for (let i = this.data.length - 1; i >= 0; i--) if ((this.data[i] || []).some((v) => v !== '' && v !== undefined && v !== null)) return i + 1;
      return 0;
    }
    getLastColumn() { let m = 0; this.data.forEach((r) => { for (let j = r.length - 1; j >= 0; j--) if (r[j] !== '' && r[j] !== undefined) { m = Math.max(m, j + 1); break; } }); return m; }
    getMaxRows() { return Math.max(1000, this.data.length); }
    getMaxColumns() { return 26; }
    getRange(r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); }
    appendRow(arr) { this.data.splice(this.getLastRow(), 0, arr.slice()); return this; }
    deleteRow(r) { this.data.splice(r - 1, 1); return this; }
    setFrozenRows(n) { this.frozen = n; return this; }
    rowsAsObjects() {
      const [h, ...rest] = this.data;
      return rest.filter((r) => r && r[0] !== '' && r[0] !== undefined).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]])));
    }
  }
  const spreadsheet = {
    getSheetByName: (n) => state.sheets[n] || null,
    insertSheet: (n) => (state.sheets[n] = new Sheet(n)),
  };
  state.tempSheets = {};
  const SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
    flush() {},
    create(name) {
      const id = nextId('F');
      state.files[id] = new File(id, name, 'application/vnd.google-apps.spreadsheet', Buffer.alloc(0), 'ROOT');
      const sh = new Sheet('Sheet1');
      sh.setName = function (n) { this.name = n; return this; };
      state.tempSheets[id] = sh;
      return { getId: () => id, getSheets: () => [sh] };
    },
  };

  // ---------------- Drive ----------------
  class File {
    constructor(id, name, mime, buf, parent) { Object.assign(this, { id, name, mime, buf, parent, trashed: false }); }
    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return 'https://drive.google.com/file/d/' + this.id + '/view'; }
    getBlob() { return new Blob(this.buf, this.mime, this.name); }
    setName(n) { this.name = n; return this; }
    getSize() { return this.buf.length; }
    setTrashed(t) { this.trashed = !!t; return this; }
    moveTo(folder) {
      if (state.failMoveAfter !== undefined && state.failMoveAfter !== null) {
        if (state.failMoveAfter <= 0) { state.failMoveAfter = null; throw new Error('Drive error (simulated)'); }
        state.failMoveAfter--;
      }
      this.parent = folder.id; return this;
    }
    makeCopy(name, folder) {
      const id = nextId('F');
      const f = (state.files[id] = new File(id, name, this.mime, Buffer.from(this.buf), folder ? folder.id : this.parent));
      if (state.docs[this.id]) state.docs[id] = JSON.parse(JSON.stringify(state.docs[this.id]));
      return f;
    }
    getAs(mime) {
      if (mime === 'application/pdf' && state.docs[this.id]) {
        if (!state.docs[this.id].saved) throw new Error('Doc exported before saveAndClose()');
        return new Blob(Buffer.from('%PDF-MOCK\n' + JSON.stringify(state.docs[this.id])), 'application/pdf', this.name + '.pdf');
      }
      throw new Error('getAs not supported for ' + this.mime);
    }
  }
  class Folder {
    constructor(id, name, parent) { Object.assign(this, { id, name, parent }); }
    getId() { return this.id; }
    getName() { return this.name; }
    getFoldersByName(n) { return makeIter(Object.values(state.folders).filter((f) => f.parent === this.id && f.name === n && !f.trashed)); }
    createFolder(n) { const id = nextId('D'); return (state.folders[id] = new Folder(id, n, this.id)); }
    createFile(blob) { const id = nextId('F'); return (state.files[id] = new File(id, blob.name, blob.mime, Buffer.from(blob.buf), this.id)); }
    getFiles() { return makeIter(Object.values(state.files).filter((f) => f.parent === this.id && !f.trashed)); }
    getFilesByName(n) { return makeIter(Object.values(state.files).filter((f) => f.parent === this.id && !f.trashed && f.name === n)); }
    getFolders() { return makeIter(Object.values(state.folders).filter((f) => f.parent === this.id && !f.trashed)); }
    setName(n) { this.name = n; return this; }
    setTrashed(t) { this.trashed = !!t; return this; }
  }
  const rootFolder = new Folder('ROOT', 'My Drive', null);
  state.folders.ROOT = rootFolder;
  const DriveApp = {
    createFolder: (n) => rootFolder.createFolder(n),
    getFolderById: (id) => { if (!state.folders[id]) throw new Error('No folder ' + id); return state.folders[id]; },
    getFileById: (id) => { if (!state.files[id]) throw new Error('No file ' + id); return state.files[id]; },
  };

  // ---------------- Documents (records the structure; "PDF"/"DOCX" = JSON of it) ----------------
  // STRICT: any method not implemented here throws, so Code.gs can only use methods whose real
  // return values are copied here (e.g. Paragraph.setText returns nothing).
  function strict(target, what) {
    return new Proxy(target, {
      get(t, k) {
        if (k in t || typeof k === 'symbol' || k === 'then' || k === 'toJSON') return t[k];
        throw new Error('Docs mock: ' + what + '.' + String(k) + '() not implemented — check the real Apps Script API');
      },
    });
  }
  function jpegSize(buf) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { w: 1600, h: 1200 };
  }
  const textObj = (node) => { const o = strict({ setFontSize: (n) => { node.size = n; return o; }, setBold: (v) => { node.bold = v; return o; } }, 'Text'); return o; };
  function wrapParagraph(node) {
    const p = strict({
      _node: node,
      setText(t) { node.text = t; node.images = []; return undefined; }, // real API returns void
      getText() { return node.text; },
      appendText(t) { node.text += t; return textObj(node); },
      setHeading(h) { node.heading = h; return p; },
      setAlignment(a) { node.align = a; return p; },
      asParagraph() { return p; },
      editAsText() { return textObj(node); },
      appendInlineImage(blob) {
        const sz = blob.buf[0] === 0xff ? jpegSize(blob.buf) : { w: 1600, h: 1200 };
        const img = { name: blob.name, w: sz.w, h: sz.h, natural: { w: sz.w, h: sz.h } };
        node.images.push(img);
        const ii = strict({
          getWidth: () => img.w, getHeight: () => img.h,
          setWidth(w) { img.w = w; return ii; }, setHeight(h) { img.h = h; return ii; },
        }, 'InlineImage');
        return ii;
      },
    }, 'Paragraph');
    return p;
  }
  const newPara = (t) => ({ type: 'p', text: t || '', images: [] });
  function wrapTable(n) {
    const tbl = strict({
      setBorderWidth(w) { n.border = w; return tbl; },
      setColumnWidth(i, w) { (n.colWidths = n.colWidths || [])[i] = w; return tbl; },
      getNumRows: () => n.rows.length,
      getRow: (ri) => {
        const row = strict({ getCell: (ci) => wrapContainer(n.rows[ri][ci], 'TableCell'),
          setMinimumHeight: (h) => { (n.minHeights = n.minHeights || [])[ri] = h; return row; } }, 'TableRow');
        return row;
      },
    }, 'Table');
    return tbl;
  }
  function makeTable(cells) {
    return { type: 'table', border: 1, rows: cells.map((r) => r.map((c) => ({ children: [newPara(c)] }))) };
  }
  /** Body or TableCell */
  function wrapContainer(holder, kind) {
    const ch = holder.children;
    const api = {
      getNumChildren: () => ch.length,
      getChild: (i) => (ch[i].type === 'table' ? wrapTable(ch[i]) : wrapParagraph(ch[i])),
      getChildIndex: (el) => ch.indexOf(el._node),
      appendParagraph: (t) => { const n = newPara(t); ch.push(n); return wrapParagraph(n); },
      appendTable: (cells) => { const n = makeTable(cells); ch.push(n); if (kind === 'TableCell') ch.push(newPara('')); return wrapTable(n); },
    };
    if (kind === 'TableCell') {
      api.setBackgroundColor = (c) => { holder.bg = c; return wrapContainer(holder, kind); };
      api.setVerticalAlignment = (v) => { holder.valign = v; return wrapContainer(holder, kind); };
    } else {
      const self = () => body;
      api.appendPageBreak = () => { ch.push({ type: 'pagebreak' }); return strict({}, 'PageBreak'); };
      ['setMarginTop', 'setMarginBottom', 'setMarginLeft', 'setMarginRight'].forEach((k) => { api[k] = (v) => { holder[k] = v; return self(); }; });
      api.setPageWidth = (v) => { holder.pageWidth = v; return self(); };
      api.setPageHeight = (v) => { holder.pageHeight = v; return self(); };
    }
    const body = strict(api, kind);
    return body;
  }
  const DocumentApp = {
    ParagraphHeading: { HEADING1: 'H1', HEADING2: 'H2', HEADING3: 'H3' },
    HorizontalAlignment: { LEFT: 'LEFT', CENTER: 'CENTER', RIGHT: 'RIGHT' },
    VerticalAlignment: { TOP: 'TOP', CENTER: 'CENTER', BOTTOM: 'BOTTOM' },
    create(name) {
      const id = nextId('F');
      state.files[id] = new File(id, name, 'application/vnd.google-apps.document', Buffer.alloc(0), 'ROOT');
      state.docs[id] = { children: [newPara('')] };
      return DocumentApp.openById(id);
    },
    openById(id) {
      const doc = state.docs[id];
      if (!doc) throw new Error('No doc ' + id);
      return strict({ getId: () => id, getBody: () => wrapContainer(doc, 'Body'), saveAndClose() { doc.saved = true; } }, 'Document');
    },
  };
  // ---------------- Utilities etc ----------------
  const pad = (n, l) => String(n).padStart(l || 2, '0');
  const Utilities = {
    newBlob: (bytes, mime, name) => new Blob(bytes, mime, name),
    base64Encode: (x) => toBuf(x).toString('base64'),
    base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
    base64EncodeWebSafe: (x) => toBuf(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64DecodeWebSafe: (s) => Array.from(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    computeHmacSha256Signature: (v, k) => Array.from(crypto.createHmac('sha256', k).update(v).digest()),
    getUuid: () => crypto.randomUUID(),
    formatDate(date, tz, pattern) {
      if (tz !== 'Asia/Kuala_Lumpur') throw new Error('mock only supports Asia/Kuala_Lumpur');
      const d = new Date(date.getTime() + 8 * 3600000);
      const map = { yyyy: d.getUTCFullYear(), MM: pad(d.getUTCMonth() + 1), dd: pad(d.getUTCDate()), HH: pad(d.getUTCHours()), mm: pad(d.getUTCMinutes()), ss: pad(d.getUTCSeconds()), XXX: '+08:00' };
      let out = '', i = 0;
      while (i < pattern.length) {
        if (pattern[i] === "'") { const j = pattern.indexOf("'", i + 1); out += pattern.slice(i + 1, j); i = j + 1; continue; }
        const tok = ['yyyy', 'XXX', 'MM', 'dd', 'HH', 'mm', 'ss'].find((t) => pattern.startsWith(t, i));
        if (tok) { out += map[tok]; i += tok.length; } else { out += pattern[i++]; }
      }
      return out;
    },
  };
  const PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (k in state.props ? state.props[k] : null), setProperty: (k, v) => { state.props[k] = String(v); } }) };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (s) => { const o = { content: s, getContent: () => s, setMimeType: () => o }; return o; },
  };
  const HtmlService = {
    createHtmlOutput: (h) => { const o = { content: h, getContent: () => h, setTitle: () => o, addMetaTag: () => o }; return o; },
  };
  const UrlFetchApp = {
    fetch(url, o) {
      const xs = url.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([^/]+)\/export\?format=xlsx$/);
      if (xs) {
        if (!o || !o.headers || o.headers.Authorization !== 'Bearer mock-oauth-token') return { getResponseCode: () => 401, getContentText: () => '', getBlob: () => null };
        const XLSX = require('xlsx');
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(state.tempSheets[xs[1]].data), 'Sheet1');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        return { getResponseCode: () => 200, getContentText: () => '', getBlob: () => new Blob(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'export.xlsx') };
      }
      const ex = url.match(/^https:\/\/docs\.google\.com\/document\/d\/([^/]+)\/export\?format=docx$/);
      if (ex) {
        if (!o || !o.headers || o.headers.Authorization !== 'Bearer mock-oauth-token') return { getResponseCode: () => 401, getContentText: () => '', getBlob: () => null };
        const doc = state.docs[ex[1]];
        if (!doc || !doc.saved) return { getResponseCode: () => 404, getContentText: () => '', getBlob: () => null };
        const buf = Buffer.from('DOCX-MOCK\n' + JSON.stringify(doc));
        return { getResponseCode: () => 200, getContentText: () => buf.toString(), getBlob: () => new Blob(buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'export.docx') };
      }
      if (!state.urlFetch) throw new Error('UrlFetchApp not mocked');
      const r = state.urlFetch(url, o);
      return { getResponseCode: () => r.code, getContentText: () => r.body };
    },
  };
  const ScriptApp = { getOAuthToken: () => 'mock-oauth-token' };
  const Session = { getEffectiveUser: () => ({ getEmail: () => state.ownerEmail }) };

  state.__services = {
    SpreadsheetApp,
    DriveApp, DocumentApp, ScriptApp, Utilities, PropertiesService, LockService, ContentService, HtmlService, UrlFetchApp, Session,
    console: { log() {}, error: (...a) => (opts.verbose ? console.error(...a) : undefined) },
    Logger: { log() {} },
  };
  state.__Blob = Blob;
  return attachCode(state, opts);
}

/**
 * Load Apps Script code into a fresh context that uses the services/state given.
 * opts.codeDir: folder with Code.gs + Logic.gs (default apps-script/). Used to run the real v2 code and then
 * the v3 code on the SAME data (migration tests).
 */
function attachCode(state, opts) {
  const sandbox = Object.assign({}, state.__services);
  vm.createContext(sandbox);
  const dir = opts.codeDir || path.join(__dirname, '..', 'apps-script');
  // Load in the "wrong" order on purpose (Code.gs first), like a fresh Apps Script project could.
  ['Code.gs', 'Logic.gs'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f }));
  // Tests use DUMMY poles (tests/fixtures/dummy-data.js), never the private SeedData.gs.
  vm.runInContext(opts.seedGs || dummySeed(), sandbox, { filename: 'SeedData.gs' });
  return { g: sandbox, state, Blob: state.__Blob };
}

module.exports = { createRuntime };
