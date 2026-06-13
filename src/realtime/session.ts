// ============================================================================
// 콘솔(/console)과 신고자 시뮬레이터(/simulator) 간 발화 단위 상태를 주고받는
// 채널.
//
// 0단계 결정: BroadcastChannel 사용.
//   - 같은 origin 의 두 탭(또는 두 창) 사이에서만 동작 (데모/테스트 시나리오).
//   - 새 서버, 새 포트, 새 의존성 0 — dev/preview/운영 모두 동일.
//   - 향후 실제 119 전화망 연동 시 이 모듈만 WebSocket/SSE 로 교체.
//   - 메시지는 모두 sessionId 를 실어 보낸다.
// ============================================================================

const CHANNEL_NAME = "ems-119-session";
const SESSION_STORAGE_KEY = "ems_119_session_id";

/** 신고자 → 콘솔 — 한 발화의 STT/번역 결과 */
export type CallerUtteranceMessage = {
  kind: "caller-utterance";
  sessionId: string;
  seq: number;
  ts: number; // epoch ms (발화 시작)
  /** 신고자 언어 코드 (서버가 감지한 값) */
  lang: string;
  /** 신고자 원문 (서버 STT 결과) */
  text: string;
  /** 한국어 번역 (서버가 채워줌; 첫 chunk 에서 비어 있을 수 있음) */
  translatedKo: string;
  /** STT/번역 신뢰도 — 콘솔에서 낮으면 경고 표시. */
  speakerConfidence?: number;
  /** 신고자 원음 (시뮬레이터가 녹음한 WAV 를 base64 로). 재생 버튼용. */
  callerAudioBase64?: string;
  /** 신고자가 "다시 말하기" 로 재녹음해서 같은 seq 를 덮어쓴 경우 true.
   *  콘솔은 같은 seq 의 기존 버블을 새 내용으로 교체하고 "정정됨" 라벨을 표시한다. */
  isRetake?: boolean;
};

/** 콘솔 → 신고자 — 요원이 친 한국어 응답을 신고자 언어로 번역+TTS 한 결과 */
export type OperatorReplyMessage = {
  kind: "operator-reply";
  sessionId: string;
  seq: number;
  ts: number;
  /** 요원이 입력한 한국어 원문 */
  textKo: string;
  /** 신고자 언어로 번역된 텍스트 */
  translated: string;
  /** 신고자 언어 코드 */
  targetLang: string;
  /** mp3 base64 — 시뮬레이터에서 디코딩해 스피커로 재생 */
  audioBase64: string;
};

/**
 * 콘솔 → 시뮬레이터 — 신고자 언어 잠금 상태 변경 알림.
 * lang === null 은 "잠금 해제(자동 감지로 복귀)" 를 의미하며, source="manual" 일 때만
 * 의미가 있다 (자동 확정 흐름에서는 null 을 보내지 않는다).
 */
export type LangLockMessage = {
  kind: "lang-lock";
  sessionId: string;
  lang: string | null;
  source: "auto" | "manual";
};

/** 콘솔이 "통화 종료" 또는 "새 세션 시작" 을 알릴 때 */
export type SessionResetMessage = {
  kind: "session-reset";
  sessionId: string;
};

/** 시뮬레이터 → 콘솔 — 시뮬레이터가 새 세션 ID 로 시작했음을 알림 */
export type SessionStartMessage = {
  kind: "session-start";
  sessionId: string;
  ts: number;
};

export type SessionMessage =
  | CallerUtteranceMessage
  | OperatorReplyMessage
  | LangLockMessage
  | SessionResetMessage
  | SessionStartMessage;

export type SessionListener = (msg: SessionMessage) => void;

/** 두 화면이 공유할 sessionId 를 가져온다. localStorage 에 캐시. */
export function getOrCreateSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing && existing.length > 0) return existing;
  } catch {
    // 접근 차단 환경 — 무시.
  }
  const sid =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, sid);
  } catch {
    // 무시 — 메모리에서만이라도 유지.
  }
  return sid;
}

/** 새 세션을 강제로 시작 (콘솔의 "새 신고 시작" 버튼용). */
export function resetSessionId(): string {
  const sid =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, sid);
  } catch {
    // 무시.
  }
  return sid;
}

/**
 * BroadcastChannel 을 얇게 감싼 래퍼. SSR/구버전 브라우저 안전.
 * close() 를 잊지 말 것 — React 컴포넌트의 cleanup 에서 호출한다.
 */
export class SessionChannel {
  private channel: BroadcastChannel | null;
  private listeners: Set<SessionListener> = new Set();

  constructor() {
    if (typeof BroadcastChannel === "undefined") {
      this.channel = null;
      return;
    }
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (ev: MessageEvent<SessionMessage>) => {
      const data = ev.data;
      if (!data || typeof data !== "object" || typeof data.kind !== "string") {
        return;
      }
      for (const l of this.listeners) {
        try {
          l(data);
        } catch {
          // listener 가 던져도 다른 listener 까지 막지 않는다.
        }
      }
    };
  }

  on(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(msg: SessionMessage): void {
    if (!this.channel) return;
    try {
      this.channel.postMessage(msg);
    } catch {
      // 채널이 닫힌 후 호출됐을 수 있음 — 무시.
    }
  }

  close(): void {
    this.listeners.clear();
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // 무시.
      }
      this.channel = null;
    }
  }
}
