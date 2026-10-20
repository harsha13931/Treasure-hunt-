import type { Beam } from "./geometry.js";
import type { MoveInput } from "./movement.js";

// Messages the browser sends to the server.
export type ClientMessage =
  | { type: "create"; name: string }
  | { type: "join"; code: string; name: string }
  | ({ type: "input" } & MoveInput)
  | { type: "lock"; yaw: number }
  | { type: "start"; /** Fill empty spots with bots, up to a full room. */ bots?: boolean }
  | { type: "leave" };

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
  | { type: "lobby"; code: string; phase: Phase; hostId: string | null; players: PublicPlayer[] }
  | {
      // Sent to each player when a hide phase starts. Other players' positions are never included.
      type: "hide";
      volley: number;
      endsAt: number;
      radius: number;
      you: { alive: boolean; x: number; z: number; yaw: number; locked: boolean };
      players: PublicPlayer[];
    }
  | {
      // Sent to each living player every tick during the hide phase. Only that player's own state.
      type: "self";
      x: number;
      z: number;
      yaw: number;
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
  | { type: "fire"; beams: Beam[]; eliminated: string[] }
  | { type: "ring"; radius: number }
  | { type: "match_over"; winnerId: string | null; players: PublicPlayer[] };

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}
