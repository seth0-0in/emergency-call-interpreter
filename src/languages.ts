/**
 * STT/번역/TTS가 공통으로 사용하는 언어 옵션 — 단일 소스.
 *
 * 이 시스템의 STT 엔진은 Cohere Transcribe (cohere-transcribe-03-2026) 이며
 * 공식 지원 언어는 정확히 아래 14개다. 이 외 언어를 드롭다운/감지 결과로 노출하면
 * STT가 제대로 받아쓰지 못하므로, 모든 화면이 이 목록에서만 골라 쓰도록 통일한다.
 *
 *   ar (Arabic), de (German), el (Greek), en (English), es (Spanish),
 *   fr (French), it (Italian), ja (Japanese), ko (Korean), nl (Dutch),
 *   pl (Polish), pt (Portuguese), vi (Vietnamese), zh (Chinese)
 *
 * - value: STT/번역 API의 language 필드로 그대로 전달되는 ISO 639-1 두 글자 코드.
 * - label: 한국어 UI 라벨.
 * - english: LLM 번역 프롬프트에 그대로 끼워 넣을 영문 언어명.
 */
export type LanguageOption = {
  value: string;
  label: string;
  english: string;
};

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: "ko", label: "한국어",   english: "Korean" },
  { value: "en", label: "영어",     english: "English" },
  { value: "zh", label: "중국어",   english: "Chinese" },
  { value: "ja", label: "일본어",   english: "Japanese" },
  { value: "vi", label: "베트남어", english: "Vietnamese" },
  { value: "ar", label: "아랍어",   english: "Arabic" },
  { value: "de", label: "독일어",   english: "German" },
  { value: "el", label: "그리스어", english: "Greek" },
  { value: "es", label: "스페인어", english: "Spanish" },
  { value: "fr", label: "프랑스어", english: "French" },
  { value: "it", label: "이탈리아어", english: "Italian" },
  { value: "nl", label: "네덜란드어", english: "Dutch" },
  { value: "pl", label: "폴란드어", english: "Polish" },
  { value: "pt", label: "포르투갈어", english: "Portuguese" },
];

/** STT 지원 언어 코드 집합 — O(1) 검사용. */
export const STT_SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set(
  LANGUAGE_OPTIONS.map((o) => o.value)
);

/**
 * 신고자(외국인) 언어 옵션. 한국어는 상황실 측 언어이므로 제외 — 13개 외국어.
 * 콘솔 드롭다운이 그대로 이걸 쓴다.
 */
export const FOREIGN_LANGUAGE_OPTIONS: LanguageOption[] = LANGUAGE_OPTIONS.filter(
  (o) => o.value !== "ko"
);

/** 언어 코드 → 한국어 UI 라벨. 옵션에 없으면 코드 그대로 반환. */
export function languageLabel(code: string): string {
  return LANGUAGE_OPTIONS.find((l) => l.value === code)?.label ?? code;
}

/** 언어 코드 → 영문 명. LLM 프롬프트에 끼워 넣을 때 사용. */
export function languageLabelEnglish(code: string): string {
  return LANGUAGE_OPTIONS.find((l) => l.value === code)?.english ?? code;
}

/** STT가 지원하는 언어인가? 지원 외 결과는 호출부에서 "unknown" 으로 폴백. */
export function isSupportedLanguage(code: string | null | undefined): boolean {
  if (!code) return false;
  return STT_SUPPORTED_LANGUAGES.has(code);
}
