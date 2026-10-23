export interface PlayerStats {
  device_id: string;
  name: string;
  wins: number;
  eliminations: number;
  matches_played: number;
  updated_at: string;
}

export interface LeaderboardEntry {
  device_id: string;
  name: string;
  wins: number;
  eliminations: number;
  matches_played: number;
}

let deviceId: string | null = null;

export function getDeviceId(): string {
  if (!deviceId) {
    // Try to load from localStorage
    const stored = localStorage.getItem("laser_ring_device_id");
    if (stored) {
      deviceId = stored;
    } else {
      // Generate new device ID
      deviceId = "device_" + Math.random().toString(36).substr(2, 9) + "_" + Date.now();
      localStorage.setItem("laser_ring_device_id", deviceId);
    }
  }
  return deviceId;
}

export async function loadPlayerStats(): Promise<PlayerStats | null> {
  try {
    const id = getDeviceId();
    const response = await fetch(`/api/player?id=${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.device_id ? data : null;
  } catch {
    return null;
  }
}

export async function savePlayerName(name: string): Promise<PlayerStats | null> {
  try {
    const id = getDeviceId();
    const response = await fetch("/api/player", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: id, name }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.device_id ? data : null;
  } catch {
    return null;
  }
}

export async function recordMatchResult(position: number): Promise<boolean> {
  try {
    const id = getDeviceId();
    const response = await fetch("/api/match", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: id,
        winnerDeviceId: id,
        position,
        matchCode: "match_" + Date.now(),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getLeaderboard(limit: number = 10): Promise<LeaderboardEntry[]> {
  try {
    const response = await fetch(`/api/leaderboard?limit=${limit}`);
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}
