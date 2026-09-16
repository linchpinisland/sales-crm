/**
 * Test.gs — 규칙 엔진·데모 데이터 테스트.
 * Apps Script 편집기에서 runAllTests() 실행 → 로그 확인. Node에서는 dev/run-tests.js 가 같은 함수를 호출.
 * 순수 함수만 사용(시트 접근 없음).
 */

function runAllTests() {
  var results = [];
  function t(name, fn) {
    try { fn(); results.push({ name: name, ok: true }); }
    catch (e) { results.push({ name: name, ok: false, error: String(e && e.message || e) }); }
  }
  function eq(a, b, msg) {
    var sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) throw new Error((msg || '') + ' expected ' + sb + ' got ' + sa);
  }
  function ok(v, msg) { if (!v) throw new Error(msg || 'assertion failed'); }

  var TODAY = '2026-09-16';

  t('daysBetween 기본/음수', function () {
    eq(daysBetween('2026-09-01', TODAY), 15);
    eq(daysBetween(TODAY, '2026-09-10'), -6);
    eq(daysBetween('', TODAY), null);
  });

  t('toDate 다양한 입력', function () {
    eq(fmtDate(toDate('2026-9-3')), '2026-09-03');
    eq(fmtDate(toDate('2026.09.03')), '2026-09-03');
    eq(fmtDate(toDate(new Date(2026, 8, 3, 15, 30))), '2026-09-03');
    eq(toDate('abc'), null);
  });

  t('nextAnniversary 연말 넘김 / 2월 29일', function () {
    eq(fmtDate(nextAnniversary('1980-12-30', '2026-12-29')), '2026-12-30');
    eq(fmtDate(nextAnniversary('1980-01-02', '2026-12-29')), '2027-01-02');
    eq(fmtDate(nextAnniversary('1988-02-29', '2026-02-20')), '2026-02-28'); // 평년
    eq(fmtDate(nextAnniversary('1988-02-29', '2028-02-20')), '2028-02-29'); // 윤년
    eq(fmtDate(nextAnniversary('1980-09-16', TODAY)), '2026-09-16'); // 오늘 포함
  });

  t('parseFilter / matchesFilter', function () {
    var f = parseFilter('유형=견적발송; 결과!=성사');
    eq(f, [{ field: '유형', op: '=', value: '견적발송' }, { field: '결과', op: '!=', value: '성사' }]);
    ok(matchesFilter_({ '유형': '견적발송', '결과': '대기' }, f));
    ok(!matchesFilter_({ '유형': '견적발송', '결과': '성사' }, f));
    ok(!matchesFilter_({ '유형': '방문', '결과': '대기' }, f));
    ok(matchesFilter_({ '금액': 1200000 }, parseFilter('금액=1,200,000')), '숫자 포맷 비교');
  });

  t('renderTemplate 미지 플레이스홀더·숫자·날짜', function () {
    var s = renderTemplate('{고객명} {금액}원 {없음}|{기준일}', { '고객명': '대성', '금액': 4800000, '기준일': new Date(2026, 8, 1) });
    eq(s, '대성 4,800,000원 |2026-09-01');
  });

  var rules = defaultRuleObjects();

  t('경과일이상 경계 (20일 안 걸림, 21일 걸림)', function () {
    var data = { customers: [
      { '고객ID': 'C1', '고객명': 'A', '단계': '거래중', '마지막연락일': '2026-08-27' }, // 20일
      { '고객ID': 'C2', '고객명': 'B', '단계': '거래중', '마지막연락일': '2026-08-26' }, // 21일
      { '고객ID': 'C3', '고객명': 'C', '단계': '이탈', '마지막연락일': '2026-01-01' }   // 필터 제외
    ], contacts: [], purchases: [] };
    var out = evaluateRules(data, rules.filter(function (r) { return r['규칙ID'] === 'R01'; }), TODAY);
    eq(out.map(function (c) { return c.customerId; }), ['C2']);
    eq(out[0].days, 21);
    eq(out[0].message, 'B 마지막 연락 21일째');
  });

  t('D일이내 경계 (D-0 걸림, D-7 걸림, D-8·D+1 안 걸림)', function () {
    var data = { customers: [{ '고객ID': 'C1', '고객명': 'A' }], contacts: [], purchases: [
      { '구매ID': 'P1', '고객ID': 'C1', '제품/서비스': 'x', '계약만료일/납기일': '2026-09-16' },
      { '구매ID': 'P2', '고객ID': 'C1', '제품/서비스': 'y', '계약만료일/납기일': '2026-09-23' },
      { '구매ID': 'P3', '고객ID': 'C1', '제품/서비스': 'z', '계약만료일/납기일': '2026-09-24' },
      { '구매ID': 'P4', '고객ID': 'C1', '제품/서비스': 'w', '계약만료일/납기일': '2026-09-15' }
    ] };
    var out = evaluateRules(data, rules.filter(function (r) { return r['규칙ID'] === 'R04'; }), TODAY);
    // 같은 고객은 가장 급한 1건만
    eq(out.length, 1);
    eq(out[0].rowId, 'P1');
    eq(out[0].message, 'A x 만료 오늘');
  });

  t('연간반복 생일 D-3', function () {
    var data = { customers: [
      { '고객ID': 'C1', '고객명': 'A', '담당자': '김', '생일': '1980-09-19' },
      { '고객ID': 'C2', '고객명': 'B', '담당자': '이', '생일': '1980-09-20' },
      { '고객ID': 'C3', '고객명': 'C', '담당자': '박', '생일': '' }
    ], contacts: [], purchases: [] };
    var out = evaluateRules(data, rules.filter(function (r) { return r['규칙ID'] === 'R06'; }), TODAY);
    eq(out.map(function (c) { return c.customerName; }), ['A']);
    eq(out[0].message, 'A 김 생일 D-3');
  });

  t('필드값일치 + onlyImmediate', function () {
    var r9 = rules.filter(function (r) { return r['규칙ID'] === 'R09'; }).map(function (r) { var o = {}; for (var k in r) o[k] = r[k]; o['사용'] = 'Y'; return o; });
    var data = { customers: [{ '고객ID': 'C1', '고객명': 'A', '구매의향': '상' }, { '고객ID': 'C2', '고객명': 'B', '구매의향': '중' }], contacts: [], purchases: [] };
    var out = evaluateRules(data, r9, TODAY, { onlyImmediate: true });
    eq(out.map(function (c) { return c.customerId; }), ['C1']);
    ok(out[0].immediate);
    eq(evaluateRules(data, rules, TODAY, { onlyImmediate: true }).length, 0, '기본 규칙은 즉시발송 없음');
  });

  t('정렬: 규칙 정렬순서 → 급한 순', function () {
    var data = { customers: [
      { '고객ID': 'C1', '고객명': 'A', '단계': '거래중', '마지막연락일': '2026-08-01' },
      { '고객ID': 'C2', '고객명': 'B', '단계': '거래중', '마지막연락일': '2026-07-01' }
    ], contacts: [], purchases: [] };
    var out = evaluateRules(data, rules, TODAY);
    eq(out.map(function (c) { return c.customerId; }), ['C2', 'C1']);
  });

  t('buildDailySummary 200자 청크', function () {
    var cands = [];
    for (var i = 0; i < 12; i++) cands.push({ ruleId: 'R01', ruleName: '장기 미접촉', message: '거래처' + i + ' 마지막 연락 ' + (30 + i) + '일째' });
    var chunks = buildDailySummary(cands, { today: TODAY, maxItems: 15, limit: 200 });
    ok(chunks.length >= 2, '여러 청크');
    chunks.forEach(function (c) { ok(c.length <= 200, '청크 길이 ' + c.length); });
    ok(chunks[0].indexOf('[오늘 챙길 고객 9/16] 12건') === 0);
    ok(/\(1\/\d\)$/.test(chunks[0]));
    eq(buildDailySummary([], { today: TODAY }), ['[오늘 챙길 고객 9/16] 오늘은 알림 0건. 편안한 하루 되세요.']);
    var capped = buildDailySummary(cands, { today: TODAY, maxItems: 3, limit: 200 }).join('\n');
    ok(capped.indexOf('…외 9건') >= 0, 'maxItems 초과 표시');
  });

  t('데모 데이터: 기본 규칙 7개 모두 최소 1건, 경계 케이스 제외', function () {
    var data = buildDemoData(TODAY);
    eq(data.customers.length, 25);
    var out = evaluateRules(data, rules, TODAY);
    var byRule = {};
    out.forEach(function (c) { (byRule[c.ruleId] = byRule[c.ruleId] || []).push(c.customerId); });
    ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07'].forEach(function (id) { ok(byRule[id] && byRule[id].length >= 1, id + ' 0건'); });
    eq(byRule['R01'].sort(), ['C003', 'C008', 'C015']);
    eq(byRule['R02'].sort(), ['C005', 'C012']);
    eq(byRule['R03'].sort(), ['C001', 'C009']);
    eq(byRule['R04'].sort(), ['C002', 'C014']);
    eq(byRule['R05'].sort(), ['C006', 'C013']);
    eq(byRule['R06'].sort(), ['C004', 'C010']);
    eq(byRule['R07'].sort(), ['C007']);
    ok(!byRule['R08'] && !byRule['R09'], '예시 규칙은 OFF');
  });

  t('대시보드 모델', function () {
    var data = buildDemoData(TODAY);
    var cands = evaluateRules(data, rules, TODAY);
    var m = buildDashboardModel(data, cands, TODAY);
    eq(m.salesByMonth.length, 6);
    ok(m.kpi.monthSales > 0, '이번 달 매출');
    eq(m.stale.length, 5);
    eq(m.stale[0].customerId, 'C015');
    ok(m.highIntent.length >= 4);
    eq(m.stageCounts.reduce(function (s, x) { return s + x.count; }, 0), 25);
  });

  var passed = results.filter(function (r) { return r.ok; }).length;
  var lines = results.map(function (r) { return (r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : ' — ' + r.error); });
  lines.push('— ' + passed + '/' + results.length + ' passed');
  var report = lines.join('\n');
  if (typeof Logger !== 'undefined') Logger.log(report);
  return { passed: passed, total: results.length, report: report, results: results };
}

/** 메뉴용: 결과를 다이얼로그로 */
function runAllTestsUi() {
  var r = runAllTests();
  SpreadsheetApp.getUi().alert('테스트 결과 ' + r.passed + '/' + r.total, r.report, SpreadsheetApp.getUi().ButtonSet.OK);
}
