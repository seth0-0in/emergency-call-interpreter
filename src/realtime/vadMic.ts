// ============================================================================
// MicVAD 를 발화 단위 WAV Blob 시퀀스로 단순화한 헬퍼.
//
// 기존 RealtimePage 의 풍부한 VAD 진단/프리셋/recover 로직은 그대로 두고
// (`/realtime` 경로에서 계속 동작), 시뮬레이터/콘솔에서는 발화 끝마다 한 번씩만
// WAV 가 떨어지면 되므로 가장 작은 표면적으로 분리.
//
// ── VAD 초기화 패턴 ────────────────────────────────────────────────────────
// - baseAssetPath 는 `${BASE_URL}vad/` (= `/static/119/vad/`) — VAD 모델
//   (silero_vad_v5.onnx) 과 worklet 가 fetch 로 로드되므로 안전.
// - ort wasm/.mjs 는 ortConfig 안에서 CDN 절대 URL 로 강제. 자세한 배경은
//   src/realtime/ortAssets.ts 의 주석 참고.
// - getStream / resumeStream 은 RealtimePage 와 동일한 패턴으로 명시.
// ============================================================================

import { MicVAD, utils as vadUtils } from "@ricky0123/vad-web";
import { configureOrtForCdn, ORT_WASM_CDN_BASE } from "./ortAssets";

const VAD_ASSET_BASE = `${import.meta.env.BASE_URL}vad/`;
const VAD_SAMPLE_RATE = 16000;

// RealtimePage 와 동일한 마이크 constraints — DSP(에코/노이즈/AGC) 활성화.
const MIC_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

async function getMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
}
async function resumeMicStream(_prev: MediaStream): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
}

export type VadMicOptions = {
  /** 발화 종료 시 WAV Blob 한 건이 떨어진다. */
  onUtterance: (wav: Blob, meta: { durationMs: number; rms: number }) => void;
  /** 발화 시작/종료 — UI 미터링용 (옵션). */
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  /** 잡음으로 폐기된 misfire — 시뮬레이터에서 "잠깐, 짧아서 못 들었어요" 표시용. */
  onMisfire?: () => void;
  /** UI 미터링을 위한 frame 콜백 (옵션). */
  onFrame?: (probSpeech: number, rms: number) => void;
};

export type VadMicHandle = {
  stop: () => void;
};

function computeRms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function float32ToWavBlob(samples: Float32Array): Blob {
  const arrayBuffer = vadUtils.encodeWAV(samples);
  return new Blob([arrayBuffer], { type: "audio/wav" });
}

/** 발화 단위 WAV 를 onUtterance 로 흘려주는 VAD 마이크를 시작. */
export async function startVadMic(opts: VadMicOptions): Promise<VadMicHandle> {
  const vad = await MicVAD.new({
    model: "v5",
    baseAssetPath: VAD_ASSET_BASE,
    // onnxWASMBasePath 는 ortConfig 가 곧바로 덮어쓰므로 CDN base 와 일치시켜 둔다.
    onnxWASMBasePath: ORT_WASM_CDN_BASE,
    ortConfig: configureOrtForCdn,
    // RealtimePage 의 "normal" 프리셋과 동일.
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    preSpeechPadMs: 250,
    minSpeechMs: 250,
    redemptionMs: 700,
    submitUserSpeechOnPause: true,
    getStream: getMicStream,
    resumeStream: resumeMicStream,
    onSpeechStart: () => {
      opts.onSpeechStart?.();
    },
    onSpeechEnd: (audio: Float32Array) => {
      opts.onSpeechEnd?.();
      if (audio.length === 0) return;
      const durationMs = (audio.length / VAD_SAMPLE_RATE) * 1000;
      const rms = computeRms(audio);
      const wav = float32ToWavBlob(audio);
      if (wav.size === 0) return;
      opts.onUtterance(wav, { durationMs, rms });
    },
    onVADMisfire: () => {
      opts.onMisfire?.();
    },
    // 라이브러리(real-time-vad.js:325)는 매 frame 마다 this.options.onFrameProcessed
    // 를 무조건 호출한다. MicVAD.new 는 default options 와 user options 를 spread
    // 하므로(line 342~346), user 가 명시적으로 `onFrameProcessed: undefined` 를
    // 전달하면 라이브러리 default no-op 이 undefined 로 덮여 첫 프레임에서
    //   TypeError: this.options.onFrameProcessed is not a function
    // 으로 즉시 destroy 된다. 그래서 opts.onFrame 이 없을 때도 명시적 no-op 으로
    // 채워 default 가 살아남도록 강제한다.
    onFrameProcessed: opts.onFrame
      ? (probs: { isSpeech: number }, frame: Float32Array) => {
          opts.onFrame!(probs.isSpeech, computeRms(frame));
        }
      : () => {},
  });
  await vad.start();
  return {
    stop: () => {
      try {
        vad.destroy();
      } catch {
        // 무시 — 두 번 호출돼도 안전.
      }
    },
  };
}
