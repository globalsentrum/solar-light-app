#!/usr/bin/env node
/*
 * PREVIEW of the report photo pages, made locally from the SAME layout definition the Apps Script uses
 * (SolarLogic.buildReportSpec): boxed table with a grey title row, borderless photo grid, captions,
 * A4 portrait, 36 pt margins, image sizes fitted into the same boxes.
 *
 * The real reports are built by Google Docs (apps-script/Code.gs renderReport_) and exported by Google
 * to PDF/Word, so fonts and spacing can differ slightly from this preview.
 *
 *   node scripts/preview-report.js [outDir]      -> PREVIEW_<activity>.docx (+ .pdf if LibreOffice is installed)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const d = require('docx');
const L = require('../shared/logic.js');

const SAMPLES = path.join(__dirname, '..', 'tests', 'fixtures', 'report-samples');
const PT = (pt) => Math.round(pt * 20);           // points -> twips
const PX = (pt) => Math.round(pt * 96 / 72);      // points -> pixels (docx ImageRun)

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('not a jpeg');
}

/** Ten dummy poles; every photo type alternates portrait / landscape between poles (mixed in every row). */
function sampleData() {
  const file = (n, o) => path.join(SAMPLES, n + '_' + o + '.jpg');
  const files = { A1: ['peg'], B1: ['korek'], B2: ['lebar'], B3: ['panjang'], B4: ['dalam'],
    C1: ['prog1', 'prog2', 'prog3', 'prog4'], C2: ['siang'], C3: ['malam'] };
  const meas = { B2: [1.3, 1.0, 1.1, 1.05, 1.2], B3: [1.6, 1.0, 1.2, 1.0, 1.1], B4: [1.5, 1.5, 1.45, 1.5, 1.55] };
  const poles = Array.from({ length: 10 }, (_, i) => 'SSL' + String(34 + i).padStart(3, '0'));
  const photos = [];
  poles.forEach((pole, pi) => {
    Object.keys(files).forEach((t, ti) => files[t].forEach((f, k) => {
      const o = (pi + ti + k) % 2 ? 'P' : 'L';
      photos.push({ PhotoID: pole + '_' + t + '_' + k, PoleID: pole, PhotoTypeID: t, Hidden: false, RetakeFlag: false, ReportOrder: 0,
        MeasurementM: meas[t] ? meas[t][pi % 5] : '', CapturedAt: '2027-01-05T08:' + String(10 + k).padStart(2, '0') + ':00+08:00', _file: file(f, o) });
    }));
  });
  return { poles, photos };
}

function grid(block, byId) {
  const rows = [];
  const colW = PT((523 - 12) / block.columns);
  for (let i = 0; i < block.cells.length; i += block.columns) {
    const cells = [];
    for (let k = 0; k < block.columns; k++) {
      const c = block.cells[i + k];
      const kids = [];
      if (c && c.photoId) {
        const buf = fs.readFileSync(byId[c.photoId]._file);
        const sz = jpegSize(buf);
        const f = L.fitBox(sz.w, sz.h, block.box);
        kids.push(new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [new d.ImageRun({ type: 'jpg', data: buf, transformation: { width: PX(f.w), height: PX(f.h) } })] }));
      } else {
        kids.push(new d.Paragraph(''));
      }
      if (c && c.caption) {
        kids.push(new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [new d.TextRun({ text: c.caption.toUpperCase(), bold: true, size: 16 })] }));
      }
      cells.push(new d.TableCell({ width: { size: colW, type: d.WidthType.DXA }, children: kids, verticalAlign: d.VerticalAlign.CENTER }));
    }
    // same as Apps Script: every photo row has the same minimum height (photo box + caption), photos centred
    rows.push(new d.TableRow({ children: cells, height: { value: PT(block.box.h + 34), rule: d.HeightRule.ATLEAST } }));
  }
  const none = { style: d.BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  return new d.Table({ rows, columnWidths: Array(block.columns).fill(colW), width: { size: PT(523 - 12), type: d.WidthType.DXA },
    borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none } });
}

function blockTable(block, byId) {
  const inner = [new d.Paragraph({ children: [new d.TextRun({ text: '', size: 4 })] }), grid(block, byId)];
  if (block.rowCaption) inner.push(new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [new d.TextRun({ text: block.rowCaption.toUpperCase(), bold: true, size: 18 })] }));
  if (block.footer) inner.push(new d.Paragraph({ children: [new d.TextRun({ text: block.footer, bold: true, size: 18 })] }));
  const line = { style: d.BorderStyle.SINGLE, size: 8, color: '000000' };
  return new d.Table({
    width: { size: PT(523), type: d.WidthType.DXA }, columnWidths: [PT(523)],
    borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
    rows: [
      new d.TableRow({ children: [new d.TableCell({ shading: { fill: 'D9D9D9', type: d.ShadingType.CLEAR, color: 'auto' },
        children: [new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [new d.TextRun({ text: block.title, bold: true, size: 20 })] })] })] }),
      new d.TableRow({ children: [new d.TableCell({ children: inner })] }),
    ],
  });
}

async function build(activityId, poleIds, data, outDir) {
  const types = L.photoTypes();
  const byId = {};
  data.photos.forEach((p) => { byId[p.PhotoID] = p; });
  const spec = L.buildReportSpec(activityId, poleIds, types, data.photos);
  const children = [];
  spec.blocks.forEach((b, i) => {
    if (b.pageBreakBefore) children.push(new d.Paragraph({ children: [new d.PageBreak()] }));
    else if (i > 0) children.push(new d.Paragraph({ children: [new d.TextRun({ text: '', size: 12 })] }));
    children.push(blockTable(b, byId));
  });
  const doc = new d.Document({
    creator: 'Solar Karak (preview)',
    styles: { default: { document: { run: { font: 'Arial' } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } }, children }],
  });
  const key = { A: 'PEGGING', B: 'TRIALPIT', C: 'INSTALLATION' }[activityId];
  const out = path.join(outDir, 'PREVIEW_' + key + '.docx');
  fs.writeFileSync(out, await d.Packer.toBuffer(doc));
  return out;
}

async function main() {
  const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'test-output', 'report-preview'));
  fs.mkdirSync(outDir, { recursive: true });
  const data = sampleData();
  // SSL034: admin chose its 4 progress photos in a different order
  const c1 = data.photos.filter((p) => p.PoleID === 'SSL034' && p.PhotoTypeID === 'C1');
  [3, 1, 4, 2].forEach((ord, i) => { c1[i].ReportOrder = ord; });
  const files = [
    await build('A', data.poles, data, outDir),
    await build('B', data.poles, data, outDir),
    await build('C', data.poles, data, outDir),
  ];
  try {
    execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', outDir].concat(files), { stdio: 'pipe', timeout: 180000 });
  } catch (e) {
    console.warn('LibreOffice not available — only .docx previews made.');
  }
  console.log('Previews in ' + outDir);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { sampleData };
