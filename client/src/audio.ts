/** The composed soundtrack: files made by tools/compose/compose.py. Every match stem has the same length and tempo. */
const MUSIC_URL = "/music/";
const MATCH_STEMS = ["bed", "pulse", "drive"] as const;
type MusicScene = "menu" | "match";

/** The announcer: clips rendered ahead of time by tools/voice/render_voice.py. */
const VOICE_URL = "/voice/";
const COLOR_PHRASES = ["red", "blue", "yellow", "green", "purple", "pink", "cyan", "orange"];

/** One piece of an announcement: a fixed phrase, or a player (called by name, or by color if the name has no clip). */
export type VoicePart = { phrase: string } | { name: string; color: number };

/** The first word of a player's name, letters only, in lower case. "Bot Ace" and "ace_77" both become "ace". */
export function nameKey(name: string): string | null {
  const words = name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  if (words.length > 1 && words[0] === "bot") words.shift();
  const word = words.find((w) => w.length >= 2);
  return word ?? null;
}

/** 0 below `from`, 1 above `to`, smooth in between. */
function smoothstep(from: number, to: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

interface PlayingMusic {
  scene: MusicScene;
  out: GainNode;
  stems: Partial<Record<(typeof MATCH_STEMS)[number], GainNode>>;
  sources: AudioBufferSourceNode[];
}

/**
 * Sound effects and the voice are generated in code with the Web Audio API. The music is composed and rendered
 * ahead of time (see tools/compose). The browser only allows audio after a user gesture, so the context is
 * created on first use.
 */
export class Audio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private shotBuffer: AudioBuffer | null = null;
  private longNoise: AudioBuffer | null = null;
  private playing: PlayingMusic | null = null;
  private scene: MusicScene = "menu";
  private music = new Map<string, AudioBuffer>();
  private musicLoads = new Map<string, Promise<AudioBuffer | null>>();
  private musicOn = false;
  private volume = 0.8;
  private intensity = 0.4;
  private voiceOn = true;
  private voiceManifest: Promise<{ names: Set<string>; phrases: string[] } | null> | null = null;
  private voiceLoads = new Map<string, Promise<AudioBuffer | null>>();
  /** When the announcer finishes the line that is playing, so the next one waits its turn. */
  private voiceFreeAt = 0;

  get isMusicOn(): boolean {
    return this.musicOn;
  }

  /** True once the browser has let the page make sound, which needs a tap or click first. */
  get isRunning(): boolean {
    return this.context?.state === "running";
  }

  /** Sets the master volume for every sound, from 0 to 1. */
  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.05);
    }
  }

  /** Turns the spoken announcements on or off. */
  setVoice(on: boolean): void {
    this.voiceOn = on;
  }

  /**
   * Gets the announcer ready: the list of names that have recorded clips, the fixed phrases, and a clip for each
   * of the given player names. Call it as soon as the names are known, so the lines play the instant they are needed.
   */
  async prepareVoice(playerNames: string[] = []): Promise<void> {
    if (!this.ensure()) return;
    try {
      if (!this.voiceManifest) {
        this.voiceManifest ??= fetch(`${VOICE_URL}manifest.json`)
          .then((response) => (response.ok ? response.json() : null))
          .then((json: { names: string[]; phrases: string[] } | null) =>
            json ? { names: new Set(json.names), phrases: json.phrases } : null,
          )
          .catch(() => null);
      }
      const manifest = await this.voiceManifest;
      if (!manifest) {
        this.voiceManifest = null;
        return;
      }
      const wanted = manifest.phrases.map((id) => `phrases/${id}`);
      for (const name of playerNames) {
        const key = nameKey(name);
        if (key && manifest.names.has(key)) wanted.push(`names/${key}`);
      }
      await Promise.all(wanted.map((path) => this.loadVoiceClip(path)));
    } catch {
      // The announcer is optional. Banners and the feed show the same news.
    }
  }

  private loadVoiceClip(path: string): Promise<AudioBuffer | null> {
    const cached = this.voiceLoads.get(path);
    if (cached) return cached;
    const ctx = this.context;
    const pending = (async () => {
      if (!ctx) return null;
      try {
        const response = await fetch(`${VOICE_URL}${path}.mp3`);
        if (!response.ok) return null;
        return await ctx.decodeAudioData(await response.arrayBuffer());
      } catch {
        this.voiceLoads.delete(path);
        return null;
      }
    })();
    this.voiceLoads.set(path, pending);
    return pending;
  }

  /**
   * Calls out a line made of recorded clips, such as "Ace" + "was eliminated by" + "Blitz". A player whose name has
   * no clip is called by their color instead ("Red robot"). Lines never overlap: a new one waits for the last.
   */
  async announce(parts: VoicePart[]): Promise<void> {
    const ctx = this.ensure();
    if (!this.voiceOn || !ctx || !this.master || this.volume === 0) return;
    const manifest = await this.voiceManifest;
    if (!manifest) {
      void this.prepareVoice();
      return;
    }
    const buffers: AudioBuffer[] = [];
    for (const part of parts) {
      let path: string;
      if ("phrase" in part) {
        path = `phrases/${part.phrase}`;
      } else {
        const key = nameKey(part.name);
        path = key && manifest.names.has(key) ? `names/${key}` : `phrases/${COLOR_PHRASES[part.color % COLOR_PHRASES.length]}`;
      }
      const buffer = await this.loadVoiceClip(path);
      // A missing clip is skipped rather than leaving the whole line silent.
      if (buffer) buffers.push(buffer);
    }
    if (buffers.length === 0) return;

    const now = ctx.currentTime;
    let at = Math.max(now + 0.02, this.voiceFreeAt);
    // A line that would start many seconds late is no longer news.
    if (at - now > 5) return;
    const start = at;
    for (const buffer of buffers) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = 1.15;
      source.connect(gain).connect(this.master);
      source.start(at);
      at += buffer.duration + 0.04;
    }
    this.voiceFreeAt = at;

    // Lower the music while the announcer talks, so every word is clear.
    const music = this.playing?.out;
    if (music) {
      music.gain.cancelScheduledValues(now);
      music.gain.setTargetAtTime(0.4, Math.max(now, start - 0.05), 0.08);
      music.gain.setTargetAtTime(this.playing?.scene === "menu" ? 0.9 : 1, at, 0.35);
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
      void this.startMusic();
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

  /** The sonar ping going out: a clean tone with a long, fading echo. */
  playSonar(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    for (const [offset, level] of [[0, 0.2], [0.28, 0.09], [0.56, 0.045]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(1500, now + offset);
      osc.frequency.exponentialRampToValueAtTime(980, now + offset + 0.35);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(level, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.5);
      osc.connect(gain).connect(this.master);
      osc.start(now + offset);
      osc.stop(now + offset + 0.55);
    }
  }

  /** A low, uneasy double pulse: something found you. */
  playSonarAlert(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    for (const offset of [0, 0.16]) {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = 330;
      const low = ctx.createBiquadFilter();
      low.type = "lowpass";
      low.frequency.value = 700;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.13);
      osc.connect(low).connect(gain).connect(this.master);
      osc.start(now + offset);
      osc.stop(now + offset + 0.15);
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
    const stinger = this.music.get(won ? "win" : "lose");
    if (stinger) {
      const source = ctx.createBufferSource();
      source.buffer = stinger;
      source.connect(this.master);
      source.start();
      return;
    }
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

  /** Chooses which piece plays: the calm menu theme, or the match score. Fades from one to the other. */
  setScene(scene: MusicScene): void {
    this.scene = scene;
    if (this.musicOn && this.playing?.scene !== scene) void this.startMusic();
  }

  /** How driving the match music is, from 0 (pads and a slow pulse) to 1 (full drums and lead). */
  setIntensity(level: number): void {
    this.intensity = Math.min(1, Math.max(0, level));
    this.applyIntensity();
  }

  private applyIntensity(): void {
    const ctx = this.context;
    const stems = this.playing?.stems;
    if (!ctx || !stems) return;
    stems.pulse?.gain.setTargetAtTime(smoothstep(0.1, 0.5, this.intensity), ctx.currentTime, 0.7);
    stems.drive?.gain.setTargetAtTime(smoothstep(0.6, 0.95, this.intensity), ctx.currentTime, 0.5);
  }

  /** Fetches and decodes one music file, once. Failures return null and the game simply plays without it. */
  private loadMusic(name: string): Promise<AudioBuffer | null> {
    const cached = this.musicLoads.get(name);
    if (cached) return cached;
    const ctx = this.ensure();
    const pending = (async () => {
      if (!ctx) return null;
      try {
        const response = await fetch(`${MUSIC_URL}${name}.mp3`);
        if (!response.ok) return null;
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        this.music.set(name, buffer);
        return buffer;
      } catch {
        this.musicLoads.delete(name);
        return null;
      }
    })();
    this.musicLoads.set(name, pending);
    return pending;
  }

  /** Quietly fetches the rest of the soundtrack once the menu theme is playing, so it is ready for the match. */
  private preloadRest(): void {
    void (async () => {
      for (const name of [...MATCH_STEMS.map((stem) => `match-${stem}`), "win", "lose"]) {
        await this.loadMusic(name);
      }
    })();
  }

  private async startMusic(): Promise<void> {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const scene = this.scene;
    const names = scene === "menu" ? ["menu"] : MATCH_STEMS.map((stem) => `match-${stem}`);
    const buffers = await Promise.all(names.map((name) => this.loadMusic(name)));
    // The player may have switched scene or turned music off while the files were loading.
    if (!this.musicOn || this.scene !== scene || this.playing?.scene === scene) return;
    if (buffers.some((buffer) => buffer === null)) return;

    const now = ctx.currentTime;
    this.fadeOutMusic(1.4);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(scene === "menu" ? 0.9 : 1, now + 1.6);
    out.connect(this.master);

    const playing: PlayingMusic = { scene, out, stems: {}, sources: [] };
    // Every stem starts at the same instant, so they stay in time with each other for as long as they loop.
    const startAt = now + 0.05;
    buffers.forEach((buffer, index) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = ctx.createGain();
      source.connect(gain).connect(out);
      if (scene === "match") {
        const stem = MATCH_STEMS[index];
        playing.stems[stem] = gain;
        gain.gain.value = stem === "bed" ? 1 : 0;
      }
      source.start(startAt);
      playing.sources.push(source);
    });
    this.playing = playing;
    this.applyIntensity();
    if (scene === "menu") this.preloadRest();
  }

  /** Fades the current music out over `seconds`, then frees it. */
  private fadeOutMusic(seconds: number): void {
    const ctx = this.context;
    const old = this.playing;
    this.playing = null;
    if (!ctx || !old) return;
    old.out.gain.cancelScheduledValues(ctx.currentTime);
    old.out.gain.setTargetAtTime(0.0001, ctx.currentTime, seconds / 4);
    window.setTimeout(() => {
      for (const source of old.sources) {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      }
      old.out.disconnect();
    }, seconds * 1000 + 300);
  }

  private stopMusic(): void {
    this.fadeOutMusic(1);
  }
}
