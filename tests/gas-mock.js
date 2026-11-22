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

function makeIter(arr) { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; }

function createRuntime(opts) {
  opts = opts || {};
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

  // ---------------- Drive ----------------
  class File {
    constructor(id, name, mime, buf, parent) { Object.assign(this, { id, name, mime, buf, parent, trashed: false }); }
    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return 'https://drive.google.com/file/d/' + this.id + '/view'; }
    getBlob() { return new Blob(this.buf, this.mime, this.name); }
    setTrashed(t) { this.trashed = !!t; return this; }
    moveTo(folder) { this.parent = folder.id; return this; }
    makeCopy(name, folder) {
      const id = nextId('F');
      const f = (state.files[id] = new File(id, name, this.mime, Buffer.from(this.buf), folder ? folder.id : this.parent));
      if (state.docs[this.id]) state.docs[id] = JSON.parse(JSON.stringify(state.docs[this.id]));
      return f;
    }
    getAs(mime) {
      if (mime === 'application/pdf' && state.docs[this.id]) {
        return new Blob(Buffer.from('%PDF-MOCK\n' + JSON.stringify(state.docs[this.id])), 'application/pdf', this.name + '.pdf');
      }
      throw new Error('getAs not supported for ' + this.mime);
    }
  }
  class Folder {
    constructor(id, name, parent) { Object.assign(this, { id, name, parent }); }
    getId() { return this.id; }
    getName() { return this.name; }
    getFoldersByName(n) { return makeIter(Object.values(state.folders).filter((f) => f.parent === this.id && f.name === n)); }
    createFolder(n) { const id = nextId('D'); return (state.folders[id] = new Folder(id, n, this.id)); }
    createFile(blob) { const id = nextId('F'); return (state.files[id] = new File(id, blob.name, blob.mime, Buffer.from(blob.buf), this.id)); }
    getFiles() { return makeIter(Object.values(state.files).filter((f) => f.parent === this.id && !f.trashed)); }
  }
  const rootFolder = new Folder('ROOT', 'My Drive', null);
  state.folders.ROOT = rootFolder;
  const DriveApp = {
    createFolder: (n) => rootFolder.createFolder(n),
    getFolderById: (id) => { if (!state.folders[id]) throw new Error('No folder ' + id); return state.folders[id]; },
    getFileById: (id) => { if (!state.files[id]) throw new Error('No file ' + id); return state.files[id]; },
  };

  // ---------------- Documents (records structure; "PDF" = JSON of it) ----------------
  function chain(target) {
    return new Proxy(target, { get(t, k) { if (k in t) return t[k]; return () => chain(t); } });
  }
  function jpegSize(buf) {
    // minimal SOF parser so InlineImage reports real width/height
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { w: 1600, h: 1200 };
  }
  function makeParagraph(store, text) {
    const node = { type: 'p', text: text || '', images: [] };
    store.push(node);
    return wrapParagraph(node);
  }
  function wrapParagraph(node) {
    const p = chain({
      _node: node,
      setText(t) { node.text = t; return p; },
      getText() { return node.text; },
      setHeading(h) { node.heading = h; return p; },
      asParagraph() { return p; },
      editAsText() { return chain({}); },
      appendInlineImage(blob) {
        const sz = blob.buf[0] === 0xff ? jpegSize(blob.buf) : { w: 1600, h: 1200 };
        const img = { name: blob.name, w: sz.w, h: sz.h };
        node.images.push(img);
        const ii = chain({
          getWidth: () => img.w, getHeight: () => img.h,
          setWidth(w) { img.w = w; return ii; }, setHeight(h) { img.h = h; return ii; },
        });
        return ii;
      },
    });
    return p;
  }
  function wrapBody(doc) {
    const children = doc.body;
    const body = chain({
      getNumChildren: () => children.length,
      getChild: (i) => wrapParagraph(children[i]),
      getChildIndex: (p) => children.indexOf(p._node),
      appendParagraph: (t) => makeParagraph(children, t),
      insertParagraph(i, t) { const n = { type: 'p', text: t, images: [] }; children.splice(i, 0, n); return wrapParagraph(n); },
      insertPageBreak(i) { children.splice(i, 0, { type: 'pagebreak' }); return chain({}); },
      insertTable(i, cells) {
        const n = { type: 'table', rows: cells.map((r) => r.map((c) => ({ paras: [{ type: 'p', text: c, images: [] }] }))) };
        children.splice(i, 0, n);
        const tbl = chain({
          getRow: (ri) => chain({
            getCell: (ci) => {
              const cell = n.rows[ri][ci];
              return chain({ getChild: (k) => wrapParagraph(cell.paras[k]), appendParagraph: (t) => makeParagraph(cell.paras, t) });
            },
          }),
        });
        return tbl;
      },
      replaceText(pat, rep) {
        const re = new RegExp(pat, 'g');
        const walk = (n) => { if (n.type === 'p') n.text = n.text.replace(re, rep); if (n.type === 'table') n.rows.forEach((r) => r.forEach((c) => c.paras.forEach(walk))); };
        children.forEach(walk);
        return body;
      },
      findText(pat) {
        const re = new RegExp(pat);
        const n = children.find((c) => c.type === 'p' && re.test(c.text));
        if (!n) return null;
        return { getElement: () => ({ getParent: () => wrapParagraph(n) }) };
      },
    });
    return body;
  }
  const DocumentApp = {
    ParagraphHeading: { HEADING1: 'H1', HEADING2: 'H2', HEADING3: 'H3' },
    create(name) {
      const id = nextId('F');
      state.files[id] = new File(id, name, 'application/vnd.google-apps.document', Buffer.alloc(0), 'ROOT');
      state.docs[id] = { body: [{ type: 'p', text: '', images: [] }] };
      return DocumentApp.openById(id);
    },
    openById(id) {
      const doc = state.docs[id];
      if (!doc) throw new Error('No doc ' + id);
      return chain({ getId: () => id, getBody: () => wrapBody(doc), getHeader: () => null, getFooter: () => null, saveAndClose() {} });
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
      if (!state.urlFetch) throw new Error('UrlFetchApp not mocked');
      const r = state.urlFetch(url, o);
      return { getResponseCode: () => r.code, getContentText: () => r.body };
    },
  };
  const Session = { getEffectiveUser: () => ({ getEmail: () => state.ownerEmail }) };

  const sandbox = {
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    DriveApp, DocumentApp, Utilities, PropertiesService, LockService, ContentService, HtmlService, UrlFetchApp, Session,
    console: { log() {}, error: (...a) => (opts.verbose ? console.error(...a) : undefined) },
    Logger: { log() {} },
  };
  vm.createContext(sandbox);
  const dir = path.join(__dirname, '..', 'apps-script');
  // Load in the "wrong" order on purpose (Code.gs first), like a fresh Apps Script project could.
  if (!fs.existsSync(path.join(dir, 'SeedData.gs'))) {
    throw new Error('apps-script/SeedData.gs missing. Put the xlsx in data/ and run: npm run import');
  }
  ['Code.gs', 'Logic.gs', 'SeedData.gs'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f }));
  return { g: sandbox, state, Blob };
}

module.exports = { createRuntime };
