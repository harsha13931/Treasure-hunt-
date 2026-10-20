# Laser Ring

A multiplayer duel in a ring. Everyone picks a seat and an aim in secret. When the lights come on, every laser fires at once, and anyone a beam touches is out.

- **Hidden positions:** during the hide phase the server sends each player only their own seat and aim. Other positions are never sent to the browser until the reveal.
- **Server decides:** the server runs the round, the timers, and every hit. The browser only draws what it's told.
- **Four guns:** Pistol, Sniper, Shotgun (five pellets, short range), and Twin (two beams).
- **Background music** generated in code, toggled with the button in the top-right corner.

## Run it locally

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. Open a second browser window (or a private window) and join with the room code.

## Tests

```bash
npm test
```

The tests cover the beam geometry, the round rules, and the check that no other player's position reaches a browser during the hide phase.

## Build and run in production

```bash
npm run build   # type-checks and builds the web client into dist/client
npm start       # serves the client and the WebSocket server on $PORT (default 8080)
```

Then open `http://localhost:8080`.

## Deploy

The included `Dockerfile` builds one container that serves both the game and its WebSocket server. Any host that runs Docker will work:

- **Render:** create a Web Service from this repo, choose Docker, and it will use `PORT` automatically. HTTPS and `wss://` are handled for you.
- **Fly.io:** run `fly launch`, then set `internal_port = 8080` in `fly.toml`.
- **Railway:** deploy from the repo. It detects the Dockerfile.

Set a custom domain in your host's dashboard. The browser connects to `/ws` on the same domain, so no extra configuration is needed.

## Project layout

```
client/        Browser app: Three.js arena, stick figures, audio, menus (Vite + TypeScript)
server/        Node server: static files, WebSocket rooms, round state machine
shared/        Constants, guns, beam geometry, and message types used by both sides
Dockerfile     Production container
```

## Rules

- Rooms hold 2 to 12 players. The host starts the match once at least two players are in the room.
- A match is five rounds. The player with the most round wins takes the match.
- A round is a series of volleys. Each volley starts with a hide phase (20 seconds) where each player picks a seat and an aim, then locks in. Everyone still undecided when the timer ends gets a random seat facing the center.
- A round ends when one player (or none) is left standing. The survivor scores a point.
- A beam stops at the first player it touches. Dead players don't block beams.

## Not yet built

These are the next steps before a wide public launch:

- Reconnecting a player after a dropped connection (currently they leave the room)
- Accounts, stats, and a persistent database
- Chat, reporting, and blocking
- Touch-first controls and a mobile layout pass
- Load testing with many rooms at once
