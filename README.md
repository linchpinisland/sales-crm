# 고객관리 (Sales CRM) — 구글 시트 + Apps Script + 매일 아침 알림

영업사원 한 사람이 거래처를 놓치지 않게 하는 가장 가벼운 도구. 구글 시트가 DB, Apps Script 웹앱이 화면, 매일 아침 "오늘 챙길 고객"이 카카오톡(나와의 채팅)으로 옵니다. 서버 없음, 비용 0, 개인 계정만으로 동작.

| 화면 | 역할 |
|---|---|
| **대시보드** | 오늘 챙길 고객(규칙별) · 이번 달 매출 · 미수금 · 의향 "상" 고객 · 오래된 순 상위 5 · 6개월 매출 차트 |
| **고객** | 검색·단계 필터·정렬 → 상세(기본 정보 · 고민/취향/다음 제안 · 상담 타임라인 · 구매 이력 · 걸린 알림) |
| **기록 입력** | 고객 추가/수정 · 상담기록 · 구매기록 (모바일에서 30초) |
| **설정** | 카카오 연결 · 발송 시각 · 요약 미리보기 · CSV 내보내기 |

## 알림 규칙 (시트 한 줄이 규칙 하나)

기본 7개: 장기 미접촉 21일 / 견적 후 무응답 7일 / 재구매 주기 도래 D-7 / 계약·납기 만료 D-7 / 미수금 기일 경과 / 담당자 생일 D-3 / 거래처 기념일 D-3.
**알림규칙** 탭에 행을 추가하면 내 규칙이 됩니다. 예) `구매의향=상` 이 되는 순간 즉시 카톡.

```
규칙ID | 규칙명 | 사용 | 대상시트 | 기준필드 | 조건유형 | 일수 | 필터 | 메시지템플릿 | 즉시발송 | 정렬순서
R10 | VIP 미접촉 | Y | 고객 | 마지막연락일 | 경과일이상 | 10 | 구매의향=상 | {고객명} VIP인데 {일수}일 방치 | N | 15
```

조건유형: `경과일이상` · `D일이내` · `연간반복D일이내` · `필드값일치`. 템플릿 플레이스홀더: `{고객명} {일수} {D-표기} {기준일}` + 아무 컬럼명.

## 가장 쉬운 설치 — AI에게 맡기기

클로드 코드(또는 Codex·Antigravity)에 이 한 줄을 보내세요.

```text
https://github.com/linchpinisland/sales-crm 이거 세팅해줘
```

AI가 구글 시트 만들기, 코드 넣기, 휴대폰용 웹앱 배포까지 합니다. 사람은 구글 로그인과 "허용"만 누르면 됩니다. (지침: [CLAUDE.md](CLAUDE.md), 스크립트: `node setup.mjs`)

## 손으로 설치 (비개발자, 15분)

1. **[템플릿 사본 만들기](https://docs.google.com/spreadsheets/d/1sMo04O-tcp0EA8_7YLh0x_NMjbhPLb8m3632nYFZO34/copy)** 링크 클릭 → 사본 만들기
2. 메뉴 **[고객관리] → [① 초기 설정 실행]** (권한 승인)
3. **확장 프로그램 → Apps Script → 배포 → 새 배포 → 웹 앱** (나 / 본인만) → URL을 설정 탭에
4. 알림은 기본으로 **내 Gmail**에 옵니다. 카카오톡으로 받고 싶을 때만(선택) [docs/카카오연동.md](docs/카카오연동.md)
5. **[데모 데이터 넣기]** 로 둘러본 뒤 **[데모 데이터 지우기]**

자세히: [docs/설치가이드.md](docs/설치가이드.md)

## Claude Code 스킬: 이번 주 챙길 고객 5곳

시트 메뉴 **[CSV 내보내기]** → 폴더를 내려받아 Claude Code 작업 폴더에 넣고 `skills/sales-weekly-picks` 를 설치한 뒤:

> "이번 주 챙길 고객 뽑아줘"

→ `이번주_챙길고객.md` (5곳 + 이유 + 첫 마디, 고객별 다음 제안, 데이터 품질 메모). 예시: [demo/이번주_챙길고객_예시.md](demo/이번주_챙길고객_예시.md)

## 어떻게 만들었나

코드는 전부 Claude Code로 시켜서 나왔고 사람이 친 코드는 없습니다. 최상위 모델로 만들었지만 **Opus·Sonnet 같은 저렴한 모델로 같은 걸 만드는 순서**(설계서 → 순수 함수 → 테스트 → 화면)를 [docs/만든방법_저렴한모델로.md](docs/만든방법_저렴한모델로.md)에 정리했습니다. 이 리포 구조가 그 순서 그대로입니다.

## 개발

```
src/            Apps Script (clasp push 대상)
  Config.gs     상수·헤더·기본 규칙          ┐
  Rules.gs      규칙 엔진 (순수 함수)         │ Node 에서 테스트·미리보기 가능
  DemoData.gs   데모 데이터 생성 (순수)       │
  Dashboard.gs  대시보드 집계 (순수)          ┘
  SheetRepo.gs  시트 ↔ 객체 (헤더 이름 기반)
  Setup.gs      초기 설정·트리거·데모
  Kakao.gs      OAuth·토큰·나에게 보내기
  Triggers.gs   dailyDigest / onEdit / 토큰 갱신
  Code.gs       메뉴·doGet·api_*
  Index/Styles/App/View*.html  웹앱
skills/sales-weekly-picks/   Claude Code 스킬
dev/            run-tests.js (13 테스트) · preview.js (로컬 미리보기) · export-demo-csv.js
docs/           spec.md · 설치가이드.md · 카카오연동.md
```

```bash
node dev/run-tests.js          # 규칙 엔진·데모 데이터·대시보드 테스트
node dev/preview.js            # http://localhost:8787 — Apps Script 없이 UI 확인
node dev/export-demo-csv.js    # demo/*.csv 생성 (스킬 테스트용)
```

Apps Script 배포: `npm i -g @google/clasp` → `clasp login` → `.clasp.json.example` 을 `.clasp.json` 으로 복사하고 시트에 바인드된 스크립트 ID 입력 → `clasp push` → `clasp deploy -i <기존 배포ID>` (URL 유지).

시각 언어는 [업무 시스템 진단기](https://github.com/linchpinisland/auto_cal)와 같은 Open Props 토큰 재매핑을 씁니다.

## 범위 밖

팀 공용·권한, 알림톡(비즈메시지), 앱 안 LLM 호출, 1만 행 이상, 자동 백업.

## 라이선스

MIT
