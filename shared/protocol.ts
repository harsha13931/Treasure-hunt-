import type { Beam, Kill } from "./geometry.js";
import type { BotDifficulty } from "./config.js";
import type { MoveInput } from "./movement.js";

// Messages the browser sends to the server.
export type ClientMessage =
  | { type: "create"; name: string }
  /** Join a public match that is waiting for players, or open a new one. */
  | { type: "quick"; name: string }
  | { type: "join"; code: string; name: string }
  | ({ type: "input" } & MoveInput)
  | { type: "lock"; yaw: number }
  | {
      type: "start";
      /** How many bots to add. A match needs at least 2 players in total, bots included. */
      bots?: number;
      difficulty?: BotDifficulty;
    }
  | { type: "leave" };

/** Whether the outer ice may break after the coming volley. */
export type EdgeWarning = "none" | "possible" | "certain";

export type Phase = "LOBBY" | "HIDE" | "REVEAL" | "FIRE" | "RESULT" | "MATCH_OVER";

export interface PublicPlayer {
  id: string;
  name: string;
  alive: boolean;
  bot: boolean;
}

export interface RevealPlayer {
  id: string;
  name: string;
  x: number;
  z: number;
  yaw: number;
}

// Messages the server sends to the browser.
export type ServerMessage =
  | { type: "joined"; code: string; playerId: string }
  | { type: "error"; message: string }
  | {
      type: "lobby";
      code: string;
      phase: Phase;
      hostId: string | null;
      players: PublicPlayer[];
      /** A public match starts by itself at this time (milliseconds), once there are enough players. */
      startsAt: number | null;
      isPublic: boolean;
    }
  | {
      // Sent to each player when a hide phase starts. Other players' positions are never included.
      type: "hide";
      volley: number;
      endsAt: number;
      radius: number;
      /** Radius the floor would shrink to. Anyone standing outside it when it breaks falls. */
      nextRadius: number;
      edge: EdgeWarning;
      you: { alive: boolean; x: number; z: number; yaw: number; vx: number; vz: number; locked: boolean };
      players: PublicPlayer[];
    }
  | {
      // Sent to each living player every tick during the hide phase. Only that player's own state.
      type: "self";
      x: number;
      z: number;
      yaw: number;
      vx: number;
      vz: number;
      ack: number;
      locked: boolean;
    }
  | {
      // Sent to everyone when the hide phase ends. Positions become public here.
      type: "reveal";
      volley: number;
      fireAt: number;
      radius: number;
      players: RevealPlayer[];
    }
  | { type: "fire"; beams: Beam[]; eliminated: string[]; kills: Kill[] }
  /** The outer ice broke away. Everyone listed in `fallen` was standing on it and fell into the crevasse. */
  | { type: "ring"; radius: number; fallen: string[] }
  | {
      type: "match_over";
      winnerId: string | null;
      players: PublicPlayer[];
      /** Everyone, from first place to last. */
      ranking: string[];
    };

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}
