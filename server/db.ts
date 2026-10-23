import { Pool, type PoolClient } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err: Error) => {
  console.error("Unexpected error on idle client", err);
});

export interface Player {
  device_id: string;
  name: string;
  wins: number;
  eliminations: number;
  matches_played: number;
  updated_at: Date;
}

export interface Match {
  id: string;
  device_id: string;
  winner_device_id: string;
  position: number;
  match_code: string;
  played_at: Date;
}

let initialized = false;

export async function initDb() {
  if (initialized) return;
  const client = await pool.connect();
  try {
    // Create players table
    await client.query(`
      CREATE TABLE IF NOT EXISTS players (
        device_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0,
        eliminations INTEGER NOT NULL DEFAULT 0,
        matches_played INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Create matches table
    await client.query(`
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        device_id TEXT NOT NULL,
        winner_device_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        match_code TEXT NOT NULL,
        played_at TIMESTAMP NOT NULL DEFAULT NOW(),
        FOREIGN KEY (device_id) REFERENCES players(device_id),
        FOREIGN KEY (winner_device_id) REFERENCES players(device_id)
      );
    `);

    console.log("Database initialized");
    initialized = true;
  } catch (err) {
    console.error("Failed to initialize database", err);
    throw err;
  } finally {
    client.release();
  }
}

export async function getPlayer(deviceId: string): Promise<Player | null> {
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT * FROM players WHERE device_id = $1", [deviceId]);
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

export async function upsertPlayer(deviceId: string, name: string): Promise<Player> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `INSERT INTO players (device_id, name, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (device_id) DO UPDATE SET name = $2, updated_at = NOW()
       RETURNING *`,
      [deviceId, name],
    );
    return result.rows[0];
  } finally {
    client.release();
  }
}

export async function recordMatch(
  deviceId: string,
  winnerDeviceId: string,
  position: number,
  matchCode: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    // Record match
    await client.query(
      `INSERT INTO matches (device_id, winner_device_id, position, match_code)
       VALUES ($1, $2, $3, $4)`,
      [deviceId, winnerDeviceId, position, matchCode],
    );

    // Update player stats
    if (position === 1) {
      // Winner
      await client.query(
        `UPDATE players SET wins = wins + 1, matches_played = matches_played + 1, updated_at = NOW()
         WHERE device_id = $1`,
        [deviceId],
      );
    } else {
      // Loser
      await client.query(
        `UPDATE players SET eliminations = eliminations + 1, matches_played = matches_played + 1, updated_at = NOW()
         WHERE device_id = $1`,
        [deviceId],
      );
    }
  } finally {
    client.release();
  }
}

export async function getLeaderboard(limit: number = 10): Promise<Player[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM players ORDER BY wins DESC, eliminations DESC LIMIT $1`,
      [limit],
    );
    return result.rows;
  } finally {
    client.release();
  }
}
