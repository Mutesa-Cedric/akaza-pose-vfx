/**
 * Procedural Web Audio synthesizer for Akaza's Blue Silver Chaotic Afterglow.
 * Generates all sound effects in real time (zero external audio files needed):
 *  - Domain activation sub-bass impact + crystalline Snowflake Compass chord
 *  - Razor-thin blue-silver air-slice whooshes & firework glints during barrage
 *  - Kinetic shockwave crack on reactive punches
 */
export class AfterglowSoundEngine {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Must be called from a user gesture (e.g., Start Camera button) to unlock audio. */
  unlock(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.noiseBuffer = this.createNoiseBuffer(this.ctx);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  dispose(): void {
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
    this.noiseBuffer = null;
  }

  playActivate(): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    // 1. Sub-bass domain impact boom (125Hz -> 36Hz)
    const bassOsc = this.ctx.createOscillator();
    const bassGain = this.ctx.createGain();
    bassOsc.type = 'sine';
    bassOsc.frequency.setValueAtTime(128, now);
    bassOsc.frequency.exponentialRampToValueAtTime(36, now + 0.55);
    bassGain.gain.setValueAtTime(0.001, now);
    bassGain.gain.linearRampToValueAtTime(0.38, now + 0.025);
    bassGain.gain.exponentialRampToValueAtTime(0.001, now + 0.72);
    bassOsc.connect(bassGain).connect(this.ctx.destination);
    bassOsc.start(now);
    bassOsc.stop(now + 0.75);

    // 2. Crystalline Snowflake Compass harmonic shimmer (D5, F#5, A5, C#6, E6)
    const notes = [587.33, 739.99, 880.0, 1108.73, 1318.51];
    notes.forEach((freq, i) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = i % 2 === 0 ? 'triangle' : 'sine';
      const t0 = now + i * 0.032;
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.008, t0 + 0.9);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(0.065 / (1 + i * 0.18), t0 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.15);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 1.2);
    });

    // 3. Shockwave air rush
    this.playFilteredNoise(now, 0.45, 2200, 320, 0.22);
  }

  playBarrageSlice(): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const startFreq = 1800 + Math.random() * 2400;
    const endFreq = 420 + Math.random() * 500;
    this.playFilteredNoise(now, 0.14, startFreq, endFreq, 0.085);

    // Subtle icy firework twinkle ping
    if (Math.random() < 0.55) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const freq = 1400 + Math.random() * 1800;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.028, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.26);
    }
  }

  playPunchBurst(): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(210, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.18);
    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.22);

    this.playFilteredNoise(now, 0.22, 3400, 520, 0.16);
  }

  playDissipate(): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    this.playFilteredNoise(now, 0.35, 1400, 260, 0.07);
  }

  private playFilteredNoise(
    startTime: number,
    duration: number,
    freqStart: number,
    freqEnd: number,
    peakGain: number,
  ): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.setValueAtTime(2.2, startTime);
    filter.frequency.setValueAtTime(freqStart, startTime);
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, freqEnd), startTime + duration);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + Math.min(0.025, duration * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    src.connect(filter).connect(gain).connect(this.ctx.destination);
    src.start(startTime);
    src.stop(startTime + duration + 0.02);
  }

  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }
}
