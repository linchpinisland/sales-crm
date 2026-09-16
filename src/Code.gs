/**
 * Code.gs — 메뉴, 웹앱 라우팅(doGet), 클라이언트 API(api_*).
 * 클라이언트는 google.script.run.api_xxx(...) 로 호출. 반환값의 Date 는 모두 'YYYY-MM-DD' 문자열로 직렬화.
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu(APP.MENU)
    .addItem('① 초기 설정 실행', 'setupAll')
    .addItem('상태 점검', 'showSetupStatus')
    .addSeparator()
    .addItem('웹앱 열기', 'openWebAppUi')
    .addItem('오늘 알림 미리보기(발송 안 함)', 'dryRunDaily')
    .addItem('오늘 알림 지금 보내기', 'sendDailyNowUi')
    .addItem('마지막연락일 다시 계산', 'refreshLastContactUi')
    .addSeparator()
    .addItem('CSV 내보내기(Drive)', 'exportCsvUi')
    .addSeparator()
    .addItem('데모 데이터 넣기', 'seedDemoData')
    .addItem('데모 데이터 지우기(전체 삭제)', 'clearDemoData')
    .addItem('촬영용 초기화(지우고 다시 넣기)', 'resetForDemo')
    .addSeparator()
    .addItem('트리거 다시 설치', 'installTriggersUi')
    .addItem('테스트 실행', 'runAllTestsUi')
    .addToUi();
}

function installTriggersUi() { SpreadsheetApp.getUi().alert(installTriggers()); }
function refreshLastContactUi() { SpreadsheetApp.getUi().alert('마지막연락일 갱신: ' + refreshLastContact() + '명'); }

function openWebAppUi() {
  var url = getSetting('웹앱 URL');
  var html = url
    ? '<p><a href="' + url + '" target="_blank" rel="noopener">웹앱 열기 ↗</a></p><p style="color:#666;font-size:12px">' + url + '</p>'
    : '<p>아직 웹앱 URL이 없습니다.</p><ol style="font-size:13px"><li>확장 프로그램 → Apps Script</li><li>배포 → 새 배포 → 유형 "웹 앱"</li><li>실행 사용자 "나", 액세스 "본인만"</li><li>배포 후 URL(/exec)을 <b>설정</b> 탭 "웹앱 URL"에 붙여넣기</li></ol>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(420).setHeight(220), '웹앱');
}

// ── 웹앱 라우팅 ────────────────────────────────────────────

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.code) return callbackPage_(handleCallback(p.code, p.state));
  if (p.error) return callbackPage_({ ok: false, error: p.error + ' ' + (p.error_description || '') });
  var tpl = HtmlService.createTemplateFromFile('Index');
  tpl.appVersion = APP.VERSION;
  return tpl.evaluate()
    .setTitle('고객관리')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) { return HtmlService.createHtmlOutputFromFile(filename).getContent(); }

// ── 클라이언트 API ─────────────────────────────────────────

function api_getDashboard() {
  var today = new Date();
  var data = loadData();
  var rules = loadRules();
  var cands = evaluateRules(data, rules, today);
  var model = buildDashboardModel(data, cands, today);
  model.kakao = getConnectionStatus();
  model.webUrl = getSetting('웹앱 URL');
  model.demoLoaded = !!props_().getProperty(PROP.DEMO_LOADED);
  model.rules = serialize(rules.map(function (r) { delete r._row; return r; }));
  return serialize(model);
}

function api_getCustomers(q) {
  q = q || {};
  var today = new Date();
  var customers = readAll(SHEETS.CUSTOMERS);
  var rules = loadRules();
  var data = loadData();
  var cands = evaluateRules(data, rules, today);
  var alertsBy = {};
  cands.forEach(function (c) { (alertsBy[c.customerId] = alertsBy[c.customerId] || []).push(c.ruleName); });
  var list = customers.map(function (c) {
    var lc = toDate(c['마지막연락일']);
    return { id: c['고객ID'], name: c['고객명'], person: c['담당자'], industry: c['업종'], stage: c['단계'], intent: c['구매의향'],
      lastContact: lc ? fmtDate(lc) : '', days: lc ? daysBetween(lc, today) : null, alerts: alertsBy[c['고객ID']] || [] };
  });
  return serialize(list);
}

function api_getCustomer(id) {
  var today = new Date();
  var data = loadData();
  var cust = data.customers.filter(function (c) { return String(c['고객ID']) === String(id); })[0];
  if (!cust) throw new Error('고객을 찾을 수 없습니다: ' + id);
  var contacts = data.contacts.filter(function (c) { return String(c['고객ID']) === String(id); })
    .sort(function (a, b) { return (daysBetween(a['상담일'], b['상담일']) || 0); });
  var purchases = data.purchases.filter(function (p) { return String(p['고객ID']) === String(id); })
    .sort(function (a, b) { return (daysBetween(a['구매일'], b['구매일']) || 0); });
  var cands = evaluateRules({ customers: [cust], contacts: contacts, purchases: purchases }, loadRules(), today);
  var total = purchases.reduce(function (s, p) { return s + (Number(p['금액']) || 0); }, 0);
  var lc = toDate(cust['마지막연락일']);
  return serialize({ customer: cust, contacts: contacts, purchases: purchases, alerts: cands, totalSales: total,
    days: lc ? daysBetween(lc, today) : null });
}

/** 고객 추가/수정. obj.고객ID 있으면 수정 */
function api_saveCustomer(obj) {
  obj = obj || {};
  if (!String(obj['고객명'] || '').trim()) throw new Error('고객명은 필수입니다.');
  var saved;
  if (obj['고객ID']) {
    var before = readAll(SHEETS.CUSTOMERS).filter(function (c) { return String(c['고객ID']) === String(obj['고객ID']); })[0];
    if (before && String(before['단계']) !== String(obj['단계'] || '')) obj['단계변경일'] = new Date();
    saved = updateRowById(SHEETS.CUSTOMERS, obj['고객ID'], obj);
    if (!saved) throw new Error('수정할 고객을 찾을 수 없습니다.');
    if (before && String(before['고객명']) !== String(obj['고객명'])) renameCustomerRefs_(obj['고객ID'], obj['고객명']);
  } else {
    obj['등록일'] = new Date();
    obj['단계변경일'] = new Date();
    saved = appendRow(SHEETS.CUSTOMERS, obj);
  }
  var immediate = evaluateImmediateForRow(SHEETS.CUSTOMERS, saved, 'webapp');
  return serialize({ customer: saved, immediate: immediate });
}

function renameCustomerRefs_(id, newName) {
  [SHEETS.CONTACTS, SHEETS.PURCHASES].forEach(function (name) {
    var s = ss_().getSheetByName(name);
    if (!s || s.getLastRow() < 2) return;
    var headers = headersOf_(s);
    var idCol = headers.indexOf('고객ID'), nameCol = headers.indexOf('고객명');
    if (idCol < 0 || nameCol < 0) return;
    var n = s.getLastRow() - 1;
    var ids = s.getRange(2, idCol + 1, n, 1).getValues();
    var names = s.getRange(2, nameCol + 1, n, 1).getValues();
    var changed = false;
    for (var i = 0; i < n; i++) if (String(ids[i][0]) === String(id)) { names[i][0] = newName; changed = true; }
    if (changed) s.getRange(2, nameCol + 1, n, 1).setValues(names);
  });
}

function api_addContact(obj) {
  obj = obj || {};
  resolveCustomerRefs_(obj, readAll(SHEETS.CUSTOMERS));
  if (!obj['고객ID']) throw new Error('고객을 선택하세요.');
  if (!obj['상담일']) obj['상담일'] = new Date();
  obj['등록일시'] = new Date();
  var saved = appendRow(SHEETS.CONTACTS, obj);
  refreshLastContact(obj['고객ID']);
  var immediate = evaluateImmediateForRow(SHEETS.CONTACTS, saved, 'webapp');
  return serialize({ contact: saved, immediate: immediate });
}

function api_addPurchase(obj) {
  obj = obj || {};
  resolveCustomerRefs_(obj, readAll(SHEETS.CUSTOMERS));
  if (!obj['고객ID']) throw new Error('고객을 선택하세요.');
  if (!obj['구매일']) obj['구매일'] = new Date();
  if (obj['금액'] !== undefined && obj['금액'] !== '') obj['금액'] = Number(String(obj['금액']).replace(/,/g, '')) || 0;
  if (!obj['다음구매예정일'] && obj['재구매주기(일)']) obj['다음구매예정일'] = addDays(obj['구매일'], Number(obj['재구매주기(일)']));
  var saved = appendRow(SHEETS.PURCHASES, obj);
  refreshLastContact(obj['고객ID']);
  var immediate = evaluateImmediateForRow(SHEETS.PURCHASES, saved, 'webapp');
  return serialize({ purchase: saved, immediate: immediate });
}

function api_getLists() { return LISTS; }

function api_getSettings() {
  var s = readSettings();
  var out = {};
  DEFAULT_SETTINGS.forEach(function (r) { out[r[0]] = { value: s[r[0]] || '', desc: r[2] }; });
  return { settings: out, kakao: getConnectionStatus(), scriptUrl: safeServiceUrl_(), version: APP.VERSION };
}

function safeServiceUrl_() { try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; } }

function api_saveSettings(map) {
  map = map || {};
  var hourChanged = false;
  Object.keys(map).forEach(function (k) {
    if (k === '일일 발송 시각' && String(map[k]) !== String(getSetting(k, '8'))) hourChanged = true;
    writeSetting(k, map[k]);
  });
  if (hourChanged) installTriggers();
  return api_getSettings();
}

function api_getKakaoAuthUrl() { return getAuthUrl(); }
function api_kakaoDisconnect() { disconnect(); return getConnectionStatus(); }
function api_sendKakaoTest() {
  var r = sendToMe('[고객관리] 테스트 메시지입니다. 연결 정상!');
  if (!r.ok) throw new Error(r.error || ('HTTP ' + r.status));
  return r;
}

function api_runDailyNow() {
  var r = dailyDigest(true);
  if (!r.ok) throw new Error(r.error || '발송 실패');
  return r;
}

function api_dryRun() {
  var today = new Date();
  var data = loadData();
  var cands = evaluateRules(data, loadRules(), today);
  var s = readSettings();
  return { candidates: serialize(cands), chunks: buildDailySummary(cands, { today: today, maxItems: parseInt(s['요약 최대 건수'], 10) || 15, userName: s['사용자 이름'] || '' }) };
}

// ── CSV 내보내기 (Claude Code 스킬 입력용) ─────────────────

function api_exportCsv() {
  var folderName = '고객관리 내보내기 ' + fmtDate(new Date());
  var folder = DriveApp.createFolder(folderName);
  [SHEETS.CUSTOMERS, SHEETS.CONTACTS, SHEETS.PURCHASES].forEach(function (name) {
    folder.createFile(name + '.csv', toCsv_(name), 'text/csv');
  });
  return { url: folder.getUrl(), name: folderName };
}

function exportCsvUi() {
  var r = api_exportCsv();
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput('<p>Drive 폴더에 CSV 3개를 만들었습니다.</p><p><a href="' + r.url + '" target="_blank" rel="noopener">' + r.name + ' ↗</a></p><p style="font-size:12px;color:#666">폴더를 내려받아 Claude Code 작업 폴더에 넣고 "이번 주 챙길 고객 뽑아줘"라고 하세요.</p>').setWidth(420).setHeight(180),
    'CSV 내보내기');
}

function toCsv_(sheetName) {
  var s = sheet_(sheetName);
  if (s.getLastRow() === 0) return '';
  var values = s.getRange(1, 1, s.getLastRow(), s.getLastColumn()).getValues();
  var lines = values.map(function (row) {
    return row.map(function (v) {
      if (v instanceof Date) v = fmtDate(v);
      var str = (v === null || v === undefined) ? '' : String(v);
      return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    }).join(',');
  });
  return '﻿' + lines.join('\r\n'); // BOM: 엑셀 한글 깨짐 방지
}
