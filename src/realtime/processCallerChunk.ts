// ============================================================================
// 신고자(시뮬레이터) 발화 1건을 백엔드로 보내 STT+화자분류+번역+TTS 결과를 받는다.
//
// 백엔드 endpoint 와 envelope 스키마는 기존 `/api/119/realtime/process` 를 그대로
// 재사용한다 — 0단계 결정대로 새 서비스/새 키 추가하지 않는다.
// 자세한 envelope 정의는 backend/ems_realtime.py 와 src/pages/RealtimePage.tsx
// 의 ServerProcessEnvelope 타입 참고.
// ============================================================================

import { apiUrl } from "../api";

export type ServerProcessEnvelope = {
  session_id: string;
  client_seq: number;
  status: "ok" | "skipped" | "error" | string;
  text: string;
  translated: string;
  source_language: string;
  target_language: string;
  speaker: string;
  speaker_reason: string;
  speaker_confidence: number;
  segments?: unknown;
  latency?: {
    stt_ms?: number;
    translate_ms?: number;
    tts_ms?: number;
    total_ms?: number;
    buffer_ms?: number;
  };
  audio_base64?: string | null;
  error?: string | null;
  reason?: string | null;
};

export type ProcessCallerOptions = {
  blob: Blob;
  sessionId: string;
  clientSeq: number;
  /** 직전 chunk 의 신고자 언어. 서버 SessionState 부트스트랩용 hint. */
  previousCallerLanguage?: string | null;
  /** 콘솔에서 사용자가 수동으로 고정한 신고자 언어. STT language hint 로 전달. */
  manualLanguageLock?: string | null;
  /** AbortController.signal — 시뮬레이터 정지 시 in-flight 요청 취소용. */
  signal?: AbortSignal;
};

export async function processCallerChunk(
  opts: ProcessCallerOptions
): Promise<ServerProcessEnvelope> {
  const { blob, sessionId, clientSeq, previousCallerLanguage, manualLanguageLock, signal } = opts;

  const form = new FormData();
  const ext = blob.type.includes("wav") ? "wav" : "webm";
  form.append("file", blob, `chunk-${clientSeq}.${ext}`);
  form.append("session_id", sessionId);
  form.append("client_seq", String(clientSeq));
  form.append("mode", "normal");

  // Phase C — 자동/감지 신호와 수동 잠금을 별도 폼 필드로 분리해 보낸다.
  // 백엔드는 manual_language_lock 이 있으면 매 호출 권위적으로 세션 언어 상태를
  // 덮어쓰고, 없으면 previous_caller_language 로 부트스트랩만 한 뒤 기존 자동 흐름.
  if (previousCallerLanguage) {
    form.append("previous_caller_language", previousCallerLanguage);
  }
  if (manualLanguageLock) {
    form.append("manual_language_lock", manualLanguageLock);
  }

  const url = apiUrl("/api/119/realtime/process");
  const res = await fetch(url, { method: "POST", body: form, signal });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`process ${res.status}: ${t.slice(0, 200)}`);
  }
  return (await res.json()) as ServerProcessEnvelope;
}

/** base64 (mp3) → Blob */
export function decodeBase64Audio(b64: string, mime = "audio/mpeg"): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Blob → base64 (BroadcastChannel 로 보낼 때 사용). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  // 큰 Blob 의 경우 chunk 단위로 변환해 콜스택 폭주 방지.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
