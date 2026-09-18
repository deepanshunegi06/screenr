/**
 * Microphone capture and agent playback.
 *
 * Deepgram wants 16 kHz mono linear16 in and sends 24 kHz linear16 back. The
 * browser will not give us 16 kHz directly on most machines, so capture runs at
 * whatever the hardware prefers and is downsampled here.
 */

const TARGET_RATE = 16000;
const PLAYBACK_RATE = 24000;

/** Average over each source window rather than picking one sample. Plain
 *  decimation aliases badly, and aliasing on speech sounds like a bad line. */
function downsample(input: Float32Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff;
    }
    return out;
  }

  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const out = new Int16Array(length);

  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const sample = sum / Math.max(1, end - start);
    out[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
  }
  return out;
}

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('capture', Capture);
`;

export type MicHandle = {
  stop: () => void;
  /** 0..1, for the level meter. */
  level: () => number;
};

export async function startMicrophone(
  onChunk: (pcm: ArrayBuffer) => void,
): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);

  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  const levels = new Uint8Array(analyser.frequencyBinCount);
  source.connect(analyser);

  const blob = new Blob([WORKLET], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const node = new AudioWorkletNode(context, "capture");
  node.port.onmessage = (event) => {
    const pcm = downsample(event.data as Float32Array, context.sampleRate, TARGET_RATE);
    onChunk(pcm.buffer as ArrayBuffer);
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
      context.close();
    },
    level: () => {
      analyser.getByteFrequencyData(levels);
      let sum = 0;
      for (let i = 0; i < levels.length; i++) sum += levels[i];
      return Math.min(1, sum / levels.length / 128);
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
  private speaking = false;

  private ensure(): AudioContext {
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext({ sampleRate: PLAYBACK_RATE });
      this.cursor = 0;
    }
    if (this.context.state === "suspended") void this.context.resume();
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

    this.speaking = true;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.speaking = false;
    };
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
    this.speaking = false;
    this.cursor = this.context?.currentTime ?? 0;
  }

  get isSpeaking() {
    return this.speaking;
  }

  close() {
    this.interrupt();
    void this.context?.close();
    this.context = null;
  }
}
