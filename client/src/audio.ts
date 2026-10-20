/**
 * All sound is generated in code with the Web Audio API, so the project ships no audio files.
 * The browser only allows audio after a user gesture, so the context is created on first use.
 */
export class Audio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private shotBuffer: AudioBuffer | null = null;
  private longNoise: AudioBuffer | null = null;
  private musicTimer: number | null = null;
  private musicNodes: AudioNode[] = [];
  private musicBus: GainNode | null = null;
  private musicOn = false;
  private volume = 0.8;

  get isMusicOn(): boolean {
    return this.musicOn;
  }

  /** Sets the master volume for every sound, from 0 to 1. */
  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.05);
    }
  }

  /** A short soft tick for buttons. */
  playClick(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(780, now);
    osc.frequency.exponentialRampToValueAtTime(520, now + 0.06);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.1, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  /** Turns the background music on or off. Call from a click handler so the browser allows it. */
  setMusic(on: boolean): void {
    this.musicOn = on;
    if (on) {
      this.startMusic();
    } else {
      this.stopMusic();
    }
  }

  playShot(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.shotBuffer) return;

    // A short noise burst through a band-pass filter, plus a falling tone for the "zap".
    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this.shotBuffer;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1400;
    band.Q.value = 0.9;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.5, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    noise.connect(band).connect(noiseGain).connect(this.master);
    noise.start(now);
    noise.stop(now + 0.25);

    const zap = ctx.createOscillator();
    zap.type = "sawtooth";
    zap.frequency.setValueAtTime(1800, now);
    zap.frequency.exponentialRampToValueAtTime(180, now + 0.16);
    const zapGain = ctx.createGain();
    zapGain.gain.setValueAtTime(0.08, now);
    zapGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    zap.connect(zapGain).connect(this.master);
    zap.start(now);
    zap.stop(now + 0.2);
  }

  playEliminated(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.6);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.75);
  }

  playRevealChime(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const start = now + i * 0.09;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.6);
      osc.connect(gain).connect(this.master!);
      osc.start(start);
      osc.stop(start + 0.65);
    });
  }

  /** A wet thud when a beam hits someone: a low drop and a short soft burst of noise. */
  playHit(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.shotBuffer) return;
    const now = ctx.currentTime;

    const thud = ctx.createOscillator();
    thud.type = "sine";
    thud.frequency.setValueAtTime(170, now);
    thud.frequency.exponentialRampToValueAtTime(42, now + 0.28);
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.5, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    thud.connect(thudGain).connect(this.master);
    thud.start(now);
    thud.stop(now + 0.35);

    const splat = ctx.createBufferSource();
    splat.buffer = this.shotBuffer;
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 1100;
    const splatGain = ctx.createGain();
    splatGain.gain.setValueAtTime(0.35, now);
    splatGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    splat.connect(low).connect(splatGain).connect(this.master);
    splat.start(now);
    splat.stop(now + 0.25);
  }

  /** One footstep on steel: a short, dull tick. Pitch varies a little so steps do not sound identical. */
  playFootstep(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.shotBuffer) return;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.shotBuffer;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 260 + Math.random() * 120;
    band.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    source.connect(band).connect(gain).connect(this.master);
    source.start(now);
    source.stop(now + 0.1);
  }

  /** The beeps before the lasers fire. The last one is higher. */
  playCountdown(last: boolean): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = last ? 990 : 660;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  /** A floor level breaking away: a deep rumble, then metal clanging as the pieces fall. */
  playCollapse(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.longNoise) return;
    const now = ctx.currentTime;

    const rumble = ctx.createBufferSource();
    rumble.buffer = this.longNoise;
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.setValueAtTime(220, now);
    low.frequency.exponentialRampToValueAtTime(70, now + 2.2);
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.setValueAtTime(0.0001, now);
    rumbleGain.gain.exponentialRampToValueAtTime(0.75, now + 0.25);
    rumbleGain.gain.exponentialRampToValueAtTime(0.001, now + 2.3);
    rumble.connect(low).connect(rumbleGain).connect(this.master);
    rumble.start(now);
    rumble.stop(now + 2.4);

    for (let i = 0; i < 5; i++) {
      const start = now + 0.15 + Math.random() * 1.4;
      const clang = ctx.createOscillator();
      clang.type = "triangle";
      clang.frequency.value = 180 + Math.random() * 380;
      const clangGain = ctx.createGain();
      clangGain.gain.setValueAtTime(0.0001, start);
      clangGain.gain.exponentialRampToValueAtTime(0.16, start + 0.01);
      clangGain.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
      clang.connect(clangGain).connect(this.master);
      clang.start(start);
      clang.stop(start + 0.55);
    }
  }

  /** A short rising phrase for a win, or a falling one for a loss. */
  playResult(won: boolean): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const notes = won ? [392, 523.25, 659.25, 783.99] : [392, 329.63, 261.63, 196];
    const now = ctx.currentTime;
    notes.forEach((freq, i) => {
      const start = now + i * 0.16;
      const osc = ctx.createOscillator();
      osc.type = won ? "triangle" : "sawtooth";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(won ? 0.16 : 0.08, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
      osc.connect(gain).connect(this.master!);
      osc.start(start);
      osc.stop(start + 0.55);
    });
  }

  private ensure(): AudioContext | null {
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.context.destination);
        this.shotBuffer = this.makeNoise(this.context, 0.3);
        this.longNoise = this.makeNoise(this.context, 2.4);
      }
      if (this.context.state === "suspended") void this.context.resume();
      return this.context;
    } catch {
      // Audio is optional. The game still plays without it.
      return null;
    }
  }

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** A slow pad under a short plucked arpeggio, with a soft echo. Runs until turned off. */
  private startMusic(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.musicTimer !== null) return;

    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, ctx.currentTime);
    bus.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 2);
    bus.connect(this.master);
    this.musicBus = bus;

    // Pad: two detuned saw waves through a low-pass whose cutoff slowly sways.
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.08;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 180;
    lfo.connect(lfoDepth).connect(filter.frequency);
    const padGain = ctx.createGain();
    padGain.gain.value = 0.05;
    for (const [freq, detune] of [
      [55, -6],
      [82.41, 7],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start();
      this.musicNodes.push(osc);
    }
    filter.connect(padGain).connect(bus);
    lfo.start();

    // Echo for the plucks.
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.375;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.4;
    delay.connect(feedback).connect(delay);
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.35;
    delay.connect(echoOut).connect(bus);

    // A minor-pentatonic arpeggio, chosen at random each beat.
    const scale = [220, 261.63, 293.66, 329.63, 392, 440, 523.25];
    this.musicTimer = window.setInterval(() => {
      const t = ctx.currentTime + 0.01;
      const freq = scale[Math.floor(Math.random() * scale.length)];
      const pluck = ctx.createOscillator();
      pluck.type = "triangle";
      pluck.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
      pluck.connect(gain);
      gain.connect(bus);
      gain.connect(delay);
      pluck.start(t);
      pluck.stop(t + 1);
    }, 1100);

    this.musicNodes.push(lfo, bus, filter, padGain, delay, feedback, echoOut, lfoDepth);
  }

  /** Fades the music out over about a second, then stops and frees its nodes. */
  private stopMusic(): void {
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    const ctx = this.context;
    if (!ctx || !this.musicBus) return;

    const nodes = this.musicNodes;
    const bus = this.musicBus;
    this.musicNodes = [];
    this.musicBus = null;
    bus.gain.cancelScheduledValues(ctx.currentTime);
    bus.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.3);

    window.setTimeout(() => {
      for (const node of nodes) {
        if (node instanceof OscillatorNode) {
          try {
            node.stop();
          } catch {
            // Already stopped.
          }
        }
        node.disconnect();
      }
    }, 1200);
  }
}
