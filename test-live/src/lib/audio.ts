// Audio helpers for the Live assistant.
//  - Recorder: mic → mono Float32 → downsample to 16 kHz → PCM16 → base64.
//  - Player:   base64 PCM16 @24 kHz → scheduled Web Audio playback with flush
//              (for barge-in) and an onPlaying callback for a speaking indicator.
// The Live API fixes these formats: input 16 kHz, output 24 kHz, both 16-bit
// mono little-endian.

export const INPUT_RATE = 16000;
export const OUTPUT_RATE = 24000;

// ── base64 <-> bytes ──
export function bytesToBase64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function downsample(buf: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate) return buf;
  const ratio = inRate / outRate;
  const outLen = Math.round(buf.length / ratio);
  const out = new Float32Array(outLen);
  let o = 0;
  let i = 0;
  while (o < outLen) {
    const next = Math.round((o + 1) * ratio);
    let sum = 0;
    let cnt = 0;
    for (; i < next && i < buf.length; i++) {
      sum += buf[i];
      cnt++;
    }
    out[o++] = cnt ? sum / cnt : 0;
  }
  return out;
}
function floatToPCM16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export class Recorder {
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private processor?: ScriptProcessorNode;
  recording = false;

  async start(onChunk: (base64: string) => void): Promise<void> {
    if (this.recording) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // prevent local echo

    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const down = downsample(input, this.ctx!.sampleRate, INPUT_RATE);
      const pcm = floatToPCM16(down);
      onChunk(bytesToBase64(new Uint8Array(pcm.buffer)));
    };

    src.connect(this.processor);
    this.processor.connect(sink);
    sink.connect(this.ctx.destination);
    this.recording = true;
  }

  stop(): void {
    this.processor?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.processor = undefined;
    this.stream = undefined;
    this.ctx = undefined;
    this.recording = false;
  }
}

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
    const bytes = base64ToBytes(b64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 0x8000;

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

/**
 * Player for the scanner's spoken guidance, with "latest-wins, no interrupt"
 * discipline:
 *   - chunks of a cue arrive via pushChunk(); endUtterance() seals the cue.
 *   - a cue that is already playing is NEVER cut off — it finishes.
 *   - cues sealed while one is playing collapse into a single pending slot that
 *     holds only the MOST RECENT cue, so when the current cue ends the freshest
 *     guidance plays next and any cues in between are skipped.
 * Format matches the Live API output: 24 kHz, 16-bit mono PCM.
 */
export class GuidancePlayer {
  private ctx?: AudioContext;
  private incoming: Float32Array[] = []; // chunks of the cue currently being received
  private pending: Float32Array | null = null; // latest sealed cue waiting to play
  private current?: AudioBufferSourceNode; // the cue currently playing (never interrupted)
  onPlayingChange?: (playing: boolean) => void;

  private ensure(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: OUTPUT_RATE });
    return this.ctx;
  }

  /** Append one base64 PCM16 chunk to the cue currently being received. */
  pushChunk(b64: string): void {
    const bytes = base64ToBytes(b64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 0x8000;
    this.incoming.push(f32);
  }

  /** Seal the received cue. Plays it now if idle, else keeps it as the latest pending cue. */
  endUtterance(): void {
    if (!this.incoming.length) return;
    const cue = concatFloat32(this.incoming);
    this.incoming = [];
    if (this.current) {
      this.pending = cue; // don't interrupt; only ever keep the newest
    } else {
      this.play(cue);
    }
  }

  private play(samples: Float32Array): void {
    const ctx = this.ensure();
    const buf = ctx.createBuffer(1, samples.length, OUTPUT_RATE);
    buf.getChannelData(0).set(samples);
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
        this.play(next); // jump straight to the freshest cue
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
