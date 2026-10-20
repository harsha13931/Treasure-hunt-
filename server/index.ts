import { randomInt } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
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

  res.writeHead(200, {
    "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
    "cache-control": filePath.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 4096 });

wss.on("connection", (socket: WebSocket) => {
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

    if (!room) {
      if (msg.type === "create") {
        const code = newRoomCode();
        const created = new Room(code);
        rooms.set(code, created);
        room = created;
        playerId = created.join(readName(msg.name), send);
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
      } else {
        fail("Create or join a room first.");
      }
      return;
    }

    room.handle(playerId as string, msg);
  });

  socket.on("close", () => {
    if (room && playerId) {
      room.leave(playerId);
      if (room.isEmpty) {
        room.destroy();
        rooms.delete(room.code);
      }
    }
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
