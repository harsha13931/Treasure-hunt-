import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";

const scryptAsync = promisify(scrypt);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err: Error) => {
  console.error("Unexpected database pool error", err);
});

/** True when a DATABASE_URL is set. When false, the game still runs; accounts and stats are simply unavailable. */
export const dbEnabled = Boolean(process.env.DATABASE_URL);

export interface Account {
  id: number;
  username: string;
  display_name: string;
  wins: number;
  eliminations: number;
  matches_played: number;
  created_at: Date;
}

/** The safe view of an account, without the password hash. */
export interface PublicAccount {
  id: number;
  username: string;
  displayName: string;
  wins: number;
  eliminations: number;
  matchesPlayed: number;
}

export interface LeaderboardEntry {
  username: string;
  displayName: string;
  wins: number;
  eliminations: number;
  matchesPlayed: number;
}

/** A session lasts this long before the player must sign in again. */
const SESSION_DAYS = 90;

function publicView(row: Account): PublicAccount {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    wins: row.wins,
    eliminations: row.eliminations,
    matchesPlayed: row.matches_played,
  };
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const keyBuffer = Buffer.from(key, "hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return keyBuffer.length === derived.length && timingSafeEqual(keyBuffer, derived);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

let initialized = false;

export async function initDb(): Promise<void> {
  if (initialized || !dbEnabled) return;
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0,
        eliminations INTEGER NOT NULL DEFAULT 0,
        matches_played INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions(account_id);`);
    console.log("Database initialized");
    initialized = true;
  } finally {
    client.release();
  }
}

export class AuthError extends Error {}

/** Creates an account and a session. Throws AuthError if the name is already taken. */
export async function register(
  displayName: string,
  password: string,
): Promise<{ account: PublicAccount; token: string }> {
  const username = displayName.trim().toLowerCase();
  const client = await pool.connect();
  try {
    const existing = await client.query("SELECT id FROM accounts WHERE username = $1", [username]);
    if (existing.rows.length > 0) throw new AuthError("That name is already taken.");

    const passwordHash = await hashPassword(password);
    const result = await client.query<Account>(
      `INSERT INTO accounts (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING *`,
      [username, displayName.trim(), passwordHash],
    );
    const account = result.rows[0];
    const token = await createSession(client, account.id);
    return { account: publicView(account), token };
  } finally {
    client.release();
  }
}

/** Verifies a name and password, and starts a session. Throws AuthError on a wrong name or password. */
export async function login(
  displayName: string,
  password: string,
): Promise<{ account: PublicAccount; token: string }> {
  const username = displayName.trim().toLowerCase();
  const client = await pool.connect();
  try {
    const result = await client.query<Account & { password_hash: string }>(
      "SELECT * FROM accounts WHERE username = $1",
      [username],
    );
    const row = result.rows[0];
    // Always run a verify, even with no row, so a missing name and a wrong password take the same time.
    const ok = await verifyPassword(password, row?.password_hash ?? "x:y");
    if (!row || !ok) throw new AuthError("Wrong name or password.");

    const token = await createSession(client, row.id);
    return { account: publicView(row), token };
  } finally {
    client.release();
  }
}

async function createSession(client: { query: Pool["query"] }, accountId: number): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await client.query(
    "INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)",
    [hashToken(token), accountId, expiresAt],
  );
  return token;
}

/** Returns the account a session token belongs to, or null if the token is unknown or expired. */
export async function accountForToken(token: string): Promise<PublicAccount | null> {
  if (!token) return null;
  const client = await pool.connect();
  try {
    const result = await client.query<Account>(
      `SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [hashToken(token)],
    );
    return result.rows[0] ? publicView(result.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function logout(token: string): Promise<void> {
  if (!token) return;
  const client = await pool.connect();
  try {
    await client.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  } finally {
    client.release();
  }
}

/** Changes the display name. Throws AuthError if the new name is taken by someone else. */
export async function updateDisplayName(accountId: number, displayName: string): Promise<PublicAccount> {
  const username = displayName.trim().toLowerCase();
  const client = await pool.connect();
  try {
    const taken = await client.query("SELECT id FROM accounts WHERE username = $1 AND id <> $2", [username, accountId]);
    if (taken.rows.length > 0) throw new AuthError("That name is already taken.");

    const result = await client.query<Account>(
      `UPDATE accounts SET username = $1, display_name = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [username, displayName.trim(), accountId],
    );
    return publicView(result.rows[0]);
  } finally {
    client.release();
  }
}

/** Changes the password after checking the current one. Throws AuthError if the current password is wrong. */
export async function changePassword(accountId: number, current: string, next: string): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ password_hash: string }>(
      "SELECT password_hash FROM accounts WHERE id = $1",
      [accountId],
    );
    const row = result.rows[0];
    if (!row || !(await verifyPassword(current, row.password_hash))) throw new AuthError("Current password is wrong.");

    const passwordHash = await hashPassword(next);
    await client.query("UPDATE accounts SET password_hash = $1, updated_at = NOW() WHERE id = $2", [
      passwordHash,
      accountId,
    ]);
    // Changing the password signs out every other device.
    await client.query("DELETE FROM sessions WHERE account_id = $1", [accountId]);
  } finally {
    client.release();
  }
}

/** Records one finished match for a player. Position 1 is a win; anything else counts as a loss. */
export async function recordMatch(accountId: number, position: number): Promise<PublicAccount | null> {
  const client = await pool.connect();
  try {
    const won = position === 1;
    const result = await client.query<Account>(
      `UPDATE accounts
       SET wins = wins + $2, eliminations = eliminations + $3, matches_played = matches_played + 1, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [accountId, won ? 1 : 0, won ? 0 : 1],
    );
    return result.rows[0] ? publicView(result.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function getLeaderboard(limit = 10): Promise<LeaderboardEntry[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<Account>(
      `SELECT * FROM accounts WHERE matches_played > 0
       ORDER BY wins DESC, eliminations DESC, matches_played ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      username: row.username,
      displayName: row.display_name,
      wins: row.wins,
      eliminations: row.eliminations,
      matchesPlayed: row.matches_played,
    }));
  } finally {
    client.release();
  }
}
