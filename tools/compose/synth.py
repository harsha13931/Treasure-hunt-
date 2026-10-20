"""A small software synthesizer: oscillators, drums, effects. Pure numpy and scipy, so the music is reproducible."""
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 44100
rng = np.random.default_rng(7)


def hz(midi):
    return 440.0 * 2.0 ** ((np.asarray(midi, dtype=float) - 69.0) / 12.0)


def t_axis(seconds):
    return np.arange(int(seconds * SR)) / SR


def adsr(n, a, d, s, r):
    """Amplitude envelope over n samples (times in seconds, s is the sustain level)."""
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    a_n, r_n = min(a_n, n), min(r_n, n)
    sus_n = max(0, n - a_n - d_n - r_n)
    env = np.concatenate([
        np.linspace(0, 1, a_n, endpoint=False),
        np.linspace(1, s, d_n, endpoint=False),
        np.full(sus_n, s),
        np.linspace(s, 0, r_n),
    ])
    if len(env) < n:
        env = np.pad(env, (0, n - len(env)))
    return env[:n]


def polyblep_saw(freq, n, phase0=0.0):
    f = np.full(n, freq) if np.isscalar(freq) else freq
    dt = f / SR
    phase = (phase0 + np.cumsum(dt)) % 1.0
    y = 2.0 * phase - 1.0
    m = phase < dt
    x = phase[m] / dt[m]
    y[m] -= x + x - x * x - 1.0
    m = phase > 1.0 - dt
    x = (phase[m] - 1.0) / dt[m]
    y[m] -= x * x + x + x + 1.0
    return y


def lowpass(x, cutoff, order=2):
    sos = butter(order, min(cutoff, SR * 0.45) / (SR / 2), btype="low", output="sos")
    return sosfilt(sos, x, axis=0)


def highpass(x, cutoff, order=2):
    sos = butter(order, cutoff / (SR / 2), btype="high", output="sos")
    return sosfilt(sos, x, axis=0)


def bandpass(x, lo, hi, order=2):
    sos = butter(order, [lo / (SR / 2), min(hi, SR * 0.45) / (SR / 2)], btype="band", output="sos")
    return sosfilt(sos, x, axis=0)


def lp_sweep(x, f0, f1, chunks=48):
    """Low-pass whose cutoff glides from f0 to f1 over the length of x."""
    out = np.zeros_like(x)
    zi = None
    edges = np.linspace(0, len(x), chunks + 1).astype(int)
    for i in range(chunks):
        fc = f0 + (f1 - f0) * (i + 0.5) / chunks
        sos = butter(2, min(fc, SR * 0.45) / (SR / 2), btype="low", output="sos")
        if zi is None:
            zi = np.zeros((sos.shape[0], 2))
        seg, zi = sosfilt(sos, x[edges[i]:edges[i + 1]], zi=zi)
        out[edges[i]:edges[i + 1]] = seg
    return out


def stereo(mono, pan=0.0):
    """Constant-power pan. pan from -1 (left) to 1 (right)."""
    a = (pan + 1) * np.pi / 4
    return np.stack([mono * np.cos(a), mono * np.sin(a)], axis=1)


def chorus(x, depth=0.003, rate=0.35, mix=0.5):
    """Widens a stereo signal with slowly moving delays."""
    n = len(x)
    t = np.arange(n) / SR
    out = np.zeros_like(x)
    for ch, ph in ((0, 0.0), (1, 1.7)):
        d = (depth * (1 + np.sin(2 * np.pi * rate * t + ph)) + 0.004) * SR
        idx = np.clip(np.arange(n) - d, 0, n - 1)
        lo = idx.astype(int)
        frac = idx - lo
        hi = np.minimum(lo + 1, n - 1)
        out[:, ch] = x[lo, ch] * (1 - frac) + x[hi, ch] * frac
    return x * (1 - mix) + out * mix


def impulse(seconds=2.8, decay=1.15, brightness=5500):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = np.zeros((n, 2))
    for ch in range(2):
        noise = rng.standard_normal(n)
        noise = lowpass(noise, brightness, 1)
        ir[:, ch] = noise * np.exp(-t / decay * 3.0)
        # A few early reflections give the room its size.
        for delay in rng.uniform(0.012, 0.09, 7):
            ir[int(delay * SR), ch] += rng.uniform(0.3, 0.8) * (1 if rng.random() < 0.5 else -1)
    ir[:, 0] *= 1.0 / np.sqrt(np.sum(ir[:, 0] ** 2))
    ir[:, 1] *= 1.0 / np.sqrt(np.sum(ir[:, 1] ** 2))
    return ir


_IR_CACHE = {}


def reverb(x, wet=0.3, seconds=2.8, decay=1.15, brightness=5500):
    key = (seconds, decay, brightness)
    if key not in _IR_CACHE:
        _IR_CACHE[key] = impulse(seconds, decay, brightness)
    ir = _IR_CACHE[key]
    out = np.stack([fftconvolve(x[:, c], ir[:, c])[: len(x)] for c in range(2)], axis=1)
    return x * (1 - wet) + out * wet * 2.2


def pingpong(x, delay_s, feedback=0.45, mix=0.35, taps=7):
    out = x.copy()
    for k in range(1, taps + 1):
        shift = int(delay_s * SR * k)
        if shift >= len(x):
            break
        gain = mix * (feedback ** (k - 1))
        side = k % 2
        out[shift:, side] += x[: len(x) - shift, 1 - side] * gain
        out[shift:, 1 - side] += x[: len(x) - shift, side] * gain * 0.4
    return out


# ---------- instruments: each returns a stereo array of the note's own length ----------

def pad_note(midi, seconds, vel=1.0, bright=1100):
    n = int(seconds * SR)
    f = float(hz(midi))
    sig = np.zeros(n)
    for cents, ph in ((-9, 0.0), (0, 0.33), (9, 0.66)):
        sig += polyblep_saw(f * 2 ** (cents / 1200), n, ph)
    sig = lp_sweep(sig / 3, bright * 0.5, bright)
    env = adsr(n, 0.7, 0.4, 0.8, 0.9)
    return stereo(sig * env * vel)


def strings_note(midi, seconds, vel=1.0):
    n = int(seconds * SR)
    f = float(hz(midi))
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * np.arange(n) / SR) * np.minimum(1, np.arange(n) / (0.6 * SR))
    sig = np.zeros(n)
    for cents in (-6, 6):
        sig += polyblep_saw(f * 2 ** (cents / 1200) * vib, n, rng.random())
    sig = lowpass(sig / 2, 2400)
    return stereo(sig * adsr(n, 0.35, 0.3, 0.85, 0.5) * vel)


def bell_note(midi, seconds, vel=1.0):
    """Glassy FM bell with an inharmonic partial, like frozen chimes."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    f = float(hz(midi))
    index = 5.0 * np.exp(-t * 4.0)
    mod = np.sin(2 * np.pi * f * 3.5 * t) * index
    sig = np.sin(2 * np.pi * f * t + mod) * np.exp(-t * 1.7)
    sig += 0.35 * np.sin(2 * np.pi * f * 2.01 * t) * np.exp(-t * 3.0)
    return stereo(sig * vel * 0.5)


def epiano_note(midi, seconds, vel=1.0):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    f = float(hz(midi))
    mod = np.sin(2 * np.pi * f * t) * (1.6 * vel) * np.exp(-t * 3.5)
    tine = np.sin(2 * np.pi * f * 14 * t) * 0.15 * np.exp(-t * 18)
    sig = np.sin(2 * np.pi * f * t + mod) * np.exp(-t * 1.3) + tine
    sig *= adsr(n, 0.004, 0.0, 1.0, 0.25)
    return stereo(sig * vel * 0.6)


def pluck_note(midi, seconds, vel=1.0):
    n = int(seconds * SR)
    f = float(hz(midi))
    sig = polyblep_saw(f, n) + 0.5 * polyblep_saw(f * 1.004, n, 0.5)
    sig = lp_sweep(sig, 4200, 600, chunks=24)
    return stereo(sig * np.exp(-np.arange(n) / SR * 7.0) * vel * 0.5)


def lead_note(midi, seconds, vel=1.0):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    f = float(hz(midi)) * (1 + 0.003 * np.sin(2 * np.pi * 5.5 * t) * np.minimum(1, t / 0.25))
    sig = np.zeros(n)
    for cents, ph in ((-12, 0.0), (-4, 0.2), (4, 0.5), (12, 0.8)):
        sig += polyblep_saw(f * 2 ** (cents / 1200), n, ph)
    sig = lowpass(sig / 4, 3200)
    sig += 0.25 * np.sin(2 * np.pi * f * t)
    return stereo(sig * adsr(n, 0.01, 0.12, 0.7, 0.12) * vel * 0.8)


def bass_note(midi, seconds, vel=1.0, cutoff=380):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    f = float(hz(midi))
    sig = polyblep_saw(f, n) * 0.6 + np.sin(2 * np.pi * f * t) * 0.8
    sig = lp_sweep(sig, cutoff * 2.2, cutoff, chunks=16)
    return stereo(sig * adsr(n, 0.006, 0.08, 0.8, 0.08) * vel)


def sub_note(midi, seconds, vel=1.0):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    return stereo(np.sin(2 * np.pi * float(hz(midi)) * t) * adsr(n, 0.3, 0.2, 0.9, 0.6) * vel * 0.9)


# ---------- drums ----------

def kick(vel=1.0):
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 46 + 120 * np.exp(-t * 32)
    phase = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(phase) * np.exp(-t * 7.5)
    click = rng.standard_normal(n) * np.exp(-t * 600) * 0.25
    return stereo((body + click) * vel * 1.1)


def snare(vel=1.0):
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    noise = bandpass(rng.standard_normal(n), 1400, 9000) * np.exp(-t * 20)
    tone = np.sin(2 * np.pi * 185 * t) * np.exp(-t * 28) * 0.5
    return stereo((noise * 0.9 + tone) * vel * 0.8)


def clap(vel=1.0):
    n = int(0.3 * SR)
    t = np.arange(n) / SR
    noise = bandpass(rng.standard_normal(n), 900, 6000)
    env = sum(np.exp(-np.maximum(0, t - d) * 45) * (t >= d) for d in (0.0, 0.011, 0.023)) * 0.5
    env += np.exp(-t * 18) * 0.4
    return stereo(noise * env * vel * 0.7)


def hat(vel=1.0, open_=False):
    n = int((0.35 if open_ else 0.08) * SR)
    t = np.arange(n) / SR
    noise = highpass(rng.standard_normal(n), 7500)
    return stereo(noise * np.exp(-t * (12 if open_ else 70)) * vel * 0.35, pan=0.25)


def tom(freq, vel=1.0):
    n = int(0.4 * SR)
    t = np.arange(n) / SR
    f = freq * (1 + 0.6 * np.exp(-t * 14))
    return stereo(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 8) * vel * 0.8)


def crash(vel=1.0, seconds=2.5):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    noise = highpass(rng.standard_normal(n), 3500)
    return stereo(noise * np.exp(-t * 1.8) * vel * 0.3)


def riser(seconds, vel=1.0):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    out = lp_sweep(noise, 300, 9000, chunks=64) * (t / seconds) ** 2
    return stereo(out * vel * 0.35)


def wind(seconds, vel=1.0):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    noise = bandpass(rng.standard_normal(n), 250, 1400)
    lfo = 0.55 + 0.45 * np.sin(2 * np.pi * 0.07 * t) * np.sin(2 * np.pi * 0.031 * t + 1.0)
    return stereo(noise * lfo * vel * 0.12)


# ---------- the mix bus ----------

class Track:
    """A stereo canvas that notes are placed on, by time in seconds."""

    def __init__(self, seconds):
        self.n = int(seconds * SR)
        self.buf = np.zeros((self.n, 2))

    def put(self, start, sig, gain=1.0, pan=0.0):
        i = int(start * SR)
        if i >= self.n or i < 0:
            return
        sig = sig[: self.n - i]
        if pan:
            mid = sig.mean(axis=1, keepdims=True)
            sig = sig * (1 - abs(pan)) + stereo(mid[:, 0], pan) * abs(pan)
        self.buf[i:i + len(sig)] += sig * gain

    def duck(self, hits, depth=0.55, release=0.16):
        """Pump the whole track down on each kick, the way dance music breathes."""
        t = np.arange(self.n) / SR
        gain = np.ones(self.n)
        for h in hits:
            m = t >= h
            gain = np.minimum(gain, 1 - depth * np.exp(-(t - h) / release) * m)
        self.buf *= gain[:, None]
