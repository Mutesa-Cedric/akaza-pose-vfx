interface SoundEnvelope {
  from: number;
  to: number;
  duration: number;
  level: number;
  attack?: number;
}

interface Tone extends SoundEnvelope {
  wave?: OscillatorType;
}

interface SoundMix {
  dry: GainNode;
  reflections: GainNode;
  master: GainNode;
}

interface ChargeVoice {
  tone: OscillatorNode;
  toneGain: GainNode;
  air: AudioBufferSourceNode;
  airFilter: BiquadFilterNode;
  airGain: GainNode;
}

const SILENCE = 0.0001;
const MASTER_LEVEL = 0.86;
const ECHO_PITCHES = [880, 1174.66, 739.99, 1567.98];

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Procedural score for the pose lock, impact, echoes, strikes, and release. */
export class AfterglowSoundEngine {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private distortionCurve: Float32Array<ArrayBuffer> | null = null;
  private mix: SoundMix | null = null;
  private charge: ChargeVoice | null = null;
  private muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.endCharge();
    if (!this.ctx || !this.mix) return;
    const gain = this.mix.master.gain;
    const now = this.ctx.currentTime;
    gain.setTargetAtTime(this.muted ? 0 : MASTER_LEVEL, now, 0.008);
  }

  /** Call from the camera, video, preview, or sound button gesture. */
  unlock(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.noiseBuffer = this.createNoiseBuffer(this.ctx);
      this.distortionCurve = this.createDistortionCurve();
    }
    if (this.ctx.state !== 'running') {
      void this.ctx.resume().catch(() => {});
    }
  }

  stopSession(): void {
    this.endCharge();
    // Detach every scheduled tail before switching video or camera sessions.
    this.mix?.master.disconnect();
    this.mix = null;
  }

  dispose(): void {
    this.stopSession();
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close();
    this.ctx = null;
    this.noiseBuffer = null;
    this.distortionCurve = null;
  }

  updateCharge(progress: number): void {
    const ctx = this.playingContext;
    if (!ctx || !this.noiseBuffer) return;
    const charge = this.charge ??= this.startCharge(ctx, this.noiseBuffer);
    const now = ctx.currentTime;
    const build = progress * progress;
    charge.tone.frequency.setTargetAtTime(112 + 186 * build, now, 0.035);
    charge.toneGain.gain.setTargetAtTime(0.014 + 0.049 * build, now, 0.032);
    charge.airFilter.frequency.setTargetAtTime(450 + 3200 * build, now, 0.04);
    charge.airGain.gain.setTargetAtTime(0.032 + 0.15 * build, now, 0.035);
  }

  endCharge(): void {
    const ctx = this.ctx;
    const charge = this.charge;
    if (!ctx || !charge) return;
    const now = ctx.currentTime;
    charge.toneGain.gain.setTargetAtTime(0, now, 0.018);
    charge.airGain.gain.setTargetAtTime(0, now, 0.024);
    charge.tone.stop(now + 0.12);
    charge.air.stop(now + 0.15);
    this.charge = null;
  }

  playActivation(): void {
    const ctx = this.playingContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    const impact = this.spatialBus(ctx, 0);

    const warmth = ctx.createWaveShaper();
    warmth.curve = this.distortionCurve;
    warmth.oversample = '2x';
    this.playTone(ctx, impact, now, { from: 168, to: 32, duration: 0.63, attack: 0.02, level: 0.41 }, warmth);
    this.playTone(ctx, impact, now + 0.008, {
      from: 242, to: 88, duration: 0.24, level: 0.19, wave: 'triangle',
    });
    this.playNoise(ctx, impact, now, { from: 5400, to: 450, duration: 0.31, level: 0.29, attack: 0.007 }, 1.2);
    this.playNoise(ctx, impact, now + 0.09, { from: 1050, to: 240, duration: 0.55, level: 0.12 }, 0.9);

    const compass = this.spatialBus(ctx, 0, 0.53);
    this.playCrystal(ctx, compass, now + 0.015, 587.33, 0.085, 0.52);
    this.playCrystal(ctx, compass, now + 0.045, 880, 0.053, 0.58);
  }

  playEcho(index: number, pan: number): void {
    const ctx = this.playingContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    const target = this.spatialBus(ctx, pan, 0.60);
    const pitch = ECHO_PITCHES[index];
    this.playNoise(ctx, target, now, {
      from: 3650 + index * 420, to: 900, duration: 0.14, level: 0.19, attack: 0.004,
    }, 1.8);
    this.playTone(ctx, target, now, {
      from: 430, to: 190, duration: 0.082, level: 0.09, attack: 0.002, wave: 'triangle',
    });
    this.playCrystal(ctx, target, now + 0.009, pitch, 0.108, 0.245);
  }

  playBarrageSlice(startPan: number, endPan: number): void {
    const ctx = this.playingContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    const target = this.spatialBus(ctx, startPan);
    target.pan.linearRampToValueAtTime(clamp(endPan, -1, 1), now + 0.105);
    const brightness = 2900 + Math.random() * 1950;
    this.playNoise(ctx, target, now, {
      from: brightness, to: 320, duration: 0.17, level: 0.20, attack: 0.009,
    }, 1.4);
    this.playTone(ctx, target, now + 0.01, {
      from: brightness * 0.62, to: 760, duration: 0.11, level: 0.028,
    });
  }

  playPunchBurst(pan: number, strength: number): void {
    const ctx = this.playingContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    const target = this.spatialBus(ctx, pan * 0.73, 0.18);
    const hit = clamp(strength, 0.55, 1);
    this.playTone(ctx, target, now, {
      from: 230, to: 54, duration: 0.21, level: 0.31 * hit, wave: 'triangle', attack: 0.004,
    });
    this.playTone(ctx, target, now, {
      from: 820, to: 118, duration: 0.066, level: 0.12 * hit, wave: 'triangle', attack: 0.002,
    });
    this.playNoise(ctx, target, now, {
      from: 5900, to: 760, duration: 0.14, level: 0.32 * hit, attack: 0.004,
    }, 1.4);
    this.playCrystal(ctx, target, now + 0.036, 1396.91, 0.037 * hit, 0.23);
  }

  playDissipate(): void {
    const ctx = this.playingContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    const vent = this.spatialBus(ctx, 0, 0.42);
    this.playNoise(ctx, vent, now, { from: 2150, to: 235, duration: 0.46, level: 0.22, attack: 0.05 }, 1.05);
    this.playCrystal(ctx, this.spatialBus(ctx, -0.32, 0.56), now + 0.02, 880, 0.049, 0.32);
    this.playCrystal(ctx, this.spatialBus(ctx, 0.34, 0.56), now + 0.085, 587.33, 0.037, 0.42);
  }

  private get playingContext(): AudioContext | null {
    return !this.muted && this.ctx?.state === 'running' ? this.ctx : null;
  }

  private startCharge(ctx: AudioContext, noise: AudioBuffer): ChargeVoice {
    const now = ctx.currentTime;
    const route = this.spatialBus(ctx, 0);
    const tone = ctx.createOscillator();
    const toneGain = ctx.createGain();
    const air = ctx.createBufferSource();
    const airFilter = ctx.createBiquadFilter();
    const airGain = ctx.createGain();
    tone.type = 'triangle';
    tone.frequency.value = 112;
    toneGain.gain.value = 0;
    air.buffer = noise;
    air.loop = true;
    airFilter.type = 'bandpass';
    airFilter.frequency.value = 450;
    airFilter.Q.value = 1.1;
    airGain.gain.value = 0;
    tone.connect(toneGain).connect(route);
    air.connect(airFilter).connect(airGain).connect(route);
    tone.start(now);
    air.start(now);
    return { tone, toneGain, air, airFilter, airGain };
  }

  private buildMix(ctx: AudioContext): SoundMix {
    const dry = ctx.createGain();
    const reflections = ctx.createGain();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -11;
    compressor.knee.value = 13;
    compressor.ratio.value = 3.2;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.14;
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : MASTER_LEVEL;
    dry.connect(compressor).connect(master).connect(ctx.destination);

    // Two short, filtered room taps put tails behind the dry transients in stereo.
    for (const tap of [{ delay: 0.053, pan: -0.64, level: 0.24 }, { delay: 0.086, pan: 0.71, level: 0.18 }]) {
      const delay = ctx.createDelay(0.12);
      const lowpass = ctx.createBiquadFilter();
      const panner = ctx.createStereoPanner();
      const gain = ctx.createGain();
      delay.delayTime.value = tap.delay;
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 2450;
      panner.pan.value = tap.pan;
      gain.gain.value = tap.level;
      reflections.connect(delay).connect(lowpass).connect(panner).connect(gain).connect(compressor);
    }
    return { dry, reflections, master };
  }

  private spatialBus(ctx: AudioContext, pan: number, room = 0): StereoPannerNode {
    const mix = this.mix ??= this.buildMix(ctx);
    const source = ctx.createStereoPanner();
    source.pan.setValueAtTime(clamp(pan, -1, 1), ctx.currentTime);
    source.connect(mix.dry);
    if (room > 0) {
      const send = ctx.createGain();
      send.gain.value = room;
      source.connect(send).connect(mix.reflections);
    }
    return source;
  }

  private playCrystal(
    ctx: AudioContext, target: AudioNode, time: number, pitch: number, level: number, duration: number,
  ): void {
    this.playTone(ctx, target, time, { from: pitch * 1.007, to: pitch, duration, level, attack: 0.005 });
    this.playTone(ctx, target, time, {
      from: pitch * 2.762, to: pitch * 2.74, duration: duration * 0.51, level: level * 0.38, attack: 0.003,
    });
    this.playTone(ctx, target, time + 0.016, {
      from: pitch * 4.08, to: pitch * 3.98, duration: duration * 0.35, level: level * 0.19, attack: 0.002,
    });
  }

  private playTone(ctx: AudioContext, target: AudioNode, time: number, tone: Tone, shaper?: WaveShaperNode): void {
    const oscillator = ctx.createOscillator();
    oscillator.type = tone.wave ?? 'sine';
    oscillator.frequency.setValueAtTime(tone.from, time);
    oscillator.frequency.exponentialRampToValueAtTime(tone.to, time + tone.duration);
    const gain = this.envelope(ctx, target, time, tone);
    if (shaper) oscillator.connect(shaper).connect(gain);
    else oscillator.connect(gain);
    oscillator.start(time);
    oscillator.stop(time + tone.duration + 0.015);
  }

  private playNoise(
    ctx: AudioContext, target: AudioNode, time: number, sweep: SoundEnvelope, resonance: number,
  ): void {
    if (!this.noiseBuffer) return;
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    source.buffer = this.noiseBuffer;
    filter.type = 'bandpass';
    filter.Q.value = resonance;
    filter.frequency.setValueAtTime(sweep.from, time);
    filter.frequency.exponentialRampToValueAtTime(sweep.to, time + sweep.duration);
    source.connect(filter).connect(this.envelope(ctx, target, time, sweep));
    const offset = Math.random() * (this.noiseBuffer.duration - sweep.duration - 0.02);
    source.start(time, offset);
    source.stop(time + sweep.duration + 0.02);
  }

  private envelope(ctx: AudioContext, target: AudioNode, time: number, sound: SoundEnvelope): GainNode {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(SILENCE, time);
    gain.gain.linearRampToValueAtTime(sound.level, time + (sound.attack ?? 0.012));
    gain.gain.exponentialRampToValueAtTime(SILENCE, time + sound.duration);
    gain.connect(target);
    return gain;
  }

  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private createDistortionCurve(): Float32Array<ArrayBuffer> {
    const curve = new Float32Array(4096);
    for (let i = 0; i < curve.length; i++) {
      curve[i] = Math.tanh(2.5 * (2 * i / (curve.length - 1) - 1));
    }
    return curve;
  }
}
