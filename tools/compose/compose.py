"""
Composes the Laser Ring soundtrack and renders it to MP3 files in client/public/music.

Everything here is original: the melodies, chords and arrangement are written below, and the sounds come from
the small synthesizer in synth.py. There are no samples and nothing to license.

Run:  python3 tools/compose/compose.py
"""
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from synth import *  # noqa: F401,F403
import synth as S

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "client", "public", "music")
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- harmony
# Key of A minor. Each chord: voicing for pads (midi), bass root (midi).
CH = {
    "Am": ([57, 60, 64, 69], 45),
    "F": ([57, 60, 65, 69], 41),
    "C": ([55, 60, 64, 67], 48),
    "G": ([55, 59, 62, 67], 43),
    "Dm": ([57, 62, 65, 69], 38),
    "E": ([56, 59, 64, 68], 40),
    "Em": ([55, 59, 64, 67], 40),
}
PROG = (
    ["Am", "F", "C", "G", "Am", "F", "Dm", "E"]          # A
    + ["Am", "F", "C", "G", "Am", "F", "Dm", "E"]        # A, played again with more weight
    + ["F", "G", "Am", "Em", "F", "G", "Am", "E"]        # B: the lift
    + ["Am", "F", "C", "G", "Am", "F", "E", "E"]         # A, home again
)

# ---------------------------------------------------------------- melody: (beat in bar, midi, length in beats)
P1 = {
    0: [(0, 76, 1.5), (1.5, 74, .5), (2, 72, 1), (3, 69, 1)],
    1: [(0, 72, 1.5), (1.5, 69, .5), (2, 69, 2)],
    2: [(0, 67, 1), (1, 72, 1), (2, 76, 1.5), (3.5, 74, .5)],
    3: [(0, 71, 2), (2, 74, 1), (3, 67, 1)],
}
P2 = {
    0: [(0, 76, 1.5), (1.5, 74, .5), (2, 72, 1), (3, 76, 1)],
    1: [(0, 77, 1.5), (1.5, 76, .5), (2, 72, 2)],
    2: [(0, 74, 1), (1, 77, 1), (2, 76, 1), (3, 74, 1)],
    3: [(0, 68, 1), (1, 71, 1), (2, 76, 2)],
}
P2_END = dict(P2)
P2_END[2] = [(0, 68, 1), (1, 71, 1), (2, 74, 1), (3, 71, 1)]
P2_END[3] = [(0, 68, 3), (3, 71, 1)]
B = {
    0: [(0, 81, 2), (2, 84, 2)],
    1: [(0, 83, 2), (2, 79, 2)],
    2: [(0, 76, 3), (3, 74, 1)],
    3: [(0, 71, 2), (2, 76, 2)],
    4: [(0, 81, 2), (2, 84, 2)],
    5: [(0, 86, 2), (2, 83, 2)],
    6: [(0, 84, 3), (3, 88, 1)],
    7: [(0, 80, 2), (2, 83, 2)],
}


def melody_notes():
    """Every melody note as (bar, beat, midi, length)."""
    notes = []
    for bar0, phrase in ((0, P1), (4, P2), (8, P1), (12, P2), (24, P1), (28, P2_END)):
        for i, ns in phrase.items():
            for beat, midi, length in ns:
                notes.append((bar0 + i, beat, midi, length))
    for i, ns in B.items():
        for beat, midi, length in ns:
            notes.append((16 + i, beat, midi, length))
    return notes


MELODY = melody_notes()
BARS = 32


class Piece:
    def __init__(self, bpm, bars=BARS, tail=4.0):
        self.bpm = bpm
        self.beat = 60.0 / bpm
        self.bar = self.beat * 4
        self.bars = bars
        self.length = self.bar * bars
        self.tail = tail

    def track(self):
        return Track(self.length + self.tail)

    def at(self, bar, beat=0.0):
        return bar * self.bar + beat * self.beat

    def seconds(self, beats):
        return beats * self.beat

    def finish(self, track, wet=0.3, loop=True, **reverb_kw):
        """Adds reverb, then folds the tail onto the start so the loop has no seam."""
        buf = track.buf
        buf = S.reverb(buf, wet=wet, **reverb_kw)
        n = int(self.length * S.SR)
        out = buf[:n].copy()
        if loop:
            tail = buf[n:]
            out[: len(tail)] += tail
        return out


def render_stems(p):
    # ---------------------------------------------------------------- BED: pads, sub bass, ice shimmer, wind
    bed = p.track()
    for b, name in enumerate(PROG):
        voicing, root = CH[name]
        for k, m in enumerate(voicing):
            bed.put(p.at(b), pad_note(m, p.bar * 1.15, 0.55, bright=900 + 500 * (b >= 16 and b < 24)), 0.5,
                    pan=(-0.5, -0.17, 0.17, 0.5)[k])
        bed.put(p.at(b), sub_note(root, p.bar * 1.05), 0.55)
        if b % 2 == 0:
            bed.put(p.at(b, 2.0), bell_note(voicing[-1] + 12, 4.0, 0.5), 0.35, pan=0.4 if b % 4 == 0 else -0.4)
    w = S.wind(bed.n / S.SR)
    bed.buf[: len(w)] += w
    bed.buf = S.chorus(bed.buf, mix=0.35)

    # ---------------------------------------------------------------- PULSE: arpeggio, muted heartbeat, bass, quiet bells
    pulse = p.track()
    pattern = [0, 2, 1, 3, 2, 1, 3, 2]
    for b, name in enumerate(PROG):
        voicing, root = CH[name]
        for i, idx in enumerate(pattern):
            note = voicing[idx % 4] + 12 + (12 if idx == 3 else 0)
            vel = 0.8 if i % 2 == 0 else 0.55
            pulse.put(p.at(b, i * 0.5), pluck_note(note, p.beat * 0.9, vel), 0.55, pan=-0.3 if i % 2 else 0.3)
        # bass: root on the beat, octave leap on the "and" of 3
        for beat, octave, length in ((0, 0, 0.9), (1.5, 0, 0.45), (2, 0, 0.9), (3.5, 12, 0.45)):
            pulse.put(p.at(b, beat), bass_note(root + octave, p.seconds(length)), 0.5)
        pulse.put(p.at(b, 0), tom(62, 0.6), 0.55)
        pulse.put(p.at(b, 2.5), tom(58, 0.35), 0.4)
        for i in range(8):
            pulse.put(p.at(b, i * 0.5), hat(0.45 if i % 2 else 0.3), 0.5)
    # the melody on quiet bells, in the A sections
    for bar, beat, midi, length in MELODY:
        if bar < 16 or bar >= 24:
            pulse.put(p.at(bar, beat), bell_note(midi + 12, min(3.0, p.seconds(length) + 1.2), 0.7), 0.35, pan=0.3)
    pulse.buf = S.pingpong(pulse.buf, p.beat * 0.75, 0.4, 0.3)

    # ---------------------------------------------------------------- DRIVE: drums, lead, driving bass, fills, risers
    drive = p.track()
    kicks = []
    for b, name in enumerate(PROG):
        voicing, root = CH[name]
        for beat in range(4):
            kicks.append(p.at(b, beat))
            drive.put(p.at(b, beat), kick(0.95 if beat % 2 == 0 else 0.8), 0.85)
        if b >= 4:
            for beat in (1, 3):
                drive.put(p.at(b, beat), snare(0.9), 0.6)
                drive.put(p.at(b, beat), clap(0.7), 0.35)
        for i in range(8):
            drive.put(p.at(b, i * 0.5), hat(0.6 if i % 2 else 0.35), 0.6)
        drive.put(p.at(b, 1.5), hat(0.8, open_=True), 0.4)
        drive.put(p.at(b, 3.5), hat(0.8, open_=True), 0.4)
        # driving 8th-note bass
        for i in range(8):
            note = root + (12 if i in (3, 7) else 0)
            drive.put(p.at(b, i * 0.5), bass_note(note, p.beat * 0.45, 0.85 if i % 2 == 0 else 0.6, cutoff=520), 0.55)
        # pad weight under the chorus
        if 8 <= b < 24:
            for m in voicing:
                drive.put(p.at(b), strings_note(m, p.bar * 1.05, 0.55), 0.3)
        # fills and impacts at the end of each 8-bar phrase
        if b % 8 == 7:
            for i, f in enumerate((70, 66, 62, 58)):
                drive.put(p.at(b, 3 + i * 0.25), tom(f, 0.8), 0.5)
            drive.put(p.at(b, 2), riser(p.seconds(2)), 0.8)
        if b % 8 == 0:
            drive.put(p.at(b), crash(1.0), 0.8)
    # lead: the tune, with a doubled octave of bells in the lift
    for bar, beat, midi, length in MELODY:
        if bar >= 8:
            drive.put(p.at(bar, beat), lead_note(midi, p.seconds(length) * 0.97 + 0.1, 0.75 if bar < 16 else 0.9), 0.5, pan=-0.1)
            if 16 <= bar < 24:
                drive.put(p.at(bar, beat), bell_note(midi + 12, 2.5, 0.8), 0.3, pan=0.35)
    drive.duck(kicks, depth=0.35, release=0.14)
    drive.buf = S.pingpong(drive.buf, p.beat * 0.75, 0.35, 0.25)

    return {
        "bed": p.finish(bed, wet=0.34, seconds=3.2, decay=1.4),
        "pulse": p.finish(pulse, wet=0.26, seconds=2.4, decay=1.0),
        "drive": p.finish(drive, wet=0.18, seconds=1.8, decay=0.8),
    }


def render_menu():
    """A calmer take: electric piano, strings and bells over a slow pulse. No drums."""
    p = Piece(84)
    t = p.track()
    for b, name in enumerate(PROG):
        voicing, root = CH[name]
        for k, m in enumerate(voicing[:3]):
            t.put(p.at(b), strings_note(m, p.bar * 1.1, 0.6), 0.4, pan=(-0.4, 0.0, 0.4)[k])
        t.put(p.at(b), sub_note(root, p.bar), 0.55)
        # slow rolling piano arpeggio, eighth notes
        for i, idx in enumerate([0, 1, 2, 3, 2, 1, 2, 1]):
            note = voicing[idx] + (12 if idx < 2 else 0)
            t.put(p.at(b, i * 0.5), epiano_note(note, p.beat * 1.6, 0.5 if i % 2 else 0.65), 0.34, pan=-0.2 + 0.4 * (i % 2))
    for bar, beat, midi, length in MELODY:
        instrument = epiano_note if bar < 16 or bar >= 24 else strings_note
        dur = p.seconds(length) + 0.6
        t.put(p.at(bar, beat), instrument(midi, dur, 0.9), 0.5, pan=0.15)
        if bar % 4 < 2:
            t.put(p.at(bar, beat), bell_note(midi + 12, 2.2, 0.5), 0.18, pan=-0.3)
    w = S.wind(t.n / S.SR)
    t.buf[: len(w)] += w * 0.8
    t.buf = S.chorus(t.buf, mix=0.3)
    t.buf = S.pingpong(t.buf, p.beat * 0.75, 0.4, 0.22)
    return p.finish(t, wet=0.42, seconds=3.6, decay=1.7)


def render_stinger(kind):
    """Short phrases for the end of a match."""
    p = Piece(100, bars=3, tail=4.0)
    t = p.track()
    if kind == "win":
        chords = [("C", [60, 64, 67, 72]), ("G", [59, 62, 67, 71]), ("Am", [57, 60, 64, 69]), ("F", [60, 65, 69, 72])]
        for i, (_, notes) in enumerate(chords):
            for m in notes:
                t.put(p.at(0, i * 1.5), strings_note(m, 2.4, 0.9), 0.35)
            t.put(p.at(0, i * 1.5), bass_note(notes[0] - 24, 0.9, 1.0, cutoff=520), 0.6)
        for i, m in enumerate([72, 76, 79, 84, 88]):
            t.put(p.at(0, 0.5 + i * 0.5), bell_note(m, 3.0, 1.0), 0.5, pan=-0.3 + 0.15 * i)
        for m in (60, 64, 67, 72, 76):
            t.put(p.at(1, 2.0), lead_note(m, 2.8, 0.9), 0.3)
        t.put(p.at(1, 2.0), sub_note(36, 3.0), 0.7)
        t.put(p.at(1, 2.0), kick(1.0), 0.8)
        t.put(p.at(1, 2.0), crash(1.0, 3.5), 0.7)
        return p.finish(t, wet=0.35, loop=False, seconds=3.0, decay=1.3)
    chords = [("Am", [57, 60, 64]), ("Dm", [57, 62, 65]), ("E", [56, 59, 64])]
    for i, (_, notes) in enumerate(chords):
        for m in notes:
            t.put(p.at(0, i * 2.0), pad_note(m, 3.6, 0.8, bright=700), 0.4)
        t.put(p.at(0, i * 2.0), sub_note(notes[0] - 24, 3.0), 0.7)
    for i, m in enumerate([76, 72, 69, 64]):
        t.put(p.at(0, i * 1.5), epiano_note(m, 2.4, 0.7), 0.45)
    t.put(p.at(1, 2.0), tom(52, 1.0), 0.8)
    return p.finish(t, wet=0.4, loop=False, seconds=3.4, decay=1.6)


# ---------------------------------------------------------------- output
def normalize(arrays, ceiling=0.7):
    """Scale a set of stems by one factor, so they keep their balance and their sum never clips."""
    total = sum(arrays.values())
    gain = ceiling / max(float(np.max(np.abs(total))), 1e-6)
    return {k: v * gain for k, v in arrays.items()}, gain


def write_mp3(name, stereo, kbps=160):
    wav = os.path.join(OUT, name + ".wav")
    pcm = (np.clip(stereo, -1, 1) * 32767).astype("<i2")
    import wave
    with wave.open(wav, "wb") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(S.SR)
        f.writeframes(pcm.tobytes())
    mp3 = os.path.join(OUT, name + ".mp3")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-codec:a", "libmp3lame", "-b:a", f"{kbps}k", mp3], check=True)
    os.remove(wav)
    print(f"{name}.mp3  {os.path.getsize(mp3) / 1e6:.2f} MB  {len(stereo) / S.SR:.1f} s")


if __name__ == "__main__":
    stems = render_stems(Piece(100))
    stems, gain = normalize(stems)
    # The stems are played together, so each is balanced against the others and saved on its own.
    for name, audio in stems.items():
        write_mp3(f"match-{name}", audio)
    menu, _ = normalize({"menu": render_menu()}, ceiling=0.6)
    write_mp3("menu", menu["menu"])
    for kind in ("win", "lose"):
        out, _ = normalize({kind: render_stinger(kind)}, ceiling=0.7)
        write_mp3(kind, out[kind], kbps=160)
