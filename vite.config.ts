import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiKey = env.JB_LLM_API_KEY;

  // 게이트웨이 대상은 모두 환경변수로 지정한다. 기본값은 공개 저장소용 예시
  // placeholder 이며 실제 운영/개발 환경에서는 `.env.local` 등으로 override.
  const apiTarget = env.VITE_API_PROXY_TARGET || "https://api.example.internal";
  const sttTarget = env.VITE_STT_PROXY_TARGET || "https://stt-gateway.example.internal";
  const llmTarget = env.VITE_LLM_PROXY_TARGET || "https://llm-gateway.example.internal";
  const ttsTarget = env.VITE_TTS_PROXY_TARGET || "https://tts-gateway.example.internal";
  const diarizeTarget =
    env.VITE_DIARIZE_PROXY_TARGET || "https://diarize-gateway.example.internal";

  // 로컬 ems_realtime 백엔드 토글 — backend/dev_server.py (127.0.0.1:8119) 사용 여부.
  // 켤 때만 /api → localhost. 끄면 VITE_API_PROXY_TARGET 으로 forward.
  // /stt, /translate, /tts, /diarize 는 이 토글과 무관 — 항상 외부 게이트웨이 사용.
  const useLocalApi =
    env.VITE_EMS_LOCAL_API === "1" || env.VITE_EMS_LOCAL_API === "true";
  if (useLocalApi) {
    // eslint-disable-next-line no-console
    console.log(
      "[vite] VITE_EMS_LOCAL_API=1 — /api proxy → http://localhost:8119 (local ems_realtime)",
    );
  }

  return {
    // 정적 자산 base — 운영에서 `<host>/static/119/` 경로로 서빙된다고 가정.
    // 다른 경로로 배포하려면 VITE_PUBLIC_BASE env 로 override (또는 본 상수 수정).
    base: env.VITE_PUBLIC_BASE || "/static/119/",

    plugins: [react()],

    server: {
      proxy: {
        /**
         * 119 실시간 통번역 백엔드 (ems_realtime.py).
         * 로컬 개발 (기본):
         *   /api/119/realtime/* -> {VITE_API_PROXY_TARGET}/api/119/realtime/*
         *
         * 로컬 백엔드 모드 (VITE_EMS_LOCAL_API=1):
         *   /api/119/realtime/* -> http://localhost:8119/api/119/realtime/*
         *   backend/dev_server.py 가 띄운 standalone FastAPI 로 forward 해
         *   ems_realtime.py 수정사항을 즉시 검증한다. 상세는 backend/DEV_LOCAL.md.
         *
         * 배포 환경 (정적 자산과 같은 origin):
         *   same-origin "/api/119/realtime/*" 직접 호출 — 운영 게이트웨이
         *   (nginx 등) 가 동일 호스트의 백엔드 라우터로 전달.
         *
         * dev 서버의 base 는 정적 자산용이며 /api 요청은 base 밖이라
         * vite 가 404 를 낸다. 이 proxy 로 백엔드까지 forward.
         * dev 한정 — production build 동작은 변하지 않는다.
         */
        "/api": useLocalApi
          ? {
              target: "http://localhost:8119",
              changeOrigin: true,
              secure: false,
            }
          : {
              target: apiTarget,
              changeOrigin: true,
              secure: true,
            },

        /**
         * STT
         * 로컬 개발:
         *   /stt -> {VITE_STT_PROXY_TARGET}/stt/v1/audio/transcriptions
         *
         * 배포 환경:
         *   same-origin "/stt/v1/audio/transcriptions" 직접 호출
         */
        "/stt": {
          target: sttTarget,
          changeOrigin: true,
          secure: true,
          rewrite: () => "/stt/v1/audio/transcriptions",
        },

        /**
         * 번역 (LLM) — 레거시 경로.
         * 로컬 개발:
         *   /translate -> {VITE_LLM_PROXY_TARGET}/llm/v1/chat/completions
         *
         * 배포 환경:
         *   same-origin "/translate" 직접 호출 — 게이트웨이가 LLM 으로 routing.
         *
         * ⚠ 운영 환경에 따라 `/translate` 라우트가 다른 LLM 게이트웨이로 가는 사례가
         *   확인되어, 프론트(summarizeCall / operatorSay) 는 아래 `/llm` 경로로
         *   직접 호출하도록 변경되었다. `/translate` proxy 는 호환을 위해 남겨둔다.
         *
         * 인증: 운영 게이트웨이 정책에 따른다. JB_LLM_API_KEY env 가 있으면
         *   호환을 위해 부착하지만, 게이트웨이가 자체 인증을 수행하는 환경에서는
         *   무시될 수 있다.
         */
        "/translate": {
          target: llmTarget,
          changeOrigin: true,
          secure: true,
          rewrite: () => "/llm/v1/chat/completions",

          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (apiKey) {
                proxyReq.setHeader(
                  "Authorization",
                  `Bearer ${apiKey}`
                );
              }
            });
          },
        },

        /**
         * LLM 직접 경로 — /llm/v1/chat/completions
         * 운영 환경에서 `/translate` 가 다른 게이트웨이로 라우팅되는 사례가 확인되어,
         * 프론트(summarizeCall / operatorSay) 가 same-origin /llm/v1/chat/completions 로
         * 직접 호출하도록 변경했다. dev 서버에서도 동일 경로를 LLM 게이트웨이로 보낸다.
         *
         * 로컬 개발: /llm/v1/chat/completions -> {VITE_LLM_PROXY_TARGET}/llm/v1/chat/completions
         * 배포 환경: same-origin 호스트가 그대로 처리.
         */
        "/llm": {
          target: llmTarget,
          changeOrigin: true,
          secure: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (apiKey) {
                proxyReq.setHeader("Authorization", `Bearer ${apiKey}`);
              }
            });
          },
        },

        /**
         * TTS
         * 로컬 개발:
         *   /tts -> {VITE_TTS_PROXY_TARGET}/tts/v1/audio/speech
         *
         * 배포 환경:
         *   same-origin "/tts" 직접 호출
         */
        "/tts": {
          target: ttsTarget,
          changeOrigin: true,
          secure: true,
          rewrite: () => "/tts/v1/audio/speech",
        },

        /**
         * 화자분리 STT (실험)
         * 로컬 개발:
         *   /diarize -> {VITE_DIARIZE_PROXY_TARGET}/v1/audio/transcriptions
         *
         * 배포 환경:
         *   same-origin "/diarize/v1/audio/transcriptions" 직접 호출
         *
         * 응답 형식:
         *   { text, segments: [{ speaker, start, end, text }] }
         */
        "/diarize": {
          target: diarizeTarget,
          changeOrigin: true,
          secure: false,
          rewrite: (path) => path.replace(/^\/diarize/, ""),
        },
      },
    },
  };
});
