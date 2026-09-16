/**
 * Rules.gs — 알림 규칙 엔진 (순수 함수).
 * SpreadsheetApp / PropertiesService / UrlFetchApp 을 절대 호출하지 않는다.
 * 입력: {customers, contacts, purchases} 객체 배열 + 규칙 배열 + today
 * 출력: Candidate[] = {ruleId, ruleName, customerId, customerName, days, label, baseDate, message, immediate, sheet, rowId}
 */

// ── 날짜 유틸 ──────────────────────────────────────────────

/** Date | 'YYYY-MM-DD' | 숫자(ms) → Date(현지 자정) 또는 null */
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate());
  if (typeof v === 'number') return toDate(new Date(v));
  var s = String(v).trim();
  var m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : toDate(d);
}

/** a → b 로 며칠 지났는가 (b - a, 일 단위 정수). DST 영향 없도록 UTC 기준. */
function daysBetween(a, b) {
  var da = toDate(a), db = toDate(b);
  if (!da || !db) return null;
  var ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  var ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round((ub - ua) / 86400000);
}

function fmtDate(d) {
  d = toDate(d);
  if (!d) return '';
  var m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

function addDays(d, n) {
  d = toDate(d);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** 연 단위 반복 날짜의 "다음 도래일" (오늘 포함). 2/29는 평년에 2/28로. */
function nextAnniversary(date, today) {
  var d = toDate(date), t = toDate(today);
  if (!d || !t) return null;
  function build(year) {
    var m = d.getMonth(), day = d.getDate();
    if (m === 1 && day === 29 && !isLeap_(year)) day = 28;
    return new Date(year, m, day);
  }
  var cand = build(t.getFullYear());
  if (daysBetween(t, cand) < 0) cand = build(t.getFullYear() + 1);
  return cand;
}

function isLeap_(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

// ── 값 유틸 ────────────────────────────────────────────────

function yn_(v) { return String(v || '').trim().toUpperCase() === 'Y'; }

function fmtNumber(n) {
  if (n === null || n === undefined || n === '') return '';
  var num = typeof n === 'number' ? n : Number(String(n).replace(/,/g, ''));
  if (isNaN(num)) return String(n);
  return String(Math.round(num)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtValue_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtDate(v);
  if (typeof v === 'number') return fmtNumber(v);
  return String(v);
}

function indexBy_(rows, key) {
  var map = {};
  (rows || []).forEach(function (r) { if (r && r[key] !== undefined && r[key] !== '') map[String(r[key])] = r; });
  return map;
}

// ── 필터 ───────────────────────────────────────────────────

/** "필드=값;필드!=값" → [{field, op, value}] */
function parseFilter(str) {
  if (!str) return [];
  return String(str).split(';').map(function (s) { return s.trim(); }).filter(Boolean).map(function (part) {
    var m = part.match(/^(.+?)\s*(!=|=)\s*(.*)$/);
    if (!m) return null;
    return { field: m[1].trim(), op: m[2], value: m[3].trim() };
  }).filter(Boolean);
}

function matchesFilter_(ctx, filter) {
  for (var i = 0; i < filter.length; i++) {
    var f = filter[i];
    var actual = fmtValue_(ctx[f.field]).trim();
    var eq = actual === f.value;
    if (f.op === '=' && !eq) return false;
    if (f.op === '!=' && eq) return false;
  }
  return true;
}

// ── 템플릿 ─────────────────────────────────────────────────

/** "{고객명} … {일수}" 치환. 미지 플레이스홀더는 빈 문자열. */
function renderTemplate(tpl, ctx) {
  return String(tpl || '').replace(/\{([^{}]+)\}/g, function (_, key) {
    var k = key.trim();
    return Object.prototype.hasOwnProperty.call(ctx, k) ? fmtValue_(ctx[k]) : '';
  });
}

function dLabel_(days) {
  if (days === 0) return '오늘';
  if (days > 0) return 'D-' + days;
  return 'D+' + (-days);
}

// ── 평가 ───────────────────────────────────────────────────

function rowsFor_(data, sheet) {
  if (sheet === '고객') return data.customers || [];
  if (sheet === '상담기록') return data.contacts || [];
  if (sheet === '구매기록') return data.purchases || [];
  return [];
}

/** 상담/구매 행에 고객 필드를 병합(행 필드 우선). 고객 행이면 그대로. */
function mergeContext_(row, customersById, sheet) {
  var ctx = {};
  var cust = customersById[String(row['고객ID'] || '')];
  if (sheet !== '고객' && cust) for (var k in cust) ctx[k] = cust[k];
  for (var k2 in row) ctx[k2] = row[k2];
  if (!ctx['고객명'] && cust) ctx['고객명'] = cust['고객명'];
  return ctx;
}

/** 규칙 하나 × 행 하나 → Candidate | null (필터는 호출 측에서 이미 통과시킴) */
function evaluateRow(rule, ctx, today) {
  var t = toDate(today);
  var type = String(rule['조건유형'] || '').trim();
  var n = Number(rule['일수']);
  if (isNaN(n)) n = 0;
  var field = String(rule['기준필드'] || '').trim();
  var base = field ? toDate(ctx[field]) : null;
  var days = null, label = '';

  if (type === '경과일이상') {
    if (!base) return null;
    days = daysBetween(base, t);
    if (days < n) return null;
    label = days + '일 경과';
  } else if (type === 'D일이내') {
    if (!base) return null;
    days = daysBetween(t, base);
    if (days < 0 || days > n) return null;
    label = dLabel_(days);
  } else if (type === '연간반복D일이내') {
    if (!base) return null;
    var next = nextAnniversary(base, t);
    days = daysBetween(t, next);
    if (days < 0 || days > n) return null;
    label = dLabel_(days);
    base = next;
  } else if (type === '필드값일치') {
    days = null;
    label = '';
  } else {
    return null;
  }

  var tctx = {};
  for (var k in ctx) tctx[k] = ctx[k];
  tctx['일수'] = days === null ? '' : Math.abs(days);
  tctx['D-표기'] = days === null ? '' : dLabel_(days);
  tctx['기준일'] = base ? fmtDate(base) : '';
  tctx['규칙명'] = rule['규칙명'];

  var sheet = String(rule['대상시트'] || '').trim();
  return {
    ruleId: String(rule['규칙ID'] || ''),
    ruleName: String(rule['규칙명'] || ''),
    conditionType: type,
    customerId: String(ctx['고객ID'] || ''),
    customerName: String(ctx['고객명'] || ''),
    days: days,
    label: label,
    baseDate: base ? fmtDate(base) : '',
    message: renderTemplate(rule['메시지템플릿'], tctx),
    immediate: yn_(rule['즉시발송']),
    sheet: sheet,
    rowId: String(ctx[ID_FIELD[sheet] || '고객ID'] || '')
  };
}

/** a 가 b 보다 급한가 (같은 규칙 내 고객 중복 제거용) */
function moreUrgent_(a, b) {
  if (a.days === null || b.days === null) return false;
  if (a.conditionType === '경과일이상') return a.days > b.days;
  return a.days < b.days;
}

/**
 * 메인 엔진.
 * @param {{customers:Object[], contacts:Object[], purchases:Object[]}} data
 * @param {Object[]} rules   알림규칙 행 객체 배열
 * @param {Date|string} today
 * @param {{onlyImmediate?:boolean}} [opts]
 */
function evaluateRules(data, rules, today, opts) {
  opts = opts || {};
  var t = toDate(today) || toDate(new Date());
  var customersById = indexBy_(data.customers, '고객ID');
  var out = [];
  var order = {};
  (rules || []).forEach(function (rule, i) {
    order[String(rule['규칙ID'])] = Number(rule['정렬순서']) || (1000 + i);
    if (!yn_(rule['사용'])) return;
    if (opts.onlyImmediate && !yn_(rule['즉시발송'])) return;
    var sheet = String(rule['대상시트'] || '').trim();
    var rows = rowsFor_(data, sheet);
    var filter = parseFilter(rule['필터']);
    var best = {};
    rows.forEach(function (row) {
      var ctx = mergeContext_(row, customersById, sheet);
      if (!matchesFilter_(ctx, filter)) return;
      var c = evaluateRow(rule, ctx, t);
      if (!c) return;
      var key = c.customerId || c.customerName;
      if (!best[key] || moreUrgent_(c, best[key])) best[key] = c;
    });
    Object.keys(best).forEach(function (k) { out.push(best[k]); });
  });
  out.sort(function (a, b) {
    var oa = order[a.ruleId] || 9999, ob = order[b.ruleId] || 9999;
    if (oa !== ob) return oa - ob;
    if (moreUrgent_(a, b)) return -1;
    if (moreUrgent_(b, a)) return 1;
    return 0;
  });
  return out;
}

/** 규칙별 그룹 [{ruleId, ruleName, items:[...]}] (입력 순서 유지) */
function groupByRule(candidates) {
  var groups = [], map = {};
  (candidates || []).forEach(function (c) {
    if (!map[c.ruleId]) { map[c.ruleId] = { ruleId: c.ruleId, ruleName: c.ruleName, items: [] }; groups.push(map[c.ruleId]); }
    map[c.ruleId].items.push(c);
  });
  return groups;
}

/**
 * 일일 요약 텍스트를 카카오 200자 제한에 맞춰 청크 배열로.
 * @param {Object[]} candidates
 * @param {{today?:Date, maxItems?:number, limit?:number, userName?:string}} opts
 * @return {string[]}
 */
function buildDailySummary(candidates, opts) {
  opts = opts || {};
  var limit = opts.limit || KAKAO.TEXT_LIMIT;
  var maxItems = opts.maxItems || 15;
  var t = toDate(opts.today) || toDate(new Date());
  var head = '[오늘 챙길 고객 ' + (t.getMonth() + 1) + '/' + t.getDate() + ']';
  if (opts.userName) head = opts.userName + ' ' + head;
  var total = candidates.length;
  if (total === 0) return [head + ' 오늘은 알림 0건. 편안한 하루 되세요.'];

  var lines = [head + ' ' + total + '건'];
  var shown = 0;
  groupByRule(candidates).forEach(function (g) {
    if (shown >= maxItems) return;
    lines.push('■ ' + g.ruleName + ' (' + g.items.length + ')');
    g.items.forEach(function (c) {
      if (shown >= maxItems) return;
      lines.push('- ' + c.message);
      shown++;
    });
  });
  if (shown < total) lines.push('…외 ' + (total - shown) + '건 (웹앱에서 확인)');
  return chunkLines_(lines, limit);
}

/** 줄 배열을 limit 자 이하 청크로. 여러 청크면 "(i/n)" 꼬리표. */
function chunkLines_(lines, limit) {
  var tail = 8; // "\n(10/10)" 여유
  var body = limit - tail;
  var chunks = [], cur = '';
  lines.forEach(function (line, i) {
    if (line.length > body) line = line.slice(0, body - 1) + '…';
    var next = cur ? cur + '\n' + line : line;
    // 규칙 제목("■ …")은 첫 항목과 같은 청크에 두기 위해 다음 줄까지 들어가는지 미리 확인
    var isHeader = line.indexOf('■ ') === 0 && i + 1 < lines.length;
    var withNext = isHeader ? next + '\n' + lines[i + 1].slice(0, body) : next;
    if (cur && withNext.length > body) { chunks.push(cur); cur = line; } else { cur = next; }
  });
  if (cur) chunks.push(cur);
  if (chunks.length > 1) chunks = chunks.map(function (c, i) { return c + '\n(' + (i + 1) + '/' + chunks.length + ')'; });
  return chunks;
}
