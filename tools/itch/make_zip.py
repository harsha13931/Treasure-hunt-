"""
Builds the game for a site that runs it inside a frame, such as itch.io, and zips it up.

The multiplayer server stays where it is (Render). The browser part is built with relative paths and told
where the server is, so it works from any address. Usage:

    python3 tools/itch/make_zip.py wss://laser-ring.onrender.com

The zip is written to dist/laser-ring-itch.zip. Upload it on itch.io as an HTML game, with
"This file will be played in the browser" ticked.
"""

import json
import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "dist", "itch")
ZIP = os.path.join(ROOT, "dist", "laser-ring-itch.zip")
# itch.io accepts at most 1000 files in a zip. The player-name voice clips alone are about 1600, so this build
# leaves them out. The announcer then calls players by their color, as it does for any name without a clip.
MAX_FILES = 1000


def drop_name_clips():
    voice = os.path.join(OUT, "voice")
    shutil.rmtree(os.path.join(voice, "names"), ignore_errors=True)
    manifest_path = os.path.join(voice, "manifest.json")
    with open(manifest_path) as f:
        manifest = json.load(f)
    manifest["names"] = []
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, separators=(",", ":"))


def main():
    if len(sys.argv) != 2 or not sys.argv[1].startswith(("https://", "http://")):
        sys.exit("Give the server's address, for example: python3 tools/itch/make_zip.py https://laser-ring.onrender.com")
    server = sys.argv[1].rstrip("/")

    env = dict(os.environ, VITE_SERVER_URL=server)
    subprocess.run(
        ["npx", "vite", "build", "--base=./", "--outDir", OUT, "--emptyOutDir"],
        cwd=ROOT,
        env=env,
        check=True,
    )

    drop_name_clips()

    if os.path.exists(ZIP):
        os.remove(ZIP)
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as archive:
        for folder, _, files in os.walk(OUT):
            for name in files:
                path = os.path.join(folder, name)
                # The game must sit at the top of the zip, so index.html is the first thing found.
                archive.write(path, os.path.relpath(path, OUT))
    with zipfile.ZipFile(ZIP) as archive:
        count = len(archive.namelist())
    if count > MAX_FILES:
        sys.exit(f"The zip has {count} files, more than itch.io allows ({MAX_FILES}).")
    size_mb = os.path.getsize(ZIP) / 1_000_000
    print(f"Wrote {ZIP} ({size_mb:.1f} MB, {count} files), connecting to {server}")


if __name__ == "__main__":
    main()
