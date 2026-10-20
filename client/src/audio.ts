// The score: 100 beats a minute, in sixteenth-note steps, four bars to the loop.
const BEAT = 0.6;
const STEP = BEAT / 4;
const BAR = BEAT * 4;
const BASS_STEPS = [0, 3, 6, 8, 11, 14];
const CHORDS = [
  { root: 55, notes: [220, 261.63, 329.63, 440] }, // A minor
  { root: 43.65, notes: [174.61, 220, 261.63, 349.23] }, // F
  { root: 65.41, notes: [261.63, 329.63, 392, 523.25] }, // C
  { root: 49, notes: [196, 246.94, 293.66, 392] }, // G
];

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
  private drumBus: GainNode | null = null;
  private leadBus: GainNode | null = null;
  private intensity = 0.4;
  private nextStepTime = 0;
  private step = 0;

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

  /** Someone drops into the crevasse: a long falling whistle with wind. */
  playFall(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.longNoise) return;
    const now = ctx.currentTime + 0.25;

    const whistle = ctx.createOscillator();
    whistle.type = "sine";
    whistle.frequency.setValueAtTime(980, now);
    whistle.frequency.exponentialRampToValueAtTime(110, now + 1.5);
    const whistleGain = ctx.createGain();
    whistleGain.gain.setValueAtTime(0.0001, now);
    whistleGain.gain.exponentialRampToValueAtTime(0.14, now + 0.1);
    whistleGain.gain.exponentialRampToValueAtTime(0.001, now + 1.6);
    whistle.connect(whistleGain).connect(this.master);
    whistle.start(now);
    whistle.stop(now + 1.7);

    const wind = ctx.createBufferSource();
    wind.buffer = this.longNoise;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.setValueAtTime(1200, now);
    band.frequency.exponentialRampToValueAtTime(300, now + 1.6);
    const windGain = ctx.createGain();
    windGain.gain.setValueAtTime(0.0001, now);
    windGain.gain.exponentialRampToValueAtTime(0.25, now + 0.2);
    windGain.gain.exponentialRampToValueAtTime(0.001, now + 1.8);
    wind.connect(band).connect(windGain).connect(this.master);
    wind.start(now);
    wind.stop(now + 2);
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

  /**
   * A looping score played by a small step sequencer: a pulsing bass, soft drums, chord pads, and a plucked
   * arpeggio over four chords (A minor, F, C, G). `setIntensity` fades the drums and lead in and out,
   * so the music builds when the lasers are about to fire. Runs until turned off.
   */
  private startMusic(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.musicTimer !== null) return;

    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, ctx.currentTime);
    bus.gain.exponentialRampToValueAtTime(0.55, ctx.currentTime + 2);
    // A gentle compressor keeps the layers together and keeps loud moments from clipping.
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -18;
    glue.ratio.value = 3;
    glue.connect(bus);
    bus.connect(this.master);
    this.musicBus = bus;

    const drums = ctx.createGain();
    const lead = ctx.createGain();
    const echo = ctx.createDelay(1);
    echo.delayTime.value = BEAT * 0.75;
    const echoFeedback = ctx.createGain();
    echoFeedback.gain.value = 0.38;
    const echoLevel = ctx.createGain();
    echoLevel.gain.value = 0.4;
    echo.connect(echoFeedback).connect(echo);
    echo.connect(echoLevel).connect(glue);
    drums.connect(glue);
    lead.connect(glue);
    lead.connect(echo);
    this.drumBus = drums;
    this.leadBus = lead;
    this.musicNodes.push(glue, drums, lead, echo, echoFeedback, echoLevel);
    this.applyIntensity();

    this.nextStepTime = ctx.currentTime + 0.1;
    this.step = 0;
    this.musicTimer = window.setInterval(() => {
      // If the tab was in the background, timers slow down. Skip ahead instead of playing a burst of old notes.
      if (this.nextStepTime < ctx.currentTime - 0.4) this.nextStepTime = ctx.currentTime + 0.05;
      while (this.nextStepTime < ctx.currentTime + 0.25) {
        this.playStep(ctx, this.step, this.nextStepTime, glue);
        this.nextStepTime += STEP;
        this.step = (this.step + 1) % (16 * CHORDS.length);
      }
    }, 40);
  }

  /** How driving the music is, from 0 (calm, mostly pad and bass) to 1 (drums and lead at full). */
  setIntensity(level: number): void {
    this.intensity = Math.min(1, Math.max(0, level));
    this.applyIntensity();
  }

  private applyIntensity(): void {
    const ctx = this.context;
    if (!ctx) return;
    this.drumBus?.gain.setTargetAtTime(0.15 + 0.85 * this.intensity, ctx.currentTime, 0.6);
    this.leadBus?.gain.setTargetAtTime(0.25 + 0.75 * this.intensity, ctx.currentTime, 0.6);
  }

  /** Everything that sounds on one sixteenth-note step of the loop. */
  private playStep(ctx: AudioContext, index: number, time: number, out: AudioNode): void {
    const bar = Math.floor(index / 16);
    const step = index % 16;
    const chord = CHORDS[bar];

    // Pad: the chord holds for the whole bar and swells in.
    if (step === 0) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(500, time);
      filter.frequency.linearRampToValueAtTime(1300, time + BAR * 0.6);
      filter.frequency.linearRampToValueAtTime(600, time + BAR);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.linearRampToValueAtTime(0.055, time + 0.9);
      gain.gain.linearRampToValueAtTime(0.0001, time + BAR + 0.5);
      for (const freq of chord.notes) {
        for (const detune of [-7, 7]) {
          const osc = ctx.createOscillator();
          osc.type = "sawtooth";
          osc.frequency.value = freq;
          osc.detune.value = detune;
          osc.connect(filter);
          osc.start(time);
          osc.stop(time + BAR + 0.6);
        }
      }
      filter.connect(gain).connect(out);
    }

    // Bass: a pulsing root note, with a jump up to the octave to keep it moving.
    if (BASS_STEPS.includes(step)) {
      const high = step === 14 || step === 11;
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = chord.root * (high ? 2 : 1);
      const low = ctx.createBiquadFilter();
      low.type = "lowpass";
      low.frequency.setValueAtTime(700, time);
      low.frequency.exponentialRampToValueAtTime(160, time + STEP * 2.2);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(0.2, time + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, time + STEP * 2.6);
      osc.connect(low).connect(gain).connect(out);
      osc.start(time);
      osc.stop(time + STEP * 2.8);
    }

    // Drums go through their own level, so they can fade in as the tension rises.
    const drums = this.drumBus;
    if (drums) {
      if (step === 0 || step === 10) this.kick(ctx, time, drums, 0.8);
      if (step === 4 || step === 12) this.kick(ctx, time, drums, 0.35);
      if (step === 4 || step === 12) this.snare(ctx, time, drums);
      if (step % 2 === 0) this.hat(ctx, time, drums, step % 4 === 2 ? 0.07 : 0.04);
    }

    // Lead: a plucked arpeggio of the chord, up an octave, on every other step.
    const lead = this.leadBus;
    if (lead && step % 2 === 0) {
      const pattern = [0, 1, 2, 3, 2, 1, 2, 1];
      const tone = chord.notes[pattern[(step / 2) % pattern.length]] * 2;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = tone;
      const tail = ctx.createOscillator();
      tail.type = "square";
      tail.frequency.value = tone;
      const tone2 = ctx.createGain();
      tone2.gain.value = 0.18;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(0.1, time + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.45);
      osc.connect(gain);
      tail.connect(tone2).connect(gain);
      gain.connect(lead);
      osc.start(time);
      tail.start(time);
      osc.stop(time + 0.5);
      tail.stop(time + 0.5);
    }
  }

  private kick(ctx: AudioContext, time: number, out: AudioNode, level: number): void {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(140, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.14);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5 * level, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
    osc.connect(gain).connect(out);
    osc.start(time);
    osc.stop(time + 0.32);
  }

  private snare(ctx: AudioContext, time: number, out: AudioNode): void {
    if (!this.shotBuffer) return;
    const noise = ctx.createBufferSource();
    noise.buffer = this.shotBuffer;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1800;
    band.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
    noise.connect(band).connect(gain).connect(out);
    noise.start(time);
    noise.stop(time + 0.2);
  }

  private hat(ctx: AudioContext, time: number, out: AudioNode, level: number): void {
    if (!this.shotBuffer) return;
    const noise = ctx.createBufferSource();
    noise.buffer = this.shotBuffer;
    const high = ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 7000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    noise.connect(high).connect(gain).connect(out);
    noise.start(time);
    noise.stop(time + 0.07);
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
    this.drumBus = null;
    this.leadBus = null;
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
      bus.disconnect();
    }, 1200);
  }
}
