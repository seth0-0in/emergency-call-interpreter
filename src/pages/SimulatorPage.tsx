// ============================================================================
// 신고자 시뮬레이터 (`/simulator`).
//
// 실 전화망 연동 전 데모/테스트용. 같은 머신에서 콘솔(`/console`) 과 함께
// 띄워, 마이크로 신고자 음성을 흘려보내고 콘솔에서 보낸 한국어 응답을 신고자
// 언어로 번역+TTS 받아 스피커로 재생한다.
//
// 0단계 결정에 따라 오디오 입출력만 분리해두면 향후 실 전화망(SIP/WebRTC) 으로
// 통째로 교체 가능. 현재는 BroadcastChannel 로 콘솔과 통신.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { COLORS, whiteCard, TYPO, STATUS_COLOR } from "../theme";
import {
  SessionChannel,
  getOrCreateSessionId,
  resetSessionId,
  type SessionMessage,
} from "../realtime/session";
import {
  processCallerChunk,
  decodeBase64Audio,
  blobToBase64,
  type ServerProcessEnvelope,
} from "../realtime/processCallerChunk";
import { startVadMic, type VadMicHandle } from "../realtime/vadMic";
import { languageLabel } from "../languages";

type CallerLine = {
  seq: number;
  text: string;
  lang: string;
  status: "listening" | "stt" | "done" | "skipped" | "error";
  ts: number;
  error?: string;
};

export default function SimulatorPage() {
  const [sessionId, setSessionId] = useState<string>(() => getOrCreateSessionId());
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("대기 중");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [callerLog, setCallerLog] = useState<CallerLine[]>([]);
  const [lastCallerLang, setLastCallerLang] = useState<string | null>(null);
  const [manualLanguageLock, setManualLanguageLock] = useState<string | null>(null);
  // retakeSeq: "다시 말하기" 가 잡혀 있는 발화 seq. null 이면 다음 발화를 새 항목으로 push,
  // 값이 있으면 다음 발화 결과로 그 seq 항목을 덮어쓰고 콘솔에도 같은 seq + isRetake=true 로 재전송.
  const [retakeSeq, setRetakeSeq] = useState<number | null>(null);

  const channelRef = useRef<SessionChannel | null>(null);
  const vadRef = useRef<VadMicHandle | null>(null);
  const seqRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  const lastCallerLangRef = useRef<string | null>(null);
  const manualLockRef = useRef<string | null>(null);
  const retakeSeqRef = useRef<number | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioQueueRef = useRef<string[]>([]); // pending mp3 blob URLs
  const isPlayingRef = useRef(false);

  // ----- channel -----
  useEffect(() => {
    const ch = new SessionChannel();
    channelRef.current = ch;
    const off = ch.on(handleChannelMessage);
    // 새 세션 알림 (콘솔이 켜져 있으면 같은 sessionId 로 동기화).
    ch.send({ kind: "session-start", sessionId: sessionIdRef.current, ts: Date.now() });
    return () => {
      off();
      ch.close();
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleChannelMessage(msg: SessionMessage) {
    if (msg.sessionId !== sessionIdRef.current) {
      // 콘솔이 새 세션을 시작했으면 시뮬레이터도 따라간다.
      if (msg.kind === "session-reset" || msg.kind === "session-start") {
        sessionIdRef.current = msg.sessionId;
        setSessionId(msg.sessionId);
        setCallerLog([]);
        setLastCallerLang(null);
        lastCallerLangRef.current = null;
        seqRef.current = 0;
        retakeSeqRef.current = null;
        setRetakeSeq(null);
      } else {
        return;
      }
    }
    if (msg.kind === "operator-reply") {
      enqueueReplyAudio(msg.audioBase64);
    } else if (msg.kind === "lang-lock") {
      // 콘솔이 보낸 자동 확정 또는 수동 고정. 둘 다 다음 STT 호출의 language hint 로
      // 같이 쓰이고, 잠긴 이후엔 envelope.source_language 가 다른 값으로 와도
      // 시뮬레이터 측 라벨/표시가 흔들리지 않게 lastCallerLang 도 동기시킨다.
      // lang === null 은 콘솔이 "자동 감지로 복귀" 한 경우 — manual lock 만 해제하고
      // lastCallerLang 은 이미 본 값을 유지(다음 자동 판별이 들어오면 envelope 이 갱신).
      if (msg.lang === null) {
        manualLockRef.current = null;
        setManualLanguageLock(null);
      } else {
        manualLockRef.current = msg.lang;
        setManualLanguageLock(msg.lang);
        lastCallerLangRef.current = msg.lang;
        setLastCallerLang(msg.lang);
      }
    } else if (msg.kind === "session-reset") {
      setCallerLog([]);
      setLastCallerLang(null);
      lastCallerLangRef.current = null;
      seqRef.current = 0;
      retakeSeqRef.current = null;
      setRetakeSeq(null);
    }
  }

  // ----- mic / VAD -----
  async function handleStart() {
    if (running) return;
    setStatus("마이크 시작 중...");
    try {
      const vad = await startVadMic({
        onSpeechStart: () => setIsSpeaking(true),
        onSpeechEnd: () => setIsSpeaking(false),
        onMisfire: () => {
          setStatus("짧은 잡음으로 폐기");
        },
        onUtterance: (wav) => {
          void processUtterance(wav);
        },
      });
      vadRef.current = vad;
      setRunning(true);
      setStatus("듣는 중");
    } catch (e) {
      setStatus(`마이크 시작 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function handleStop() {
    vadRef.current?.stop();
    vadRef.current = null;
    setRunning(false);
    setStatus("대기 중");
    setIsSpeaking(false);
  }

  function handleNewCall() {
    handleStop();
    const newSid = resetSessionId();
    sessionIdRef.current = newSid;
    setSessionId(newSid);
    setCallerLog([]);
    setLastCallerLang(null);
    lastCallerLangRef.current = null;
    seqRef.current = 0;
    retakeSeqRef.current = null;
    setRetakeSeq(null);
    setStatus("새 신고 — 시작 버튼을 눌러 마이크 시작");
    channelRef.current?.send({
      kind: "session-reset",
      sessionId: newSid,
    });
    channelRef.current?.send({
      kind: "session-start",
      sessionId: newSid,
      ts: Date.now(),
    });
  }

  useEffect(() => {
    return () => {
      vadRef.current?.stop();
      vadRef.current = null;
    };
  }, []);

  // ----- 한 발화 처리 -----
  async function processUtterance(wav: Blob) {
    // retake 모드: 잡혀 있는 seq 가 있으면 그 항목을 덮어쓰고, 콘솔에도 같은 seq 로 재전송.
    // 새 발화 진입 시점에 한 번 캡처해 두고 이후 즉시 풀어, 다음 발화는 다시 새 항목으로 처리.
    const retakingSeq = retakeSeqRef.current;
    retakeSeqRef.current = null;
    setRetakeSeq(null);
    const isRetake = retakingSeq !== null;
    const seq = isRetake ? retakingSeq : ++seqRef.current;
    const ts = Date.now();

    if (isRetake) {
      setCallerLog((prev) =>
        prev.map((l) =>
          l.seq === seq
            ? { ...l, status: "stt", text: "", error: undefined, ts }
            : l
        )
      );
      setStatus(`발화 #${seq} 다시 처리 중...`);
    } else {
      const placeholder: CallerLine = {
        seq,
        text: "",
        lang: lastCallerLangRef.current ?? "unknown",
        status: "stt",
        ts,
      };
      setCallerLog((prev) => [...prev, placeholder]);
      setStatus(`발화 #${seq} 처리 중...`);
    }

    let envelope: ServerProcessEnvelope;
    try {
      envelope = await processCallerChunk({
        blob: wav,
        sessionId: sessionIdRef.current,
        clientSeq: seq,
        previousCallerLanguage: lastCallerLangRef.current,
        manualLanguageLock: manualLockRef.current,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCallerLog((prev) =>
        prev.map((l) =>
          l.seq === seq ? { ...l, status: "error", error: msg } : l
        )
      );
      setStatus(`발화 #${seq} 실패: ${msg}`);
      return;
    }

    if (envelope.status !== "ok") {
      setCallerLog((prev) =>
        prev.map((l) =>
          l.seq === seq
            ? {
                ...l,
                status: envelope.status === "skipped" ? "skipped" : "error",
                error: envelope.reason ?? envelope.error ?? undefined,
              }
            : l
        )
      );
      setStatus(
        envelope.status === "skipped"
          ? `발화 #${seq} 무시됨 (${envelope.reason ?? "skipped"})`
          : `발화 #${seq} 오류 (${envelope.error ?? "error"})`
      );
      return;
    }

    // 신고자 발화로 잡혔을 때만 콘솔로 전달 (operator/interpreter 는 시뮬레이터에서 폐기).
    // 콘솔에서 잠금(lang-lock) 이 떨어져 있으면 envelope.source_language 가 다른 코드로
    // 와도 잠긴 lang 으로 라벨링/저장한다 (단일 발화 STT 오인식이 라벨을 뒤집지 못하게).
    const lockedLang = manualLockRef.current;
    const envLang = envelope.source_language || "unknown";
    const lang = lockedLang || envLang;
    setCallerLog((prev) =>
      prev.map((l) =>
        l.seq === seq
          ? { ...l, text: envelope.text, lang, status: "done" }
          : l
      )
    );
    if (!lockedLang) {
      // 잠금 전에만 envelope 의 lang 으로 ref 를 갱신해 다음 STT 호출의 hint 로 흘려보낸다.
      lastCallerLangRef.current = envLang;
      setLastCallerLang(envLang);
    }
    setStatus(isRetake ? `발화 #${seq} 정정 전송` : `발화 #${seq} 전송 완료`);

    if (envelope.speaker !== "caller") {
      // 시뮬레이터 마이크는 신고자 1명만 가정 — operator 로 분류됐다면 백엔드 휴리스틱
      // 오판으로 보고 그대로 caller 로 콘솔에 전달한다.
    }

    let callerAudioBase64: string | undefined;
    try {
      callerAudioBase64 = await blobToBase64(wav);
    } catch {
      callerAudioBase64 = undefined;
    }

    channelRef.current?.send({
      kind: "caller-utterance",
      sessionId: sessionIdRef.current,
      seq,
      ts,
      lang,
      text: envelope.text,
      translatedKo: envelope.translated,
      speakerConfidence: envelope.speaker_confidence,
      callerAudioBase64,
      isRetake,
    });
  }

  // ----- 다시 말하기 토글 -----
  function handleRetakeToggle(seq: number) {
    if (retakeSeqRef.current === seq) {
      retakeSeqRef.current = null;
      setRetakeSeq(null);
      setStatus(running ? "듣는 중" : "대기 중");
      return;
    }
    retakeSeqRef.current = seq;
    setRetakeSeq(seq);
    setStatus(
      running
        ? `발화 #${seq} 다시 말해주세요 — 그대로 말씀하시면 됩니다`
        : `발화 #${seq} 재녹음 대기 — 먼저 마이크를 시작하세요`
    );
  }

  // ----- 콘솔 응답 오디오 재생 큐 -----
  function enqueueReplyAudio(b64: string) {
    try {
      const blob = decodeBase64Audio(b64, "audio/mpeg");
      const url = URL.createObjectURL(blob);
      audioQueueRef.current.push(url);
      drainAudio();
    } catch (e) {
      // mp3 decode 실패 — 무시.
      console.warn("operator-reply audio decode failed", e);
    }
  }

  function drainAudio() {
    if (isPlayingRef.current) return;
    const next = audioQueueRef.current.shift();
    if (!next) return;
    isPlayingRef.current = true;
    let el = audioElRef.current;
    if (!el) {
      el = new Audio();
      audioElRef.current = el;
    }
    el.src = next;
    const cleanup = () => {
      isPlayingRef.current = false;
      try {
        URL.revokeObjectURL(next);
      } catch {
        // 무시.
      }
      drainAudio();
    };
    el.onended = cleanup;
    el.onerror = cleanup;
    el.play().catch(cleanup);
  }

  // ----- 렌더링 -----
  // 마이크 상태 — 3가지 시각화: 말하는 중(적색 펄스), 듣는 중(녹색 펄스), 정지(회색).
  const micState: "speaking" | "listening" | "idle" = isSpeaking
    ? "speaking"
    : running
    ? "listening"
    : "idle";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: COLORS.pageBg,
        color: "#fff",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {/* 공용 keyframes — 마이크 펄스 + spinner. */}
      <style>{`
        @keyframes ems-sim-spin { to { transform: rotate(360deg); } }
        @keyframes ems-sim-pulse-green {
          0%   { box-shadow: 0 0 0 0 rgba(15,123,84,0.55); }
          70%  { box-shadow: 0 0 0 18px rgba(15,123,84,0); }
          100% { box-shadow: 0 0 0 0 rgba(15,123,84,0); }
        }
        @keyframes ems-sim-pulse-red {
          0%   { box-shadow: 0 0 0 0 rgba(217,45,32,0.65); }
          70%  { box-shadow: 0 0 0 22px rgba(217,45,32,0); }
          100% { box-shadow: 0 0 0 0 rgba(217,45,32,0); }
        }
      `}</style>

      <header style={{ marginBottom: 16 }}>
        <h1
          style={{
            margin: 0,
            fontSize: TYPO.fs.xl,
            fontWeight: TYPO.fw.bold,
            lineHeight: TYPO.lh.tight,
          }}
        >
          신고자 시뮬레이터{" "}
          <span style={{ opacity: 0.55, fontSize: TYPO.fs.sm, fontWeight: TYPO.fw.normal }}>
            (데모 / 테스트용)
          </span>
        </h1>
        <div
          style={{
            marginTop: 6,
            fontSize: TYPO.fs.sm,
            color: COLORS.onDarkMuted,
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span>
            세션 ID <code style={{ color: COLORS.onDark }}>{sessionId.slice(0, 8)}</code>
          </span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span>상태: <span style={{ color: COLORS.onDark }}>{status}</span></span>
        </div>
      </header>

      <div style={{ ...whiteCard, padding: 18, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          {/* 큰 마이크 상태 인디케이터 — 글랜스 가능. */}
          <MicIndicator state={micState} />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!running ? (
              <button onClick={handleStart} style={primaryBtn}>
                🎤 마이크 시작
              </button>
            ) : (
              <button onClick={handleStop} style={dangerBtn}>
                ⏹ 마이크 정지
              </button>
            )}
            <button onClick={handleNewCall} style={secondaryBtn}>
              새 신고 시작
            </button>
          </div>

          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 2,
              fontSize: TYPO.fs.xs,
            }}
          >
            <span
              style={{
                color: COLORS.inkMuted,
                fontWeight: TYPO.fw.semibold,
                letterSpacing: 0.3,
                textTransform: "uppercase",
              }}
            >
              감지된 신고자 언어
            </span>
            <strong
              style={{
                color: COLORS.ink,
                fontSize: TYPO.fs.base,
                fontWeight: TYPO.fw.bold,
              }}
            >
              {manualLanguageLock
                ? `${languageLabel(manualLanguageLock)} 🔒`
                : lastCallerLang
                ? languageLabel(lastCallerLang)
                : "아직 없음"}
            </strong>
            {manualLanguageLock ? (
              <span style={{ color: COLORS.inkMuted, fontSize: TYPO.fs.xs }}>
                콘솔에서 수동 고정됨
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div style={{ ...whiteCard, padding: 18 }}>
        <h2
          style={{
            margin: 0,
            marginBottom: 4,
            fontSize: TYPO.fs.lg,
            fontWeight: TYPO.fw.bold,
            color: COLORS.ink,
            borderLeft: `4px solid ${COLORS.caller}`,
            paddingLeft: 10,
            lineHeight: TYPO.lh.tight,
          }}
        >
          내가 한 말
        </h2>
        <div
          style={{
            marginLeft: 14,
            marginBottom: 12,
            fontSize: TYPO.fs.xs,
            color: COLORS.inkMuted,
          }}
        >
          AI가 인식한 원문 — 콘솔로 자동 전송됩니다
        </div>
        {callerLog.length === 0 ? (
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
            마이크를 시작하고 자기 언어로 말씀해보세요.
            <br />
            인식된 텍스트가 여기에 표시됩니다.
          </div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {callerLog.map((l, idx) => {
              const isLastDone = idx === callerLog.length - 1 && l.status === "done";
              const isThisRetake = retakeSeq === l.seq;
              const tone = lineTone(l.status, isThisRetake);
              return (
                <li
                  key={l.seq}
                  style={{
                    padding: 14,
                    borderRadius: 10,
                    border: isThisRetake
                      ? `2px solid ${COLORS.red}`
                      : `1px solid ${COLORS.cardBorder}`,
                    borderLeft: `4px solid ${tone.accent}`,
                    background: tone.bg,
                    color: COLORS.ink,
                  }}
                >
                  <div
                    style={{
                      fontSize: TYPO.fs.xs,
                      color: COLORS.inkMuted,
                      marginBottom: 6,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: TYPO.fw.semibold,
                        color: COLORS.inkSoft,
                      }}
                    >
                      #{l.seq}
                    </span>
                    <span aria-hidden style={{ opacity: 0.5 }}>·</span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      {new Date(l.ts).toLocaleTimeString()}
                    </span>
                    <span aria-hidden style={{ opacity: 0.5 }}>·</span>
                    <span>{languageLabel(l.lang)}</span>
                    <SimStatusChip status={l.status} />
                    {isThisRetake ? (
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: 999,
                          background: COLORS.red,
                          color: "#fff",
                          fontSize: TYPO.fs.xs,
                          fontWeight: TYPO.fw.bold,
                          letterSpacing: 0.3,
                        }}
                      >
                        ✏ 재녹음 대기
                      </span>
                    ) : null}
                  </div>
                  {l.text ? (
                    <div
                      style={{
                        fontSize: TYPO.fs.md,
                        fontWeight: TYPO.fw.medium,
                        lineHeight: TYPO.lh.normal,
                      }}
                    >
                      {l.text}
                    </div>
                  ) : l.error ? (
                    <div style={{ fontSize: TYPO.fs.sm, color: COLORS.redDark, fontWeight: TYPO.fw.medium }}>
                      {l.error}
                    </div>
                  ) : (
                    <div
                      style={{
                        fontSize: TYPO.fs.sm,
                        color: COLORS.inkMuted,
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      <SimSpinner color={COLORS.amber} />
                      처리 중...
                    </div>
                  )}
                  {/* 다시 말하기: 가장 최근 done 항목 또는 현재 retake 잡힌 항목에만 노출. */}
                  {(isLastDone || isThisRetake) && (
                    <div
                      style={{
                        marginTop: 10,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <button
                        onClick={() => handleRetakeToggle(l.seq)}
                        style={isThisRetake ? retakeActiveBtn : retakeBtn}
                      >
                        {isThisRetake
                          ? "✖ 다시 말하기 취소"
                          : "🎤 다시 말하기"}
                      </button>
                      {isThisRetake && (
                        <span
                          style={{
                            fontSize: TYPO.fs.xs,
                            color: COLORS.redDark,
                            fontWeight: TYPO.fw.semibold,
                          }}
                        >
                          다음에 말씀하시는 내용으로 덮어씁니다
                        </span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ----- 표현용 헬퍼 -----

/** 큰 마이크 인디케이터 — 듣는 중/말하는 중/정지를 색·아이콘·라벨 3중 단서로 시각화. */
function MicIndicator({ state }: { state: "speaking" | "listening" | "idle" }) {
  const palette =
    state === "speaking"
      ? { bg: COLORS.red, fg: "#fff", animation: "ems-sim-pulse-red 1.2s infinite", label: "🎤 말하는 중" }
      : state === "listening"
      ? { bg: COLORS.green, fg: "#fff", animation: "ems-sim-pulse-green 1.6s infinite", label: "👂 듣는 중" }
      : { bg: COLORS.slate, fg: "#fff", animation: "none", label: "⏸ 정지" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span
        aria-hidden
        style={{
          width: 44,
          height: 44,
          borderRadius: "50%",
          background: palette.bg,
          color: palette.fg,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          animation: palette.animation,
        }}
      >
        🎙
      </span>
      <span
        style={{
          fontWeight: TYPO.fw.bold,
          fontSize: TYPO.fs.base,
          color: COLORS.ink,
        }}
      >
        {palette.label}
      </span>
    </div>
  );
}

function SimSpinner({ size = 12, color = "currentColor" }: { size?: number; color?: string }) {
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
        animation: "ems-sim-spin 0.7s linear infinite",
        marginRight: 6,
        verticalAlign: -1,
      }}
    />
  );
}

/** 발화 라인 상태 칩. */
function SimStatusChip({ status }: { status: CallerLine["status"] }) {
  const map: Record<CallerLine["status"], { label: string; tone: keyof typeof STATUS_COLOR }> = {
    listening: { label: "듣는 중", tone: "live" },
    stt: { label: "처리 중", tone: "processing" },
    done: { label: "전송됨", tone: "ok" },
    skipped: { label: "무시됨", tone: "idle" },
    error: { label: "오류", tone: "error" },
  };
  const { label, tone } = map[status];
  const c = STATUS_COLOR[tone];
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
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
          background: c.dot,
          display: "inline-block",
        }}
      />
      {label}
    </span>
  );
}

/** 라인 카드 톤 — 상태에 따른 배경/액센트. */
function lineTone(
  status: CallerLine["status"],
  isRetake: boolean
): { bg: string; accent: string } {
  if (isRetake) return { bg: "#fff7ed", accent: COLORS.red };
  if (status === "error") return { bg: "#fef2f2", accent: COLORS.red };
  if (status === "skipped") return { bg: "#f1f5f9", accent: COLORS.slate };
  if (status === "done") return { bg: "#fff", accent: COLORS.caller };
  return { bg: "#fff", accent: COLORS.amber };
}

const primaryBtn: React.CSSProperties = {
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
const dangerBtn: React.CSSProperties = {
  ...primaryBtn,
  background: COLORS.slate,
  boxShadow: "0 2px 6px rgba(81,97,117,0.35)",
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
const retakeBtn: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: TYPO.fs.xs,
  background: "#fff",
  color: COLORS.navy,
  border: `1px solid ${COLORS.navy}`,
  borderRadius: 6,
  cursor: "pointer",
  fontWeight: TYPO.fw.semibold,
};
const retakeActiveBtn: React.CSSProperties = {
  ...retakeBtn,
  background: COLORS.red,
  color: "#fff",
  border: `1px solid ${COLORS.red}`,
};
