// ============================================================================
// 전사된 원문 텍스트의 언어를 동작 중인 LLM 으로 판별한다.
//
// 왜 이 모듈이 필요한가:
//   백엔드 envelope.source_language 는 STT 게이트웨이(cohere-transcribe) 의 오디오
//   기반 LID 결과를 그대로 노출한다. 이 LID 가 중국어 오디오를 "vi" 로 잘못 태그하는
//   사례가 관찰되어, 인바운드 번역(LLM) 은 정확한데 신고자 언어 라벨만 어긋나는
//   현상이 발생했다. 한자(zh) ↔ 라틴+성조부호(vi) 는 텍스트로는 절대 혼동되지
//   않으므로, 같은 LLM 에 텍스트만 보내 판별하면 안전하다.
//
// 호출 경로/모델 — operatorSay / summarizeCall 과 동일 게이트웨이:
//   POST /translate (또는 same-origin /llm/v1/chat/completions)
//   모델은 VITE_LLM_MODEL 빌드 env 로 override.
// 새 endpoint / 새 모델 / 새 키 도입 없음.
//
// 지원 언어 집합은 languages.ts (STT_SUPPORTED_LANGUAGES) 가 단일 소스.
// 그 외 코드가 나오면 "unknown" 으로 폴백해 요원이 수동 선택하도록 유도한다.
// ============================================================================

import { apiUrl } from "../api";
import {
  LANGUAGE_OPTIONS,
  STT_SUPPORTED_LANGUAGES,
  languageLabelEnglish,
} from "../languages";

/** LLM 응답으로 받을 수 있는 모든 코드 — STT 지원 코드 + "unknown". */
export type LanguageCode = string;

/** 동적 시스템 프롬프트 — languages.ts 에서 지원 언어 목록을 끌어와 LLM 에 그대로 안내. */
const SUPPORTED_LIST_FOR_PROMPT = LANGUAGE_OPTIONS.map(
  (o) => `  ${o.value} (${o.english})`
).join(",\n");

const SYSTEM_PROMPT = [
  "You are a language identification classifier.",
  "Reply with EXACTLY ONE ISO 639-1 two-letter lowercase code from this set:",
  SUPPORTED_LIST_FOR_PROMPT + ".",
  "If none fits, reply exactly: unknown",
  "Rules:",
  "- Look at the script and orthography, not just keywords.",
  "- Han characters → zh (or ja only if kana is present).",
  "- Latin letters with Vietnamese tone marks (ă â đ ê ô ơ ư + diacritics) → vi.",
  "- Hangul → ko. Arabic script → ar. Greek script → el.",
  `- Use ${languageLabelEnglish("de")}, ${languageLabelEnglish("es")}, ${languageLabelEnglish("fr")}, ${languageLabelEnglish("it")}, ${languageLabelEnglish("nl")}, ${languageLabelEnglish("pl")}, ${languageLabelEnglish("pt")} as needed based on diacritics and orthography.`,
  "- ASCII Latin without diacritics → en.",
  "- If the text is in a language outside the listed set, reply exactly: unknown.",
  "- Output the code only. No punctuation, no quotes, no explanation.",
].join("\n");

type LlmResponse = {
  choices?: Array<{
    message?: { content?: string; reasoning?: string };
    text?: string;
  }>;
};

/** 응답에서 첫 2글자 [a-z][a-z] 토큰 또는 "unknown" 추출. 지원 외 코드는 "unknown". */
function pickCode(raw: string): LanguageCode {
  const t = raw.trim().toLowerCase();
  if (!t) return "unknown";
  if (/\bunknown\b/.test(t)) return "unknown";
  const m = t.match(/[a-z]{2}/);
  if (!m) return "unknown";
  const code = m[0];
  return STT_SUPPORTED_LANGUAGES.has(code) ? code : "unknown";
}

/**
 * 텍스트 기반 언어 판별. 신고자 원문(STT 결과) 또는 한국어 번역 어느 쪽도 가능하지만,
 * 호출부는 원문 텍스트를 넘기는 것을 강력히 권장 — 한국어 번역은 어차피 한국어로
 * 평탄화되어 원어 정보를 잃어버린다.
 *
 * 실패 시 throw — 호출부가 fallback (예: unicode-block heuristic) 으로 진행.
 * 지원 외 결과는 "unknown" 반환 — 임의로 잘못된 언어로 고정하지 않는다.
 */
export async function detectLanguageFromText(
  text: string,
  signal?: AbortSignal,
): Promise<LanguageCode> {
  const t = (text ?? "").trim();
  if (!t) return "unknown";
  const llmModel: string =
    (import.meta.env.VITE_LLM_MODEL as string | undefined) ||
    "example-llm-model";
  const body = {
    model: llmModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      // 800 자로 cap — 응답 시간 안정성.
      { role: "user", content: t.slice(0, 800) },
    ],
    temperature: 0.0,
    max_tokens: 8,
  };
  const res = await fetch(apiUrl("/translate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const t2 = await res.text().catch(() => "");
    throw new Error(`detect-lang ${res.status}: ${t2.slice(0, 200)}`);
  }
  const json = (await res.json()) as LlmResponse;
  const first = json.choices?.[0];
  const raw =
    first?.message?.content?.trim() ||
    first?.text?.trim() ||
    first?.message?.reasoning?.trim() ||
    "";
  return pickCode(raw);
}

/**
 * 텍스트의 unicode 블록만 보고 짧게 1차 판별 — LLM 응답 도착 전 즉시 UI 갱신용.
 * 지원 14 개 중 unique 시그니처만 즉시 확정한다:
 *   한글→ko, 가나→ja, 한자→zh, 아랍→ar, 그리스→el,
 *   베트남어 고유 다이아크리틱(ă â đ ê ô ơ ư + 성조 결합)→vi.
 * 그 외 라틴 계열 (en/de/es/fr/it/nl/pl/pt) 은 서로 혼동되므로 "unknown" 으로 두고
 * LLM 결과를 기다린다.
 *
 * 반환값이 "unknown" 일 수 있는데, 그때는 LLM 결과만 채택한다.
 */
export function detectScriptFromText(text: string): LanguageCode {
  const t = (text ?? "").trim();
  if (!t) return "unknown";
  if (/[぀-ヿ]/.test(t)) return "ja"; // 가나 (히라가나/가타카나)
  if (/[가-힯]/.test(t)) return "ko"; // 한글 음절
  if (/[؀-ۿ]/.test(t)) return "ar"; // 아랍 스크립트
  if (/[Ͱ-Ͽ]/.test(t)) return "el"; // 그리스 스크립트
  if (/[一-鿿]/.test(t)) return "zh"; // CJK 통합 한자 (가나 검사 뒤에 두어 일본어 우선)
  // 베트남어 — 다른 라틴어에 거의 등장하지 않는 고유 글자(ă â đ ê ô ơ ư) 또는
  // 성조 결합 모음 한 글자만 있어도 강한 시그니처. 백엔드 휴리스틱(ems_realtime.py
  // detect_language_from_text) 과 동일 정신.
  if (
    /[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/.test(
      t,
    )
  ) {
    return "vi";
  }
  return "unknown";
}
