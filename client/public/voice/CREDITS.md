# Announcer voice

The clips in this folder were rendered ahead of time by `tools/voice/render_voice.py`.

- Voice: Piper `en_US-joe-medium`, trained on the NabuCasa "joe" dataset, released under CC0 (public domain).
  Model source: https://huggingface.co/rhasspy/piper-voices/tree/v1.0.0/en/en_US/joe/medium
- Engine: Piper (https://github.com/OHF-Voice/piper1-gpl), used only offline to make these files. The game itself
  contains no speech engine, so the engine's licence does not apply to the game.
- Names come from first-name lists in the Faker library plus a hand-written list of common names. A player whose name
  has no clip is called by their color instead, for example "Red robot".
