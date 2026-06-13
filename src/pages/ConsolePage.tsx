// ============================================================================
// 상황실 콘솔 (`/console`) — 메인 제품.
//
// 신고자 시뮬레이터(`/simulator`) 또는 향후 실 전화망에서 발화 단위 메시지가
// 도착하면 대화 로그에 표시한다. 요원은 한국어를 채팅으로 입력하면
// 신고자 언어로 번역+TTS 되어 시뮬레이터로 전달된다.
//
// 0단계 결정에 따라 두 화면 통신은 BroadcastChannel. 백엔드 추가/수정 없음.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  COLORS,
  whiteCard,
  sectionHeading,
  TYPO,
  URGENCY_COLOR,
  INCIDENT_COLOR,
  STATUS_COLOR,
} from "../theme";
import { languageLabel, isSupportedLanguage } from "../languages";
import {
  SessionChannel,
  getOrCreateSessionId,
  resetSessionId,
  type CallerUtteranceMessage,
  type SessionMessage,
} from "../realtime/session";
import { decodeBase64Audio } from "../realtime/processCallerChunk";
import { operatorSay, callerLanguageOptions } from "../realtime/operatorSay";
import { useAppData, type RealtimeMessage } from "../context/AppDataContext";
import {
  summarizeCall,
  type CallSummary,
  type SummaryInputEntry,
} from "../realtime/summarizeCall";
import {
  detectLanguageFromText,
  detectScriptFromText,
} from "../realtime/detectLanguageFromText";

type CallerLogEntry = {
  role: "caller";
  seq: number;
  ts: number;
  lang: string;
  text: string;
  translatedKo: string;
  speakerConfidence?: number;
  callerAudioBase64?: string;
  /** 신고자가 "다시 말하기" 로 한 번 이상 덮어쓴 항목인지. UI 에 "정정됨" 라벨 표시용. */
  corrected?: boolean;
};

type OperatorLogEntry = {
  role: "operator";
  seq: number;
  ts: number;
  textKo: string;
  /** 신고자 언어 번역. */
  translated: string;
  targetLang: string;
  status: "translating" | "sent" | "error";
  error?: string;
};

type LogEntry = CallerLogEntry | OperatorLogEntry;

const QUICK_PHRASES = [
  "지금 안전한가요?",
  "현재 위치를 말해주세요.",
  "다친 사람이 있나요?",
  "구급차가 출동했습니다.",
];

const LOW_CONFIDENCE_THR = 0.4;

export default function ConsolePage() {
  const [sessionId, setSessionId] = useState<string>(() => getOrCreateSessionId());
  const [log, setLog] = useState<LogEntry[]>([]);
  // 신고자 언어. null = 아직 받은 발화 없음. "unknown" = 서버가 감지 실패.
  const [detectedCallerLang, setDetectedCallerLang] = useState<string | null>(null);
  // 요원이 드롭다운으로 수동 고정한 언어. null 이면 자동(detected) 사용.
  const [manualCallerLang, setManualCallerLang] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>("");
  // 세션 시작/종료 시각. start 는 첫 발화가 잡히는 순간 set, end 는 "통화 종료" 시점.
  const [sessionStart, setSessionStart] = useState<number | null>(null);
  const [sessionEnd, setSessionEnd] = useState<number | null>(null);
  // LLM 구조화 요약. idle 상태(=summary null)에서 사용자가 "요약 생성" 누르면 호출.
  const [summary, setSummary] = useState<CallSummary | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const channelRef = useRef<SessionChannel | null>(null);
  const sessionIdRef = useRef(sessionId);
  const opSeqRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // 두 ref 는 별도 — manual 은 우선순위, detected 는 fallback.
  const detectedRef = useRef<string | null>(null);
  const manualRef = useRef<string | null>(null);
  // 텍스트 기반 LLM 판별의 잠금 — 한 번 잠그면 같은 세션 내에서 다시 LLM 판별 호출을 하지 않는다.
  // 보수 정책: 잠금은 오직 unicode-block 시그니처가 명확한 언어(한자/가나/한글/아랍/그리스/
  // 베트남어 다이아크리틱) 에서만 발생한다. 라틴 ASCII 만 들어왔을 때는 LLM 결과가 무엇이든
  // 자동 잠그지 않고 요원이 드롭다운으로 직접 선택하도록 유도한다.
  const detectionConfirmedRef = useRef<boolean>(false);

  const navigate = useNavigate();
  const { upsertRealtimeRecord } = useAppData();

  // ----- channel -----
  useEffect(() => {
    const ch = new SessionChannel();
    channelRef.current = ch;
    const off = ch.on(handleChannelMessage);
    return () => {
      off();
      ch.close();
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleChannelMessage(msg: SessionMessage) {
    if (msg.kind === "session-start") {
      // 시뮬레이터가 새로 켜졌다 — 같은 sessionId 라면 무시, 다르다면 콘솔이 따라간다.
      if (msg.sessionId !== sessionIdRef.current) {
        sessionIdRef.current = msg.sessionId;
        setSessionId(msg.sessionId);
        setLog([]);
        setDetectedCallerLang(null);
        detectedRef.current = null;
        setManualCallerLang(null);
        manualRef.current = null;
        detectionConfirmedRef.current = false;
        setSessionStart(null);
        setSessionEnd(null);
        setSummary(null);
        setSummaryError(null);
        setStatusMsg("새 신고자 세션에 연결됨");
      }
      return;
    }
    if (msg.sessionId !== sessionIdRef.current) {
      return; // 다른 세션의 메시지는 무시 — 같은 origin 의 잔여 탭 등.
    }
    if (msg.kind === "caller-utterance") {
      appendCaller(msg);
    } else if (msg.kind === "session-reset") {
      setLog([]);
      setDetectedCallerLang(null);
      detectedRef.current = null;
      detectionConfirmedRef.current = false;
      setSessionStart(null);
      setSessionEnd(null);
      setSummary(null);
      setSummaryError(null);
    }
    // operator-reply / lang-lock 은 시뮬레이터 측 메시지지만, 콘솔 자신이 보낸 것을
    // 다시 받을 수도 있다. BroadcastChannel 은 보낸 탭에는 echo 하지 않으므로 안전.
  }

  function appendCaller(msg: CallerUtteranceMessage) {
    setLog((prev) => {
      // 같은 seq 의 신고자 발화가 이미 있으면 retake (다시 말하기) — 그 항목을 교체하고
      // "정정됨" 표시. 없으면 신규 발화로 push.
      const existingIdx = prev.findIndex(
        (e) => e.role === "caller" && e.seq === msg.seq
      );
      const next: CallerLogEntry = {
        role: "caller",
        seq: msg.seq,
        ts: msg.ts,
        lang: msg.lang,
        text: msg.text,
        translatedKo: msg.translatedKo,
        speakerConfidence: msg.speakerConfidence,
        callerAudioBase64: msg.callerAudioBase64,
        corrected: msg.isRetake === true || existingIdx >= 0,
      };
      if (existingIdx >= 0) {
        const copy = prev.slice();
        copy[existingIdx] = next;
        return copy;
      }
      return [...prev, next];
    });
    // 신고자 언어 결정 — envelope.lang (= STT 오디오 LID) 는 신뢰하지 않는다.
    // 한자/가나 등 unique 한 스크립트는 unicode-block 으로 즉시 잠정 set 하고,
    // LLM 텍스트 판별을 비동기로 호출해 2회 연속 같은 결과면 잠금.
    if (manualRef.current) return; // 수동 고정 시 어떤 자동 판별도 우선하지 않는다.
    if (!msg.text) return;
    if (detectionConfirmedRef.current) return; // 이미 잠금 — 더 이상 변경 안 함.
    applyTextBasedDetection(msg.text);
  }

  /** 텍스트 기반 자동 감지/잠금 — 보수 정책.
   *
   *   1) unicode-block fast (한자/가나/한글/아랍/그리스/베트남어 다이아크리틱) 가 잡힌
   *      발화에 한해 detectedRef 를 즉시 갱신한다. fast 와 LLM 응답이 같으면 그 자리에서 잠금.
   *   2) 라틴 ASCII 만으로 들어온 발화(예: 일본어/한국어 음성을 STT 가 로마자로 잘못 전사한 케이스,
   *      짧은 영어 단어 한두 개)는 LLM 결과가 무엇이든 detected 도 갱신하지 않고 잠금도 하지 않는다.
   *      이런 모호 텍스트로는 어떤 언어라고 확신할 수 없으므로, 요원이 드롭다운으로 직접 고르도록
   *      "감지 대기" 상태를 유지한다.
   *   3) 수동 드롭다운은 절대 우선 — 어떤 자동 판별도 manualRef 를 덮지 않는다.
   */
  function applyTextBasedDetection(text: string) {
    const fast = detectScriptFromText(text);
    const hasStrongScriptSignature =
      fast !== "unknown" && isSupportedLanguage(fast);

    if (hasStrongScriptSignature) {
      detectedRef.current = fast;
      setDetectedCallerLang(fast);
    }

    // LLM 판별은 항상 호출 — strong-signal 일 때 잠금 트리거에만 사용한다.
    // strong signature 가 없을 때 LLM 단독 결과로 라벨/잠금하지 않는다.
    void (async () => {
      try {
        const llm = await detectLanguageFromText(text);
        if (llm === "unknown") return;
        if (!isSupportedLanguage(llm)) return;
        if (manualRef.current) return;
        if (detectionConfirmedRef.current) return;

        // 모호한 라틴 텍스트로 LLM 이 어떤 언어를 짚어도 잠그지 않는다.
        // (실사례: 일본어 음성이 "Hotsejimashite ..." 처럼 로마자로 전사되면 LLM 이 vi/it 등으로
        //  오분류하는 경우가 있다. 119 에선 확신에 찬 오판이 더 위험하다.)
        if (!hasStrongScriptSignature) return;

        // unicode-block 시그니처 + LLM 합의 → 즉시 잠금.
        if (fast === llm) {
          detectionConfirmedRef.current = true;
          setStatusMsg(`신고자 언어 확정: ${languageLabel(llm)} (자동)`);
          channelRef.current?.send({
            kind: "lang-lock",
            sessionId: sessionIdRef.current,
            lang: llm,
            source: "auto",
          });
        }
        // strong signature 가 있는데 LLM 만 다른 답을 주면(드문 케이스) detected 는 fast 유지,
        // 잠금은 보류 — 다음 발화에서 합의가 들어오면 그때 잠근다.
      } catch {
        // 판별 실패 — 무시.
      }
    })();
  }

  // ----- 언어 드롭다운 -----
  function handleManualLangChange(next: string) {
    const lang = next || null;
    manualRef.current = lang;
    setManualCallerLang(lang);
    if (lang) {
      // 수동 선택은 절대 우선 — 진행 중인 자동 판별 비동기 콜백도 차단한다.
      // (잠금 플래그를 켜두면 후속 LLM 응답이 detectedRef 를 흔들지 못한다.)
      detectionConfirmedRef.current = true;
      channelRef.current?.send({
        kind: "lang-lock",
        sessionId: sessionIdRef.current,
        lang,
        source: "manual",
      });
      setStatusMsg(`신고자 언어를 ${languageLabel(lang)} 로 수동 고정`);
    } else {
      // 자동 감지로 복귀 — 다음 발화부터 다시 strong-signal 잠금 시도.
      // 시뮬레이터에도 unlock 알림을 보내 manualLockRef stale 상태를 청소하고,
      // 이후 processCallerChunk 가 manual_language_lock 폼 필드를 더 이상 보내지
      // 않게 한다 (백엔드 sess.manual_locked 도 다음 호출에서 자동 클리어).
      detectionConfirmedRef.current = false;
      channelRef.current?.send({
        kind: "lang-lock",
        sessionId: sessionIdRef.current,
        lang: null,
        source: "manual",
      });
      setStatusMsg("신고자 언어 자동 감지로 전환");
    }
  }

  function effectiveCallerLang(): string | null {
    return manualRef.current ?? detectedRef.current;
  }

  function isLangLocked(): boolean {
    return manualRef.current !== null;
  }

  // ----- 새 신고 -----
  function handleNewCall() {
    const sid = resetSessionId();
    sessionIdRef.current = sid;
    setSessionId(sid);
    setLog([]);
    setDetectedCallerLang(null);
    detectedRef.current = null;
    setManualCallerLang(null);
    manualRef.current = null;
    detectionConfirmedRef.current = false;
    opSeqRef.current = 0;
    setSessionStart(null);
    setSessionEnd(null);
    setSummary(null);
    setSummaryError(null);
    setStatusMsg("새 신고 세션 시작");
    channelRef.current?.send({ kind: "session-reset", sessionId: sid });
  }

  // ----- 자주 쓰는 문구 버튼 -----
  function handleQuickPhrase(phrase: string) {
    setInput((prev) => (prev ? prev + " " + phrase : phrase));
  }

  // ----- 요원 전송 -----
  async function handleSend() {
    if (sending) return;
    const text = input.trim();
    if (!text) return;
    const targetLang = effectiveCallerLang();
    if (!targetLang || targetLang === "unknown") {
      setStatusMsg("신고자 언어가 정해지지 않았습니다. 드롭다운에서 선택해주세요.");
      return;
    }

    const seq = ++opSeqRef.current;
    const ts = Date.now();
    setLog((prev) => [
      ...prev,
      {
        role: "operator",
        seq,
        ts,
        textKo: text,
        translated: "",
        targetLang,
        status: "translating",
      },
    ]);
    setInput("");
    setSending(true);

    try {
      const { translated, audioBase64 } = await operatorSay({ textKo: text, targetLang });
      setLog((prev) =>
        prev.map((e) =>
          e.role === "operator" && e.seq === seq
            ? { ...e, translated, status: "sent" }
            : e
        )
      );
      channelRef.current?.send({
        kind: "operator-reply",
        sessionId: sessionIdRef.current,
        seq,
        ts,
        textKo: text,
        translated,
        targetLang,
        audioBase64,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLog((prev) =>
        prev.map((entry) =>
          entry.role === "operator" && entry.seq === seq
            ? { ...entry, status: "error", error: msg }
            : entry
        )
      );
      setStatusMsg(`번역/TTS 실패: ${msg}`);
    } finally {
      setSending(false);
    }
  }

  // ----- caller 원음 재생 -----
  function playCallerOriginal(b64: string) {
    try {
      const blob = decodeBase64Audio(b64, "audio/wav");
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      a.onerror = () => URL.revokeObjectURL(url);
      void a.play();
    } catch (e) {
      console.warn("caller original play failed", e);
    }
  }

  // ----- 자동 스크롤 -----
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [log.length]);

  // ----- 첫 발화 시 세션 시작 시각 set -----
  useEffect(() => {
    if (sessionStart != null) return;
    if (log.length === 0) return;
    setSessionStart(log[0].ts);
  }, [log, sessionStart]);

  // ----- 콘솔 log → RealtimeMessage[] 변환 (ResultPage 가 같은 포맷으로 처리) -----
  const realtimeMessages: RealtimeMessage[] = useMemo(() => {
    return log.map((entry) => {
      if (entry.role === "caller") {
        return {
          id: entry.seq,
          timestamp: entry.ts,
          speaker: "caller",
          speakerLabel: "신고자",
          sourceLanguage: entry.lang || "unknown",
          targetLanguage: "ko",
          original: entry.text,
          translated: entry.translatedKo,
          status: entry.corrected ? "정정됨" : "ok",
          speakerConfidence: entry.speakerConfidence,
          speakerReason: entry.corrected ? "신고자 재녹음으로 정정됨" : undefined,
        };
      }
      // operator
      return {
        id: 1_000_000 + entry.seq,
        timestamp: entry.ts,
        speaker: "operator",
        speakerLabel: "구급대원",
        sourceLanguage: "ko",
        targetLanguage: entry.targetLang || "unknown",
        original: entry.textKo,
        translated: entry.translated,
        status: entry.status === "sent"
          ? "ok"
          : entry.status === "translating"
          ? "처리 중"
          : "error",
        error: entry.error,
      };
    });
  }, [log]);

  // ----- 실시간 history upsert (RealtimePage 와 동일 패턴) -----
  // 메시지가 한 건이라도 있고 sessionStart 가 잡혔으면 같은 sessionId 로 upsert.
  // ResultPage 에서 카드로 보이며 TXT/HTML/PDF(인쇄) 출력 가능.
  useEffect(() => {
    if (sessionStart == null) return;
    if (realtimeMessages.length === 0) return;
    upsertRealtimeRecord({
      id: sessionIdRef.current,
      createdAt: sessionStart,
      endedAt: sessionEnd,
      messages: realtimeMessages,
      meta: {},
      summary: summary ?? null,
    });
  }, [realtimeMessages, sessionStart, sessionEnd, summary, upsertRealtimeRecord]);

  // ----- 통화 종료 -----
  function handleEndCall() {
    if (sessionEnd != null) return;
    if (log.length === 0) {
      setStatusMsg("저장할 대화가 없습니다.");
      return;
    }
    setSessionEnd(Date.now());
    setStatusMsg("통화를 종료했습니다. 기록이 저장되었습니다.");
  }

  // ----- 즉시 내보내기 (TXT / JSON) -----
  function downloadBlob(content: string, filename: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportFilenameBase(): string {
    const d = new Date(sessionStart ?? Date.now());
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(
      d.getHours()
    )}${p(d.getMinutes())}`;
    return `119_console_${stamp}_${sessionIdRef.current.slice(0, 8)}`;
  }

  function buildExportTxt(): string {
    const fmt = (ms: number) => {
      const x = new Date(ms);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(
        x.getHours()
      )}:${p(x.getMinutes())}:${p(x.getSeconds())}`;
    };
    const sep = "=".repeat(50);
    const lines: string[] = [];
    lines.push(sep);
    lines.push("119 외국인 신고자 통번역 콘솔 — 대화 기록");
    lines.push(sep);
    lines.push(`세션 ID         : ${sessionIdRef.current}`);
    lines.push(
      `세션 시작       : ${sessionStart != null ? fmt(sessionStart) : "-"}`
    );
    lines.push(
      `세션 종료       : ${
        sessionEnd != null ? fmt(sessionEnd) : "(진행 중)"
      }`
    );
    lines.push(
      `신고자 언어     : ${
        manualCallerLang
          ? `${languageLabel(manualCallerLang)} (수동 고정)`
          : detectedCallerLang
          ? `${languageLabel(detectedCallerLang)} (자동 감지)`
          : "(감지 안 됨)"
      }`
    );
    lines.push(`대화 건수       : ${log.length}건`);
    lines.push("");
    if (summary) {
      lines.push("-".repeat(50));
      lines.push("[신고 내용 요약 — LLM 자동 생성]");
      lines.push(`요약            : ${summary.summary}`);
      lines.push(`위치 / 주소     : ${summary.location}`);
      lines.push(`환자 / 피해자   : ${summary.patientState}`);
      lines.push(`사고 유형       : ${summary.incidentType}`);
      lines.push(`긴급도          : ${summary.urgency}`);
      lines.push(`필요 조치       : ${summary.actions}`);
      if (summary.inferences.length > 0) {
        lines.push("추정 항목       :");
        summary.inferences.forEach((s) => lines.push(`  · ${s}`));
      }
      lines.push("");
    }
    lines.push("-".repeat(50));
    log.forEach((entry) => {
      const time = new Date(entry.ts).toLocaleTimeString();
      if (entry.role === "caller") {
        const tag = entry.corrected ? " [정정됨]" : "";
        lines.push(`[${time}] 🆘 신고자 (${languageLabel(entry.lang)})${tag}`);
        lines.push(`  원문    : ${entry.text || "(빈 발화)"}`);
        lines.push(`  한국어  : ${entry.translatedKo || "(번역 없음)"}`);
      } else {
        lines.push(
          `[${time}] 🚑 상황실 → ${languageLabel(entry.targetLang)}`
        );
        lines.push(`  한국어  : ${entry.textKo}`);
        if (entry.status === "sent") {
          lines.push(`  번역    : ${entry.translated || "(빈 번역)"}`);
        } else if (entry.status === "error") {
          lines.push(`  ⚠ 오류  : ${entry.error ?? "error"}`);
        } else {
          lines.push(`  번역    : (처리 중)`);
        }
      }
      lines.push("");
    });
    lines.push(sep);
    lines.push("이 파일은 콘솔 즉시 내보내기 결과입니다.");
    lines.push("정식 사건 기록 문서(TXT/HTML/PDF)는 '/result' 화면에서 생성하세요.");
    return lines.join("\n");
  }

  function buildExportJson(): string {
    const payload = {
      sessionId: sessionIdRef.current,
      createdAt: sessionStart,
      endedAt: sessionEnd,
      detectedCallerLanguage: detectedCallerLang,
      manualCallerLanguage: manualCallerLang,
      summary: summary ?? null,
      messages: log.map((entry) =>
        entry.role === "caller"
          ? {
              role: "caller",
              seq: entry.seq,
              ts: entry.ts,
              lang: entry.lang,
              text: entry.text,
              translatedKo: entry.translatedKo,
              corrected: entry.corrected ?? false,
              speakerConfidence: entry.speakerConfidence,
            }
          : {
              role: "operator",
              seq: entry.seq,
              ts: entry.ts,
              targetLang: entry.targetLang,
              textKo: entry.textKo,
              translated: entry.translated,
              status: entry.status,
              error: entry.error,
            }
      ),
    };
    return JSON.stringify(payload, null, 2);
  }

  function handleDownloadTxt() {
    if (log.length === 0) {
      setStatusMsg("저장할 대화가 없습니다.");
      return;
    }
    downloadBlob(
      buildExportTxt(),
      `${exportFilenameBase()}.txt`,
      "text/plain;charset=utf-8"
    );
  }

  function handleDownloadJson() {
    if (log.length === 0) {
      setStatusMsg("저장할 대화가 없습니다.");
      return;
    }
    downloadBlob(
      buildExportJson(),
      `${exportFilenameBase()}.json`,
      "application/json;charset=utf-8"
    );
  }

  function handleGoToResult() {
    navigate("/result");
  }

  // ----- LLM 구조화 요약 생성 -----
  async function handleSummarize() {
    if (summarizing) return;
    if (log.length === 0) {
      setSummaryError("요약할 대화가 없습니다.");
      return;
    }
    setSummarizing(true);
    setSummaryError(null);
    try {
      const entries: SummaryInputEntry[] = log.map((e) =>
        e.role === "caller"
          ? {
              role: "caller",
              ts: e.ts,
              lang: e.lang,
              text: e.text,
              translatedKo: e.translatedKo,
              corrected: e.corrected,
            }
          : {
              role: "operator",
              ts: e.ts,
              targetLang: e.targetLang,
              textKo: e.textKo,
              translated: e.translated,
              status: e.status,
            }
      );
      const result = await summarizeCall({
        entries,
        callerLanguage: manualCallerLang ?? detectedCallerLang,
      });
      setSummary(result);
      setStatusMsg("요약을 생성했습니다.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSummaryError(msg);
      // 대화 로그는 그대로 — summary 만 null/error 로 표시.
    } finally {
      setSummarizing(false);
    }
  }

  // ----- 렌더링 -----
  const callerLangOptions = useMemo(() => callerLanguageOptions(), []);
  // 표시 라벨 — 수동 고정 > 자동 감지 > (발화 있는데 모호) "언어 미상 — 드롭다운에서 선택" > "감지 대기".
  // 발화는 들어왔지만 detected 가 null 인 케이스는 보수 정책에 따라 모호 텍스트(라틴 ASCII 등)로
  // 자동 확신을 보류한 상태 — 요원에게 명시적으로 수동 선택을 유도한다.
  const langDisplay = manualCallerLang
    ? `${languageLabel(manualCallerLang)} (수동 고정)`
    : detectedCallerLang
    ? `${languageLabel(detectedCallerLang)} (자동 감지)`
    : log.length > 0
    ? "언어 미상 — 드롭다운에서 선택"
    : "감지 대기";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: COLORS.pageBg,
        color: "#fff",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {/* 공용 keyframes — Spinner / 마이크 펄스 등 표현용. */}
      <style>{`
        @keyframes ems-spin { to { transform: rotate(360deg); } }
        @keyframes ems-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(15,123,84,0.55); }
          70%  { box-shadow: 0 0 0 14px rgba(15,123,84,0); }
          100% { box-shadow: 0 0 0 0 rgba(15,123,84,0); }
        }
        @keyframes ems-pulse-red {
          0%   { box-shadow: 0 0 0 0 rgba(217,45,32,0.55); }
          70%  { box-shadow: 0 0 0 14px rgba(217,45,32,0); }
          100% { box-shadow: 0 0 0 0 rgba(217,45,32,0); }
        }
      `}</style>
      <header style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div
          aria-hidden
          style={{
            width: 38,
            height: 38,
            borderRadius: 8,
            background: COLORS.red,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
            fontWeight: TYPO.fw.extra,
            boxShadow: "0 2px 6px rgba(217,45,32,0.45)",
            letterSpacing: 0.5,
          }}
        >
          119
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h1
            style={{
              margin: 0,
              fontSize: TYPO.fs.xl,
              fontWeight: TYPO.fw.bold,
              lineHeight: TYPO.lh.tight,
              letterSpacing: -0.2,
            }}
          >
            119 상황실 콘솔
          </h1>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 6,
              fontSize: TYPO.fs.sm,
              color: COLORS.onDarkMuted,
              flexWrap: "wrap",
            }}
          >
            <SessionDot active={sessionEnd == null} />
            <span style={{ color: COLORS.onDark }}>
              {sessionEnd == null ? "세션 진행 중" : "세션 종료"}
            </span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>
              세션 ID <code style={{ color: COLORS.onDark }}>{sessionId.slice(0, 8)}</code>
            </span>
            {statusMsg ? (
              <>
                <span style={{ opacity: 0.5 }}>·</span>
                <span>{statusMsg}</span>
              </>
            ) : null}
          </div>
        </div>
      </header>

      {/* 상단: 언어 + 새 신고 + 내보내기/요약 */}
      <div style={{ ...whiteCard, padding: 16 }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 240 }}>
            <label
              style={{
                fontSize: TYPO.fs.xs,
                color: COLORS.inkMuted,
                fontWeight: TYPO.fw.semibold,
                letterSpacing: 0.4,
                textTransform: "uppercase",
              }}
            >
              신고자 언어
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <select
                value={manualCallerLang ?? ""}
                onChange={(e) => handleManualLangChange(e.target.value)}
                style={langSelect}
                aria-label="신고자 언어 선택"
              >
                <option value="">자동 감지</option>
                {callerLangOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span style={langModeBadge(isLangLocked())}>
                <span aria-hidden style={{ marginRight: 4 }}>
                  {isLangLocked() ? "🔒" : "🔄"}
                </span>
                {isLangLocked() ? "수동 고정" : "자동"} · {langDisplay}
              </span>
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {sessionEnd == null ? (
              <button
                onClick={handleEndCall}
                disabled={log.length === 0}
                style={log.length === 0 ? endCallDisabledBtn : endCallBtn}
              >
                ⏹ 통화 종료 / 기록 저장
              </button>
            ) : (
              <span style={endedBadge}>
                <span aria-hidden style={{ marginRight: 4 }}>✅</span>
                종료됨 · {new Date(sessionEnd).toLocaleTimeString()}
              </span>
            )}
            <button onClick={handleNewCall} style={secondaryBtn}>
              새 신고 시작
            </button>
          </div>
        </div>
        {/* 내보내기 + 요약 액션 영역 — 대화가 있을 때 항상 노출. */}
        {log.length > 0 ? (
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
              marginTop: 14,
              paddingTop: 14,
              borderTop: `1px solid ${COLORS.cardBorder}`,
            }}
          >
            <button
              onClick={() => void handleSummarize()}
              disabled={summarizing}
              style={summarizing ? exportPrimaryDisabledBtn : exportPrimaryBtn}
            >
              {summarizing ? (
                <>
                  <Spinner />
                  요약 생성 중...
                </>
              ) : summary ? (
                "🧠 요약 다시 생성"
              ) : (
                "🧠 신고 내용 요약 생성"
              )}
            </button>
            <span style={{ flex: 1 }} />
            <span
              style={{
                fontSize: TYPO.fs.xs,
                color: COLORS.inkMuted,
                fontWeight: TYPO.fw.semibold,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                marginRight: 4,
              }}
            >
              기록 내보내기
            </span>
            <button onClick={handleDownloadTxt} style={exportBtn}>
              TXT
            </button>
            <button onClick={handleDownloadJson} style={exportBtn}>
              JSON
            </button>
            <button onClick={handleGoToResult} style={exportBtn}>
              사건 기록 문서
            </button>
          </div>
        ) : null}
      </div>

      {/* 요약 카드 — 생성됐을 때만 노출. */}
      {(summary || summaryError) && (
        <SummaryPanel
          summary={summary}
          error={summaryError}
          loading={summarizing}
          onRetry={() => void handleSummarize()}
        />
      )}

      {/* 대화 로그 */}
      <div style={{ ...whiteCard, padding: 16, flex: 1, minHeight: 360, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <h2 style={{ ...sectionHeading, margin: 0 }}>대화 로그</h2>
          <span
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: 10,
              fontSize: TYPO.fs.xs,
              color: COLORS.inkMuted,
              fontWeight: TYPO.fw.semibold,
              letterSpacing: 0.3,
              textTransform: "uppercase",
            }}
          >
            <LegendDot color={COLORS.caller} label="신고자" />
            <LegendDot color={COLORS.operator} label="상황실" />
          </span>
        </div>
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            paddingRight: 4,
          }}
        >
          {log.length === 0 ? (
            <div
              style={{
                color: COLORS.inkMuted,
                fontSize: TYPO.fs.sm,
                padding: "16px 12px",
                textAlign: "center",
                border: `1px dashed ${COLORS.cardBorder}`,
                borderRadius: 10,
                lineHeight: TYPO.lh.normal,
              }}
            >
              아직 발화가 없습니다. 신고자 시뮬레이터에서 마이크를 시작해 음성을 입력하세요.
            </div>
          ) : (
            log.map((entry, idx) => {
              const isLast = idx === log.length - 1;
              return entry.role === "caller" ? (
                <CallerBubble
                  key={`c-${entry.seq}`}
                  entry={entry}
                  isLast={isLast}
                  onPlay={playCallerOriginal}
                />
              ) : (
                <OperatorBubble
                  key={`o-${entry.seq}`}
                  entry={entry}
                  isLast={isLast}
                />
              );
            })
          )}
          <div ref={logEndRef} />
        </div>
      </div>

      {/* 자주 쓰는 문구 + 입력창 */}
      <div style={{ ...whiteCard, padding: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <span
            style={{
              fontSize: TYPO.fs.xs,
              color: COLORS.inkMuted,
              fontWeight: TYPO.fw.semibold,
              letterSpacing: 0.4,
              textTransform: "uppercase",
            }}
          >
            자주 쓰는 문구
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {QUICK_PHRASES.map((p) => (
            <button key={p} onClick={() => handleQuickPhrase(p)} style={quickBtn}>
              {p}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="한국어로 입력 (Enter 전송, Shift+Enter 줄바꿈)"
            rows={2}
            style={textArea}
            disabled={sending}
          />
          <button
            onClick={() => void handleSend()}
            disabled={sending}
            style={sending ? { ...primaryBtn, opacity: 0.7, cursor: "not-allowed" } : primaryBtn}
          >
            {sending ? (
              <>
                <Spinner color="#fff" />
                전송 중...
              </>
            ) : (
              "전송 ▶"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 신고자 발화 — 좌측 정렬. 적색 강조 좌측 보더 + 캘러 아이콘 + 위치(좌)+색+라벨 3중 단서로 발화자 식별.
 * 한국어 번역(요원이 실제로 읽는 것)을 가장 크게, 원문은 보조 정보로.
 */
function CallerBubble({
  entry,
  isLast,
  onPlay,
}: {
  entry: CallerLogEntry;
  isLast: boolean;
  onPlay: (b64: string) => void;
}) {
  const lowConfidence =
    typeof entry.speakerConfidence === "number" &&
    entry.speakerConfidence < LOW_CONFIDENCE_THR;
  return (
    <div style={{ alignSelf: "flex-start", maxWidth: "82%", width: "82%" }}>
      <div
        style={{
          fontSize: TYPO.fs.xs,
          color: COLORS.inkMuted,
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            color: COLORS.caller,
            fontWeight: TYPO.fw.bold,
            letterSpacing: 0.3,
          }}
        >
          🆘 신고자
        </span>
        <span aria-hidden style={{ opacity: 0.5 }}>·</span>
        <span>{languageLabel(entry.lang)}</span>
        <span aria-hidden style={{ opacity: 0.5 }}>·</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {new Date(entry.ts).toLocaleTimeString()}
        </span>
        {entry.corrected ? <CorrectedBadge /> : null}
        {lowConfidence ? (
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 999,
              background: COLORS.redSoft,
              color: COLORS.redDark,
              border: `1px solid ${COLORS.red}`,
              fontWeight: TYPO.fw.semibold,
              fontSize: TYPO.fs.xs,
            }}
          >
            ⚠ 신뢰도 낮음
          </span>
        ) : null}
      </div>
      <div
        style={{
          padding: 14,
          borderRadius: 12,
          background: "#fff",
          borderLeft: `4px solid ${COLORS.caller}`,
          border: `1px solid ${COLORS.cardBorder}`,
          borderLeftWidth: 4,
          color: COLORS.ink,
          boxShadow: isLast ? `0 0 0 3px ${COLORS.callerSoft}` : undefined,
        }}
      >
        {/* 1. 한국어 번역 — 요원이 실제로 읽는 텍스트. 가장 크게/굵게. */}
        <div
          style={{
            fontSize: TYPO.fs.lg,
            fontWeight: TYPO.fw.semibold,
            lineHeight: TYPO.lh.normal,
            color: COLORS.ink,
          }}
        >
          {entry.translatedKo || (
            <span style={{ color: COLORS.inkMuted, fontWeight: TYPO.fw.normal }}>
              (번역 없음)
            </span>
          )}
        </div>

        {/* 2. 원문 — 보조 정보. 흐리게, 작게. */}
        <div
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: `1px dashed ${COLORS.cardBorder}`,
            display: "flex",
            gap: 6,
            alignItems: "flex-start",
          }}
        >
          <span
            style={{
              fontSize: TYPO.fs.xs,
              color: COLORS.inkMuted,
              fontWeight: TYPO.fw.semibold,
              letterSpacing: 0.3,
              textTransform: "uppercase",
              flex: "0 0 auto",
              marginTop: 1,
            }}
          >
            원문
          </span>
          <span
            style={{
              fontSize: TYPO.fs.sm,
              color: COLORS.inkSoft,
              lineHeight: TYPO.lh.normal,
            }}
          >
            {entry.text || "(빈 발화)"}
          </span>
        </div>

        {entry.callerAudioBase64 ? (
          <button
            onClick={() => onPlay(entry.callerAudioBase64!)}
            style={{
              marginTop: 10,
              padding: "5px 12px",
              fontSize: TYPO.fs.xs,
              border: `1px solid ${COLORS.caller}`,
              background: "#fff",
              color: COLORS.caller,
              borderRadius: 6,
              cursor: "pointer",
              fontWeight: TYPO.fw.semibold,
            }}
          >
            ▶ 원음 재생
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 상황실 메시지 — 우측 정렬. 네이비 강조 보더. 한국어가 원문이므로 한국어를 크게.
 */
function OperatorBubble({
  entry,
  isLast,
}: {
  entry: OperatorLogEntry;
  isLast: boolean;
}) {
  const isProcessing = entry.status === "translating";
  const isError = entry.status === "error";
  return (
    <div style={{ alignSelf: "flex-end", maxWidth: "82%", width: "82%" }}>
      <div
        style={{
          fontSize: TYPO.fs.xs,
          color: COLORS.inkMuted,
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          justifyContent: "flex-end",
        }}
      >
        <span
          style={{
            color: COLORS.operator,
            fontWeight: TYPO.fw.bold,
            letterSpacing: 0.3,
          }}
        >
          🚑 상황실 → {languageLabel(entry.targetLang)}
        </span>
        <span aria-hidden style={{ opacity: 0.5 }}>·</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {new Date(entry.ts).toLocaleTimeString()}
        </span>
        {isProcessing ? <StatusChip kind="processing" label="번역 중" /> : null}
        {entry.status === "sent" ? <StatusChip kind="ok" label="전송됨" /> : null}
        {isError ? <StatusChip kind="error" label="오류" /> : null}
      </div>
      <div
        style={{
          padding: 14,
          borderRadius: 12,
          background: "#fff",
          borderRight: `4px solid ${COLORS.operator}`,
          border: `1px solid ${COLORS.cardBorder}`,
          borderRightWidth: 4,
          color: COLORS.ink,
          boxShadow: isLast ? `0 0 0 3px ${COLORS.operatorSoft}` : undefined,
        }}
      >
        {/* 한국어 원문 — 요원이 입력한 것. 메인. */}
        <div
          style={{
            fontSize: TYPO.fs.lg,
            fontWeight: TYPO.fw.semibold,
            lineHeight: TYPO.lh.normal,
            color: COLORS.ink,
          }}
        >
          {entry.textKo}
        </div>

        {/* 번역 결과 — 보조 정보. */}
        <div
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: `1px dashed ${COLORS.cardBorder}`,
            display: "flex",
            gap: 6,
            alignItems: "flex-start",
          }}
        >
          <span
            style={{
              fontSize: TYPO.fs.xs,
              color: COLORS.inkMuted,
              fontWeight: TYPO.fw.semibold,
              letterSpacing: 0.3,
              textTransform: "uppercase",
              flex: "0 0 auto",
              marginTop: 1,
            }}
          >
            {languageLabel(entry.targetLang)} 번역
          </span>
          <span
            style={{
              fontSize: TYPO.fs.sm,
              color: COLORS.inkSoft,
              lineHeight: TYPO.lh.normal,
            }}
          >
            {isProcessing ? (
              <span style={{ color: COLORS.amber, display: "inline-flex", alignItems: "center" }}>
                <Spinner color={COLORS.amber} />
                번역 + TTS 처리 중...
              </span>
            ) : isError ? (
              <span style={{ color: COLORS.red }}>{entry.error}</span>
            ) : (
              entry.translated || (
                <span style={{ color: COLORS.inkMuted }}>(빈 번역)</span>
              )
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/** 메타 라인용 작은 범례 dot. */
function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
          display: "inline-block",
        }}
      />
      {label}
    </span>
  );
}

/** 정정됨 배지 — 글자만이 아니라 알약 칩으로 강조. */
function CorrectedBadge() {
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 999,
        background: COLORS.amberSoft,
        color: "#7c3a00",
        border: `1px solid ${COLORS.amber}`,
        fontWeight: TYPO.fw.bold,
        fontSize: TYPO.fs.xs,
        letterSpacing: 0.3,
      }}
      title="신고자가 다시 말하기로 발화를 덮어썼습니다"
    >
      ✏️ 정정됨
    </span>
  );
}

/** 상태 칩 — processing/ok/error. STATUS_COLOR 토큰 사용. */
function StatusChip({
  kind,
  label,
}: {
  kind: "processing" | "ok" | "error";
  label: string;
}) {
  const tone = STATUS_COLOR[kind];
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 999,
        background: tone.bg,
        color: tone.fg,
        fontSize: TYPO.fs.xs,
        fontWeight: TYPO.fw.bold,
        letterSpacing: 0.3,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: tone.dot,
          display: "inline-block",
        }}
      />
      {label}
    </span>
  );
}

// ---- 작은 표현용 헬퍼 ----

/** 세션 진행 중일 때만 녹색 펄스. 종료되면 회색. 색만이 아니라 라벨 옆에서만 사용. */
function SessionDot({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: active ? STATUS_COLOR.live.dot : STATUS_COLOR.idle.dot,
        boxShadow: active
          ? `0 0 0 4px rgba(15,123,84,0.25)`
          : "none",
        display: "inline-block",
        flex: "0 0 auto",
      }}
    />
  );
}

/** inline 스피너 — 번역/요약 중 표시. */
function Spinner({ size = 12, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        border: `2px solid ${color}`,
        borderTopColor: "transparent",
        borderRadius: "50%",
        display: "inline-block",
        animation: "ems-spin 0.7s linear infinite",
        marginRight: 6,
        verticalAlign: -1,
      }}
    />
  );
}

function langModeBadge(locked: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    background: locked ? COLORS.navySoft : COLORS.greenSoft,
    color: locked ? COLORS.navyDark : "#0f5132",
    border: `1px solid ${locked ? COLORS.navy : COLORS.green}`,
    fontSize: TYPO.fs.xs,
    fontWeight: TYPO.fw.semibold,
    display: "inline-flex",
    alignItems: "center",
    whiteSpace: "nowrap",
  };
}

// ---- styles ----

const primaryBtn: React.CSSProperties = {
  padding: "12px 22px",
  background: COLORS.red,
  color: "#fff",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: TYPO.fw.bold,
  fontSize: TYPO.fs.base,
  boxShadow: "0 2px 6px rgba(217,45,32,0.35)",
};
const secondaryBtn: React.CSSProperties = {
  padding: "10px 16px",
  background: "#fff",
  color: COLORS.navy,
  border: `1px solid ${COLORS.navy}`,
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: TYPO.fw.semibold,
  fontSize: TYPO.fs.sm,
};
const endCallBtn: React.CSSProperties = {
  padding: "10px 18px",
  background: COLORS.red,
  color: "#fff",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: TYPO.fw.bold,
  fontSize: TYPO.fs.sm,
  boxShadow: "0 2px 6px rgba(217,45,32,0.35)",
};
const endCallDisabledBtn: React.CSSProperties = {
  ...endCallBtn,
  background: "#cbd5e1",
  color: "#64748b",
  cursor: "not-allowed",
  boxShadow: "none",
};
const endedBadge: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 999,
  background: COLORS.greenSoft,
  color: "#0f5132",
  border: `1px solid ${COLORS.green}`,
  fontSize: TYPO.fs.sm,
  fontWeight: TYPO.fw.semibold,
  alignSelf: "center",
  whiteSpace: "nowrap",
};
const exportBtn: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: TYPO.fs.sm,
  background: "#fff",
  color: COLORS.navy,
  border: `1px solid ${COLORS.navy}`,
  borderRadius: 6,
  cursor: "pointer",
  fontWeight: TYPO.fw.semibold,
};
const exportPrimaryBtn: React.CSSProperties = {
  ...exportBtn,
  background: COLORS.navy,
  color: "#fff",
  padding: "9px 16px",
  display: "inline-flex",
  alignItems: "center",
};
const exportPrimaryDisabledBtn: React.CSSProperties = {
  ...exportPrimaryBtn,
  background: "#94a3b8",
  borderColor: "#94a3b8",
  cursor: "not-allowed",
};

// ---- Summary panel ----

function SummaryPanel({
  summary,
  error,
  loading,
  onRetry,
}: {
  summary: CallSummary | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}) {
  if (error && !summary) {
    return (
      <div
        style={{
          ...whiteCard,
          padding: 16,
          borderLeft: `4px solid ${COLORS.red}`,
        }}
      >
        <div style={{ ...sectionHeading, marginBottom: 8 }}>신고 내용 요약</div>
        <div style={{ color: COLORS.red, fontSize: TYPO.fs.sm, marginBottom: 8 }}>
          요약 생성에 실패했습니다: {error}
        </div>
        <button onClick={onRetry} disabled={loading} style={exportPrimaryBtn}>
          {loading ? (
            <>
              <Spinner />
              재시도 중...
            </>
          ) : (
            "다시 시도"
          )}
        </button>
      </div>
    );
  }
  if (!summary) return null;

  const incidentTone = INCIDENT_COLOR[summary.incidentType] ?? INCIDENT_COLOR["미상"];
  const urgencyTone = URGENCY_COLOR[summary.urgency] ?? URGENCY_COLOR["미상"];

  return (
    <div
      style={{
        ...whiteCard,
        padding: 18,
        // 긴급도가 "높음" 이면 카드 좌측 적색 강조 — 글랜스 시 즉시 인지.
        borderLeft:
          summary.urgency === "높음" ? `6px solid ${COLORS.red}` : undefined,
      }}
    >
      {/* 헤더 — 요약 라벨 + 보조 안내 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <span
          style={{
            fontSize: TYPO.fs.lg,
            fontWeight: TYPO.fw.extra,
            color: COLORS.ink,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span aria-hidden>🧠</span> 신고 내용 요약
        </span>
        <span
          style={{
            fontSize: TYPO.fs.xs,
            color: COLORS.inkMuted,
            fontWeight: TYPO.fw.normal,
            marginLeft: "auto",
          }}
        >
          LLM 자동 생성 — 검토 후 사용하세요
        </span>
      </div>

      {/* 글랜서블 배지 라인 — 사고유형 + 긴급도. 의미 색 + 라벨. */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 14,
          alignItems: "center",
        }}
      >
        <span
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            background: incidentTone.bg,
            color: incidentTone.fg,
            fontSize: TYPO.fs.sm,
            fontWeight: TYPO.fw.bold,
            letterSpacing: 0.3,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
          aria-label={`사고 유형: ${summary.incidentType}`}
        >
          <span aria-hidden>🚨</span>
          사고 유형 · {summary.incidentType}
        </span>
        <span
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            background: urgencyTone.bg,
            color: urgencyTone.fg,
            border: `1px solid ${urgencyTone.border}`,
            fontSize: TYPO.fs.sm,
            fontWeight: TYPO.fw.bold,
            letterSpacing: 0.3,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
          aria-label={`긴급도: ${summary.urgency}`}
        >
          <span aria-hidden>⏱</span>
          긴급도 · {summary.urgency}
        </span>
      </div>

      {/* 본문 요약 — 가장 크게 */}
      <div
        style={{
          padding: 14,
          borderRadius: 10,
          background: COLORS.track,
          color: COLORS.ink,
          fontSize: TYPO.fs.md,
          lineHeight: TYPO.lh.relaxed,
          marginBottom: 14,
        }}
      >
        {summary.summary}
      </div>

      {/* 위치 / 환자 / 조치 — 카드 그리드 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 10,
        }}
      >
        <SummaryField label="📍 위치 / 주소" value={summary.location} />
        <SummaryField label="🩺 환자 / 피해자 상태" value={summary.patientState} />
        <SummaryField label="✅ 필요 조치" value={summary.actions} fullWidth />
      </div>

      {summary.inferences.length > 0 && (
        <div
          style={{
            marginTop: 14,
            padding: 12,
            borderRadius: 10,
            background: COLORS.amberSoft,
            border: `1px solid ${COLORS.amber}`,
          }}
        >
          <div
            style={{
              fontSize: TYPO.fs.xs,
              fontWeight: TYPO.fw.bold,
              color: "#7c3a00",
              marginBottom: 6,
              letterSpacing: 0.3,
              textTransform: "uppercase",
            }}
          >
            ⚠ 추정 항목 — 대화에 명시되지 않아 추론한 내용입니다
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              color: COLORS.ink,
              fontSize: TYPO.fs.sm,
              lineHeight: TYPO.lh.normal,
            }}
          >
            {summary.inferences.map((s, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 10, color: COLORS.red, fontSize: TYPO.fs.xs }}>
          최근 재생성 실패: {error}
        </div>
      )}
    </div>
  );
}

function SummaryField({
  label,
  value,
  fullWidth,
}: {
  label: string;
  value: string;
  fullWidth?: boolean;
}) {
  return (
    <div
      style={{
        gridColumn: fullWidth ? "1 / -1" : undefined,
        padding: 12,
        border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: 10,
        background: "#fff",
      }}
    >
      <div
        style={{
          fontSize: TYPO.fs.xs,
          color: COLORS.inkMuted,
          fontWeight: TYPO.fw.semibold,
          marginBottom: 6,
          letterSpacing: 0.4,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          color: COLORS.ink,
          fontSize: TYPO.fs.base,
          lineHeight: TYPO.lh.normal,
          fontWeight: TYPO.fw.medium,
        }}
      >
        {value || "정보 없음"}
      </div>
    </div>
  );
}
const quickBtn: React.CSSProperties = {
  padding: "7px 14px",
  fontSize: TYPO.fs.sm,
  background: "#fff",
  color: COLORS.navy,
  border: `1px solid ${COLORS.navy}`,
  borderRadius: 999,
  cursor: "pointer",
  fontWeight: TYPO.fw.medium,
};
const langSelect: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: TYPO.fs.base,
  border: `1px solid ${COLORS.cardBorder}`,
  borderRadius: 8,
  background: "#fff",
  color: COLORS.ink,
  fontWeight: TYPO.fw.medium,
  minWidth: 140,
};
const textArea: React.CSSProperties = {
  flex: 1,
  padding: 12,
  fontSize: TYPO.fs.base,
  borderRadius: 8,
  border: `1px solid ${COLORS.cardBorder}`,
  fontFamily: "inherit",
  lineHeight: TYPO.lh.normal,
  resize: "vertical",
  color: COLORS.ink,
};
