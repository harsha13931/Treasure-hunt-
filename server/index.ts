import { randomInt } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { brotliCompressSync, gzipSync, constants as zlib } from "node:zlib";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { ROOM_CODE_LENGTH } from "../shared/config.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import { encode } from "../shared/protocol.js";
import { Room } from "./room.js";

const PORT = Number(process.env.PORT ?? 8080);
const CLIENT_DIR = resolve(fileURLToPath(new URL("../dist/client", import.meta.url)));
// The browser sends movement at 20 messages per second, so leave room for that plus a few actions.
const MAX_MESSAGES_PER_SECOND = 60;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rooms = new Map<string, Room>();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function newRoomCode(): string {
  let code: string;
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function openRoom(isPublic: boolean): Room {
  const code = newRoomCode();
  const room: Room = new Room(code, {
    isPublic,
    onMatchEnd: (summary) => console.log(JSON.stringify({ event: "match_end", ...summary })),
    onEmpty: () => {
      room.destroy();
      rooms.delete(code);
    },
  });
  rooms.set(code, room);
  return room;
}

/** File types worth compressing. Music, images and fonts are already compressed. */
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".glb"]);
/** Compressed copies are made once and kept, since the files only change when the game is rebuilt. */
const compressed = new Map<string, Buffer>();

function cacheControl(filePath: string): string {
  if (filePath.includes("/assets/")) return "public, max-age=31536000, immutable";
  // The music, voice clips and model are large and rarely change, so browsers may keep them for a day.
  if (filePath.includes("/music/") || filePath.includes("/models/") || filePath.includes("/voice/")) return "public, max-age=86400";
  return "no-cache";
}

/**
 * Sends one file from the built client. Files that compress well are sent compressed, and a browser that already
 * has the current copy is told so instead of being sent it again. Both matter on a small free server and a phone connection.
 */
function serveFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  const stats = statSync(filePath);
  const extension = extname(filePath);
  const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "content-type": MIME[extension] ?? "application/octet-stream",
    "cache-control": cacheControl(filePath),
    etag,
    vary: "Accept-Encoding",
  };

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers).end();
    return;
  }

  const accepted = String(req.headers["accept-encoding"] ?? "");
  const encoding = !COMPRESSIBLE.has(extension) ? null : /\bbr\b/.test(accepted) ? "br" : /\bgzip\b/.test(accepted) ? "gzip" : null;
  if (encoding) {
    const key = `${filePath}:${etag}:${encoding}`;
    let body = compressed.get(key);
    if (!body) {
      const raw = readFileSync(filePath);
      body =
        encoding === "br"
          ? brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9 } })
          : gzipSync(raw, { level: 9 });
      compressed.set(key, body);
    }
    res.writeHead(200, { ...headers, "content-encoding": encoding, "content-length": String(body.length) }).end(body);
    return;
  }

  res.writeHead(200, { ...headers, "content-length": String(stats.size) });
  createReadStream(filePath).pipe(res);
}

const http = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }

  if (!existsSync(CLIENT_DIR)) {
    res.writeHead(503, { "content-type": "text/plain" }).end("Client not built. Run `npm run build` first.");
    return;
  }

  // Serve the built client. Paths are resolved inside CLIENT_DIR only.
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  let filePath = normalize(join(CLIENT_DIR, requested));
  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(CLIENT_DIR, "index.html");
  }

  serveFile(req, res, filePath);
});

const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 4096 });

// Ping every connection now and then. It keeps idle connections open through the hosting proxy, and finds the ones
// whose phone has gone away without saying goodbye, so their seats are not held forever.
const answered = new WeakMap<WebSocket, boolean>();
setInterval(() => {
  for (const client of wss.clients) {
    if (answered.get(client) === false) {
      client.terminate();
      continue;
    }
    answered.set(client, false);
    client.ping();
  }
}, 25_000).unref();

wss.on("connection", (socket: WebSocket) => {
  answered.set(socket, true);
  socket.on("pong", () => answered.set(socket, true));
  let room: Room | null = null;
  let playerId: string | null = null;
  let windowStart = Date.now();
  let messagesInWindow = 0;

  const send = (message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(encode(message));
  };
  const fail = (message: string) => send({ type: "error", message });

  socket.on("message", (raw) => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      messagesInWindow = 0;
    }
    messagesInWindow += 1;
    if (messagesInWindow > MAX_MESSAGES_PER_SECOND) {
      fail("Too many messages. Slow down.");
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      fail("Malformed message.");
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") {
      fail("Malformed message.");
      return;
    }
    const msg = message as ClientMessage;

    // Heartbeats work before and after joining a room, and do not count as game messages.
    if (msg.type === "ping") {
      send({ type: "pong", t: Number(msg.t) || 0 });
      return;
    }

    if (!room) {
      if (msg.type === "create") {
        const created = openRoom(false);
        room = created;
        playerId = created.join(readName(msg.name), send);
      } else if (msg.type === "quick") {
        // Quick Match: join a public room that is waiting for players, or open a new one.
        const waiting = [...rooms.values()].find((candidate) => candidate.isPublic && candidate.isOpen);
        const target = waiting ?? openRoom(true);
        room = target;
        playerId = target.join(readName(msg.name), send);
      } else if (msg.type === "join") {
        const code = typeof msg.code === "string" ? msg.code.trim().toUpperCase() : "";
        const found = rooms.get(code);
        if (!found) {
          fail("No room with that code.");
          return;
        }
        try {
          playerId = found.join(readName(msg.name), send);
          room = found;
        } catch (error) {
          fail(error instanceof Error ? error.message : "Could not join.");
        }
      } else if (msg.type === "rejoin") {
        // Coming back after a dropped connection. The token proves this is the same player.
        const code = typeof msg.code === "string" ? msg.code.trim().toUpperCase() : "";
        const found = rooms.get(code);
        const id = typeof msg.playerId === "string" ? msg.playerId : "";
        try {
          if (!found) throw new Error("That match is no longer available.");
          found.reconnect(id, typeof msg.token === "string" ? msg.token : "", send);
          room = found;
          playerId = id;
        } catch (error) {
          fail(error instanceof Error ? error.message : "Could not rejoin.");
        }
      } else {
        fail("Create or join a room first.");
      }
      return;
    }

    room.handle(playerId as string, msg);
  });

  const connectedAt = Date.now();
  socket.on("close", (code, reason) => {
    // One line per drop, so the logs show whether connections end cleanly (1000, 1001) or are cut (1005, 1006).
    console.log(
      JSON.stringify({
        event: "disconnect",
        code,
        reason: reason.toString().slice(0, 60),
        room: room?.code ?? null,
        phase: room?.currentPhase ?? null,
        seconds: Math.round((Date.now() - connectedAt) / 1000),
      }),
    );
    if (room && playerId) room.disconnect(playerId, send);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readName(value: unknown): string {
  return typeof value === "string" ? value : "";
}

http.listen(PORT, () => {
  console.log(`Laser Ring server listening on http://localhost:${PORT}`);
});
