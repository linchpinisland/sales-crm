#!/usr/bin/env node
/**
 * dev/preview.js — Apps Script 없이 웹앱 UI를 로컬에서 미리보기.
 *   node dev/preview.js  → http://localhost:8787
 * Index.html 의 <?!= include('X') ?> 를 치환해 서빙하고, /api/<name> 을 순수 함수 + 메모리 데이터로 흉내낸다.
 * 카카오·Drive·메일은 스텁(오류 또는 가짜 응답).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadPure } = require('./run-tests');

const SRC = path.join(__dirname, '..', 'src');
const PORT = Number(process.env.PORT) || 8787;
const G = loadPure();

// ── 메모리 데이터 ──
const today = new Date();
const store = G.buildDemoData(today);
const settings = {};
G.DEFAULT_SETTINGS.forEach(r => { settings[r[0]] = r[1]; });
const rules = G.defaultRuleObjects();
let kakao = { status: '', connectedAt: '', refreshExpiresAt: '', lastError: '', restKeySet: false, redirectUri: '' };

function nextId(list, field, prefix, width) {
  let max = 0;
  list.forEach(o => { const m = String(o[field] || '').match(new RegExp('^' + prefix + '(\\d+)$')); if (m) max = Math.max(max, +m[1]); });
  return prefix + String(max + 1).padStart(width, '0');
}
function refreshLast(id) {
  store.customers.forEach(c => { if (!id || c['고객ID'] === id) c['마지막연락일'] = G.computeLastContact(c['고객ID'], store.contacts, store.purchases, c['마지막연락일']); });
}
function resolveRefs(obj) {
  const byName = store.customers.find(c => c['고객명'] === String(obj['고객명'] || '').trim());
  if (byName) { obj['고객ID'] = byName['고객ID']; obj['고객명'] = byName['고객명']; }
  return obj;
}
function immediate(sheet, row) {
  const imm = rules.filter(r => G.yn_(r['사용']) && G.yn_(r['즉시발송']));
  if (!imm.length) return [];
  const data = { customers: store.customers, contacts: [], purchases: [] };
  if (sheet === '고객') data.customers = [row]; else if (sheet === '상담기록') data.contacts = [row]; else data.purchases = [row];
  return G.evaluateRules(data, imm, today, { onlyImmediate: true });
}

const API = {
  api_getDashboard() {
    const cands = G.evaluateRules(store, rules, today);
    const m = G.buildDashboardModel(store, cands, today);
    return Object.assign(m, { kakao, webUrl: '', demoLoaded: true, rules });
  },
  api_getCustomers() {
    const cands = G.evaluateRules(store, rules, today);
    const by = {}; cands.forEach(c => (by[c.customerId] = by[c.customerId] || []).push(c.ruleName));
    return store.customers.map(c => ({ id: c['고객ID'], name: c['고객명'], person: c['담당자'], industry: c['업종'], stage: c['단계'], intent: c['구매의향'],
      lastContact: c['마지막연락일'], days: c['마지막연락일'] ? G.daysBetween(c['마지막연락일'], today) : null, alerts: by[c['고객ID']] || [] }));
  },
  api_getCustomer(id) {
    const cust = store.customers.find(c => c['고객ID'] === id);
    if (!cust) throw new Error('고객을 찾을 수 없습니다: ' + id);
    const contacts = store.contacts.filter(c => c['고객ID'] === id).sort((a, b) => G.daysBetween(a['상담일'], b['상담일']));
    const purchases = store.purchases.filter(p => p['고객ID'] === id).sort((a, b) => G.daysBetween(a['구매일'], b['구매일']));
    const alerts = G.evaluateRules({ customers: [cust], contacts, purchases }, rules, today);
    return { customer: cust, contacts, purchases, alerts, totalSales: purchases.reduce((s, p) => s + (Number(p['금액']) || 0), 0),
      days: cust['마지막연락일'] ? G.daysBetween(cust['마지막연락일'], today) : null };
  },
  api_saveCustomer(obj) {
    if (!String(obj['고객명'] || '').trim()) throw new Error('고객명은 필수입니다.');
    let saved;
    if (obj['고객ID']) {
      saved = store.customers.find(c => c['고객ID'] === obj['고객ID']);
      if (!saved) throw new Error('수정할 고객을 찾을 수 없습니다.');
      if (saved['단계'] !== obj['단계']) obj['단계변경일'] = G.fmtDate(today);
      Object.assign(saved, obj);
    } else {
      saved = Object.assign({}, obj, { '고객ID': nextId(store.customers, '고객ID', 'C', 3), '등록일': G.fmtDate(today), '단계변경일': G.fmtDate(today) });
      store.customers.push(saved);
    }
    return { customer: saved, immediate: immediate('고객', saved) };
  },
  api_addContact(obj) {
    resolveRefs(obj);
    if (!obj['고객ID']) throw new Error('고객을 선택하세요.');
    const saved = Object.assign({}, obj, { '기록ID': nextId(store.contacts, '기록ID', 'L', 4), '상담일': obj['상담일'] || G.fmtDate(today), '등록일시': G.fmtDate(today) });
    store.contacts.push(saved); refreshLast(obj['고객ID']);
    return { contact: saved, immediate: immediate('상담기록', saved) };
  },
  api_addPurchase(obj) {
    resolveRefs(obj);
    if (!obj['고객ID']) throw new Error('고객을 선택하세요.');
    obj['금액'] = Number(String(obj['금액'] || '').replace(/,/g, '')) || 0;
    if (!obj['다음구매예정일'] && obj['재구매주기(일)']) obj['다음구매예정일'] = G.fmtDate(G.addDays(obj['구매일'] || today, Number(obj['재구매주기(일)'])));
    const saved = Object.assign({}, obj, { '구매ID': nextId(store.purchases, '구매ID', 'P', 4), '구매일': obj['구매일'] || G.fmtDate(today) });
    store.purchases.push(saved); refreshLast(obj['고객ID']);
    return { purchase: saved, immediate: immediate('구매기록', saved) };
  },
  api_getLists() { return G.LISTS; },
  api_getSettings() {
    const out = {}; G.DEFAULT_SETTINGS.forEach(r => { out[r[0]] = { value: settings[r[0]] || '', desc: r[2] }; });
    return { settings: out, kakao, scriptUrl: 'http://localhost:' + PORT + '/exec', version: G.APP.VERSION + '-dev' };
  },
  api_saveSettings(map) { Object.assign(settings, map); kakao.restKeySet = !!settings['카카오 REST API 키']; kakao.redirectUri = settings['웹앱 URL']; return API.api_getSettings(); },
  api_getKakaoAuthUrl() { throw new Error('로컬 미리보기에서는 카카오 연결을 할 수 없습니다 (Apps Script 배포 후 가능)'); },
  api_kakaoDisconnect() { kakao = Object.assign({}, kakao, { status: '', connectedAt: '' }); return kakao; },
  api_sendKakaoTest() { throw new Error('로컬 미리보기: 카카오 발송 스텁'); },
  api_runDailyNow() { const c = G.evaluateRules(store, rules, today); return { count: c.length, channel: 'mock', ok: true, chunks: G.buildDailySummary(c, { today }) }; },
  api_dryRun() {
    const c = G.evaluateRules(store, rules, today);
    return { candidates: c, chunks: G.buildDailySummary(c, { today, maxItems: parseInt(settings['요약 최대 건수'], 10) || 15, userName: settings['사용자 이름'] || '' }) };
  },
  api_exportCsv() { return { url: 'https://drive.google.com/#mock', name: '고객관리 내보내기 ' + G.fmtDate(today) + ' (mock)' }; }
};

function assembleIndex() {
  let html = fs.readFileSync(path.join(SRC, 'Index.html'), 'utf8');
  html = html.replace(/<\?!= include\('([^']+)'\) \?>/g, (_, name) => fs.readFileSync(path.join(SRC, name + '.html'), 'utf8'));
  html = html.replace(/<\?= appVersion \?>/g, G.APP.VERSION + '-dev');
  return html;
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/')) {
    const name = req.url.slice(5);
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        if (!API[name]) throw new Error('unknown api ' + name);
        const args = body ? JSON.parse(body) : [];
        const out = API[name].apply(null, args);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out === undefined ? null : out));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(assembleIndex());
}).listen(PORT, () => console.log('preview: http://localhost:' + PORT));
