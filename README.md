# 119 외국인 신고자 실시간 통번역 시스템

외국인 신고자와 119 상황실 간 양방향 실시간 통역 + 신고 기록 문서 생성 도구.

- **신고자 발화 → STT → 언어 감지(자동/수동 lock) → 원문 + 한국어 번역** 을
  상황실 콘솔에 표시.
- **상황실 요원 한국어 입력 → 신고자 언어로 번역 + TTS** 를 신고자 단말로
  전달.

본 문서는 개발자·유지보수자 대상이다. 작업 인계 메모는 `HANDOFF.md` 를
참고하고, 배포 절차와 로컬 백엔드 실행 가이드는 내부 비공개 문서를
참고한다.

## 주요 기능

- 양방향 실시간 통번역, STT 언어 자동 감지 + 콘솔 드롭다운 수동 lock
- 14 개 언어 지원 (Cohere Transcribe 공식 지원)
  — `ko` + 외국어 13 종(`ar` / `de` / `el` / `en` / `es` / `fr` / `it` / `ja` /
  `nl` / `pl` / `pt` / `vi` / `zh`). 단일 소스는 `src/languages.ts`.
- LLM 신고 요약 — 사고유형 / 긴급도 / 위치 / 환자 상태 / 조치 / 추정 항목을
  구조화 JSON 으로 생성 (`src/realtime/summarizeCall.ts`).
- 사건 기록 문서 내보내기 — 화면 / HTML / TXT 3 출력, 인쇄(PDF) 시 출동 요약
  히어로 + 대화 카드 단위 break-inside avoid.
- 녹음파일 업로드 전사 — `/upload` 화면에서 wav/m4a 업로드 → 화자분리 STT.

## 화면 (라우트)

`src/App.tsx` 의 실제 라우트 정의 그대로. base path 는 `/static/119/`
(vite.config.ts) 이므로 dev 서버에서는 `http://localhost:<port>/static/119/...`
로 접근한다.

| 경로 | 컴포넌트 | 비고 |
|---|---|---|
| `/` | `LauncherPage` | 메인 런처 — 4 개 진입점 카드(콘솔/시뮬레이터/업로드/결과) |
| `/console` | `ConsolePage` | **상황실 콘솔 (메인 제품)** — 신고자 대화 로그 + 한국어 채팅 + LLM 요약 |
| `/simulator` | `SimulatorPage` | 신고자 시뮬레이터 (데모/테스트) — 브라우저 마이크 → STT |
| `/upload` | `UploadPage` | 업로드 녹취 자동 분석 (구 인덱스 페이지) |
| `/result` | `ResultPage` | 사건 기록 문서 — 업로드/실시간 record 선택 → HTML/TXT/인쇄 |
| `/realtime` | `RealtimePage` | 레거시 1인 통역 화면 — 라우트 보존, nav 에서 미노출 |

## 기술 스택

- **프론트** — React 19 + Vite 8 + TypeScript (~6.0), `react-router-dom` 7.
  base path `/static/119/`.
- **VAD** — `@ricky0123/vad-web` (Silero V5) + `onnxruntime-web` 1.26.
  wasm/.mjs 는 jsDelivr CDN 에서 로드 (`src/realtime/ortAssets.ts` 참고).
- **백엔드** — Python FastAPI 라우터 `backend/ems_realtime.py`. 운영 호스트는
  환경에 따라 다르며 모두 환경변수로 주입.
- **외부 게이트웨이** (운영 env 로 지정, 기본값은 예시 placeholder)
  - STT / TTS / Diarize — `EMS_STT_URL` / `EMS_TTS_URL` / `EMS_DIARIZE_URL`
  - LLM — `EMS_LLM_URL` (OpenAI-compatible `/v1/chat/completions`), 모델은
    `EMS_LLM_MODEL` (백엔드) / `VITE_LLM_MODEL` (프론트 빌드 env)

## 아키텍처

```
[신고자 시뮬레이터]                                    [상황실 콘솔]
    브라우저 마이크
        │
        ▼  WAV (MicVAD 발화 단위)
   POST /api/119/realtime/process  ── backend/ems_realtime.py
        │      └─ STT → 화자/언어 판단 → 한국어 번역 (백엔드가 LLM 호출)
        ▼
   envelope { text, translatedKo, source_language, latency, ... }
        │
        ├─→ 시뮬레이터: "내가 한 말" 패널 표시
        │
        ▼  BroadcastChannel("ems-119-session")
        │     { kind: "caller-utterance", ... }
        └────────────────────────────────────────► 콘솔 대화 로그(신고자)

                                                   요원이 한국어 입력
                                                       │
                                                       ▼
                                       POST /llm/v1/chat/completions
                                       (same-origin → LLM 게이트웨이)
                                                       │  translated text
                                                       ▼
                                                   POST /tts
                                                       │  audioBase64
                                                       ▼
                                                   콘솔 대화 로그(요원)
   ◄──────────────────  BroadcastChannel  ────────────┘
   audioBase64 (mp3) 디코딩 → 신고자 단말 스피커 재생

   통화 종료 시
   └─→ POST /llm/v1/chat/completions (summarizeCall.ts)
          → CallSummary { incidentType, urgency, location,
                          patientState, actions, inferences, summary }
          → ResultPage 의 출동 요약 히어로 + HTML/TXT 출력에 반영
```

### 통신 경로 요약

- **콘솔 ↔ 시뮬레이터** — `BroadcastChannel("ems-119-session")`. 같은 origin
  두 탭/창 간 메시지. 백엔드 fan-out 없음. 향후 WebSocket 으로 교체 예정
  (`HANDOFF.md` 참고).
- **신고자 번역** — 프론트 → 백엔드 `/api/119/realtime/process` → 백엔드가
  `EMS_LLM_URL` 직접 호출.
- **요약 · 요원 메시지** — 프론트가 **same-origin `/llm/v1/chat/completions`**
  직접 호출 (vite dev proxy `/llm` → LLM 게이트웨이). `/translate` 경로는 운영
  게이트웨이가 모델 없는 LLM 게이트웨이로 misroute → 404. 사용 금지.
- **TTS** — 프론트 `operatorSay` 가 same-origin `/tts` 호출 (운영 게이트웨이
  same-origin route).

## 디렉터리 구조 요약

```
src/
├── App.tsx                          # 라우터 (BrowserRouter basename=/static/119/)
├── main.tsx                         # ReactDOM 진입점
├── api.ts                           # apiUrl() — same-origin / dev proxy 분기
├── languages.ts                     # 14 언어 단일 소스 + 라벨/검증 헬퍼
├── theme.ts                         # COLORS / TYPO / URGENCY_COLOR / INCIDENT_COLOR / STATUS_COLOR
├── context/
│   └── AppDataContext.tsx           # UploadRecord / RealtimeRecord 히스토리 + summary 보관
├── pages/
│   ├── LauncherPage.tsx             # 런처 (4 개 카드)
│   ├── ConsolePage.tsx              # 상황실 콘솔 (메인)
│   ├── SimulatorPage.tsx            # 신고자 시뮬레이터
│   ├── UploadPage.tsx               # 업로드 전사
│   ├── ResultPage.tsx               # 사건 기록 문서 (RealtimeDocument + UploadDocument)
│   └── RealtimePage.tsx             # 레거시 1인 통역 화면 (회귀용)
├── realtime/
│   ├── session.ts                   # BroadcastChannel 래퍼 + sessionId 관리
│   ├── processCallerChunk.ts        # 신고자 WAV → /api/119/realtime/process
│   ├── operatorSay.ts               # 한국어 → /llm + /tts (요원 메시지)
│   ├── summarizeCall.ts             # 통화 종료 후 LLM 구조화 요약
│   ├── detectLanguageFromText.ts    # 신고자 언어 텍스트 기반 LLM 판별
│   ├── vadMic.ts                    # MicVAD → 발화 단위 WAV Blob
│   └── ortAssets.ts                 # ort wasm/.mjs CDN 로드 + 버전 동기화
└── components/
    ├── AppHeader.tsx                # 공통 상단 네비게이션
    ├── UploadPanel.tsx              # 업로드 입력 UI
    └── TranscriptPanel.tsx          # 전사 결과 표시 UI

backend/
├── ems_realtime.py                  # FastAPI 라우터 (prefix /api/119/realtime)
└── dev_server.py                    # 로컬 standalone uvicorn (선택, 내부 비공개 문서 참고)

public/vad/                          # VAD ONNX 모델 + worklet
```

## 로컬 개발

`package.json` scripts:

| 명령 | 설명 |
|---|---|
| `npm install` | 의존성 설치 (최초 1회) |
| `npm run dev` | vite dev 서버. 기본 `/api` → `VITE_API_PROXY_TARGET` forward (미설정 시 예시 placeholder) |
| `npm run build` | `tsc -b && vite build` → `dist/` |
| `npm run lint` | ESLint |
| `npm run preview` | vite preview (build 결과 검증) |

브라우저 두 탭으로 데모:

- 콘솔: `http://localhost:<port>/static/119/console`
- 시뮬레이터: `http://localhost:<port>/static/119/simulator`

dev 서버 시작 시 콘솔에 실제 포트(5173 / 5174 / ...) 가 출력된다.

### 로컬 백엔드 모드 (선택)

`backend/ems_realtime.py` 를 수정한 채 운영 컨테이너 영향 없이 검증할 때:

```powershell
# T1 — 로컬 uvicorn (127.0.0.1:8119)
py -m venv backend\.venv
.\backend\.venv\Scripts\python.exe -m pip install `
  "fastapi>=0.110" "uvicorn[standard]>=0.27" "httpx>=0.27" "python-multipart>=0.0.9"
.\backend\.venv\Scripts\python.exe .\backend\dev_server.py

# T2 — vite (env 켜고)
$env:VITE_EMS_LOCAL_API = "1"
npm run dev
```

상세는 내부 비공개 문서 참고. `/api` 만 localhost 로 forward 되고
`/stt /translate /tts /diarize /llm` 은 항상 외부 게이트웨이 사용.

## 배포

### 프론트

- `npm run build` → 산출물 `dist/` 를 운영 환경의 정적 서빙 경로에 배치한다.
- 환경변수는 `.env.example` 참고. 실제 값(LLM/STT/TTS 게이트웨이 URL 등) 은
  배포 환경에서 주입한다.

### 백엔드

- `backend/ems_realtime.py` 라우터를 운영 FastAPI 앱에 mount.
- 외부 게이트웨이 URL / 모델명 / 인증은 모두 환경변수로 주입 (아래
  "환경 변수" 표 참고).
- 배포 환경별 구체 절차(컨테이너 내부 경로, 재시작 방식, 백업 정책 등) 는
  내부 비공개 문서에서 별도 관리한다.

## 환경 변수 (`backend/ems_realtime.py`)

`os.getenv` 로 정의된 항목 전체. 모두 기본값이 잡혀 있으므로 미설정 시 운영
프리셋대로 동작한다.

### 외부 게이트웨이

| Env | Default | 비고 |
|---|---|---|
| `EMS_STT_URL` | `https://stt-gateway.example.internal/v1/audio/transcriptions` | STT |
| `EMS_STT_MODEL` | `cohere-transcribe` | STT 모델 |
| `EMS_DIARIZE_URL` | `https://diarize-gateway.example.internal/v1/audio/transcriptions` | 화자분리 STT (실험) |
| `EMS_LLM_URL` | `https://llm-gateway.example.internal/v1/chat/completions` | LLM (백엔드용) |
| `EMS_LLM_MODEL` | `example-llm-model` | OpenAI-compatible 모델명. 운영에서 실 값으로 override |
| `EMS_TTS_URL` | `https://tts-gateway.example.internal/v1/audio/speech` | TTS |
| `EMS_TTS_MODEL` | `example-tts-model` | 운영에서 실 값으로 override |

### 인증 / 보안

| Env | Default | 비고 |
|---|---|---|
| `EMS_LLM_API_KEY` | (없음) | 1 순위 |
| `JB_LLM_API_KEY` | (없음) | 2 순위 |
| `OPENAI_API_KEY` | (없음) | 3 순위 |
| `EMS_LLM_API_KEY_FILE` | `/run/secrets/ems_llm_api_key` | 파일 폴백 (env 가 부팅 스크립트로 덮어쓰이는 환경 대비) |
| `EMS_LLM_AUTH_REQUIRED` | `false` | true 시 키 없으면 `LLMAuthMissing` |
| `EMS_LLM_AUTH_BYPASS` | `false` | 게이트웨이가 자체 인증을 수행해 Authorization 헤더 미부착이 필요한 환경 |
| `EMS_SSL_VERIFY` | `false` | 외부 HTTPS 인증서 검증 (사설 인증서 환경 기본 off) |

### Timeout / 사이즈

| Env | Default | 비고 |
|---|---|---|
| `EMS_HTTP_TIMEOUT` | `60` | 일반 HTTP timeout (초) |
| `EMS_STT_TIMEOUT` | `180` | STT 전용 (30~60s m4a 처리 대비) |
| `EMS_MIN_AUDIO_BYTES` | `1024` | 최소 오디오 크기 (≈ 64ms PCM16 16k mono) |

### 실시간 pending 버퍼 / STT 힌트

| Env | Default | 비고 |
|---|---|---|
| `EMS_REALTIME_PENDING_ENABLED` | `true` | pending 버퍼 ON/OFF |
| `EMS_REALTIME_PENDING_MIN_WORDS` | `1` | fragment 판정 최소 단어 수. 단일 단어("Help"/"물") 도 즉시 commit. 보수적으로 가려면 2~3 |
| `EMS_REALTIME_PENDING_MAX_AGE_SEC` | `8.0` | pending 보관 한도 (초) |
| `EMS_REALTIME_PENDING_MAX_TEXT_CHARS` | `400` | pending 누적 텍스트 한도 |
| `EMS_REALTIME_PENDING_FORCE_COMMIT_MS` | `6000` | 강제 flush 임계 (ms). MAX_AGE_SEC 과 작은 값이 실제 임계 |
| `EMS_STT_USE_LANGUAGE_HINT` | `true` | `confirmed_caller_language` 잠금 시 STT 에 language hint 부착 |

### 프론트 빌드 환경

| Env | Default | 비고 |
|---|---|---|
| `VITE_EMS_LOCAL_API` | `0` | `1` 이면 vite dev 가 `/api` 를 `localhost:8119` 로 forward |
| `VITE_API_PROXY_TARGET` | placeholder | dev 의 `/api` forward 대상 |
| `VITE_STT_PROXY_TARGET` | placeholder | dev 의 `/stt` forward 대상 |
| `VITE_LLM_PROXY_TARGET` | placeholder | dev 의 `/translate`, `/llm` forward 대상 |
| `VITE_TTS_PROXY_TARGET` | placeholder | dev 의 `/tts` forward 대상 |
| `VITE_DIARIZE_PROXY_TARGET` | placeholder | dev 의 `/diarize` forward 대상 |
| `VITE_LLM_MODEL` | `example-llm-model` | 프론트가 LLM 호출 시 model 필드에 보낼 값 |
| `VITE_PUBLIC_BASE` | `/static/119/` | 정적 자산 base path (vite `base` 옵션) |
| `JB_LLM_API_KEY` | (없음) | dev 한정 — vite proxy 가 `/translate`, `/llm` 요청에 Bearer 부착 |

## 백엔드 엔드포인트

`router = APIRouter(prefix="/api/119/realtime", ...)` 기준.

| Method | Path | 용도 |
|---|---|---|
| POST | `/api/119/realtime/process` | 신고자 발화 chunk → STT → 화자/언어 → 번역 → TTS 일괄. `file`, `session_id`, `client_seq`, `mode`, `previous_caller_language`, `manual_language_lock` 폼 필드 |
| GET | `/api/119/realtime/health` | 헬스 + 게이트웨이 설정 노출 (`stt_url`, `llm_url`, `llm_model`, `tts_url`, `ssl_verify` 등) |
| GET | `/api/119/realtime/session/{session_id}` | 세션 상태(`primary_caller_language`, `confirmed_caller_language`, `manual_locked`, `recent_text_count` 등) |
| POST | `/api/119/realtime/session/{session_id}/reset` | 세션 메모리 비움 |

## LLM 경로 / 모델 가이드

| 호출자 | 경로 |
|---|---|
| 신고자 번역 (백엔드) | `EMS_LLM_URL` 직접 fetch (OpenAI-compatible `/v1/chat/completions`) |
| `summarizeCall` · `operatorSay` · `detectLanguageFromText` (프론트) | same-origin `/llm/v1/chat/completions` (vite dev: `/llm` → `VITE_LLM_PROXY_TARGET`) |
| 모델 | `EMS_LLM_MODEL` (백엔드) / `VITE_LLM_MODEL` (프론트). 두 값을 일치시켜 운영 |
| 인증 | env 로 처리 (`EMS_LLM_API_KEY` / `EMS_LLM_AUTH_BYPASS` / `EMS_LLM_AUTH_REQUIRED`) |

운영 환경에 따라 `/translate` 라우트가 다른 LLM 게이트웨이로 라우팅되어 모델
not-found 가 나는 사례가 있어, 프론트는 same-origin `/llm/v1/chat/completions`
를 직접 호출하도록 통일되어 있다. 되돌리지 말 것.

## 주의사항

- **LLM 게이트웨이 경로** — 프론트 요약(`summarizeCall`) / 요원 메시지
  (`operatorSay`) 는 `/translate` 가 아니라 same-origin
  `/llm/v1/chat/completions` 사용. 운영 게이트웨이의 `/translate` 가 모델
  없는 LLM 게이트웨이로 misroute → 404 사례 확인 후 전환. **되돌리지 말 것.**
  (`src/api.ts` `ORIGIN_RELATIVE_PREFIXES` 에 `/llm` 등록 + `vite.config.ts`
  dev proxy `/llm` → `VITE_LLM_PROXY_TARGET`.)
- **`operatorSay` TTS 실패 차단 (미해결)** — `operatorSay` 가 `/tts` 호출 후
  BroadcastChannel send 순서로 동작한다. TTS 가 throw 하면 메시지 전달이
  통째로 차단되므로, 추후 `/tts` 점검 또는 TTS try/catch 후 broadcast 진행
  하도록 non-fatal 처리 권장.
- **`/result` 문서 섹션 라벨 분산** — 실시간 문서가 화면
  (`RealtimeDocument`) · HTML (`buildRealtimeHtml`) · TXT (`buildRealtimeText`)
  3 곳에 같은 구조로 분산되어 있다. 라벨 / 이모지 매핑 / 조건부 표시 룰 수정
  시 세 곳 모두 동기 필요. 업로드 문서 경로(`UploadDocument` /
  `buildUploadHtml` / `buildUploadText`, `DocumentPaper` / `DocumentFooter`)는
  별개이며 본 개편 범위 밖이라 손대지 않는다.
- **언어 코드 단일 소스** — `src/languages.ts` 가 14 언어 단일 소스. 다른
  모듈에서 자체 맵을 만들지 말 것 (`detectLanguageFromText.ts`,
  `operatorSay.ts`, `ResultPage.tsx` 가 모두 위임).
- **`RealtimePage.tsx`** — 레거시 1인 통역 화면. 라우트는 보존하지만
  `AppHeader` 네비게이션에서는 제외. 회귀 방지 위해 손대지 않는다 (라벨 문구
  정도만 예외).
- **VAD wasm CDN 의존** — `src/realtime/ortAssets.ts` 가
  `cdn.jsdelivr.net/npm/onnxruntime-web@<ver>/dist/` 에서 .mjs/.wasm 을 로드.
  폐쇄망 배포 시 동일 파일을 내부 정적 서빙 경로로 미러링 후 `ORT_VERSION`
  / wasmPaths 교체 필요. `onnxruntime-web` 버전 업 시 `package.json` 과
  `ortAssets.ts` 의 `ORT_VERSION` 동시 갱신 (ABI 일치 필요).

## 관련 문서

- `HANDOFF.md` — 작업 인계 노트 (현재 상태 / 다음 트랙)
- 배포 절차 / 로컬 백엔드 실행 가이드 — 내부 비공개 문서 참고.
