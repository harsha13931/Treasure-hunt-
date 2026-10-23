import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AuthError,
  accountForToken,
  changePassword,
  dbEnabled,
  getLeaderboard,
  login,
  logout,
  recordMatch,
  register,
  updateDisplayName,
} from "./db.js";

const NAME_MIN = 2;
const NAME_MAX = 16;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 100;
const BODY_LIMIT = 4096;

/** A name may hold letters, numbers, spaces and a few marks, so friends can use the names they like without breaking layouts. */
const NAME_PATTERN = /^[\p{L}\p{N} _.'-]+$/u;

/**
 * The API is called both from the game's own page and, when the game is embedded elsewhere (itch.io), from another
 * site. The game is public and uses a bearer token rather than cookies, so any origin may call it.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS }).end(JSON.stringify(body));
}

/** Reads and parses a small JSON body. Rejects anything too large so a flood of data cannot exhaust memory. */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > BODY_LIMIT) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return reject(new Error("Body too large."));
      try {
        const parsed = JSON.parse(body || "{}");
        resolve(typeof parsed === "object" && parsed !== null ? parsed : {});
      } catch {
        reject(new Error("Malformed body."));
      }
    });
    req.on("error", () => reject(new Error("Read error.")));
  });
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function checkName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < NAME_MIN) return `Name must be at least ${NAME_MIN} characters.`;
  if (trimmed.length > NAME_MAX) return `Name must be at most ${NAME_MAX} characters.`;
  if (!NAME_PATTERN.test(trimmed)) return "Name has characters that are not allowed.";
  return null;
}

function checkPassword(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return "Password is too long.";
  return null;
}

/**
 * A small sign-in rate limiter. Each address gets a handful of tries, and the window resets after a while, so a
 * forgotten password is no bother while a password-guessing flood is slowed to a crawl.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const record = attempts.get(ip);
  if (!record || now > record.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  record.count += 1;
  return record.count > MAX_ATTEMPTS;
}

function clientIp(req: IncomingMessage): string {
  const forwarded = str(req.headers["x-forwarded-for"]).split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

/** Handles every /api/ request. Writes the response itself. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // A browser on another site sends this preflight before a POST. Answer it with the allowed methods and headers.
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS).end();
    return;
  }

  if (!dbEnabled) {
    sendJson(res, 503, { error: "Accounts are not set up on this server." });
    return;
  }

  try {
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/api/leaderboard" && method === "GET") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 10, 1), 100);
      sendJson(res, 200, { entries: await getLeaderboard(limit) });
      return;
    }

    if (path === "/api/register" && method === "POST") {
      if (tooManyAttempts(clientIp(req))) {
        sendJson(res, 429, { error: "Too many tries. Wait a few minutes." });
        return;
      }
      const body = await readBody(req);
      const name = str(body.name);
      const password = str(body.password);
      const nameError = checkName(name);
      if (nameError) return sendJson(res, 400, { error: nameError });
      const passwordError = checkPassword(password);
      if (passwordError) return sendJson(res, 400, { error: passwordError });
      const result = await register(name, password);
      sendJson(res, 200, result);
      return;
    }

    if (path === "/api/login" && method === "POST") {
      if (tooManyAttempts(clientIp(req))) {
        sendJson(res, 429, { error: "Too many tries. Wait a few minutes." });
        return;
      }
      const body = await readBody(req);
      const result = await login(str(body.name), str(body.password));
      sendJson(res, 200, result);
      return;
    }

    if (path === "/api/me" && method === "GET") {
      const account = await accountForToken(bearer(req));
      if (!account) return sendJson(res, 401, { error: "Not signed in." });
      sendJson(res, 200, { account });
      return;
    }

    if (path === "/api/logout" && method === "POST") {
      await logout(bearer(req));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === "/api/profile" && method === "POST") {
      const account = await accountForToken(bearer(req));
      if (!account) return sendJson(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      const name = str(body.name);
      const nameError = checkName(name);
      if (nameError) return sendJson(res, 400, { error: nameError });
      const updated = await updateDisplayName(account.id, name);
      sendJson(res, 200, { account: updated });
      return;
    }

    if (path === "/api/password" && method === "POST") {
      const account = await accountForToken(bearer(req));
      if (!account) return sendJson(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      const next = str(body.next);
      const passwordError = checkPassword(next);
      if (passwordError) return sendJson(res, 400, { error: passwordError });
      await changePassword(account.id, str(body.current), next);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === "/api/match" && method === "POST") {
      const account = await accountForToken(bearer(req));
      if (!account) return sendJson(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      const position = Number(body.position);
      if (!Number.isInteger(position) || position < 1) return sendJson(res, 400, { error: "Bad position." });
      const updated = await recordMatch(account.id, position);
      sendJson(res, 200, { account: updated });
      return;
    }

    sendJson(res, 404, { error: "Unknown endpoint." });
  } catch (err) {
    if (err instanceof AuthError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    console.error("API error", err);
    sendJson(res, 500, { error: "Something went wrong." });
  }
}
