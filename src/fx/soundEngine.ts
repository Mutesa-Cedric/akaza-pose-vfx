/**
 * Procedural Web Audio synthesizer for Akaza's Destructive Death – Final Form:
 * Blue Silver Chaotic Afterglow (破壊殺・終式 青銀乱残光).
 *
 * Cinematic procedural audio architecture (zero external asset dependencies):
 *  - FM synthesis metallic crystalline chime (carrier D6/A6 + 3.5× modulator with decaying mod index)
 *  - WaveShaper soft-saturated sub-bass domain stomp (180Hz -> 28Hz pitch dive)
 *  - High-Q supersonic air-shear crack & razor slice swooshes
 *  - Reactive punch burst with crystalline sparkle echo
 */

export class AfterglowSoundEngine {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private distortionCurve: Float32Array | null = null;
  private muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Must be called from a user gesture to unlock the Web Audio context. */
  unlock(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.noiseBuffer = this.createNoiseBuffer(this.ctx);
      this.distortionCurve = this.createDistortionCurve(2.8);
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
    this.distortionCurve = null;
  }

  /**
   * Domain activation sound:
   *  1. FM synthesis metallic crystalline chime (carrier D6/A6 + 3.5× modulator).
   *  2. WaveShaper soft-saturated sub-bass domain stomp (180Hz -> 28Hz).
   *  3. Crisp high-Q bandpass air-shear swoosh.
   */
  playActivation(): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    // -------------------------------------------------------------------------
    // 1. WaveShaper soft-saturated sub-bass domain stomp (180Hz -> 28Hz)
    // -------------------------------------------------------------------------
    const bassOsc = this.ctx.createOscillator();
    const bassGain = this.ctx.createGain();
    const shaper = this.ctx.createWaveShaper();

    if (this.distortionCurve) {
      shaper.curve = this.distortionCurve;
      shaper.oversample = '2x';
    }

    bassOsc.type = 'sine';
    bassOsc.frequency.setValueAtTime(180, now);
    bassOsc.frequency.exponentialRampToValueAtTime(28, now + 0.52);

    bassGain.gain.setValueAtTime(0.0001, now);
    bassGain.gain.linearRampToValueAtTime(0.44, now + 0.022);
    bassGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);

    bassOsc.connect(shaper);
    shaper.connect(bassGain);
    bassGain.connect(this.ctx.destination);

    bassOsc.start(now);
    bassOsc.stop(now + 0.75);

    // -------------------------------------------------------------------------
    // 2. FM synthesis metallic crystalline chime: D6 (1174.66Hz) & A6 (1760.0Hz)
    // Modulator frequency = 3.5× carrier for icy metallic bell timbre
    // -------------------------------------------------------------------------
    const fmChimes = [
      { carrier: 1174.66, modRatio: 3.5, modIndex: 1200, delay: 0.0 },
      { carrier: 1760.00, modRatio: 3.5, modIndex: 1600, delay: 0.035 },
      { carrier: 2349.32, modRatio: 3.5, modIndex: 1800, delay: 0.07 },
    ];

    for (const chime of fmChimes) {
      const t0 = now + chime.delay;
      const carrierOsc = this.ctx.createOscillator();
      const carrierGain = this.ctx.createGain();
      const modOsc = this.ctx.createOscillator();
      const modGain = this.ctx.createGain();

      carrierOsc.type = 'sine';
      carrierOsc.frequency.setValueAtTime(chime.carrier, t0);

      modOsc.type = 'sine';
      modOsc.frequency.setValueAtTime(chime.carrier * chime.modRatio, t0);

      // Decaying modulation index produces metallic ring decaying into clean tone
      modGain.gain.setValueAtTime(chime.modIndex, t0);
      modGain.gain.exponentialRampToValueAtTime(0.1, t0 + 0.85);

      modOsc.connect(modGain);
      modGain.connect(carrierOsc.frequency);

      // Amplitude envelope
      carrierGain.gain.setValueAtTime(0.0001, t0);
      carrierGain.gain.linearRampToValueAtTime(0.065, t0 + 0.018);
      carrierGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.25);

      carrierOsc.connect(carrierGain);
      carrierGain.connect(this.ctx.destination);

      modOsc.start(t0);
      carrierOsc.start(t0);
      modOsc.stop(t0 + 1.3);
      carrierOsc.stop(t0 + 1.3);
    }

    // -------------------------------------------------------------------------
    // 3. Crisp high-Q bandpass air-shear swoosh
    // -------------------------------------------------------------------------
    this.playFilteredNoise(now, 0.42, 4200, 380, 0.24, 4.8);
  }

  /** Backwards-compatibility alias for playActivation */
  playActivate(): void {
    this.playActivation();
  }

  /**
   * Heavy punch burst:
   *  - Snappy high-Q supersonic crack + sub-punch thump
   *  - Crystalline sparkle echo pings
   */
  playPunchBurst(): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    // Sub-punch thump
    const thumpOsc = this.ctx.createOscillator();
    const thumpGain = this.ctx.createGain();
    thumpOsc.type = 'triangle';
    thumpOsc.frequency.setValueAtTime(240, now);
    thumpOsc.frequency.exponentialRampToValueAtTime(42, now + 0.16);
    thumpGain.gain.setValueAtTime(0.36, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    thumpOsc.connect(thumpGain).connect(this.ctx.destination);
    thumpOsc.start(now);
    thumpOsc.stop(now + 0.2);

    // Snappy high-Q supersonic crack
    this.playFilteredNoise(now, 0.11, 5200, 680, 0.32, 6.5);

    // Crystalline sparkle echo
    const sparkles = [
      { freq: 2489.02, delay: 0.038, gain: 0.045 },
      { freq: 3520.00, delay: 0.075, gain: 0.032 },
    ];
    for (const spk of sparkles) {
      const t = now + spk.delay;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(spk.freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(spk.gain, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    }
  }

  /** Fast razor air slice swoosh during the continuous chaotic barrage. */
  playBarrageSlice(): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const startFreq = 2600 + Math.random() * 2200;
    const endFreq = 420 + Math.random() * 450;
    this.playFilteredNoise(now, 0.12, startFreq, endFreq, 0.09, 3.8);

    // Occasional diamond needle ping
    if (Math.random() < 0.6) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const freq = 1600 + Math.random() * 1800;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.032, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.22);
    }
  }

  /** Clean dispersing cold wind whoosh when the domain dissipates. */
  playDissipate(): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    this.playFilteredNoise(now, 0.44, 1500, 220, 0.08, 2.0);
  }

  private playFilteredNoise(
    startTime: number,
    duration: number,
    freqStart: number,
    freqEnd: number,
    peakGain: number,
    q = 2.4,
  ): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.setValueAtTime(q, startTime);
    filter.frequency.setValueAtTime(freqStart, startTime);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, freqEnd), startTime + duration);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + Math.min(0.02, duration * 0.18));
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

  private createDistortionCurve(k = 2.5): Float32Array {
    const samples = 44100;
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; ++i) {
      const x = (i * 2) / samples - 1;
      curve[i] = Math.tanh(k * x);
    }
    return curve;
  }
}
