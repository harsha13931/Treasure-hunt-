"""
Renders the announcer's voice lines to small MP3 files in client/public/voice.

The voice is Piper's "en_US-joe-medium" (a neural text-to-speech voice, CC0 / public domain), run offline here, so
the game ships ready-made clips and needs no speech service while it runs.

  phrases/<id>.mp3   fixed lines, such as "was eliminated by"
  names/<name>.mp3   one clip for each first name in the dictionary
  manifest.json      which names have clips

Run:  pip install piper-tts joe-us-piper-voice faker numpy scipy
      python3 tools/voice/render_voice.py
Needs ffmpeg.
"""
import json
import os
import re
import subprocess
import tempfile
import wave

import numpy as np
from scipy.signal import butter, sosfilt

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "client", "public", "voice")
SR = 22050

# Fixed lines. The keys are what the game asks for.
PHRASES = {
    "was_eliminated_by": "was eliminated by",
    "you_were_eliminated_by": "You were eliminated by",
    "fell": "fell into the crevasse",
    "you_fell": "You fell into the crevasse",
    "wins": "wins the match",
    "you_win": "You win the match",
    "and": "and",
    "you": "you",
    "final_stand": "Final stand",
    "cracking": "The floor is cracking",
    "red": "Red robot",
    "blue": "Blue robot",
    "yellow": "Yellow robot",
    "green": "Green robot",
    "purple": "Purple robot",
    "pink": "Pink robot",
    "cyan": "Cyan robot",
    "orange": "Orange robot",
}

CAPS = {"en_US": 400, "en_GB": 300, "en_IN": 400, "en_AU": 200, "en_CA": 200, "en_IE": 100, "en_NZ": 100,
        "ta_IN": 150, "te_IN": 150, "bn_BD": 100, "ne_NP": 80, "hi_IN": 150}

EXTRA_NAMES = """
ace blitz cobra dash echo fang ghost hawk zed max neo ninja viper shadow storm blaze frost rex nova rogue spark
titan wolf raven phoenix jinx koda luna orion pixel quinn riot sage tank vega wraith yuki zeus bolt axel
harsha naga ravi priya kumar sangeetha lakshmi ramesh suresh mahesh ganesh dinesh rajesh naresh mukesh yogesh
venkat venkatesh srinivas sai saikiran kiran karthik kartik arun anil sunil vijay ajay sanjay sanjeev rahul rohit
rohan raj raju ram rama rao reddy naidu murthy babu chandra chandu mohan mohit manoj manish nikhil nitin nithin
pavan pawan praveen prasad prakash pradeep pranav prashanth rakesh ramya revathi swathi sneha divya deepa deepak
deepika anitha anjali ananya aditya abhishek amit amar ankit ashok ashwin bharath bharat gopal gopi hari hema
jagadish jaya jayanth kavya kavitha keerthi krishna madhavi meena meera mohana mounika naveen neha nandini
padma pooja radha rani rekha ritu roja sandeep sandhya sarath satish shiva shankar shyam sita sowmya srikanth
srinu sudhir sumanth suman surya sushma tarun uday uma usha vamsi varun vasu vedha vignesh vikram vinay vinod
vishnu vivek yash yamini ismail ahmed ali omar hassan hussain fatima aisha zara zoya imran irfan salman
sam alex chris david james john mike tom tim ben dan joe leo max sam jack jake luke noah liam ethan mason
emma olivia sophia mia ava lily ella grace chloe zoe ruby maya nina sara anna lisa kate amy
""".split()


def collect_names():
    from faker import Faker

    locales = ["en_US", "en_GB", "en_IN", "en_AU", "en_CA", "en_IE", "en_NZ", "es_ES", "es_MX", "fr_FR", "de_DE",
               "it_IT", "pt_BR", "nl_NL", "tr_TR", "pl_PL", "sv_SE", "da_DK", "fi_FI", "cs_CZ", "id_ID", "vi_VN",
               "tl_PH", "ar_AA", "fa_IR", "ta_IN", "te_IN", "bn_BD", "ne_NP", "hi_IN", "hy_AM", "az_AZ", "ko_KR", "ja_JP"]
    seen = {}
    for loc in locales:
        try:
            fake = Faker(loc)
            provider = [p for p in fake.providers if hasattr(p, "first_names")][-1]
            pool = list(getattr(provider, "first_names", []))
        except Exception:
            continue
        # Long lists are ordered by how common a name is, so keep the common end. English and Indian names get the
        # most room, since those are the names players are most likely to type.
        for name in pool[: CAPS.get(loc, 60)]:
            key = re.sub(r"[^a-z]", "", name.lower())
            if 2 <= len(key) <= 12 and name.isascii() and key not in seen:
                seen[key] = name
    for name in EXTRA_NAMES:
        seen.setdefault(name, name.capitalize())
    return seen


def trim(x, threshold=0.012, pad=0.02):
    peak = np.max(np.abs(x)) or 1.0
    idx = np.where(np.abs(x) > threshold * peak * 4)[0]
    if len(idx) == 0:
        return x
    a = max(0, idx[0] - int(pad * SR))
    b = min(len(x), idx[-1] + int(pad * SR))
    y = x[a:b].copy()
    fade = int(0.006 * SR)
    y[:fade] *= np.linspace(0, 1, fade)
    y[-fade:] *= np.linspace(1, 0, fade)
    return y


def master(x):
    """Cleans one clip and brings every clip to the same loudness, so a sentence made of clips sounds even."""
    sos = butter(2, 90 / (SR / 2), btype="high", output="sos")
    x = sosfilt(sos, x)
    x = trim(x)
    rms = np.sqrt(np.mean(x ** 2)) or 1.0
    x = x * (0.11 / rms)
    # A soft ceiling keeps loud consonants from jumping out.
    return np.tanh(x * 1.4) / 1.4 * 1.5


def read_wav(path):
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768


def write_mp3(x, path):
    pcm = (np.clip(x, -0.98, 0.98) * 32767).astype("<i2")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp = f.name
    with wave.open(tmp, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-codec:a", "libmp3lame", "-b:a", "40k", "-ac", "1", path], check=True)
    os.remove(tmp)


def main():
    import joe_us_piper_voice as joe
    from piper import PiperVoice, SynthesisConfig

    voice = PiperVoice.load(joe.model_path(), config_path=joe.config_path())
    os.makedirs(os.path.join(OUT, "phrases"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "names"), exist_ok=True)

    def say(text):
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp = f.name
        with wave.open(tmp, "wb") as w:
            # A little faster than the default, which suits an announcer calling the action.
            voice.synthesize_wav(text, w, syn_config=SynthesisConfig(length_scale=0.86, noise_scale=0.6))
        x = read_wav(tmp)
        os.remove(tmp)
        return master(x)

    for key, text in PHRASES.items():
        write_mp3(say(text), os.path.join(OUT, "phrases", f"{key}.mp3"))
    print(f"{len(PHRASES)} phrases")

    names = collect_names()
    keys = []
    folder = os.path.join(OUT, "names")
    for key, name in sorted(names.items()):
        path = os.path.join(folder, f"{key}.mp3")
        # Clips that already exist are kept, so a re-run only renders what is new.
        if not os.path.exists(path):
            write_mp3(say(name), path)
        keys.append(key)
    for stale in set(os.listdir(folder)) - {f"{k}.mp3" for k in keys}:
        os.remove(os.path.join(folder, stale))
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump({"names": keys, "phrases": list(PHRASES)}, f, separators=(",", ":"))
    total = sum(os.path.getsize(os.path.join(OUT, "names", f"{k}.mp3")) for k in keys)
    print(f"{len(keys)} names, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
