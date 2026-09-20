/**
 * Triggers.gs — 트리거 진입점과 발송 파이프라인.
 *   dailyDigest()          매일 아침: 전체 평가 → 요약 1건(청크) 발송
 *   onEditInstalled(e)     설치형 편집 트리거: 편집된 행만 즉시발송 규칙 평가
 *   weeklyTokenKeepAlive() 주 1회 토큰 갱신
 */

/**
 * @param {boolean} [force]  true 면 오늘 이미 보낸 건도 다시 포함(메뉴 "지금 보내기"용)
 * @return {{count:number, channel:string, ok:boolean, error?:string, chunks:string[]}}
 */
function dailyDigest(force) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var today = new Date();
    refreshLastContact();
    fillMissingIds(SHEETS.CUSTOMERS);
    var data = loadData();
    var rules = loadRules();
    var all = evaluateRules(data, rules, today);
    var sent = force ? {} : loadTodayLogKeys(today);
    var cands = all.filter(function (c) { return !sent[dedupKey_(today, c)]; });
    var settings = readSettings();
    var chunks = buildDailySummary(cands, {
      today: today,
      maxItems: parseInt(settings['요약 최대 건수'], 10) || 15,
      userName: settings['사용자 이름'] || ''
    });
    if (cands.length === 0 && !force) {
      return { count: 0, channel: 'none', ok: true, chunks: chunks, skipped: all.length };
    }
    var result = deliver_(chunks, '오늘 챙길 고객 ' + fmtDate(today), settings);
    cands.forEach(function (c) {
      appendLog({ ruleId: c.ruleId, customerId: c.customerId, customerName: c.customerName, message: c.message,
        channel: 'daily/' + result.channel, status: result.ok ? '성공' : '실패', error: result.error || '', key: dedupKey_(today, c) });
    });
    return { count: cands.length, channel: result.channel, ok: result.ok, error: result.error, chunks: chunks };
  } finally {
    lock.releaseLock();
  }
}

/** 카카오 → (실패/미연결 시) 이메일 폴백. @return {{channel, ok, error}} */
function deliver_(texts, subject, settings) {
  settings = settings || readSettings();
  var webUrl = settings['웹앱 URL'] || '';
  var kakaoErr = '';
  var st = getConnectionStatus();
  if (st.status === 'CONNECTED' || props_().getProperty(PROP.KAKAO_REFRESH)) {
    var allOk = true;
    for (var i = 0; i < texts.length; i++) {
      var r = sendToMe(texts[i], i === 0 ? webUrl : null);
      if (!r.ok) { allOk = false; kakaoErr = r.error || ('HTTP ' + r.status); break; }
    }
    if (allOk) return { channel: 'kakao', ok: true };
  }
  // 카카오를 연결한 적이 없으면 이메일이 기본 채널이다(오류 아님) → 메일에 실패 문구를 붙이지 않는다.
  if (yn_(settings['이메일 폴백'] || 'Y')) {
    try {
      var to = Session.getEffectiveUser().getEmail();
      MailApp.sendEmail({ to: to, subject: '[고객관리] ' + subject + (kakaoErr ? ' (카카오 실패: 이메일로 대체)' : ''),
        body: texts.join('\n\n') + (webUrl ? '\n\n웹앱: ' + webUrl : '') + (kakaoErr ? '\n\n카카오 오류: ' + kakaoErr : '') });
      return { channel: 'email', ok: true, error: kakaoErr };
    } catch (e) {
      return { channel: 'email', ok: false, error: (kakaoErr ? kakaoErr + ' / ' : '') + '이메일 실패: ' + e.message };
    }
  }
  return { channel: 'kakao', ok: false, error: kakaoErr };
}

/** 즉시발송 후보들을 건별로 발송(중복키 검사 포함). @return 발송된 후보 배열 */
function sendCandidates(candidates, channel) {
  var today = new Date();
  var sent = loadTodayLogKeys(today);
  var out = [];
  var settings = readSettings();
  candidates.forEach(function (c) {
    var key = dedupKey_(today, c);
    if (sent[key]) return;
    var r = deliver_(['[즉시] ' + c.message], c.ruleName + ' — ' + c.customerName, settings);
    appendLog({ ruleId: c.ruleId, customerId: c.customerId, customerName: c.customerName, message: c.message,
      channel: (channel || 'immediate') + '/' + r.channel, status: r.ok ? '성공' : '실패', error: r.error || '', key: key });
    if (r.ok) out.push(c);
  });
  return out;
}

/** 편집된 행 1개(또는 저장된 객체)에 대해 즉시발송 규칙 평가 + 발송. 웹앱 저장 함수도 호출. */
function evaluateImmediateForRow(sheetName, rowObj, channel) {
  if (!rowObj) return [];
  var rules = loadRules().filter(function (r) { return yn_(r['사용']) && yn_(r['즉시발송']); });
  if (!rules.length) return [];
  var customers = readAll(SHEETS.CUSTOMERS);
  var data = { customers: customers, contacts: [], purchases: [] };
  if (sheetName === SHEETS.CUSTOMERS) data.customers = [rowObj];
  else if (sheetName === SHEETS.CONTACTS) data.contacts = [rowObj];
  else if (sheetName === SHEETS.PURCHASES) data.purchases = [rowObj];
  else return [];
  var cands = evaluateRules(data, rules, new Date(), { onlyImmediate: true });
  return sendCandidates(cands, channel || 'immediate');
}

/** 설치형 onEdit. 관련 탭·데이터 행만 처리 */
function onEditInstalled(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    var name = sheet.getName();
    if ([SHEETS.CUSTOMERS, SHEETS.CONTACTS, SHEETS.PURCHASES].indexOf(name) < 0) return;
    var row = e.range.getRow();
    if (row < 2) return;
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return;
    try {
      // ID 자동 부여
      fillMissingIds(name);
      var obj = readRow(name, row);
      if (!obj) return;
      // 상담/구매 행: 고객명 ↔ 고객ID 보정, 마지막연락일 갱신, 다음구매예정일 자동
      if (name !== SHEETS.CUSTOMERS) {
        var customers = readAll(SHEETS.CUSTOMERS);
        var before = JSON.stringify([obj['고객ID'], obj['고객명']]);
        resolveCustomerRefs_(obj, customers);
        var patch = {};
        if (JSON.stringify([obj['고객ID'], obj['고객명']]) !== before) { patch['고객ID'] = obj['고객ID']; patch['고객명'] = obj['고객명']; }
        if (name === SHEETS.PURCHASES && !obj['다음구매예정일'] && obj['재구매주기(일)'] && toDate(obj['구매일'])) {
          patch['다음구매예정일'] = addDays(obj['구매일'], Number(obj['재구매주기(일)']));
          obj['다음구매예정일'] = patch['다음구매예정일'];
        }
        if (Object.keys(patch).length) updateRowById(name, obj[ID_FIELD[name]], patch);
        if (obj['고객ID']) refreshLastContact(obj['고객ID']);
      } else {
        // 고객 탭: 단계 변경 시 단계변경일 자동
        var headers = headersOf_(sheet);
        var col = e.range.getColumn();
        if (headers[col - 1] === '단계' && e.value !== e.oldValue) {
          updateRowById(name, obj['고객ID'], { '단계변경일': new Date() });
        }
      }
      evaluateImmediateForRow(name, readRow(name, row), 'edit');
    } finally { lock.releaseLock(); }
  } catch (err) {
    console.error('onEditInstalled: ' + (err.stack || err));
  }
}

/** 주 1회: 발송이 없던 주에도 리프레시 토큰이 회전되도록 */
function weeklyTokenKeepAlive() {
  if (!props_().getProperty(PROP.KAKAO_REFRESH)) return 'skip';
  var t = refreshTokens();
  if (!t && yn_(getSetting('이메일 폴백', 'Y'))) {
    try {
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '[고객관리] 카카오 재연결 필요',
        '카카오 토큰 갱신에 실패했습니다. 웹앱 > 설정 > "카카오 연결"을 다시 눌러주세요.\n오류: ' + (props_().getProperty(PROP.KAKAO_LAST_ERROR) || ''));
    } catch (e) {}
  }
  return t ? 'refreshed' : 'failed';
}

/** 메뉴용 드라이런: 발송 없이 오늘 후보와 요약문 미리보기 */
function dryRunDaily() {
  var today = new Date();
  refreshLastContact();
  var data = loadData();
  var rules = loadRules();
  var cands = evaluateRules(data, rules, today);
  var settings = readSettings();
  var chunks = buildDailySummary(cands, { today: today, maxItems: parseInt(settings['요약 최대 건수'], 10) || 15, userName: settings['사용자 이름'] || '' });
  var byRule = groupByRule(cands).map(function (g) { return g.ruleName + ' ' + g.items.length + '건'; }).join(' / ');
  var msg = '후보 ' + cands.length + '건 (' + (byRule || '없음') + ')\n\n' + chunks.join('\n────\n');
  try { SpreadsheetApp.getUi().alert('오늘 알림 미리보기 (발송 안 함)', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return { candidates: serialize(cands), chunks: chunks };
}

/** 메뉴용: 지금 보내기(중복 무시) */
function sendDailyNowUi() {
  var r = dailyDigest(true);
  var msg = r.ok ? ('발송 완료: ' + r.count + '건 → ' + r.channel) : ('발송 실패: ' + r.error);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return r;
}
