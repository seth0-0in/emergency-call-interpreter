// ============================================================================
// 콘솔 — 요원이 친 한국어 한 줄을 신고자 언어로 번역하고 TTS 까지 받아낸다.
//
// vite.config.ts 의 dev proxy 두 개를 그대로 재사용한다 — 새 서비스/새 키 추가 없음.
//   /llm/v1/chat/completions  → LLM 번역
//   /tts                      → TTS
//
// 운영 빌드(정적 자산 base 환경) 에서는 vite proxy 가 없으므로 두 경로가
// same-origin 으로 게이트웨이에 도달해야 한다. same-origin route 가 없는
// 환경이라면 백엔드(ems_realtime.py) 에 번역+TTS 통합 endpoint 를 추가하고
// 이 모듈이 그 경로를 호출하도록 교체한다.
// ============================================================================

import { apiUrl } from "../api";
import { FOREIGN_LANGUAGE_OPTIONS, languageLabelEnglish } from "../languages";

/** 신고자 언어에 맞는 TTS voice. 백엔드 pick_tts_voice() 와 동일 규칙. */
function pickTtsVoice(lang: string): string {
  return lang === "ko" ? "sohee" : "vivian";
}

export type OperatorSayResult = {
  translated: string;
  audioBase64: string;
  targetLang: string;
};

type LlmResponse = {
  choices?: Array<{
    message?: { content?: string };
  }>;
};

/** 한국어 → 신고자 언어 번역. LLM 게이트웨이는 OpenAI 호환. */
async function translateKoTo(
  textKo: string,
  targetLang: string,
  signal?: AbortSignal
): Promise<string> {
  // 운영 환경의 `/translate` 라우트가 다른 LLM 게이트웨이로 라우팅되어
  // "model not found" 가 나는 사례가 있어, 작동이 검증된 same-origin
  // `/llm/v1/chat/completions` 를 직접 호출한다.
  const url = apiUrl("/llm/v1/chat/completions");
  // 게이트웨이마다 모델 이름이 다르므로 빌드 환경변수로 override 한다.
  // 미설정 시에는 일반적인 placeholder 가 들어가며 운영 게이트웨이가 model 필드를
  // 무시하는 경우에 한해서만 그대로 동작한다.
  const llmModel: string =
    (import.meta.env.VITE_LLM_MODEL as string | undefined) ||
    "example-llm-model";
  const body = {
    model: llmModel,
    messages: [
      {
        role: "system",
        content: `You are a real-time interpreter for a Korean 119 emergency dispatcher. Translate the user's Korean message into ${languageLabelEnglish(
          targetLang
        )}. Output ONLY the translated text — no explanations, no quotes, no labels.`,
      },
      { role: "user", content: textKo },
    ],
    temperature: 0.1,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`translate ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as LlmResponse;
  const content = json.choices?.[0]?.message?.content ?? "";
  return content.trim();
}

/** 신고자 언어 텍스트 → mp3 (base64). */
async function ttsTo(
  text: string,
  targetLang: string,
  signal?: AbortSignal
): Promise<string> {
  const url = apiUrl("/tts");
  const ttsModel: string =
    (import.meta.env.VITE_TTS_MODEL as string | undefined) ||
    "example-tts-model";
  const body = {
    model: ttsModel,
    input: text,
    voice: pickTtsVoice(targetLang),
    response_format: "mp3",
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`tts ${res.status}: ${t.slice(0, 200)}`);
  }
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export type OperatorSayOptions = {
  textKo: string;
  targetLang: string;
  signal?: AbortSignal;
};

/** 요원 한국어 입력 → {신고자 언어 번역 + mp3 base64}. */
export async function operatorSay(
  opts: OperatorSayOptions
): Promise<OperatorSayResult> {
  const { textKo, targetLang, signal } = opts;
  if (!textKo.trim()) {
    throw new Error("empty operator text");
  }
  if (!targetLang || targetLang === "unknown") {
    throw new Error("target language not set");
  }
  const translated = await translateKoTo(textKo.trim(), targetLang, signal);
  if (!translated) {
    throw new Error("translation produced empty text");
  }
  const audioBase64 = await ttsTo(translated, targetLang, signal);
  return { translated, audioBase64, targetLang };
}

/**
 * 콘솔 드롭다운에 표시할 언어 목록 — 한국어 제외 (신고자는 외국인).
 * 실 목록은 languages.ts 의 FOREIGN_LANGUAGE_OPTIONS 가 단일 소스.
 */
export function callerLanguageOptions() {
  return FOREIGN_LANGUAGE_OPTIONS;
}
