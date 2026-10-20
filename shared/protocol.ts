import type { Beam } from "./geometry.js";
import type { GunId } from "./config.js";

// Messages the client sends to the server.
export type ClientMessage =
  | { type: "create"; name: string; gun: GunId }
  | { type: "join"; code: string; name: string; gun: GunId }
  | { type: "gun"; gun: GunId }
  | { type: "choose"; seat: number }
  | { type: "aim"; aimDeg: number }
  | { type: "lock" }
  | { type: "start" }
  | { type: "leave" };

export type Phase = "LOBBY" | "HIDE" | "REVEAL" | "FIRE" | "RESULT" | "ROUND_BREAK" | "MATCH_OVER";


export interface PublicPlayer {
  id: string;
  name: string;
  gun: GunId;
  score: number;
  alive: boolean;
}

export interface RevealPlayer extends PublicPlayer {
  seat: number | null;
  aimDeg: number;
}

// Messages the server sends to the client.
export type ServerMessage =
  | { type: "joined"; code: string; playerId: string }
  | { type: "error"; message: string }
  | { type: "lobby"; code: string; phase: Phase; hostId: string | null; players: PublicPlayer[] }
  | {
      // Sent privately to each player. It never includes other players' seats or aims.
      type: "hide";
      round: number;
      volley: number;
      endsAt: number;
      you: { alive: boolean; seat: number | null; aimDeg: number; locked: boolean; gun: GunId };
      players: PublicPlayer[];
    }
  | {
      // Sent to everyone once the hide phase ends. Positions become public here.
      type: "reveal";
      round: number;
      volley: number;
      fireAt: number;
      players: RevealPlayer[];
    }
  | { type: "fire"; beams: Beam[]; eliminated: string[] }
  | { type: "round_over"; round: number; winnerId: string | null; players: PublicPlayer[] }
  | { type: "match_over"; winnerIds: string[]; players: PublicPlayer[] };

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}
