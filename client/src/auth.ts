export interface Account {
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

const TOKEN_KEY = "laser-ring:token";

let token: string | null = null;
let account: Account | null = null;
const listeners = new Set<(account: Account | null) => void>();

function readToken(): string | null {
  if (token) return token;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }
  return token;
}

function writeToken(value: string | null): void {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be blocked (private mode, an itch.io frame). The player simply signs in again next time.
  }
}

function setAccount(next: Account | null): void {
  account = next;
  for (const listener of listeners) listener(account);
}

/** Calls back whenever the signed-in account changes, and once right away with the current one. */
export function onAccountChange(listener: (account: Account | null) => void): void {
  listeners.add(listener);
  listener(account);
}

export function currentAccount(): Account | null {
  return account;
}

export function isSignedIn(): boolean {
  return account !== null;
}

class ApiError extends Error {}

async function api<T>(path: string, options: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.auth) {
    const current = readToken();
    if (current) headers.authorization = `Bearer ${current}`;
  }
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || "Something went wrong.");
  return data as T;
}

/** Restores a signed-in session from a saved token, if there is one. Safe to call at startup. */
export async function restoreSession(): Promise<Account | null> {
  if (!readToken()) return null;
  try {
    const { account: me } = await api<{ account: Account }>("/api/me", { auth: true });
    setAccount(me);
    return me;
  } catch {
    // The token is no longer good. Drop it quietly.
    writeToken(null);
    setAccount(null);
    return null;
  }
}

export async function register(name: string, password: string): Promise<Account> {
  const { account: me, token: newToken } = await api<{ account: Account; token: string }>("/api/register", {
    method: "POST",
    body: { name, password },
  });
  writeToken(newToken);
  setAccount(me);
  return me;
}

export async function signIn(name: string, password: string): Promise<Account> {
  const { account: me, token: newToken } = await api<{ account: Account; token: string }>("/api/login", {
    method: "POST",
    body: { name, password },
  });
  writeToken(newToken);
  setAccount(me);
  return me;
}

export async function signOut(): Promise<void> {
  try {
    await api("/api/logout", { method: "POST", auth: true });
  } catch {
    // Even if the server call fails, forget the account on this device.
  }
  writeToken(null);
  setAccount(null);
}

export async function updateName(name: string): Promise<Account> {
  const { account: me } = await api<{ account: Account }>("/api/profile", { method: "POST", body: { name }, auth: true });
  setAccount(me);
  return me;
}

export async function changePassword(current: string, next: string): Promise<void> {
  await api("/api/password", { method: "POST", body: { current, next }, auth: true });
  // The server signs out other devices, but this one keeps its session.
}

/** Records a finished match. Position 1 is a win. Updates the cached stats. Does nothing for guests. */
export async function recordMatch(position: number): Promise<void> {
  if (!isSignedIn()) return;
  try {
    const { account: me } = await api<{ account: Account | null }>("/api/match", {
      method: "POST",
      body: { position },
      auth: true,
    });
    if (me) setAccount(me);
  } catch {
    // A lost match record is not worth bothering the player about.
  }
}

export async function getLeaderboard(limit = 10): Promise<LeaderboardEntry[]> {
  try {
    const { entries } = await api<{ entries: LeaderboardEntry[] }>(`/api/leaderboard?limit=${limit}`);
    return entries;
  } catch {
    return [];
  }
}
