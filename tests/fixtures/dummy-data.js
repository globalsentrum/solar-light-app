'use strict';
/*
 * DUMMY project data for tests — NOT the real pole list (real data stays private).
 * Same shape and the same totals as the real project (123 = 33 + 44 + 46, EB 54 / WB 69,
 * 51 "CH belum tepat"), but every chainage and date here is made up.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function dummyRows() {
  const rows = [];
  for (let n = 1; n <= 123; n++) {
    const id = 'SL-' + String(n).padStart(3, '0');
    let workArea, ch, date = null;
    if (n <= 33) { workArea = 'Installed'; ch = 'CH.' + (10000 + n * 37); }
    else if (n <= 77) {
      workArea = 'Non-widening';
      ch = n >= 56 && n <= 60 ? 'CH.20100 – CH.20300' : 'CH.' + (20000 + n * 41);
      if (n % 3 !== 0) date = 46395 + (n % 5); // dummy Excel serial dates
    } else { workArea = 'Widening'; ch = 'CH.' + (30000 + n * 10) + ' – CH.' + (30000 + n * 10 + 100); }
    const bound = n % 9 < 4 ? 'EB' : 'WB';
    rows.push([n, id, 'Zone X', bound, ch, workArea, 'x', date, null, null, null]);
  }
  // force the real bound totals (EB 54 / WB 69) with dummy assignment
  let eb = rows.filter((r) => r[3] === 'EB').length;
  for (let i = 0; eb !== 54 && i < rows.length; i++) {
    if (eb < 54 && rows[i][3] === 'WB') { rows[i][3] = 'EB'; eb++; } else if (eb > 54 && rows[i][3] === 'EB') { rows[i][3] = 'WB'; eb--; }
  }
  return rows;
}

/** Write a dummy planning xlsx with the same sheet layout as the real one. */
function writeDummyXlsx(file) {
  const aoa = [['DUMMY PLAN'], ['dummy'], ['dummy'], [],
    ['No.', 'Light ID', 'Zone', 'Bound', 'Chainage / Location', 'Work Area', 'Installation Status', 'Planned Start Date',
      'Planned Completion Date', 'Actual Completion Date', 'Remarks / Site Readiness']].concat(dummyRows());
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Installation Plan');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  XLSX.writeFile(wb, file);
  return file;
}

/** Dummy SeedData.gs text for the Apps Script mock. */
function dummySeedGs() {
  const { readPoles, seedDataGs } = require('../../scripts/import-xlsx.js');
  const os = require('os');
  const f = writeDummyXlsx(path.join(os.tmpdir(), 'solar-dummy-' + process.pid + '.xlsx'));
  return seedDataGs(readPoles(f));
}

module.exports = { dummyRows, writeDummyXlsx, dummySeedGs };
