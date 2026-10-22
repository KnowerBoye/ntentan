// ─────────────────────────────────────────────
//  Audio for the Live features, ported from the test-live web app
//  (test-live/src/lib/audio.ts) to React Native.
//
//  Capture:  react-native-audio-record — emits base64 PCM16 @16 kHz mono
//            directly (no manual downsampling needed, unlike the browser).
//  Playback: react-native-audio-api — a Web-Audio-compatible AudioContext, so
//            the Player / GuidancePlayer / EncodedPlayer classes mirror the web
//            versions almost line for line.
//
//  Live API fixes the formats: input 16 kHz, output 24 kHz, both 16-bit mono LE.
// ─────────────────────────────────────────────
import { PermissionsAndroid, Platform } from "react-native";
import AudioRecord from "react-native-audio-record";
import {
  AudioContext,
  type AudioBuffer,
  type AudioBufferSourceNode,
} from "react-native-audio-api";
import { INPUT_RATE, OUTPUT_RATE } from "../config";
import { base64ToBytes } from "./base64";

// Android mic source. 7 = MediaRecorder.AudioSource.VOICE_COMMUNICATION, which
// routes capture through the platform's voice pre-processing — hardware acoustic
// echo cancellation (AEC) + noise suppression + auto gain — the same path VoIP
// apps use. This stops the always-open assistant mic from re-capturing the
// assistant's own spoken reply out of the loudspeaker (the feedback loop).
// (6 = VOICE_RECOGNITION is tuned for ASR and applies NO echo cancellation.)
// iOS gets the equivalent from the AVAudioSession PlayAndRecord + VoiceChat mode
// set in the patched native audio libs (patches/*.patch).
const ANDROID_SOURCE_VOICE_COMMUNICATION = 7;

// ── PCM16 base64 -> Float32 [-1, 1] ──
function pcm16Base64ToFloat32(b64: string): Float32Array {
  const bytes = base64ToBytes(b64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

// ─────────────────────────────────────────────
//  Recorder — mic -> base64 PCM16 @16 kHz chunks
// ─────────────────────────────────────────────
export class Recorder {
  private running = false;
  private listener: { remove: () => void } | null = null;

  static async ensurePermission(): Promise<boolean> {
    if (Platform.OS !== "android") return true; // iOS prompts via Info.plist
    const res = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      {
        title: "Microphone",
        message: "Ntentan needs the microphone so you can talk to the assistant.",
        buttonPositive: "OK",
      }
    );
    return res === PermissionsAndroid.RESULTS.GRANTED;
  }

  async start(onChunk: (base64Pcm16: string) => void): Promise<void> {
    if (this.running) return;
    AudioRecord.init({
      sampleRate: INPUT_RATE,
      channels: 1,
      bitsPerSample: 16,
      audioSource: ANDROID_SOURCE_VOICE_COMMUNICATION, // AEC/NS/AGC — no echo loop
      wavFile: "", // streaming only; no file written
    });
    // AudioRecord.on returns a subscription; keep it so we can detach on stop.
    this.listener = AudioRecord.on("data", onChunk) as unknown as {
      remove: () => void;
    };
    AudioRecord.start();
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    void AudioRecord.stop();
    this.listener?.remove?.();
    this.listener = null;
    this.running = false;
  }
}

// ─────────────────────────────────────────────
//  Player — streaming PCM16 @24 kHz, gapless, with barge-in flush
//  (assistant native audio out)
// ─────────────────────────────────────────────
export class Player {
  private ctx?: AudioContext;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  onPlayingChange?: (playing: boolean) => void;

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: OUTPUT_RATE });
      this.nextTime = this.ctx.currentTime;
    }
    return this.ctx;
  }

  enqueue(b64: string): void {
    const ctx = this.ensure();
    const f32 = pcm16Base64ToFloat32(b64);
    if (f32.length === 0) return;

    const buf = ctx.createBuffer(1, f32.length, OUTPUT_RATE);
    buf.copyToChannel(f32, 0);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);

    const start = Math.max(this.nextTime, ctx.currentTime);
    node.start(start);
    this.nextTime = start + buf.duration;

    this.sources.add(node);
    this.onPlayingChange?.(true);
    node.onended = () => {
      this.sources.delete(node);
      if (this.sources.size === 0) this.onPlayingChange?.(false);
    };
  }

  /** Stop and drop all scheduled audio (barge-in). */
  flush(): void {
    this.sources.forEach((n) => {
      try {
        n.stop();
      } catch {
        /* noop */
      }
    });
    this.sources.clear();
    if (this.ctx) this.nextTime = this.ctx.currentTime;
    this.onPlayingChange?.(false);
  }

  close(): void {
    this.flush();
    void this.ctx?.close();
    this.ctx = undefined;
  }
}

// ─────────────────────────────────────────────
//  EncodedPlayer — ordered, gapless WAV clips (Twi assistant TTS)
// ─────────────────────────────────────────────
export class EncodedPlayer {
  private ctx?: AudioContext;
  private sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private chain: Promise<void> = Promise.resolve();
  private gen = 0;
  onPlayingChange?: (playing: boolean) => void;

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.nextTime = this.ctx.currentTime;
    }
    return this.ctx;
  }

  /** Queue a clip; clips play in call order, back-to-back. */
  play(b64: string): Promise<void> {
    this.chain = this.chain.then(() => this.decodeAndSchedule(b64)).catch(() => {});
    return this.chain;
  }

  private async decodeAndSchedule(b64: string): Promise<void> {
    const ctx = this.ensure();
    if (ctx.state === "suspended") await ctx.resume();
    const myGen = this.gen;
    const bytes = base64ToBytes(b64);
    const buf = await ctx.decodeAudioData(bytes.buffer as ArrayBuffer);
    if (myGen !== this.gen) return; // flushed while decoding

    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    const start = Math.max(this.nextTime, ctx.currentTime);
    node.start(start);
    this.nextTime = start + buf.duration;
    this.sources.add(node);
    this.onPlayingChange?.(true);
    node.onended = () => {
      this.sources.delete(node);
      if (this.sources.size === 0) this.onPlayingChange?.(false);
    };
  }

  /** Stop and drop all queued/playing clips (new utterance). */
  flush(): void {
    this.gen++;
    this.sources.forEach((n) => {
      try {
        n.stop();
      } catch {
        /* noop */
      }
    });
    this.sources.clear();
    if (this.ctx) this.nextTime = this.ctx.currentTime;
    this.onPlayingChange?.(false);
  }

  close(): void {
    this.flush();
    void this.ctx?.close();
    this.ctx = undefined;
  }
}

// ─────────────────────────────────────────────
//  GuidancePlayer — scanner spoken cues, "latest-wins, no interrupt"
//  (streaming PCM16 @24 kHz chunks sealed by endUtterance)
// ─────────────────────────────────────────────
export class GuidancePlayer {
  private ctx?: AudioContext;
  private incoming: Float32Array[] = [];
  private pending: Float32Array | null = null;
  private current?: AudioBufferSourceNode;
  onPlayingChange?: (playing: boolean) => void;

  private ensure(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: OUTPUT_RATE });
    // Like the other players here, resume a context that starts suspended — on
    // mobile the audio session often begins suspended, which would leave the
    // scanner's PCM guidance scheduled but silent (the primary feature for a
    // visually-impaired user relies on hearing it).
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  pushChunk(b64: string): void {
    const f32 = pcm16Base64ToFloat32(b64);
    if (f32.length) this.incoming.push(f32);
  }

  endUtterance(): void {
    if (!this.incoming.length) return;
    const cue = concatFloat32(this.incoming);
    this.incoming = [];
    if (this.current) this.pending = cue; // don't interrupt; keep only newest
    else this.play(cue);
  }

  private play(samples: Float32Array): void {
    const ctx = this.ensure();
    const buf = ctx.createBuffer(1, samples.length, OUTPUT_RATE);
    buf.copyToChannel(samples, 0);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    this.current = node;
    this.onPlayingChange?.(true);
    node.start();
    node.onended = () => {
      this.current = undefined;
      if (this.pending) {
        const next = this.pending;
        this.pending = null;
        this.play(next);
      } else {
        this.onPlayingChange?.(false);
      }
    };
  }

  close(): void {
    try {
      this.current?.stop();
    } catch {
      /* noop */
    }
    this.current = undefined;
    this.pending = null;
    this.incoming = [];
    void this.ctx?.close();
    this.ctx = undefined;
    this.onPlayingChange?.(false);
  }
}

// ─────────────────────────────────────────────
//  EncodedGuidancePlayer — scanner Twi cues, "latest-wins" over WAV clips
// ─────────────────────────────────────────────
export class EncodedGuidancePlayer {
  private ctx?: AudioContext;
  private current?: AudioBufferSourceNode;
  private pending: string | null = null;
  private busy = false;
  onPlayingChange?: (playing: boolean) => void;

  private ensure(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  play(b64: string): void {
    if (this.busy) {
      this.pending = b64;
      return;
    }
    void this.start(b64);
  }

  private async start(b64: string): Promise<void> {
    this.busy = true;
    const ctx = this.ensure();
    if (ctx.state === "suspended") await ctx.resume();
    let buf: AudioBuffer;
    try {
      buf = await ctx.decodeAudioData(base64ToBytes(b64).buffer as ArrayBuffer);
    } catch {
      this.busy = false;
      this.afterEnd();
      return;
    }
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    this.current = node;
    this.onPlayingChange?.(true);
    node.start();
    node.onended = () => {
      this.current = undefined;
      this.busy = false;
      this.afterEnd();
    };
  }

  private afterEnd(): void {
    if (this.pending) {
      const next = this.pending;
      this.pending = null;
      void this.start(next);
    } else {
      this.onPlayingChange?.(false);
    }
  }

  close(): void {
    try {
      this.current?.stop();
    } catch {
      /* noop */
    }
    this.current = undefined;
    this.pending = null;
    this.busy = false;
    void this.ctx?.close();
    this.ctx = undefined;
    this.onPlayingChange?.(false);
  }
}

function concatFloat32(parts: Float32Array[]): Float32Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
