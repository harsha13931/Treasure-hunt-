import { randomBytes } from "node:crypto";
import {
  FIRE_MS,
  GUN_IDS,
  GunId,
  HIDE_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  REVEAL_MS,
  RESULT_MS,
  ROUND_BREAK_MS,
  ROUNDS_PER_MATCH,
  SEAT_COUNT,
} from "../shared/config.js";
import { inwardAimDeg, resolveVolley, seatPosition, Shooter, Target } from "../shared/geometry.js";
import type { ClientMessage, Phase, PublicPlayer, RevealPlayer, ServerMessage } from "../shared/protocol.js";

export type Send = (message: ServerMessage) => void;

interface Player {
  id: string;
  name: string;
  gun: GunId;
  score: number;
  alive: boolean;
  seat: number | null;
  aimDeg: number;
  locked: boolean;
  send: Send;
}

/**
 * One match room. The room owns the round state machine and is the only place
 * that knows player positions before the reveal. Clients never decide hits or deaths.
 */
export class Room {
  readonly code: string;
  private players = new Map<string, Player>();
  private hostId: string | null = null;
  private phase: Phase = "LOBBY";
  private round = 0;
  private volley = 0;
  private endsAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(code: string) {
    this.code = code;
  }

  get size(): number {
    return this.players.size;
  }

  get isEmpty(): boolean {
    return this.players.size === 0;
  }

  join(name: string, gun: GunId, send: Send): string {
    if (this.players.size >= MAX_PLAYERS) {
      throw new Error("This room is full.");
    }
    const id = randomBytes(8).toString("hex");
    const player: Player = {
      id,
      name: sanitizeName(name),
      gun,
      score: 0,
      alive: false,
      seat: null,
      aimDeg: 0,
      locked: false,
      send,
    };
    this.players.set(id, player);
    this.hostId ??= id;

    player.send({ type: "joined", code: this.code, playerId: id });
    this.broadcastLobby();
    return id;
  }

  leave(id: string): void {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);

    if (this.hostId === id) {
      this.hostId = this.players.keys().next().value ?? null;
    }
    if (this.phase === "HIDE" && player.alive) {
      // A departing player may have been the one holding up the round.
      player.alive = false;
      if (this.alivePlayers().length < 2) {
        this.clearTimer();
        this.afterVolley();
      } else {
        this.maybeRevealEarly();
      }
    }
    this.broadcastLobby();
  }

  destroy(): void {
    this.clearTimer();
    this.players.clear();
  }

  handle(id: string, message: ClientMessage): void {
    const player = this.players.get(id);
    if (!player) return;

    try {
      this.dispatch(player, message);
    } catch (error) {
      player.send({ type: "error", message: error instanceof Error ? error.message : "Something went wrong." });
    }
  }

  private dispatch(player: Player, message: ClientMessage): void {
    switch (message.type) {
      case "gun":
        if (this.phase !== "LOBBY" && this.phase !== "MATCH_OVER") {
          throw new Error("You can change guns between matches.");
        }
        player.gun = checkGun(message.gun);
        this.broadcastLobby();
        return;

      case "start":
        if (player.id !== this.hostId) throw new Error("Only the host can start the match.");
        if (this.phase !== "LOBBY" && this.phase !== "MATCH_OVER") throw new Error("A match is already running.");
        if (this.connectedCount() < MIN_PLAYERS) throw new Error(`You need at least ${MIN_PLAYERS} players.`);
        this.startMatch();
        return;

      case "choose":
        this.requireHidePhase(player);
        if (!Number.isInteger(message.seat) || message.seat < 0 || message.seat >= SEAT_COUNT) {
          throw new Error("That seat does not exist.");
        }
        if (this.seatTaken(message.seat, player.id)) throw new Error("That seat is taken.");
        player.seat = message.seat;
        this.sendHideAll();
        return;

      case "aim":
        this.requireHidePhase(player);
        if (typeof message.aimDeg !== "number" || !Number.isFinite(message.aimDeg)) {
          throw new Error("Aim must be a number.");
        }
        player.aimDeg = normalizeDeg(message.aimDeg);
        this.sendHideAll();
        return;

      case "lock":
        this.requireHidePhase(player);
        if (player.seat === null) throw new Error("Pick a seat before locking in.");
        player.locked = true;
        this.sendHideAll();
        this.maybeRevealEarly();
        return;

      case "leave":
        this.leave(player.id);
        return;

      default:
        throw new Error("Unknown message.");
    }
  }

  private requireHidePhase(player: Player): void {
    if (this.phase !== "HIDE") throw new Error("Positions can only change during the hide phase.");
    if (!player.alive) throw new Error("You are out of this round.");
    if (player.locked) throw new Error("You are already locked in.");
  }

  private startMatch(): void {
    for (const player of this.players.values()) player.score = 0;
    this.round = 0;
    this.startRound();
  }

  private startRound(): void {
    if (this.connectedCount() < MIN_PLAYERS) {
      this.phase = "LOBBY";
      this.broadcastLobby();
      return;
    }
    this.round += 1;
    this.volley = 0;
    for (const player of this.players.values()) player.alive = true;
    this.enterHide();
  }

  private enterHide(): void {
    this.volley += 1;
    for (const player of this.players.values()) {
      player.seat = null;
      player.aimDeg = 0;
      player.locked = false;
    }
    this.phase = "HIDE";
    this.endsAt = Date.now() + HIDE_MS;
    this.schedule(HIDE_MS, () => this.lockEveryone());
    this.sendHideAll();
  }

  /** Locks in everyone who is still undecided. Undecided players get a random free seat facing the center. */
  private lockEveryone(): void {
    for (const player of this.alivePlayers()) {
      if (player.seat === null) {
        player.seat = this.randomFreeSeat();
        player.aimDeg = inwardAimDeg(player.seat);
      }
      player.locked = true;
    }
    this.enterReveal();
  }

  private maybeRevealEarly(): void {
    if (this.alivePlayers().every((player) => player.locked)) {
      this.clearTimer();
      this.enterReveal();
    }
  }

  private enterReveal(): void {
    this.clearTimer();
    this.phase = "REVEAL";
    const fireAt = Date.now() + REVEAL_MS;
    const players: RevealPlayer[] = [...this.players.values()].map((player) => ({
      ...publicView(player),
      seat: player.alive ? player.seat : null,
      aimDeg: player.aimDeg,
    }));
    this.broadcast({ type: "reveal", round: this.round, volley: this.volley, fireAt, players });
    this.schedule(REVEAL_MS, () => this.enterFire());
  }

  private enterFire(): void {
    this.phase = "FIRE";
    const shooters: Shooter[] = this.alivePlayers()
      .filter((player) => player.seat !== null)
      .map((player) => ({ id: player.id, seat: player.seat as number, aimDeg: player.aimDeg, gun: player.gun }));
    const targets: Target[] = shooters.map((shooter) => ({ id: shooter.id, pos: seatPosition(shooter.seat) }));

    const { beams, eliminated } = resolveVolley(shooters, targets);
    for (const id of eliminated) {
      const player = this.players.get(id);
      if (player) player.alive = false;
    }

    this.broadcast({ type: "fire", beams, eliminated });
    this.schedule(FIRE_MS, () => this.enterResult());
  }

  private enterResult(): void {
    this.phase = "RESULT";
    this.schedule(RESULT_MS, () => this.afterVolley());
  }

  private afterVolley(): void {
    const alive = this.alivePlayers();
    if (alive.length >= 2) {
      this.enterHide();
      return;
    }
    this.endRound(alive[0] ?? null);
  }

  private endRound(winner: Player | null): void {
    if (winner) winner.score += 1;
    this.broadcast({
      type: "round_over",
      round: this.round,
      winnerId: winner?.id ?? null,
      players: this.publicPlayers(),
    });

    if (this.round >= ROUNDS_PER_MATCH) {
      this.endMatch();
      return;
    }
    this.phase = "ROUND_BREAK";
    this.schedule(ROUND_BREAK_MS, () => this.startRound());
  }

  private endMatch(): void {
    this.phase = "MATCH_OVER";
    const best = Math.max(0, ...this.publicPlayers().map((player) => player.score));
    const winnerIds = this.publicPlayers()
      .filter((player) => player.score === best && best > 0)
      .map((player) => player.id);
    this.broadcast({ type: "match_over", winnerIds, players: this.publicPlayers() });
    this.broadcastLobby();
  }

  // ----- helpers -----

  private schedule(ms: number, fn: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private alivePlayers(): Player[] {
    return [...this.players.values()].filter((player) => player.alive);
  }

  private connectedCount(): number {
    return this.players.size;
  }

  private seatTaken(seat: number, exceptId: string): boolean {
    return this.alivePlayers().some((player) => player.id !== exceptId && player.seat === seat);
  }

  private randomFreeSeat(): number {
    const free: number[] = [];
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      if (!this.seatTaken(seat, "")) free.push(seat);
    }
    return free[Math.floor(Math.random() * free.length)];
  }

  private publicPlayers(): PublicPlayer[] {
    return [...this.players.values()].map(publicView);
  }

  private broadcastLobby(): void {
    this.broadcast({
      type: "lobby",
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      players: this.publicPlayers(),
    });
  }

  /**
   * Hide-phase messages are built per player. Each player only learns their own seat and aim.
   * Other players' positions are never included here.
   */
  private sendHideAll(): void {
    const players = this.publicPlayers();
    for (const player of this.players.values()) {
      player.send({
        type: "hide",
        round: this.round,
        volley: this.volley,
        endsAt: this.endsAt,
        you: {
          alive: player.alive,
          seat: player.seat,
          aimDeg: player.aimDeg,
          locked: player.locked,
          gun: player.gun,
        },
        players,
      });
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const player of this.players.values()) player.send(message);
  }
}

function publicView(player: Player): PublicPlayer {
  return {
    id: player.id,
    name: player.name,
    gun: player.gun,
    score: player.score,
    alive: player.alive,
  };
}

function sanitizeName(raw: string): string {
  const cleaned = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 16);
  return cleaned || "Player";
}

function normalizeDeg(deg: number): number {
  return ((Math.round(deg) % 360) + 360) % 360;
}

function checkGun(value: unknown): GunId {
  if (typeof value === "string" && (GUN_IDS as string[]).includes(value)) return value as GunId;
  throw new Error("Unknown gun.");
}
