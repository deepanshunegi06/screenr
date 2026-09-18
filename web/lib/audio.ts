/**
 * Microphone capture and agent playback.
 *
 * Deepgram wants 16 kHz mono linear16 in and sends 24 kHz linear16 back. The
 * browser will not give us 16 kHz directly on most machines, so capture runs at
 * whatever the hardware prefers and is downsampled here.
 */

const TARGET_RATE = 16000;
const PLAYBACK_RATE = 24000;

// ~85 ms at 48 kHz. Deepgram recommends 20-250 ms chunks; per-render-quantum
// posting (128 samples) would mean ~375 tiny WebSocket frames a second.
const CAPTURE_BLOCK = 4096;

/** Averages over each source window rather than picking one sample -- plain
 *  decimation aliases badly, and aliasing on speech sounds like a bad line.
 *  Keeps a fractional read position across calls so the ratio does not drift
 *  a sample per block at 44.1 kHz. */
class Downsampler {
  private position = 0;
  constructor(
    private readonly fromRate: number,
    private readonly toRate: number,
  ) {}

  process(input: Float32Array): Int16Array {
    if (this.fromRate === this.toRate) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) out[i] = clamp(input[i]);
      return out;
    }
    const ratio = this.fromRate / this.toRate;
    const out: number[] = [];
    let start = this.position;
    while (start + ratio <= input.length) {
      const end = start + ratio;
      const from = Math.floor(start);
      const to = Math.min(Math.ceil(end), input.length);
      let sum = 0;
      for (let j = from; j < to; j++) sum += input[j];
      out.push(clamp(sum / Math.max(1, to - from)));
      start = end;
    }
    this.position = start - input.length;
    return Int16Array.from(out);
  }
}

function clamp(sample: number): number {
  return Math.max(-1, Math.min(1, sample)) * 0x7fff;
}

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(${CAPTURE_BLOCK});
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const room = this.buffer.length - this.filled;
      const take = Math.min(room, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer);
        this.buffer = new Float32Array(this.buffer.length);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
`;

export type MicHandle = {
  stop: () => void;
  /** 0..1 overall level, for a simple meter. */
  level: () => number;
  /** Frequency bins, for an honest meter. */
  bins: () => Uint8Array;
};

export async function startMicrophone(onChunk: (pcm: ArrayBuffer) => void): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const context = new AudioContext();
  // Safari leaves a context suspended until something resumes it; capture that
  // never runs looks exactly like a silent candidate.
  await context.resume().catch(() => {});
  const source = context.createMediaStreamSource(stream);

  const analyser = context.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.6;
  const levels = new Uint8Array(analyser.frequencyBinCount);
  source.connect(analyser);

  const blob = new Blob([WORKLET], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const downsampler = new Downsampler(context.sampleRate, TARGET_RATE);
  const node = new AudioWorkletNode(context, "capture");
  node.port.onmessage = (event) => {
    const pcm = downsampler.process(event.data as Float32Array);
    if (pcm.length) onChunk(pcm.buffer as ArrayBuffer);
  };
  source.connect(node);
  // Worklets only run once connected to a destination; a zero gain keeps the
  // candidate from hearing themselves.
  const mute = context.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(context.destination);

  return {
    stop: () => {
      node.port.onmessage = null;
      node.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void context.close();
    },
    level: () => {
      analyser.getByteFrequencyData(levels);
      let sum = 0;
      for (let i = 0; i < levels.length; i++) sum += levels[i];
      return Math.min(1, sum / levels.length / 128);
    },
    bins: () => {
      analyser.getByteFrequencyData(levels);
      return levels;
    },
  };
}

/**
 * Plays agent audio in order.
 *
 * Chunks arrive faster than real time, so each is scheduled against a running
 * cursor rather than played on arrival -- otherwise they overlap and the agent
 * sounds like several people talking at once.
 */
export class AgentVoice {
  private context: AudioContext | null = null;
  private cursor = 0;
  private sources = new Set<AudioBufferSourceNode>();

  /** Create and resume the context from inside a user gesture. Browsers refuse
   *  to start audio otherwise, and a WebSocket message is not a gesture. */
  async unlock(): Promise<void> {
    const context = this.ensure();
    await context.resume().catch(() => {});
  }

  private ensure(): AudioContext {
    if (!this.context || this.context.state === "closed") {
      try {
        this.context = new AudioContext({ sampleRate: PLAYBACK_RATE });
      } catch {
        // Older WebKit rejects a requested sample rate. createBuffer still
        // takes 24 kHz and the context resamples on output.
        this.context = new AudioContext();
      }
      this.cursor = 0;
    }
    if (this.context.state === "suspended") void this.context.resume().catch(() => {});
    return this.context;
  }

  play(pcm: ArrayBuffer) {
    const context = this.ensure();
    const samples = new Int16Array(pcm);
    if (!samples.length) return;

    const buffer = context.createBuffer(1, samples.length, PLAYBACK_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const startAt = Math.max(context.currentTime + 0.05, this.cursor);
    source.start(startAt);
    this.cursor = startAt + buffer.duration;

    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  /** Cut the agent off when the candidate starts talking. */
  interrupt() {
    this.sources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // already finished
      }
    });
    this.sources.clear();
    this.cursor = this.context?.currentTime ?? 0;
  }

  close() {
    this.interrupt();
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
