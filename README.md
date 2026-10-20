# Laser Ring

A multiplayer last-one-standing game. You are a stick man in a deep pit, inside a steel cage, holding a laser pistol. Everyone walks to a spot and turns to face a direction in secret. When the lights come on, all the lasers fire at once. If a beam touches you, you are out for good. The last player standing wins.

- **Hidden positions:** during the hide phase the server sends each player only their own position. Nobody else is drawn on your screen, and their positions are never sent to your browser until the reveal.
- **The server decides:** the server runs the timers, the movement, every hit, and the cage. The browser only draws what it is told.
- **One gun:** a laser pistol. The beam is a straight line that stops at the first player it touches.
- **The floor breaks away:** the arena floor is built as concentric levels. If two volleys in a row end with nobody hit, the outermost level cracks apart and falls into the pit, and the cage closes in to the next level. Anyone left outside the new edge is pushed back in.
- **Eight players, with bots:** a full room is eight. The host can fill empty spots with bots, so one person can play alone, or two or more can play together. Bots only use positions that were made public at a reveal, and they are removed when the match ends.
- **Out means out:** there are no points. A player who is hit watches the rest of the match.
- **Works on phones (landscape only):** floating joysticks that appear under your thumb, plus buttons for walking forward and back (left side) and turning left and right (right side).
- **Everything is free:** the stick men, the pistol, the pit, the textures, and every sound are drawn or generated in code. There are no model, image, or audio files to license.
- **A real game feel:** a title screen where two stick men face off and one shoots the other, muzzle flashes, soft glowing lasers, a red burst when someone is hit, falling and recoil animations, camera shake, a 3-2-1 countdown, footsteps, and sound effects for shots, hits, and the floor breaking away.
- **No laser until it fires:** there is no crosshair and no aiming line. A faint arrow on the floor in front of you shows which way you face. Beams appear only when the lasers fire.

## How a match plays

1. The host starts the match. With bots on (the default), the room is filled to eight. With bots off, at least two people are needed.
2. **Hide phase (30 seconds):** walk anywhere inside the cage and turn to aim. Press Lock in (or Space) to stand still. When everyone has locked in, or the timer ends, the reveal starts.
3. **Reveal (3 seconds):** every player's position and aim become visible.
4. **Fire:** every laser fires at the same moment. Anyone a beam touches is out.
5. If nobody was hit twice in a row, the outer floor level breaks away and the cage closes in. Then the next hide phase begins with the survivors.
6. The last player alive wins.

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

They cover the beam geometry, the movement rules, the round flow, the cage shrinking, last-one-standing, and the check that no other player's position reaches a browser during the hide phase.

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
client/        Browser app: Three.js pit and cage, stick men, touch controls, audio, menus (Vite + TypeScript)
server/        Node server: static files, WebSocket rooms, round state machine
shared/        Rules, movement, beam geometry, floor levels, and message types used by both sides
Dockerfile     Production container
render.yaml    Render Blueprint (one-click setup)
```

## Tuning

Everything about the rules lives in `shared/config.ts`: the cage size and the number of floor levels, how many quiet volleys make a level fall, walking speed, player size, room size, and all the phase timings. Bot behavior is in `server/bot.ts`.

## Not yet built

These are the next steps before a wide public launch:

- Reconnecting a player after a dropped connection (currently they leave the room)
- Accounts, stats, and a persistent database
- Chat, reporting, and blocking
- Load testing with many rooms at once
- Your own environment art, if you want something other than the pit
