// ============================================================================
// onnxruntime-web wasm 자산 로딩 헬퍼 (공용).
//
// 문제 배경
// ---------
// Vite dev 서버는 `/public` 아래 파일을 source-code import / dynamic import
// 로 가져오는 것을 차단한다(에러 메시지: "This file is in /public ... should
// not be imported from source code. It can only be referenced via HTML tags.").
// 그런데 onnxruntime-web 1.26 은 런타임에 `ort-wasm-simd-threaded.mjs` 를
// **dynamic import** 로 로드한다. 따라서 wasmPaths 를 public 경로
// (`/static/119/vad/`) 로 두면 dev 빌드에서 `initWasm()` 이 매번 실패한다.
// `optimizeDeps.exclude` 로 우회하려 하면 vad-web 의 named export(`MicVAD`) 가
// 깨져 `/realtime` 까지 망가뜨린다(CommonJS 분기 때문).
//
// 해결
// ----
// onnxruntime-web 의 wasm/.mjs 자산을 **외부 절대 URL(jsDelivr CDN)** 에서
// fetch 한다. Vite dev 의 /public import 차단 규칙은 origin-relative 경로에만
// 적용되므로 외부 https URL 은 우회된다. dev / build 모두 동일하게 동작.
//
// 버전 동기화 (중요)
// -----------------
// CDN URL 의 ort 버전은 **node_modules 의 실제 설치 버전과 정확히 일치**해야
// 한다. mismatch 가 나면 .mjs/.wasm 의 ABI 가 어긋나 `no available backend
// found` 등으로 깨진다. 아래 ORT_VERSION 상수를 package.json 의
// `onnxruntime-web` 버전을 올릴 때 함께 수정한다. README 의 "VAD 자산"
// 섹션에도 같은 주의가 적혀 있다.
//
// VAD 모델(`silero_vad_v5.onnx`) 과 worklet(`vad.worklet.bundle.min.js`) 은
// dynamic import 가 아니라 `fetch` 로 가져오기 때문에 그대로 public/vad/ 에
// 두어도 안전하다 (baseAssetPath = `${BASE_URL}vad/`).
// ============================================================================

// onnxruntime-web @1.26.0 (package.json 과 일치 — 변경 시 함께 갱신할 것).
export const ORT_VERSION = "1.26.0";

/** CDN 의 ort dist/ base URL — wasmPaths 가 가리키는 prefix. 끝에 슬래시 포함. */
export const ORT_WASM_CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

/**
 * `@ricky0123/vad-web` 의 MicVAD.new options 에 그대로 넘기는 ortConfig 콜백.
 * 라이브러리가 `onnxWASMBasePath` 를 wasmPaths 에 대입한 직후 호출되며, 우리
 * 콜백이 그 값을 CDN URL 로 덮어쓴다(real-time-vad.js line 348~350 참고).
 *
 * - wasmPaths : CDN dist/ 의 절대 URL (string base).
 * - numThreads=1, proxy=false : 단일 마이크 환경에 충분하고 threaded variant
 *   동적 import 경로를 단순화 (시뮬레이터 한 사람 마이크에는 영향 없음).
 */
export function configureOrtForCdn(ort: unknown): void {
  type OrtLike = {
    env: {
      wasm: {
        wasmPaths?: string | Record<string, string>;
        numThreads?: number;
        proxy?: boolean;
      };
    };
  };
  const o = ort as OrtLike;
  o.env.wasm.wasmPaths = ORT_WASM_CDN_BASE;
  o.env.wasm.numThreads = 1;
  o.env.wasm.proxy = false;
}
