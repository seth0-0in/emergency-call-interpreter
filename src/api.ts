// 백엔드 API URL 헬퍼.
//
// 배경:
//   Vite config 의 base 가 정적 자산 prefix(예: "/static/119/") 로 설정되어
//   빌드된 자산(JS/CSS/VAD 모델/onnx wasm 등) 은 그 prefix 아래에서 서빙된다.
//   그러나 **백엔드 API endpoint 는 서버 루트의 /api/... 에 마운트**되어 있어,
//   정적 자산 base 와 API base 는 서로 다른 축이다.
//
// 규칙:
//   - 자산(예: VAD 모델 / onnxruntime wasm) 은 import.meta.env.BASE_URL 을 그대로 쓴다
//     (예: `${BASE_URL}vad/`). 정적 자산 base 라서 그 prefix 가 있어야 한다.
//   - API 호출은 모두 apiUrl("/api/...") 로 감싼다. helper 가 "/api/..." 입력은
//     루트 origin-relative 로 그대로 반환하며 BASE_URL prefix 를 붙이지 않는다.
//     이렇게 해야 dev / preview / 배포 어디서든 동일하게 `/api/119/realtime/process`
//     로 나간다.
//   - 도메인을 하드코딩하지 않는다 — 브라우저가 현재 origin 을 자동으로 붙인다.

const BASE: string = import.meta.env.BASE_URL || "/";

// ---------------------------------------------------------------------------
// EMS_DEBUG / diag — 진단 로그 단일 출처
//
// 119 운영 시스템이므로 정상 흐름의 verbose 진단 로그(VAD frame · process
// request URL · queue 상태 · placeholder 라이프사이클 등)는 운영 콘솔을
// 도배하지 않도록 기본 OFF. 다음 세 경로 중 하나라도 충족되면 ON 으로 켜진다:
//
//   1) import.meta.env.DEV — dev 빌드는 항상 ON (운영 빌드에서는 build-time
//      에 false 로 박혀 dead-code-eliminated).
//   2) sessionStorage["ems_debug"] === "1" — 운영에서 개발자가 콘솔에서 직접
//      `sessionStorage.setItem("ems_debug","1"); location.reload();` 로 켠다.
//      URL 공유로는 노출되지 않고 탭이 닫히면 사라진다.
//   3) ?debug=1 쿼리 파라미터 — 디버깅 기간 편의용 URL 토글.
//      반드시 `=== "1"` 로 정확히 비교한다 — `.has("debug")` 는 ?debug=0 /
//      ?debug=banana 까지 true 가 되어 끄려는 URL 에서도 켜지는 버그가 난다.
//
// 안정화 후에는 마지막 경로(?debug=1)만 삭제하면 sessionStorage 방식만 남는다.
//
// ⚠ 119 운영 — 신고자 / 구급대원 발화 원문(STT 결과 / 번역 결과 텍스트)이나
// 개인정보를 diag 페이로드에 절대 넣지 않는다. ?debug=1 은 운영에서도 켜질
// 수 있으므로 발화 텍스트는 길이 / 언어 / seq 같은 메타데이터로만 남긴다.
// (rms / prob / 경로 / queue 상태 같은 비-내용 진단값은 debug 뒤에 두는 걸로
// 충분하다.) 실제 실패 신호(fetch 실패 / STT 오류 / 예외 등)는 diag() 로
// 숨기지 말고 console.warn / console.error 로 운영 기본값에서도 남긴다.
// ---------------------------------------------------------------------------

function _readEmsDebugFlag(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    if (
      typeof sessionStorage !== "undefined" &&
      sessionStorage.getItem("ems_debug") === "1"
    ) {
      return true;
    }
  } catch {
    // sessionStorage 접근 차단 환경 (privacy mode 등) — 무시.
  }
  try {
    if (
      typeof location !== "undefined" &&
      new URLSearchParams(location.search).get("debug") === "1"
    ) {
      return true;
    }
  } catch {
    // 무시.
  }
  return false;
}

export const EMS_DEBUG: boolean = _readEmsDebugFlag();

/**
 * 진단 로그 헬퍼. EMS_DEBUG 가 false 면 즉시 return — payload 객체 자체가
 * 만들어지지 않아 운영에서 성능 부담 없음. 단, 호출 인자에서 무거운 계산
 * (예: computeRms) 을 하면 flag 가 꺼져 있어도 계산은 매번 돈다. 이런
 * hot-path 로그는 호출부에서 `if (EMS_DEBUG) { ... diag(...) }` 로 한 번 더
 * 감싸 계산 자체가 안 돌게 한다.
 *
 * 출력 형식: `[ems-rt diag] <event> { t, ...fields }`
 *   t = performance.now() 정수 ms (chunk 간 간격을 콘솔에서 바로 셀 수 있게).
 */
export function diag(
  event: string,
  fields: Record<string, unknown> = {}
): void {
  if (!EMS_DEBUG) return;
  try {
    // eslint-disable-next-line no-console
    console.log(`[ems-rt diag] ${event}`, {
      t: Math.round(performance.now()),
      ...fields,
    });
  } catch {
    // 콘솔 자체가 막힌 환경 — 무시.
  }
}

/**
 * 입력 path 의 종류:
 *   "/api/..."        → 백엔드 API. 서버 루트 절대경로로 반환. BASE_URL prefix 미적용.
 *   "/translate", "/tts", "/stt", "/diarize"
 *                     → vite.config.ts 의 dev proxy 경로 (운영에서는 nginx
 *                       same-origin route). 위와 동일하게 origin-relative 로 반환.
 *   "http(s)://..."   → 외부 게이트웨이 절대 URL. 그대로 통과.
 *   그 외 (예: "vad/") → 정적 자산 후보. 기존 동작대로 BASE_URL 을 prefix 한다.
 *
 * dev 서버는 base("/static/119/") 밖의 경로를 알지 못한다. 위 API/proxy 경로들
 * 은 모두 base 밖에서 라우팅되어야 백엔드/게이트웨이까지 도달한다.
 */

// 운영 게이트웨이 same-origin route 와 dev vite proxy 가 모두 잡는 prefix 집합.
// 새 dev proxy 를 vite.config.ts 에 추가할 때마다 함께 등록한다.
// `/llm` — LLM 게이트웨이(/llm/v1/chat/completions) 로 직접 same-origin 호출.
// `/translate` 라우트가 다른 LLM 게이트웨이로 라우팅되어 모델 not-found 가 나는
// 운영 환경 대응으로 추가. 운영 게이트웨이가 /llm/ 을 직접 서빙하면 그대로 도달한다.
const ORIGIN_RELATIVE_PREFIXES = ["/api", "/translate", "/llm", "/tts", "/stt", "/diarize"];

function isOriginRelativeApiPath(path: string): boolean {
  for (const p of ORIGIN_RELATIVE_PREFIXES) {
    if (path === p || path.startsWith(p + "/")) return true;
  }
  return false;
}

export function apiUrl(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    return BASE;
  }
  // 절대 URL 은 그대로.
  if (/^https?:\/\//i.test(path)) return path;

  // 선행 슬래시 정규화.
  const withLead = path.startsWith("/") ? path : "/" + path;

  // /api/... 및 알려진 vite proxy 경로 — 항상 서버 루트 origin-relative.
  if (isOriginRelativeApiPath(withLead)) {
    return withLead;
  }

  // 나머지(자산 후보) — 기존 BASE_URL prefix 동작 유지. 단, 이미 BASE 로 시작하면
  // 이중 prefix 방지.
  const trimmed = withLead.replace(/^\/+/, "");
  const baseNoLead = BASE.replace(/^\/+/, ""); // "static/119/" 또는 "" (BASE="/")
  if (baseNoLead && trimmed.startsWith(baseNoLead)) {
    return "/" + trimmed;
  }
  return BASE + trimmed;
}
