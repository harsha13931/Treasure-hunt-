"""
Builds the game for a site that runs it inside a frame, such as itch.io, and zips it up.

The multiplayer server stays where it is (Render). The browser part is built with relative paths and told
where the server is, so it works from any address. Usage:

    python3 tools/itch/make_zip.py wss://laser-ring.onrender.com

The zip is written to dist/laser-ring-itch.zip. Upload it on itch.io as an HTML game, with
"This file will be played in the browser" ticked.
"""

import os
import subprocess
import sys
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "dist", "itch")
ZIP = os.path.join(ROOT, "dist", "laser-ring-itch.zip")


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

    if os.path.exists(ZIP):
        os.remove(ZIP)
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as archive:
        for folder, _, files in os.walk(OUT):
            for name in files:
                path = os.path.join(folder, name)
                # The game must sit at the top of the zip, so index.html is the first thing found.
                archive.write(path, os.path.relpath(path, OUT))
    size_mb = os.path.getsize(ZIP) / 1_000_000
    print(f"Wrote {ZIP} ({size_mb:.1f} MB), connecting to {server}")


if __name__ == "__main__":
    main()
