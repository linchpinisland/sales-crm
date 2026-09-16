/**
 * SheetRepo.gs — 시트 ↔ 객체 변환 계층. 헤더 이름 기반이라 컬럼 순서를 바꿔도 동작한다.
 * 이 파일만 SpreadsheetApp 을 직접 다룬다(Setup.gs 제외).
 */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  var s = ss_().getSheetByName(name);
  if (!s) throw new Error('"' + name + '" 탭이 없습니다. 메뉴 [' + APP.MENU + '] > [초기 설정 실행]을 먼저 해주세요.');
  return s;
}

/** 첫 행 헤더 배열 */
function headersOf_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
}

/** 셀 값 정규화: 날짜 컬럼은 Date(자정) 또는 '', 나머지는 그대로('' 유지) */
function normalizeCell_(sheetName, header, v) {
  if (v === null || v === undefined) return '';
  if ((DATE_FIELDS[sheetName] || []).indexOf(header) >= 0) {
    var d = toDate(v);
    return d || '';
  }
  return v;
}

/**
 * 탭 전체를 객체 배열로. 각 객체에 _row(시트 행 번호) 포함.
 * 빈 행(모든 셀 '')은 제외.
 */
function readAll(sheetName) {
  var sheet = sheet_(sheetName);
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol === 0) return [];
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r], obj = {}, empty = true;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      var v = normalizeCell_(sheetName, headers[c], row[c]);
      if (v !== '' && v !== null) empty = false;
      obj[headers[c]] = v;
    }
    if (empty) continue;
    obj._row = r + 1;
    out.push(obj);
  }
  return out;
}

function loadData() {
  return { customers: readAll(SHEETS.CUSTOMERS), contacts: readAll(SHEETS.CONTACTS), purchases: readAll(SHEETS.PURCHASES) };
}

function loadRules() { return readAll(SHEETS.RULES); }

/** 시트 행 번호 → 객체 1개 (편집 트리거용) */
function readRow(sheetName, rowNum) {
  var sheet = sheet_(sheetName);
  var headers = headersOf_(sheet);
  if (rowNum < 2 || rowNum > sheet.getLastRow()) return null;
  var row = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  var obj = {}, empty = true;
  headers.forEach(function (h, i) {
    if (!h) return;
    var v = normalizeCell_(sheetName, h, row[i]);
    if (v !== '') empty = false;
    obj[h] = v;
  });
  if (empty) return null;
  obj._row = rowNum;
  return obj;
}

/** ID 컬럼을 훑어 다음 ID (예: C026) */
function nextId(sheetName) {
  var sheet = sheet_(sheetName);
  var headers = headersOf_(sheet);
  var idField = ID_FIELD[sheetName], prefix = ID_PREFIX[sheetName], width = ID_WIDTH[sheetName];
  var col = headers.indexOf(idField) + 1;
  var max = 0;
  if (col > 0 && sheet.getLastRow() >= 2) {
    sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues().forEach(function (r) {
      var m = String(r[0]).match(new RegExp('^' + prefix + '(\\d+)$'));
      if (m && +m[1] > max) max = +m[1];
    });
  }
  return prefix + pad_(max + 1, width);
}

/** ID 가 비어 있는 행에 ID 부여 (시트 직접 입력 사용자 지원). 부여한 수 반환 */
function fillMissingIds(sheetName) {
  var sheet = sheet_(sheetName);
  var headers = headersOf_(sheet);
  var col = headers.indexOf(ID_FIELD[sheetName]) + 1;
  if (col === 0 || sheet.getLastRow() < 2) return 0;
  var n = sheet.getLastRow() - 1;
  var ids = sheet.getRange(2, col, n, 1).getValues();
  var all = sheet.getRange(2, 1, n, headers.length).getValues();
  var prefix = ID_PREFIX[sheetName], width = ID_WIDTH[sheetName];
  var max = 0;
  ids.forEach(function (r) { var m = String(r[0]).match(new RegExp('^' + prefix + '(\\d+)$')); if (m && +m[1] > max) max = +m[1]; });
  var changed = 0;
  for (var i = 0; i < n; i++) {
    var rowEmpty = all[i].every(function (v) { return v === '' || v === null; });
    if (rowEmpty || String(ids[i][0]).trim() !== '') continue;
    ids[i][0] = prefix + pad_(++max, width);
    changed++;
  }
  if (changed) sheet.getRange(2, col, n, 1).setValues(ids);
  return changed;
}

/** 값 객체 → 시트 컬럼 순서 배열 */
function toRowArray_(sheetName, headers, obj) {
  return headers.map(function (h) {
    if (!h || !Object.prototype.hasOwnProperty.call(obj, h)) return '';
    var v = obj[h];
    if (v === null || v === undefined) return '';
    if ((DATE_FIELDS[sheetName] || []).indexOf(h) >= 0) { var d = toDate(v); return d || ''; }
    return v;
  });
}

/** 행 추가. ID 비어 있으면 발급. 추가된 객체(+_row) 반환 */
function appendRow(sheetName, obj) {
  var sheet = sheet_(sheetName);
  var headers = headersOf_(sheet);
  var idField = ID_FIELD[sheetName];
  var copy = {};
  for (var k in obj) copy[k] = obj[k];
  if (idField && !copy[idField]) copy[idField] = nextId(sheetName);
  var row = toRowArray_(sheetName, headers, copy);
  sheet.appendRow(row);
  copy._row = sheet.getLastRow();
  return copy;
}

/** ID 로 행을 찾아 patch 만 갱신. 갱신된 객체 반환 (없으면 null) */
function updateRowById(sheetName, id, patch) {
  var sheet = sheet_(sheetName);
  var headers = headersOf_(sheet);
  var idField = ID_FIELD[sheetName];
  var col = headers.indexOf(idField) + 1;
  if (col === 0 || sheet.getLastRow() < 2) return null;
  var ids = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues();
  var rowNum = -1;
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) { rowNum = i + 2; break; }
  if (rowNum < 0) return null;
  var current = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  headers.forEach(function (h, i) {
    if (h && Object.prototype.hasOwnProperty.call(patch, h)) {
      var v = patch[h];
      if ((DATE_FIELDS[sheetName] || []).indexOf(h) >= 0) v = toDate(v) || '';
      current[i] = (v === null || v === undefined) ? '' : v;
    }
  });
  sheet.getRange(rowNum, 1, 1, headers.length).setValues([current]);
  return readRow(sheetName, rowNum);
}

/** 고객명 → 고객ID (정확 일치, 없으면 '') */
function resolveCustomerId(name) {
  if (!name) return '';
  var hit = readAll(SHEETS.CUSTOMERS).filter(function (c) { return String(c['고객명']).trim() === String(name).trim(); });
  return hit.length ? String(hit[0]['고객ID']) : '';
}

/** 상담/구매 행의 고객ID·고객명을 서로 채움 */
function resolveCustomerRefs_(obj, customers) {
  var byId = indexBy_(customers, '고객ID');
  if (obj['고객ID'] && byId[obj['고객ID']]) { obj['고객명'] = byId[obj['고객ID']]['고객명']; return obj; }
  var name = String(obj['고객명'] || '').trim();
  for (var i = 0; i < customers.length; i++) {
    if (String(customers[i]['고객명']).trim() === name) { obj['고객ID'] = customers[i]['고객ID']; return obj; }
  }
  return obj;
}

/**
 * 마지막연락일 캐시 갱신: max(현재값, 상담일, 구매일).
 * customerId 를 주면 그 고객만, 없으면 전체. 갱신된 고객 수 반환.
 */
function refreshLastContact(customerId) {
  var sheet = sheet_(SHEETS.CUSTOMERS);
  var headers = headersOf_(sheet);
  var idCol = headers.indexOf('고객ID'), lcCol = headers.indexOf('마지막연락일');
  if (idCol < 0 || lcCol < 0 || sheet.getLastRow() < 2) return 0;
  var contacts = readAll(SHEETS.CONTACTS), purchases = readAll(SHEETS.PURCHASES);
  var n = sheet.getLastRow() - 1;
  var ids = sheet.getRange(2, idCol + 1, n, 1).getValues();
  var lcs = sheet.getRange(2, lcCol + 1, n, 1).getValues();
  var changed = 0;
  for (var i = 0; i < n; i++) {
    var id = String(ids[i][0]);
    if (!id || (customerId && id !== String(customerId))) continue;
    var next = computeLastContact(id, contacts, purchases, lcs[i][0]);
    var cur = fmtDate(lcs[i][0]);
    if (next && next !== cur) { lcs[i][0] = toDate(next); changed++; }
  }
  if (changed) sheet.getRange(2, lcCol + 1, n, 1).setValues(lcs);
  return changed;
}

// ── 설정 ─────────────────────────────────────────────────

function readSettings() {
  var map = {};
  DEFAULT_SETTINGS.forEach(function (r) { map[r[0]] = r[1]; });
  var s = ss_().getSheetByName(SHEETS.SETTINGS);
  if (!s || s.getLastRow() < 2) return map;
  s.getRange(2, 1, s.getLastRow() - 1, 2).getValues().forEach(function (r) {
    var k = String(r[0]).trim();
    if (k) map[k] = (r[1] === null || r[1] === undefined) ? '' : String(r[1]).trim();
  });
  return map;
}

function getSetting(key, fallback) {
  var v = readSettings()[key];
  return (v === undefined || v === '') ? (fallback === undefined ? '' : fallback) : v;
}

function writeSetting(key, value) {
  var s = sheet_(SHEETS.SETTINGS);
  var n = Math.max(s.getLastRow() - 1, 0);
  if (n > 0) {
    var keys = s.getRange(2, 1, n, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0]).trim() === key) { s.getRange(i + 2, 2).setValue(value); return; }
    }
  }
  var desc = '';
  DEFAULT_SETTINGS.forEach(function (r) { if (r[0] === key) desc = r[2]; });
  s.appendRow([key, value, desc]);
}

// ── 알림로그 ───────────────────────────────────────────────

function appendLog(entry) {
  var s = ss_().getSheetByName(SHEETS.LOG);
  if (!s) return;
  s.appendRow([new Date(), entry.ruleId || '', entry.customerId || '', entry.customerName || '', entry.message || '',
    entry.channel || '', entry.status || '', entry.error || '', entry.key || '']);
}

/** 오늘 이미 발송한 중복키 집합 */
function loadTodayLogKeys(today) {
  var s = ss_().getSheetByName(SHEETS.LOG);
  var set = {};
  if (!s || s.getLastRow() < 2) return set;
  var prefix = fmtDate(today) + '|';
  var headers = headersOf_(s);
  var keyCol = headers.indexOf('중복키') + 1, statusCol = headers.indexOf('상태') + 1;
  if (keyCol === 0) return set;
  var n = s.getLastRow() - 1;
  var keys = s.getRange(2, keyCol, n, 1).getValues();
  var statuses = statusCol ? s.getRange(2, statusCol, n, 1).getValues() : null;
  for (var i = 0; i < n; i++) {
    var k = String(keys[i][0]);
    if (k.indexOf(prefix) === 0 && (!statuses || String(statuses[i][0]) === '성공')) set[k] = true;
  }
  return set;
}

function dedupKey_(today, c) { return fmtDate(today) + '|' + c.ruleId + '|' + (c.customerId || c.customerName); }

// ── 직렬화 (웹앱 전송용: Date → 'YYYY-MM-DD') ─────────────

function serialize(v) {
  if (v instanceof Date) return fmtDate(v);
  if (Array.isArray(v)) return v.map(serialize);
  if (v && typeof v === 'object') { var o = {}; for (var k in v) o[k] = serialize(v[k]); return o; }
  return v;
}
