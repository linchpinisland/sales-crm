/**
 * Kakao.gs — 카카오 "나에게 보내기" (OAuth 인가 코드 → 토큰 → /v2/api/talk/memo/default/send)
 * 토큰은 ScriptProperties 에만 저장한다(시트에 두지 않음).
 *
 * 사용자 사전 준비 (docs/카카오연동.md):
 *   1) developers.kakao.com > 내 애플리케이션 > 앱 추가 → REST API 키
 *   2) 카카오 로그인 활성화 ON, Redirect URI 에 웹앱 /exec URL 등록
 *   3) 동의항목 > 카카오톡 메시지 전송(talk_message) 설정
 */

function props_() { return PropertiesService.getScriptProperties(); }

function kakaoConfig_() {
  var s = readSettings();
  return {
    restKey: s['카카오 REST API 키'] || '',
    secret: s['카카오 Client Secret'] || '',
    redirectUri: s['웹앱 URL'] || ''
  };
}

/** 인가 URL. state 는 CSRF 방지용으로 저장 후 콜백에서 대조 */
function getAuthUrl() {
  var cfg = kakaoConfig_();
  if (!cfg.restKey) throw new Error('설정 탭에 "카카오 REST API 키"를 먼저 입력하세요.');
  if (!cfg.redirectUri) throw new Error('설정 탭에 "웹앱 URL"(/exec)을 먼저 입력하세요.');
  var state = Utilities.getUuid().replace(/-/g, '');
  props_().setProperty(PROP.OAUTH_STATE, state);
  return KAKAO.AUTH_URL + '?response_type=code' +
    '&client_id=' + encodeURIComponent(cfg.restKey) +
    '&redirect_uri=' + encodeURIComponent(cfg.redirectUri) +
    '&scope=' + encodeURIComponent(KAKAO.SCOPE) +
    '&state=' + state;
}

/** doGet 콜백 처리 → {ok, error} */
function handleCallback(code, state) {
  var saved = props_().getProperty(PROP.OAUTH_STATE);
  if (saved && state && saved !== state) return { ok: false, error: 'state 불일치(다시 연결 버튼을 눌러주세요)' };
  try {
    var json = exchangeCode(code);
    saveTokens_(json);
    props_().deleteProperty(PROP.OAUTH_STATE);
    return { ok: true };
  } catch (e) {
    props_().setProperty(PROP.KAKAO_LAST_ERROR, String(e.message || e));
    return { ok: false, error: String(e.message || e) };
  }
}

function tokenRequest_(payload) {
  var cfg = kakaoConfig_();
  payload.client_id = cfg.restKey;
  if (cfg.secret) payload.client_secret = cfg.secret;
  var res = UrlFetchApp.fetch(KAKAO.TOKEN_URL, {
    method: 'post', contentType: 'application/x-www-form-urlencoded', payload: payload, muteHttpExceptions: true
  });
  var body = res.getContentText();
  var json;
  try { json = JSON.parse(body); } catch (e) { throw new Error('토큰 응답 파싱 실패: ' + body.slice(0, 200)); }
  if (res.getResponseCode() !== 200 || json.error) {
    throw new Error('카카오 토큰 오류 ' + res.getResponseCode() + ': ' + (json.error_description || json.error || body.slice(0, 200)));
  }
  return json;
}

function exchangeCode(code) {
  var cfg = kakaoConfig_();
  return tokenRequest_({ grant_type: 'authorization_code', redirect_uri: cfg.redirectUri, code: code });
}

/** 토큰 응답 저장. refresh_token 이 없으면(갱신 시) 기존 유지 */
function saveTokens_(json) {
  var p = props_();
  var now = Date.now();
  var patch = {};
  patch[PROP.KAKAO_ACCESS] = json.access_token;
  patch[PROP.KAKAO_ACCESS_EXP] = String(now + (Number(json.expires_in) || 21600) * 1000);
  if (json.refresh_token) {
    patch[PROP.KAKAO_REFRESH] = json.refresh_token;
    patch[PROP.KAKAO_REFRESH_EXP] = String(now + (Number(json.refresh_token_expires_in) || 5184000) * 1000);
  }
  if (!p.getProperty(PROP.KAKAO_CONNECTED_AT)) patch[PROP.KAKAO_CONNECTED_AT] = new Date().toISOString();
  patch[PROP.KAKAO_STATUS] = 'CONNECTED';
  patch[PROP.KAKAO_LAST_ERROR] = '';
  p.setProperties(patch, false);
}

/** 유효한 액세스 토큰 반환. 만료 임박이면 갱신. 미연결이면 null */
function ensureAccessToken() {
  var p = props_();
  var token = p.getProperty(PROP.KAKAO_ACCESS);
  var refresh = p.getProperty(PROP.KAKAO_REFRESH);
  if (!token && !refresh) return null;
  var exp = Number(p.getProperty(PROP.KAKAO_ACCESS_EXP) || 0);
  if (token && Date.now() < exp - KAKAO.REFRESH_MARGIN_MS) return token;
  return refreshTokens();
}

/** 리프레시. 실패 시 DISCONNECTED 기록 후 null */
function refreshTokens() {
  var p = props_();
  var refresh = p.getProperty(PROP.KAKAO_REFRESH);
  if (!refresh) return null;
  try {
    var json = tokenRequest_({ grant_type: 'refresh_token', refresh_token: refresh });
    saveTokens_(json);
    return json.access_token;
  } catch (e) {
    p.setProperties({ KAKAO_STATUS: 'DISCONNECTED', KAKAO_LAST_ERROR: String(e.message || e) }, false);
    return null;
  }
}

/**
 * 나에게 보내기. text 는 200자 이하.
 * @return {{ok:boolean, status:number, error?:string}}
 */
function sendToMe(text, linkUrl) {
  var token = ensureAccessToken();
  if (!token) return { ok: false, status: 0, error: '카카오 미연결 또는 토큰 만료 — 설정에서 다시 연결' };
  if (text.length > KAKAO.TEXT_LIMIT) text = text.slice(0, KAKAO.TEXT_LIMIT - 1) + '…';
  var tpl = { object_type: 'text', text: text, link: {} };
  if (linkUrl) { tpl.link = { web_url: linkUrl, mobile_web_url: linkUrl }; tpl.button_title = '웹앱 열기'; }
  var res = UrlFetchApp.fetch(KAKAO.SEND_URL, {
    method: 'post',
    headers: { Authorization: 'Bearer ' + token },
    contentType: 'application/x-www-form-urlencoded',
    payload: { template_object: JSON.stringify(tpl) },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 200) return { ok: true, status: 200 };
  var body = res.getContentText();
  // 링크 도메인 미등록(-?) 등으로 실패하면 링크 없이 재시도
  if (linkUrl && code === 400) return sendToMe(text, null);
  if (code === 401) { props_().setProperties({ KAKAO_STATUS: 'DISCONNECTED', KAKAO_LAST_ERROR: body.slice(0, 200) }, false); }
  return { ok: false, status: code, error: body.slice(0, 300) };
}

function getConnectionStatus() {
  var p = props_();
  var cfg = kakaoConfig_();
  return {
    status: p.getProperty(PROP.KAKAO_STATUS) || '',
    connectedAt: p.getProperty(PROP.KAKAO_CONNECTED_AT) || '',
    accessExpiresAt: p.getProperty(PROP.KAKAO_ACCESS_EXP) ? new Date(Number(p.getProperty(PROP.KAKAO_ACCESS_EXP))).toISOString() : '',
    refreshExpiresAt: p.getProperty(PROP.KAKAO_REFRESH_EXP) ? new Date(Number(p.getProperty(PROP.KAKAO_REFRESH_EXP))).toISOString() : '',
    lastError: p.getProperty(PROP.KAKAO_LAST_ERROR) || '',
    restKeySet: !!cfg.restKey,
    redirectUri: cfg.redirectUri
  };
}

function disconnect() {
  var p = props_();
  [PROP.KAKAO_ACCESS, PROP.KAKAO_ACCESS_EXP, PROP.KAKAO_REFRESH, PROP.KAKAO_REFRESH_EXP, PROP.KAKAO_CONNECTED_AT, PROP.KAKAO_STATUS, PROP.KAKAO_LAST_ERROR, PROP.OAUTH_STATE]
    .forEach(function (k) { p.deleteProperty(k); });
  return true;
}

/** 콜백 결과 페이지 HTML */
function callbackPage_(result) {
  var ok = result.ok;
  var test = ok ? sendToMe('[고객관리] 카카오톡 연결 완료! 매일 아침 요약이 이 채팅으로 옵니다.') : null;
  var body = ok
    ? '<h2>✅ 카카오톡 연결 완료</h2><p>' + (test && test.ok ? '테스트 메시지를 보냈습니다. 카카오톡 "나와의 채팅"을 확인하세요.' : '연결은 됐지만 테스트 발송 실패: ' + escapeHtml_(test ? test.error : '')) + '</p>'
    : '<h2>❌ 연결 실패</h2><p>' + escapeHtml_(result.error || '') + '</p>';
  var url = getSetting('웹앱 URL');
  return HtmlService.createHtmlOutput(
    '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif;padding:32px;max-width:520px;margin:auto;color:#202124}a{color:#1a73e8}</style></head><body>' +
    body + (url ? '<p><a href="' + url + '#settings" target="_top">← 웹앱으로 돌아가기</a></p>' : '<p>이 탭을 닫고 웹앱으로 돌아가세요.</p>') +
    '</body></html>').setTitle('카카오 연결');
}

function escapeHtml_(s) {
  return String(s || '').replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
