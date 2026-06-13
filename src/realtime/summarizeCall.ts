// ============================================================================
// 통화 종료 후 — 콘솔에 쌓인 양방향 대화 로그를 LLM 으로 구조화 요약한다.
//
// 호출 경로/모델 — operatorSay.translateKoTo() 와 동일 게이트웨이를 재사용한다.
//   POST /llm/v1/chat/completions  (vite dev proxy / 운영 게이트웨이 same-origin)
//   모델은 VITE_LLM_MODEL 빌드 env 로 override.
//   인증 정책은 운영 게이트웨이 정책에 따른다.
//
// 새 백엔드 endpoint / 새 API 키 / 새 서비스 추가 없음.
// 백엔드 /api/119/realtime/process 는 손대지 않는다.
// ============================================================================

import { apiUrl } from "../api";
import { languageLabel } from "../languages";

export type IncidentType =
  | "구급"
  | "화재"
  | "구조"
  | "교통사고"
  | "기타"
  | "미상";

export type Urgency = "높음" | "보통" | "낮음" | "미상";

/** LLM 이 채워 돌려주는 구조화 요약. 미언급 항목은 "정보 없음" 또는 "미상" 으로 둔다. */
export type CallSummary = {
  /** 신고 요약 — 2~3 문장의 한국어 자연어. 대화에 명시된 사실만. */
  summary: string;
  /** 위치/주소 — 언급된 그대로. 없으면 "정보 없음". */
  location: string;
  /** 환자/피해자 상태. 없으면 "정보 없음". */
  patientState: string;
  /** 사고 유형 — 분류 6 종 중 하나. */
  incidentType: IncidentType;
  /** 긴급도 — 4 종 중 하나. 대화에서 단서가 없으면 "미상". */
  urgency: Urgency;
  /** 필요 조치 / 안내한 응급처치 등. 없으면 "정보 없음". */
  actions: string;
  /** 대화에 명시되지 않았지만 LLM 이 추정한 항목 — 항목명 + 근거를 짧게 자연어로. */
  inferences: string[];
};

const INCIDENT_TYPES: IncidentType[] = [
  "구급", "화재", "구조", "교통사고", "기타", "미상",
];
const URGENCIES: Urgency[] = ["높음", "보통", "낮음", "미상"];

/** 콘솔 log entry — ConsolePage 의 CallerLogEntry / OperatorLogEntry 와 동일한 최소 필드만. */
export type SummaryInputEntry =
  | {
      role: "caller";
      ts: number;
      lang: string;
      text: string;
      translatedKo: string;
      corrected?: boolean;
    }
  | {
      role: "operator";
      ts: number;
      targetLang: string;
      textKo: string;
      translated: string;
      status: string;
    };

const SYSTEM_PROMPT = [
  "You are an assistant for a Korean 119 emergency dispatcher.",
  "You will be given a transcript of a bilingual emergency call (foreign-language caller ↔ Korean dispatcher).",
  "Summarize the call in Korean as STRICT JSON only — no markdown, no code fences, no commentary before or after.",
  "",
  "Output schema (all fields required):",
  '{',
  '  "summary":       "2~3문장의 한국어 신고 요약. 대화에 명시된 사실만 사용",',
  '  "location":      "언급된 위치/주소를 한국어로. 없으면 \\"정보 없음\\"",',
  '  "patientState":  "환자/피해자 상태를 한국어로. 없으면 \\"정보 없음\\"",',
  '  "incidentType":  "구급|화재|구조|교통사고|기타|미상 중 정확히 하나",',
  '  "urgency":       "높음|보통|낮음|미상 중 정확히 하나",',
  '  "actions":       "안내한 응급처치/필요한 조치. 없으면 \\"정보 없음\\"",',
  '  "inferences":    ["대화에 직접 명시되지 않았지만 추정한 항목과 그 근거 — 한국어 한 문장씩의 배열. 추정한 게 없으면 빈 배열"]',
  "}",
  "",
  "Strict rules:",
  "- Use ONLY information explicitly present in the transcript. Do NOT invent names, addresses, ages, vitals, or specific times.",
  '- If a field is not mentioned in the conversation, write "정보 없음" (or "미상" for incidentType/urgency).',
  '- If you must infer something (e.g. urgency from severity keywords), include the inferred conclusion in the field AND add an "(추정)" suffix in Korean, and list the basis in the `inferences` array.',
  "- All natural-language values must be in Korean even if the caller spoke a foreign language.",
  "- Return ONLY the JSON object. No prose, no markdown, no ```json fences.",
].join("\n");

type LlmResponse = {
  choices?: Array<{
    message?: { content?: string; reasoning?: string };
    text?: string;
  }>;
};

/** ConsolePage 의 log → LLM 에 보낼 자연어 transcript. */
function buildTranscript(entries: SummaryInputEntry[]): string {
  if (entries.length === 0) return "(빈 대화)";
  const lines: string[] = [];
  for (const e of entries) {
    const time = new Date(e.ts).toLocaleTimeString("ko-KR");
    if (e.role === "caller") {
      const tag = e.corrected ? " [정정됨]" : "";
      lines.push(`[${time}] 신고자 (${languageLabel(e.lang)})${tag}`);
      lines.push(`  원문: ${e.text || "(빈 발화)"}`);
      lines.push(`  한국어 번역: ${e.translatedKo || "(번역 없음)"}`);
    } else {
      // 상황실 메시지는 한국어가 원문 — 신고자 언어 번역은 LLM 컨텍스트에 불필요.
      if (e.status === "sent") {
        lines.push(`[${time}] 상황실 → ${languageLabel(e.targetLang)}`);
        lines.push(`  한국어: ${e.textKo}`);
      } else {
        // 처리 중/오류인 메시지는 transcript 에 넣지 않는다 — 추측 유발.
      }
    }
  }
  return lines.join("\n");
}

/**
 * LLM 응답 본문에서 JSON 오브젝트 추출.
 * 게이트웨이가 ```json fence 를 끼우거나 thinking-trace 를 앞에 붙이는 경우 대응.
 */
function extractJsonObject(raw: string): unknown {
  const stripped = raw.trim();
  // 1) 통째로 JSON.parse 시도.
  try {
    return JSON.parse(stripped);
  } catch {
    // 통과 — fence 또는 prefix 가 있을 가능성.
  }
  // 2) ```json ... ``` fence 안쪽.
  const fence = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // 통과 — 마지막 경로로.
    }
  }
  // 3) 첫 { 부터 마지막 } 까지 — reasoning 텍스트가 앞뒤로 붙은 경우.
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = stripped.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // 통과.
    }
  }
  throw new Error("LLM 응답에서 JSON 객체를 추출하지 못했습니다");
}

function coerceString(v: unknown, fallback: string): string {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 0 ? t : fallback;
  }
  return fallback;
}

function coerceEnum<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  if (typeof v === "string") {
    const t = v.trim();
    const hit = allowed.find((a) => a === t);
    if (hit) return hit;
  }
  return fallback;
}

function coerceInferences(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string") {
      const t = x.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function normalizeSummary(raw: unknown): CallSummary {
  const obj = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
  return {
    summary: coerceString(obj.summary, "(요약 생성 실패 — 응답 비어있음)"),
    location: coerceString(obj.location, "정보 없음"),
    patientState: coerceString(obj.patientState, "정보 없음"),
    incidentType: coerceEnum<IncidentType>(obj.incidentType, INCIDENT_TYPES, "미상"),
    urgency: coerceEnum<Urgency>(obj.urgency, URGENCIES, "미상"),
    actions: coerceString(obj.actions, "정보 없음"),
    inferences: coerceInferences(obj.inferences),
  };
}

export type SummarizeOptions = {
  entries: SummaryInputEntry[];
  /** 신고자 언어 코드 (감지/수동 고정값). 프롬프트 컨텍스트에 포함. */
  callerLanguage?: string | null;
  signal?: AbortSignal;
};

export async function summarizeCall(
  opts: SummarizeOptions
): Promise<CallSummary> {
  const { entries, callerLanguage, signal } = opts;
  const transcript = buildTranscript(entries);
  const callerLangNote = callerLanguage
    ? `Caller language: ${languageLabel(callerLanguage)} (${callerLanguage}).`
    : "Caller language: not yet identified.";

  const userPrompt = [
    callerLangNote,
    `Total entries: ${entries.length}.`,
    "",
    "Transcript (Korean dispatcher console log):",
    transcript,
    "",
    "Return ONLY the JSON object described in the system prompt.",
  ].join("\n");

  // 게이트웨이마다 모델 이름이 다르므로 빌드 env 로 override 한다 (operatorSay 와 동일).
  const llmModel: string =
    (import.meta.env.VITE_LLM_MODEL as string | undefined) ||
    "example-llm-model";
  const body = {
    model: llmModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    // 사실 기반 구조화이므로 매우 낮은 temperature.
    temperature: 0.0,
    max_tokens: 600,
  };

  // 작동이 검증된 same-origin `/llm/v1/chat/completions` 를 직접 호출
  // (operatorSay 와 동일 — 운영 환경의 `/translate` 라우트 misroute 회피).
  const res = await fetch(apiUrl("/llm/v1/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`summarize ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as LlmResponse;
  const first = json.choices?.[0];
  const raw =
    first?.message?.content?.trim() ||
    first?.text?.trim() ||
    first?.message?.reasoning?.trim() ||
    "";
  if (!raw) {
    throw new Error("LLM 응답이 비어 있습니다");
  }
  const parsed = extractJsonObject(raw);
  return normalizeSummary(parsed);
}
