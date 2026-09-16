#!/usr/bin/env node
/**
 * dev/run-tests.js — 순수 .gs 파일(Config/Rules/DemoData/Dashboard/Test)을 Node에서 로드해 runAllTests() 실행.
 * Apps Script 의 전역 스코프 공유를 흉내내기 위해 파일을 이어붙여 vm 으로 실행한다.
 *   node dev/run-tests.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const PURE_FILES = ['Config.gs', 'Rules.gs', 'DemoData.gs', 'Dashboard.gs', 'Test.gs'];

function loadPure() {
  const code = PURE_FILES.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n;\n');
  const ctx = { console, Logger: { log: (s) => console.log(String(s)) } };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'pure.gs' });
  return ctx;
}

if (require.main === module) {
  const ctx = loadPure();
  const r = ctx.runAllTests();
  process.exitCode = r.passed === r.total ? 0 : 1;
}

module.exports = { loadPure };
