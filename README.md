# Laser Ring

A multiplayer last-one-standing game. You are a stick man on a circle of ice in a snowy world, inside a steel cage, holding a laser pistol. Everyone walks to a spot and turns to face a direction in secret. When the reveal comes, all the lasers fire at once. If a beam touches you, you are out for good. The last player standing wins.

## Ways to play

The game opens on a **Start Game** screen. Tap it, then choose **Play Game** from the main menu, then:

- **Solo vs Bots:** play right away against computer players. You choose how many bots (1 to 7) and how hard they are (Easy, Normal, Hard).
- **Play Online, Quick Match:** join a public match with real people. The match starts by itself a few seconds after a second player joins. The host of the room can also add bots.
- **Play Online, Private room:** make a room, share its five-letter code, and friends join with it. The host picks how many bots to add, if any.

A match needs **at least 2 players in total**, bots included, and holds up to 8. Nothing forces a full room. Bots only use positions that were made public at a reveal, so they cannot see you while you hide.

## How a match plays

1. **Hide phase (30 seconds):** walk anywhere inside the cage and turn to aim. Press Lock in (or Space) to stand still. When everyone has locked in, or the timer ends, the reveal starts.
2. **Reveal (3 seconds):** every player's position and aim become visible, with a 3-2-1 countdown.
3. **Fire:** every laser fires at the same moment. A beam stops at the first player it touches, and anyone it touches is **out for the whole match**. There are no points.
4. **The floor breaks away:** the arena floor is built as concentric ice levels. The outermost level cracks apart and falls into the crevasse, and the cage closes in, when either two volleys in a row end with nobody hit, or three volleys have passed since the last time, whichever comes first. So a match always keeps moving toward an ending.
5. The next hide phase begins with the survivors. The last player alive wins, and a results screen shows the final ranking, with Play Again and Main menu.

## Features

- **Snow world:** an open snowfield with mountains and pine trees, snow falling from above, and the arena as a circle of ice over a deep crevasse.
- **The floor is deadly:** when the outer ice breaks, anyone standing on it falls into the crevasse and is out. Before every round the game warns you (orange: it breaks if nobody is hit; red: it will break), and shades the doomed band on the floor and the minimap.
- **Announcements:** every knock-out is called out by name, as a banner and in a feed ("Ben was eliminated by Ann", "Cy fell into the crevasse").
- **Score:** a generated soundtrack (bass, drums, pads, arpeggio) that builds when the lasers are about to fire.
- **Steady frame rate:** one animation loop updates and draws; resolution adapts to the device if frames run long; bloom only runs while lasers are on screen; stick men are merged into a handful of meshes. Add `?perf=1` to the address to see fps, draw calls and resolution.
- **Smooth movement:** you speed up and slow down like a person, and your own movement is predicted in the browser so it never waits on the network.
- **A real-game feel:** a title screen where two stick men face off and one shoots the other, muzzle flashes, thin glowing lasers, a red burst when someone is hit, falling and recoil animations, camera shake, footsteps, and sound effects for shots, hits, and the floor breaking away.
- **Works on phones (landscape only):** floating joysticks that appear under your thumb, plus buttons for walking forward and back (left side) and turning left and right (right side).
- **Settings:** music, sound volume, and camera shake, saved in the browser.
- **Everything is free:** the stick men, the pistol, the world, the textures, and every sound are drawn or generated in code. There are no model, image, or audio files to license.
- **No laser until it fires:** there is no crosshair and no aiming line. A faint arrow on the floor in front of you shows which way you face.

## Controls

| | Desktop | Phone or tablet |
|---|---|---|
| Walk | W A S D or the arrow keys | Left joystick, or the ▲ ▼ buttons on the left |
| Turn and aim | Mouse (click the screen first) or Q and E | Right joystick, or the ◀ ▶ buttons on the right |
| Lock in | Space or the Lock in button | Lock in button |

On a phone, hold the device sideways. In portrait, the game asks you to turn it.

## Run it locally

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. Open a second browser window and join with the room code. To try the phone controls, open the same address on a phone on your network, or use your browser's device emulation.

## Tests

```bash
npm test
```

They cover the beam geometry, the movement rules, the round flow, the floor breaking away (both rules), last-one-standing and rankings, bots and the two-player minimum, public matches starting by themselves, and the check that no other player's position reaches a browser during the hide phase.

## Build and run in production

```bash
npm run build   # type-checks and builds the web client into dist/client
npm start       # serves the client and the WebSocket server on $PORT (default 8080)
```

Then open `http://localhost:8080`.

## Host it on Render

Render runs this game as a single web service. The WebSocket connection works on Render, and Render provides the HTTPS address for you.

1. Push this repository to GitHub.
2. In the Render dashboard choose **New > Blueprint** and pick the repository. Render reads `render.yaml` and builds the `Dockerfile`. (Or choose **New > Web Service**, pick the repository, and set the runtime to **Docker**. The health check path is `/healthz`.)
3. Wait for the build. Render gives you an address like `https://laser-ring.onrender.com`. Open it and play.

Things to know:

- **The free plan sleeps.** After a while with no visitors, the service stops, and the first visit afterwards takes about a minute to wake it up. A match in progress is lost if the service restarts. A paid plan keeps it awake.
- **Run exactly one instance.** Rooms live in the server's memory, so every player in a room must reach the same instance. Do not scale the service to more than one.
- **The port is automatic.** Render sets `PORT`, and the server uses it. You do not need to set anything.
- Any host that runs Docker works the same way, such as Fly.io (set `internal_port = 8080`) or Railway.

## Project layout

```
client/        Browser app: Three.js snow world, stick men, touch controls, audio, menus (Vite + TypeScript)
server/        Node server: static files, WebSocket rooms, round state machine
shared/        Rules, movement, beam geometry, floor levels, and message types used by both sides
Dockerfile     Production container
render.yaml    Render Blueprint (one-click setup)
```

## Tuning

Everything about the rules lives in `shared/config.ts`: the cage size and the number of floor levels, how many quiet volleys (and how many volleys in total) make a level fall, walking speed, player size, room size, how long a public match waits to start, and all the phase timings. Bot behavior is in `server/bot.ts`.

## Not yet built

These are the next steps before a wide public launch:

- Reconnecting a player after a dropped connection (currently they leave the room)
- Accounts, stats, and a persistent database
- Chat, reporting, and blocking
- Load testing with many rooms at once
- Your own environment art, if you want something other than the pit
