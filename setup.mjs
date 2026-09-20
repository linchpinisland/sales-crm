#!/usr/bin/env node
/**
 * setup.mjs — 고객관리 도구 자동 설치.
 * 하는 일: 내 구글 드라이브에 새 구글 시트 "고객관리"를 만들고, 이 리포의 코드를 그 시트에 넣고,
 *          휴대폰용 웹앱까지 배포한다. 사람이 할 일은 구글 로그인과 "허용" 클릭뿐이다.
 * 사용법 : node setup.mjs            (처음 설치)
 *          node setup.mjs --status   (어디까지 됐는지만 확인)
 * 의존성 : Node 18+, @google/clasp 3.x (없거나 2.x면 설치·업데이트 명령을 안내하고 멈춘다)
 * clasp 3 명령 체계 사용: create-script / create-deployment / update-deployment / show-authorized-user (--json)
 * 종료코드: 0 성공 / 2 사람이 할 일이 남음(메시지에 정확히 무엇인지 적힘) / 1 오류
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const CLASP_JSON = path.join(ROOT, '.clasp.json');
const STATE = path.join(ROOT, '.setup-state.json');
const MANIFEST = path.join(SRC, 'appsscript.json');
const DEPLOY_INFO = path.join(SRC, 'DeployInfo.gs');
const TITLE = process.env.CRM_TITLE || '고객관리';

const say = (s) => console.log(s);
const human = (title, steps) => {
  say('\n──────── 사람이 할 일 ────────');
  say(title);
  steps.forEach((s, i) => say(`  ${i + 1}. ${s}`));
  say('끝나면 같은 명령을 다시 실행하세요:  node setup.mjs');
  process.exit(2);
};
const run = (cmd, opts = {}) => {
  const r = spawnSync(cmd, { shell: true, cwd: ROOT, encoding: 'utf8', ...opts });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
};
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));

function checkClasp() {
  const r = run('clasp --version');
  const m = r.out.match(/(\d+)\.(\d+)\.(\d+)/);
  if (r.code !== 0 || !m) {
    human('clasp(구글 Apps Script 도구)가 없습니다.', ['터미널에서 실행:  npm install -g @google/clasp']);
  }
  if (Number(m[1]) < 3) {
    human(`clasp ${m[0]} 은 오래된 버전입니다. 3.x 가 필요합니다.`, ['터미널에서 실행:  npm install -g @google/clasp@latest']);
  }
}

/** --json 출력에서 JSON 부분만 뽑아 파싱(경고 문구가 앞뒤에 섞여도 동작). */
function parseJson(out) {
  const s = out.indexOf('{'), a = out.indexOf('[');
  const start = (a !== -1 && (a < s || s === -1)) ? a : s;
  if (start === -1) return null;
  const end = Math.max(out.lastIndexOf('}'), out.lastIndexOf(']'));
  try { return JSON.parse(out.slice(start, end + 1)); } catch { return null; }
}

function checkLogin(state) {
  const r = run('clasp show-authorized-user --json');
  const j = parseJson(r.out);
  const ok = j ? j.loggedIn === true : /logged in as/i.test(r.out);
  if (!ok) {
    human('구글 로그인이 필요합니다.', [
      '터미널에서 실행:  clasp login',
      '브라우저가 열리면 도구를 쓸 구글 계정을 고르고 "허용"',
    ]);
  }
  state.account = (j && j.email) || (r.out.match(/logged in as ([^\s.]+@[^\s]+?)\.?\s/i) || [])[1] || '';
  if (state.account) say(`구글 계정: ${state.account}`);
}

function apiDisabled(out) {
  return /User has not enabled the Apps Script API|Apps Script API has not been used|script\.google\.com\/home\/usersettings/i.test(out);
}
function askEnableApi(account) {
  human('구글 계정에서 "Apps Script API"를 켜야 합니다. (계정마다 한 번)' + (account ? `  ← 계정: ${account}` : ''), [
    '브라우저에서 열기:  https://script.google.com/home/usersettings',
    '로그인한 계정이 clasp login 때 고른 계정과 같은지 확인',
    '"Google Apps Script API"를 "사용"으로 바꾸기',
    '1분쯤 기다리기',
  ]);
}

function createSheet(state) {
  if (fs.existsSync(CLASP_JSON)) {
    const j = JSON.parse(fs.readFileSync(CLASP_JSON, 'utf8'));
    if (j.scriptId && !/여기에/.test(j.scriptId)) {
      state.scriptId = j.scriptId;
      state.sheetId = state.sheetId || (Array.isArray(j.parentId) ? j.parentId[0] : j.parentId) || '';
      say(`이미 만들어진 시트가 있습니다. (scriptId ${j.scriptId.slice(0, 8)}…) 이어서 진행합니다.`);
      return;
    }
  }
  say(`1/4 구글 시트 "${TITLE}" 만드는 중…`);
  const manifestBackup = fs.readFileSync(MANIFEST, 'utf8'); // clasp create 가 덮어쓰므로 보관
  const r = run(`clasp create-script --type sheets --title "${TITLE}" --rootDir src`);
  fs.writeFileSync(MANIFEST, manifestBackup);
  if (apiDisabled(r.out)) askEnableApi(state.account);
  if (r.code !== 0 || !fs.existsSync(CLASP_JSON)) {
    // clasp 버전에 따라 .clasp.json 이 src/ 안에 생기기도 한다
    const alt = path.join(SRC, '.clasp.json');
    if (fs.existsSync(alt)) fs.renameSync(alt, CLASP_JSON);
  }
  if (!fs.existsSync(CLASP_JSON)) { say(r.out); throw new Error('시트 생성 실패 — 위 메시지를 확인하세요.'); }
  const j = JSON.parse(fs.readFileSync(CLASP_JSON, 'utf8'));
  j.rootDir = 'src';
  fs.writeFileSync(CLASP_JSON, JSON.stringify(j, null, 2));
  state.scriptId = j.scriptId;
  const pid = Array.isArray(j.parentId) ? j.parentId[0] : j.parentId;
  const m = r.out.match(/(?:spreadsheets\/d\/|open\?id=|\/d\/)([A-Za-z0-9_-]{25,})/);
  state.sheetId = pid || (m && m[1]) || '';
  writeState(state);
}

function push(state) {
  const r = run('clasp push -f');
  if (apiDisabled(r.out)) askEnableApi(state.account);
  if (r.code !== 0) { say(r.out); throw new Error('코드 올리기 실패'); }
}

function deploy(state) {
  say(state.deploymentId ? '3/4 웹앱을 같은 주소로 새 버전 배포 중…' : '3/4 휴대폰용 웹앱 배포 중…');
  const cmd = state.deploymentId
    ? `clasp update-deployment ${state.deploymentId} -d "setup" --json`
    : 'clasp create-deployment -d "setup" --json';
  const r = run(cmd);
  if (r.code !== 0) { say(r.out); throw new Error('웹앱 배포 실패'); }
  const j = parseJson(r.out);
  const id = (j && (j.deploymentId || (Array.isArray(j) && j[0] && j[0].deploymentId))) || (r.out.match(/(AKfycb[A-Za-z0-9_-]+)/) || [])[1];
  if (id) state.deploymentId = id;
  if (!state.deploymentId) { say(r.out); throw new Error('배포 ID를 읽지 못했습니다.'); }
  state.webAppUrl = `https://script.google.com/macros/s/${state.deploymentId}/exec`;
  writeState(state);
}

/** @return {boolean} 파일이 바뀌었으면 true */
function writeDeployInfo(url) {
  const before = fs.readFileSync(DEPLOY_INFO, 'utf8');
  const after = before.replace(/var DEPLOYED_WEBAPP_URL = '[^']*';/, `var DEPLOYED_WEBAPP_URL = '${url}';`);
  if (after === before) return false;
  fs.writeFileSync(DEPLOY_INFO, after);
  return true;
}

/**
 * 사용자가 "눈으로 보는" 바탕화면 경로를 찾는다.
 * Windows 는 OneDrive 백업이 켜져 있으면 실제 바탕화면이 %OneDrive%\\Desktop(또는 "바탕 화면")으로 옮겨져 있어
 * ~/Desktop 에 만들면 보이지 않는 폴더가 된다 → 셸에 등록된 Desktop 경로를 직접 물어본다.
 */
function realDesktop() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8' });
    const p = (ps.stdout || '').trim();
    if (p && fs.existsSync(p)) return p;
    const od = process.env.OneDrive || process.env.OneDriveConsumer || process.env.OneDriveCommercial;
    for (const base of [od, home].filter(Boolean)) {
      for (const name of ['Desktop', '바탕 화면']) {
        const c = path.join(base, name);
        if (fs.existsSync(c)) return c;
      }
    }
    return null;
  }
  if (process.platform === 'linux') {
    const x = spawnSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' });
    const p = (x.stdout || '').trim();
    if (p && p !== home && fs.existsSync(p)) return p;
  }
  const d = path.join(home, 'Desktop');
  return fs.existsSync(d) ? d : null;
}

function openFolder(dir) {
  try {
    if (process.platform === 'win32') spawnSync('explorer.exe', [dir]);
    else if (process.platform === 'darwin') spawnSync('open', [dir]);
    else spawnSync('xdg-open', [dir]);
  } catch { /* 열기 실패는 무시 — 경로는 화면에 출력된다 */ }
}

function workspace(state) {
  // 바탕화면을 못 찾으면 이 리포 폴더 옆에 만든다(사용자가 고른 폴더 안이라 반드시 보인다).
  const base = process.env.CRM_WORKSPACE_DIR || realDesktop() || path.dirname(ROOT);
  const dir = path.join(base, '고객관리-클로드폴더');
  const skillDst = path.join(dir, '.claude', 'skills', 'sales-weekly-picks');
  fs.mkdirSync(path.dirname(skillDst), { recursive: true });
  fs.cpSync(path.join(ROOT, 'skills', 'sales-weekly-picks'), skillDst, { recursive: true });
  fs.writeFileSync(path.join(dir, '여기에_CSV_세개를_넣으세요.txt'),
    '구글 시트 메뉴 [고객관리] → CSV 내보내기 로 받은 고객.csv · 상담기록.csv · 구매기록.csv 를 이 폴더에 넣고,\n클로드 코드에서 이 폴더를 열어 "이번 주 챙길 고객 뽑아줘" 라고 하세요.\n');
  state.workspace = dir;
  writeState(state);
  if (!process.env.CRM_NO_OPEN) openFolder(dir);
}

function finish(state) {
  const sheetUrl = state.sheetId ? `https://docs.google.com/spreadsheets/d/${state.sheetId}/edit` : '(구글 드라이브에서 "' + TITLE + '" 시트를 여세요)';
  say('\n════════ 설치 완료 ════════');
  say(`구글 시트 : ${sheetUrl}`);
  say(`웹앱(휴대폰): ${state.webAppUrl}`);
  say(`클로드 폴더: ${state.workspace}  (방금 탐색기/파인더로 열어 드렸습니다)`);
  say('\n──────── 마지막으로 사람이 할 일 (2분) ────────');
  say('  1. 위 구글 시트 주소를 연다. 메뉴 [고객관리]가 안 보이면 새로고침 후 5초.');
  say('  2. [고객관리] → [① 초기 설정 실행] → "승인 필요" → 내 계정 → "고급" → "…(으)로 이동" → 허용.');
  say('  3. [① 초기 설정 실행]을 한 번 더 누른다. "초기 설정 완료"가 뜨면 끝. 웹앱 주소는 자동으로 들어간다.');
  say('  4. [데모 데이터 넣기]로 둘러보고, [오늘 알림 지금 보내기]로 메일이 오는지 확인.');
}

(async function main() {
  const state = readState();
  if (process.argv.includes('--status')) { say(JSON.stringify(state, null, 2)); return; }
  try {
    checkClasp();
    checkLogin(state);
    createSheet(state);
    say('2/4 코드를 시트에 넣는 중…');
    push(state);
    deploy(state);
    if (writeDeployInfo(state.webAppUrl)) { // 웹앱 주소가 새로 정해졌을 때만 한 번 더 올린다
      push(state);
      deploy(state); // 같은 주소로 새 버전
    }
    say('4/4 클로드 코드용 폴더 만드는 중…');
    workspace(state);
    finish(state);
  } catch (e) {
    say('\n[오류] ' + e.message);
    process.exit(1);
  }
})();
