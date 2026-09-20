/**
 * Setup.gs — 초기 설정 마법사. 사본 사용자가 메뉴 한 번으로 탭·검증·기본 규칙·트리거를 갖추게 한다.
 * 모든 함수는 멱등(여러 번 실행해도 중복 생성 없음).
 */

function setupAll() {
  var log = [];
  log.push(ensureSheets());
  log.push(applyValidations());
  log.push(seedDefaultRules());
  log.push(seedSettings());
  log.push(fillWebAppUrl_());
  log.push(protectLog());
  log.push(installTriggers());
  SpreadsheetApp.flush();
  var msg = log.join('\n');
  var next = getSetting('웹앱 URL')
    ? '다음 단계: 메뉴 [고객관리] → 웹앱 열기'
    : '다음 단계: 확장 프로그램 > Apps Script > 배포 > 새 배포(웹 앱)';
  try { SpreadsheetApp.getUi().alert('초기 설정 완료', msg + '\n\n' + next, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

/** 자동 설치로 배포된 웹앱 주소가 있으면 설정 탭에 채운다(비어 있을 때만). */
function fillWebAppUrl_() {
  var url = (typeof DEPLOYED_WEBAPP_URL === 'string') ? DEPLOYED_WEBAPP_URL : '';
  if (!url || getSetting('웹앱 URL')) return '웹앱 URL: 변경 없음';
  writeSetting('웹앱 URL', url);
  return '웹앱 URL: 자동 입력됨';
}

/** 탭 생성 + 헤더(없는 컬럼은 뒤에 추가) + 틀 고정 */
function ensureSheets() {
  var ss = ss_();
  var created = [], patched = [];
  Object.keys(HEADERS).forEach(function (name) {
    var s = ss.getSheetByName(name);
    if (!s) { s = ss.insertSheet(name); created.push(name); }
    var want = HEADERS[name];
    var have = headersOf_(s).filter(Boolean);
    if (have.length === 0) {
      s.getRange(1, 1, 1, want.length).setValues([want]);
    } else {
      var missing = want.filter(function (h) { return have.indexOf(h) < 0; });
      if (missing.length) {
        s.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
        patched.push(name + '(+' + missing.join(',') + ')');
      }
    }
    s.setFrozenRows(1);
    var hdr = s.getRange(1, 1, 1, s.getLastColumn());
    hdr.setFontWeight('bold').setBackground('#f1f3f4');
    if (s.getMaxColumns() > s.getLastColumn() + 2 && s.getLastRow() <= 1) {
      // 새 탭이면 보기 좋게 폭만 정리
      s.setColumnWidths(1, s.getLastColumn(), 120);
    }
  });
  // _메타
  var meta = ss.getSheetByName(SHEETS.META);
  if (!meta) { meta = ss.insertSheet(SHEETS.META); created.push(SHEETS.META); }
  writeMetaLists_(meta);
  meta.hideSheet();
  // 기본 시트(Sheet1/시트1)가 비어 있으면 제거
  var def = ss.getSheets()[0];
  if (def && ['Sheet1', '시트1'].indexOf(def.getName()) >= 0 && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  return '탭: 생성 ' + (created.length ? created.join(', ') : '없음') + (patched.length ? ' / 헤더 보강 ' + patched.join(', ') : '');
}

/** _메타 탭에 드롭다운 목록을 세로로 기록 (컬럼당 목록 하나) */
function writeMetaLists_(meta) {
  meta.clear();
  var cols = [];
  Object.keys(LISTS).forEach(function (sheetName) {
    Object.keys(LISTS[sheetName]).forEach(function (field) {
      cols.push({ key: sheetName + '.' + field, values: LISTS[sheetName][field] });
    });
  });
  cols.forEach(function (c, i) {
    var col = i + 1;
    meta.getRange(1, col).setValue(c.key);
    meta.getRange(2, col, c.values.length, 1).setValues(c.values.map(function (v) { return [v]; }));
  });
  meta.getRange(1, 1, 1, cols.length).setFontWeight('bold');
}

/** 드롭다운·날짜 검증 */
function applyValidations() {
  var ss = ss_();
  var meta = ss.getSheetByName(SHEETS.META);
  var metaKeys = headersOf_(meta);
  var count = 0;
  Object.keys(LISTS).forEach(function (sheetName) {
    var s = ss.getSheetByName(sheetName);
    if (!s) return;
    var headers = headersOf_(s);
    var maxRows = Math.max(s.getMaxRows() - 1, 1);
    Object.keys(LISTS[sheetName]).forEach(function (field) {
      var col = headers.indexOf(field) + 1;
      if (!col) return;
      var metaCol = metaKeys.indexOf(sheetName + '.' + field) + 1;
      var listRange = meta.getRange(2, metaCol, LISTS[sheetName][field].length, 1);
      var rule = SpreadsheetApp.newDataValidation().requireValueInRange(listRange, true).setAllowInvalid(true).build();
      s.getRange(2, col, maxRows, 1).setDataValidation(rule);
      count++;
    });
    // 날짜 컬럼
    (DATE_FIELDS[sheetName] || []).forEach(function (field) {
      var col = headers.indexOf(field) + 1;
      if (!col) return;
      var rule = SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true).setHelpText('날짜(예: 2026-09-16)').build();
      s.getRange(2, col, maxRows, 1).setDataValidation(rule).setNumberFormat('yyyy-mm-dd');
    });
  });
  // 상담기록/구매기록 고객명 → 고객 탭 참조
  var cust = ss.getSheetByName(SHEETS.CUSTOMERS);
  var nameCol = headersOf_(cust).indexOf('고객명') + 1;
  [SHEETS.CONTACTS, SHEETS.PURCHASES].forEach(function (name) {
    var s = ss.getSheetByName(name);
    var col = headersOf_(s).indexOf('고객명') + 1;
    if (!col || !nameCol) return;
    var ref = cust.getRange(2, nameCol, Math.max(cust.getMaxRows() - 1, 1), 1);
    var rule = SpreadsheetApp.newDataValidation().requireValueInRange(ref, true).setAllowInvalid(true).build();
    s.getRange(2, col, Math.max(s.getMaxRows() - 1, 1), 1).setDataValidation(rule);
    count++;
  });
  // 금액 숫자 포맷
  var pur = ss.getSheetByName(SHEETS.PURCHASES);
  var amtCol = headersOf_(pur).indexOf('금액') + 1;
  if (amtCol) pur.getRange(2, amtCol, Math.max(pur.getMaxRows() - 1, 1), 1).setNumberFormat('#,##0');
  return '데이터 검증 ' + count + '개 적용';
}

function seedDefaultRules() {
  var s = sheet_(SHEETS.RULES);
  if (s.getLastRow() >= 2) return '알림규칙: 기존 ' + (s.getLastRow() - 1) + '행 유지';
  var headers = headersOf_(s);
  var rows = DEFAULT_RULES.map(function (r) {
    var obj = {};
    HEADERS[SHEETS.RULES].forEach(function (h, i) { obj[h] = r[i]; });
    return headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; });
  });
  s.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return '알림규칙: 기본 ' + rows.length + '행 추가';
}

function seedSettings() {
  var s = sheet_(SHEETS.SETTINGS);
  var have = {};
  if (s.getLastRow() >= 2) s.getRange(2, 1, s.getLastRow() - 1, 1).getValues().forEach(function (r) { have[String(r[0]).trim()] = true; });
  var added = 0;
  DEFAULT_SETTINGS.forEach(function (r) { if (!have[r[0]]) { s.appendRow(r); added++; } });
  s.setColumnWidth(1, 170); s.setColumnWidth(2, 360); s.setColumnWidth(3, 420);
  return '설정: ' + added + '개 항목 추가';
}

function protectLog() {
  var s = sheet_(SHEETS.LOG);
  var existing = s.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  if (existing.length) return '알림로그: 보호 유지';
  s.protect().setDescription('코드가 기록하는 탭 — 직접 편집하지 마세요').setWarningOnly(true);
  return '알림로그: 경고 보호 설정';
}

var TRIGGER_HANDLERS_ = ['dailyDigest', 'onEditInstalled', 'weeklyTokenKeepAlive'];

function removeTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_HANDLERS_.indexOf(t.getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

function installTriggers() {
  removeTriggers();
  var hour = parseInt(getSetting('일일 발송 시각', '8'), 10);
  if (isNaN(hour) || hour < 0 || hour > 23) hour = 8;
  ScriptApp.newTrigger('dailyDigest').timeBased().everyDays(1).atHour(hour).create();
  ScriptApp.newTrigger('onEditInstalled').forSpreadsheet(ss_()).onEdit().create();
  ScriptApp.newTrigger('weeklyTokenKeepAlive').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(hour + 1 > 23 ? 0 : hour + 1).create();
  return '트리거: 매일 ' + hour + '시 요약 / 편집 즉시 / 주간 토큰 갱신 설치';
}

// ── 데모 데이터 ────────────────────────────────────────────

function seedDemoData(skipConfirm) {
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) {}
  var cust = sheet_(SHEETS.CUSTOMERS);
  if (cust.getLastRow() >= 2 && !skipConfirm && ui) {
    var res = ui.alert('데모 데이터 넣기', '고객 탭에 이미 데이터가 있습니다. 데모 데이터를 뒤에 추가할까요?\n(기존 데이터는 지우지 않습니다. 완전 초기화는 "데모 데이터 지우기" 후 실행)', ui.ButtonSet.YES_NO);
    if (res !== ui.Button.YES) return '취소';
  }
  var data = buildDemoData(new Date());
  writeRows_(SHEETS.CUSTOMERS, data.customers);
  writeRows_(SHEETS.CONTACTS, data.contacts);
  writeRows_(SHEETS.PURCHASES, data.purchases);
  PropertiesService.getScriptProperties().setProperty(PROP.DEMO_LOADED, fmtDate(new Date()));
  var msg = '데모 데이터: 고객 ' + data.customers.length + ' / 상담 ' + data.contacts.length + ' / 구매 ' + data.purchases.length + '건 추가';
  if (ui && !skipConfirm) ui.alert(msg);
  return msg;
}

function writeRows_(sheetName, objs) {
  if (!objs.length) return;
  var s = sheet_(sheetName);
  var headers = headersOf_(s);
  var rows = objs.map(function (o) { return toRowArray_(sheetName, headers, o); });
  s.getRange(s.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

function clearDemoData(skipConfirm) {
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) {}
  if (!skipConfirm && ui) {
    var res = ui.alert('데이터 전체 지우기', '고객·상담기록·구매기록·알림로그 탭의 데이터 행을 모두 지웁니다(헤더·규칙·설정은 유지). 계속할까요?', ui.ButtonSet.YES_NO);
    if (res !== ui.Button.YES) return '취소';
  }
  [SHEETS.CUSTOMERS, SHEETS.CONTACTS, SHEETS.PURCHASES, SHEETS.LOG].forEach(function (name) {
    var s = ss_().getSheetByName(name);
    if (s && s.getLastRow() >= 2) s.getRange(2, 1, s.getLastRow() - 1, s.getLastColumn()).clearContent();
  });
  PropertiesService.getScriptProperties().deleteProperty(PROP.DEMO_LOADED);
  return '데이터 행 삭제 완료';
}

/** 촬영 리허설용: 전부 지우고 데모 데이터 재생성, 예시 규칙 OFF */
function resetForDemo() {
  clearDemoData(true);
  seedDemoData(true);
  var s = sheet_(SHEETS.RULES);
  var headers = headersOf_(s);
  var idCol = headers.indexOf('규칙ID'), useCol = headers.indexOf('사용');
  if (s.getLastRow() >= 2 && idCol >= 0 && useCol >= 0) {
    var n = s.getLastRow() - 1;
    var ids = s.getRange(2, idCol + 1, n, 1).getValues();
    var uses = s.getRange(2, useCol + 1, n, 1).getValues();
    for (var i = 0; i < n; i++) uses[i][0] = (['R08', 'R09'].indexOf(String(ids[i][0])) >= 0) ? 'N' : uses[i][0];
    s.getRange(2, useCol + 1, n, 1).setValues(uses);
  }
  try { SpreadsheetApp.getUi().alert('데모 초기화 완료. 규칙 R08/R09는 OFF 상태입니다.'); } catch (e) {}
}

/** 상태 점검 */
function showSetupStatus() {
  var ss = ss_();
  var lines = [];
  Object.keys(HEADERS).forEach(function (name) {
    var s = ss.getSheetByName(name);
    lines.push((s ? '✔ ' : '✖ ') + name + (s ? ' (' + Math.max(s.getLastRow() - 1, 0) + '행)' : ' 없음'));
  });
  var triggers = ScriptApp.getProjectTriggers().filter(function (t) { return TRIGGER_HANDLERS_.indexOf(t.getHandlerFunction()) >= 0; });
  lines.push('트리거: ' + triggers.map(function (t) { return t.getHandlerFunction(); }).join(', ') + (triggers.length ? '' : '없음 — 초기 설정 실행 필요'));
  var k = getConnectionStatus();
  lines.push('카카오: ' + (k.status || '미연결') + (k.lastError ? ' / ' + k.lastError : ''));
  lines.push('웹앱 URL(설정): ' + (getSetting('웹앱 URL') || '미입력'));
  var msg = lines.join('\n');
  try { SpreadsheetApp.getUi().alert('상태 점검', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}
