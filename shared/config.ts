// Game rules and tuning values shared by the server and the browser.
// Units are meters.

export const MIN_PLAYERS = 2;
/**
 * One color per seat, all easy to tell apart on white snow. A room never has more players than colors,
 * and the server hands each player a color nobody else in the room has.
 */
export const PLAYER_COLORS = ["#e5484d", "#2f7de1", "#f2c230", "#2fb344", "#8b5cf6", "#ff5fb0", "#19c3d6", "#f26b21"] as const;

/** A full room. Empty spots can be filled with bots up to this number. */
export const ROOM_SIZE = 8;
export const MAX_PLAYERS = ROOM_SIZE;
export const ROOM_CODE_LENGTH = 5;
/** Server simulation step. The browser predicts with the same step. */
export const TICK_MS = 50;

// The circle the players must stay inside. It shrinks in steps.
export const START_RING_RADIUS = 18;
export const RING_SHRINK_STEP = 2.5;
export const MIN_RING_RADIUS = 5.5;
/** After this many volleys in a row with no kill, the ring shrinks one step. */
export const NO_KILL_VOLLEYS_BEFORE_SHRINK = 2;
/** The ring also shrinks after this many volleys even if there were kills, so a match always moves on. */
export const FORCED_SHRINK_EVERY_VOLLEYS = 3;
/** In a public match, how long the lobby waits after the second player joins before it starts. */
export const QUICK_START_DELAY_MS = 15_000;

// Players and the laser pistol.
export const PLAYER_RADIUS = 1;
export const PLAYER_HEIGHT = 4.8;
export const WALK_SPEED = 4.6;
/** Height of the laser beam. Also the height the gun is held at. */
export const BEAM_HEIGHT = 2.75;
/** Distance from the body center to the muzzle, along the aim direction. */
export const MUZZLE_FORWARD = 1.92;
export const BEAM_HALF_WIDTH = 0.09;
export const BEAM_RANGE = 80;

/** Bot skill from 0 (easy) to 1 (hard). */
export const BOT_SKILL = { easy: 0.15, normal: 0.5, hard: 0.9 } as const;
export type BotDifficulty = keyof typeof BOT_SKILL;

// The sonar ping: each player gets one per match. It points roughly toward the nearest enemy.
/** How far off the bearing can be, in radians, either way. */
export const SONAR_NOISE = 0.45;
/** Distances (meters) that split the answer into near, mid and far. */
export const SONAR_NEAR = 8;
export const SONAR_MID = 16;

/** How long a dropped player's spot is held during a match, so a phone that loses signal can come back. */
export const RECONNECT_GRACE_MS = 45_000;

// Phase timings.
export const HIDE_MS = 30_000;
export const REVEAL_MS = 3_000;
export const FIRE_MS = 1_200;
export const RESULT_MS = 2_500;

// The snow world. The arena is a circle of ice cut into the snowfield, over a deep crevasse.
export const WORLD_RADIUS = 380;
/** How far down the bottom of the crevasse is. Floor levels that break away fall this far. */
export const PIT_DEPTH = 50;

/**
 * The edge of each floor level, from the outside in. The cage stands on the outer edge of the
 * current level. When the ring shrinks, the level outside the cage breaks away and falls.
 */
export function ringLevels(): number[] {
  const levels: number[] = [];
  for (let radius = START_RING_RADIUS; radius > MIN_RING_RADIUS + 1e-6; radius -= RING_SHRINK_STEP) {
    levels.push(radius);
  }
  levels.push(MIN_RING_RADIUS);
  return levels;
}
