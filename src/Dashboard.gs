/**
 * Dashboard.gs — 대시보드 집계 모델 (순수 함수).
 * 시트 접근 없음. Code.gs 의 api_getDashboard 가 데이터를 읽어 여기로 넘긴다.
 */

/**
 * @param {{customers, contacts, purchases}} data
 * @param {Object[]} candidates  evaluateRules 결과
 * @param {Date|string} today
 * @param {{months?:number, staleDays?:number}} [opts]
 */
function buildDashboardModel(data, candidates, today, opts) {
  opts = opts || {};
  var t = toDate(today) || toDate(new Date());
  var months = opts.months || 6;
  var customers = data.customers || [], purchases = data.purchases || [];
  var active = customers.filter(function (c) { return String(c['단계']) !== '이탈'; });

  // 이번 달 매출/건수 (구매일 기준)
  var ym = t.getFullYear() + '-' + pad_(t.getMonth() + 1, 2);
  var monthSales = 0, monthCount = 0;
  purchases.forEach(function (p) {
    var pd = toDate(p['구매일']);
    if (pd && fmtDate(pd).slice(0, 7) === ym) { monthSales += Number(p['금액']) || 0; monthCount++; }
  });

  // 최근 N개월 매출
  var series = [];
  for (var i = months - 1; i >= 0; i--) {
    var m = new Date(t.getFullYear(), t.getMonth() - i, 1);
    var key = m.getFullYear() + '-' + pad_(m.getMonth() + 1, 2);
    series.push({ key: key, label: (m.getMonth() + 1) + '월', total: 0, count: 0 });
  }
  var byKey = indexBy_(series, 'key');
  purchases.forEach(function (p) {
    var pd = toDate(p['구매일']);
    if (!pd) return;
    var k = fmtDate(pd).slice(0, 7);
    if (byKey[k]) { byKey[k].total += Number(p['금액']) || 0; byKey[k].count++; }
  });

  // 단계별 고객 수
  var stageOrder = LISTS['고객']['단계'];
  var stageCounts = stageOrder.map(function (s) {
    return { stage: s, count: customers.filter(function (c) { return String(c['단계']) === s; }).length };
  });

  // 미수금 합계
  var receivable = 0;
  purchases.forEach(function (p) {
    if (String(p['수금상태']) !== '완료' && p['수금상태'] !== '') receivable += Number(p['금액']) || 0;
  });

  // 오래된 순 상위 5 (이탈 제외)
  var stale = active.map(function (c) {
    var lc = toDate(c['마지막연락일']);
    return { customerId: c['고객ID'], customerName: c['고객명'], stage: c['단계'], intent: c['구매의향'],
      lastContact: lc ? fmtDate(lc) : '', days: lc ? daysBetween(lc, t) : null };
  }).sort(function (a, b) {
    if (a.days === null) return 1;
    if (b.days === null) return -1;
    return b.days - a.days;
  }).slice(0, 5);

  // 구매의향 상
  var highIntent = active.filter(function (c) { return String(c['구매의향']) === '상'; }).map(function (c) {
    var lc = toDate(c['마지막연락일']);
    return { customerId: c['고객ID'], customerName: c['고객명'], stage: c['단계'], nextIdea: c['다음제안아이디어'] || '',
      lastContact: lc ? fmtDate(lc) : '', days: lc ? daysBetween(lc, t) : null };
  });

  var todayCustomers = {};
  (candidates || []).forEach(function (c) { todayCustomers[c.customerId || c.customerName] = true; });

  return {
    today: fmtDate(t),
    kpi: {
      todayCount: Object.keys(todayCustomers).length,
      alertCount: (candidates || []).length,
      monthSales: monthSales,
      monthCount: monthCount,
      highIntentCount: highIntent.length,
      customerCount: active.length,
      receivable: receivable
    },
    groups: groupByRule(candidates || []),
    salesByMonth: series,
    stageCounts: stageCounts,
    stale: stale,
    highIntent: highIntent
  };
}
