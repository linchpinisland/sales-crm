#!/usr/bin/env node
/**
 * dev/export-demo-csv.js — 데모 데이터를 demo/ 폴더에 CSV 3개로 내보낸다 (스킬 테스트용).
 *   node dev/export-demo-csv.js [YYYY-MM-DD]
 */
const fs = require('fs');
const path = require('path');
const { loadPure } = require('./run-tests');

const G = loadPure();
const today = process.argv[2] || G.fmtDate(new Date());
const data = G.buildDemoData(today);
const OUT = path.join(__dirname, '..', 'demo');
fs.mkdirSync(OUT, { recursive: true });

function csv(headers, rows) {
  const q = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '﻿' + [headers.join(',')].concat(rows.map(r => headers.map(h => q(r[h])).join(','))).join('\r\n') + '\r\n';
}
[['고객', data.customers], ['상담기록', data.contacts], ['구매기록', data.purchases]].forEach(([name, rows]) => {
  fs.writeFileSync(path.join(OUT, name + '.csv'), csv(G.HEADERS[name], rows), 'utf8');
  console.log(name + '.csv', rows.length + '행');
});
console.log('기준일', today, '→', OUT);
