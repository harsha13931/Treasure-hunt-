import { randomBytes } from "node:crypto";
import {
  FIRE_MS,
  HIDE_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  MIN_RING_RADIUS,
  NO_KILL_VOLLEYS_BEFORE_SHRINK,
  REVEAL_MS,
  RESULT_MS,
  RING_SHRINK_STEP,
  START_RING_RADIUS,
  TICK_MS,
} from "../shared/config.js";
import { resolveVolley, Shooter, Target } from "../shared/geometry.js";
import { clampToRing, MoveInput, Pose, startPoseFor, stepPose } from "../shared/movement.js";
import type { ClientMessage, Phase, PublicPlayer, RevealPlayer, ServerMessage } from "../shared/protocol.js";

export type Send = (message: ServerMessage) => void;

export interface RoomOptions {
  /** Where each player starts a match. Tests use this to set up exact duels. */
  spawn?: (index: number, count: number) => Pose;
}

interface Player {
  id: string;
  name: string;
  send: Send;
  alive: boolean;
  locked: boolean;
  pose: Pose;
  /** Inputs received from the browser but not yet simulated. One is applied per tick. */
  queue: MoveInput[];
  /** Sequence number of the last input the server applied. The browser uses it to reconcile. */
  ack: number;
}

/** Caps how far a browser can run ahead of the server. About half a second of input. */
const MAX_QUEUED_INPUTS = 10;

/**
 * One match room. The server runs the timers, the movement, the hits, and the ring.
 * The browser only predicts its own movement. It never decides hits or deaths.
 */
export class Room {
  readonly code: string;
  private players = new Map<string, Player>();
  private hostId: string | null = null;
  private phase: Phase = "LOBBY";
  private volley = 0;
  private radius = START_RING_RADIUS;
  private noKillStreak = 0;
  private lastKills = 0;
  private endsAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private spawn: (index: number, count: number) => Pose;

  constructor(code: string, options: RoomOptions = {}) {
    this.code = code;
    this.spawn = options.spawn ?? startPoseFor;
  }

  get isEmpty(): boolean {
    return this.players.size === 0;
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  get ringRadius(): number {
    return this.radius;
  }

  join(name: string, send: Send): string {
    if (this.players.size >= MAX_PLAYERS) {
      throw new Error("This room is full.");
    }
    const id = randomBytes(8).toString("hex");
    this.players.set(id, {
      id,
      name: sanitizeName(name),
      send,
      alive: false,
      locked: false,
      pose: { x: 0, z: 0, yaw: 0 },
      queue: [],
      ack: 0,
    });
    this.hostId ??= id;

    send({ type: "joined", code: this.code, playerId: id });
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
      player.alive = false;
      if (this.livingPlayers().length < 2) {
        this.endMatch();
      } else {
        this.revealIfEveryoneLocked();
      }
    }
    this.broadcastLobby();
  }

  destroy(): void {
    this.clearTimers();
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
      case "input": {
        if (this.phase !== "HIDE" || !player.alive || player.locked) return;
        const input = sanitizeInput(message);
        if (player.queue.length < MAX_QUEUED_INPUTS) player.queue.push(input);
        return;
      }

      case "lock": {
        if (this.phase !== "HIDE") throw new Error("You can only lock in during the hide phase.");
        if (!player.alive) throw new Error("You are out of the game.");
        if (player.locked) return;
        this.lockPlayer(player, finiteYaw(message.yaw));
        this.sendSelf(player);
        this.revealIfEveryoneLocked();
        return;
      }

      case "start": {
        if (player.id !== this.hostId) throw new Error("Only the host can start the match.");
        if (this.phase !== "LOBBY" && this.phase !== "MATCH_OVER") throw new Error("A match is already running.");
        if (this.players.size < MIN_PLAYERS) throw new Error(`You need at least ${MIN_PLAYERS} players.`);
        this.startMatch();
        return;
      }

      case "leave":
        this.leave(player.id);
        return;

      default:
        throw new Error("Unknown message.");
    }
  }

  private startMatch(): void {
    this.clearTimers();
    const all = [...this.players.values()];
    all.forEach((player, index) => {
      player.alive = true;
      player.locked = false;
      player.queue = [];
      player.ack = 0;
      player.pose = this.spawn(index, all.length);
    });
    this.radius = START_RING_RADIUS;
    this.noKillStreak = 0;
    this.volley = 0;
    this.enterHide();
  }

  private enterHide(): void {
    if (this.livingPlayers().length < 2) {
      this.endMatch();
      return;
    }

    this.volley += 1;
    this.phase = "HIDE";
    this.endsAt = Date.now() + HIDE_MS;
    for (const player of this.livingPlayers()) {
      player.locked = false;
      player.queue = [];
    }

    this.sendHideToAll();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.schedule(HIDE_MS, () => {
      for (const player of this.livingPlayers()) {
        if (!player.locked) this.lockPlayer(player, player.pose.yaw);
      }
      this.enterReveal();
    });
  }

  /** Runs one simulation step for every living player who is still moving. */
  private tick(): void {
    for (const player of this.livingPlayers()) {
      if (!player.locked) {
        const input = player.queue.shift();
        if (input) {
          player.pose = stepPose(player.pose, input, TICK_MS / 1000, this.radius);
          player.ack = input.seq;
        }
      }
      this.sendSelf(player);
    }
  }

  /** Applies any queued movement, then freezes the player in place facing the given yaw. */
  private lockPlayer(player: Player, yaw: number): void {
    while (player.queue.length > 0) {
      const input = player.queue.shift() as MoveInput;
      player.pose = stepPose(player.pose, input, TICK_MS / 1000, this.radius);
      player.ack = input.seq;
    }
    player.pose = { ...player.pose, yaw };
    player.locked = true;
  }

  private revealIfEveryoneLocked(): void {
    if (this.phase !== "HIDE") return;
    const living = this.livingPlayers();
    if (living.length >= 2 && living.every((player) => player.locked)) {
      this.enterReveal();
    }
  }

  private enterReveal(): void {
    this.clearTimers();
    this.phase = "REVEAL";
    const fireAt = Date.now() + REVEAL_MS;
    const players: RevealPlayer[] = this.livingPlayers().map((player) => ({
      id: player.id,
      name: player.name,
      x: player.pose.x,
      z: player.pose.z,
      yaw: player.pose.yaw,
    }));
    this.broadcast({ type: "reveal", volley: this.volley, fireAt, radius: this.radius, players });
    this.schedule(REVEAL_MS, () => this.enterFire());
  }

  private enterFire(): void {
    this.phase = "FIRE";
    const living = this.livingPlayers();
    const shooters: Shooter[] = living.map((player) => ({ id: player.id, pos: player.pose, yaw: player.pose.yaw }));
    const targets: Target[] = living.map((player) => ({ id: player.id, pos: player.pose }));

    const { beams, eliminated } = resolveVolley(shooters, targets);
    for (const id of eliminated) {
      const player = this.players.get(id);
      if (player) player.alive = false;
    }
    this.lastKills = eliminated.length;

    this.broadcast({ type: "fire", beams, eliminated });
    this.schedule(FIRE_MS, () => this.afterFire());
  }

  private afterFire(): void {
    this.phase = "RESULT";
    if (this.livingPlayers().length < 2) {
      this.schedule(RESULT_MS, () => this.endMatch());
      return;
    }

    this.noKillStreak = this.lastKills === 0 ? this.noKillStreak + 1 : 0;
    if (this.noKillStreak >= NO_KILL_VOLLEYS_BEFORE_SHRINK) {
      this.shrinkRing();
    }
    this.schedule(RESULT_MS, () => this.enterHide());
  }

  /** Shrinks the ring one step and pushes any player outside it back to the new edge. */
  private shrinkRing(): void {
    this.radius = Math.max(MIN_RING_RADIUS, this.radius - RING_SHRINK_STEP);
    this.noKillStreak = 0;
    for (const player of this.livingPlayers()) {
      player.pose = clampToRing(player.pose, this.radius);
    }
    this.broadcast({ type: "ring", radius: this.radius });
  }

  private endMatch(): void {
    this.clearTimers();
    this.phase = "MATCH_OVER";
    const survivors = this.livingPlayers();
    const winnerId = survivors.length === 1 ? survivors[0].id : null;
    this.broadcast({ type: "match_over", winnerId, players: this.publicPlayers() });
    this.broadcastLobby();
  }

  // ----- helpers -----

  private schedule(ms: number, fn: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.timer = null;
    this.tickTimer = null;
  }

  private livingPlayers(): Player[] {
    return [...this.players.values()].filter((player) => player.alive);
  }

  private publicPlayers(): PublicPlayer[] {
    return [...this.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      alive: player.alive,
    }));
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
   * Hide messages are built per player. Each player gets only their own position.
   * Nobody else's position is included before the reveal.
   */
  private sendHideToAll(): void {
    const players = this.publicPlayers();
    for (const player of this.players.values()) {
      player.send({
        type: "hide",
        volley: this.volley,
        endsAt: this.endsAt,
        radius: this.radius,
        you: {
          alive: player.alive,
          x: player.pose.x,
          z: player.pose.z,
          yaw: player.pose.yaw,
          locked: player.locked,
        },
        players,
      });
    }
  }

  private sendSelf(player: Player): void {
    if (!player.alive) return;
    player.send({
      type: "self",
      x: player.pose.x,
      z: player.pose.z,
      yaw: player.pose.yaw,
      ack: player.ack,
      locked: player.locked,
    });
  }

  private broadcast(message: ServerMessage): void {
    for (const player of this.players.values()) player.send(message);
  }
}

function sanitizeInput(message: { seq: unknown; forward: unknown; strafe: unknown; yaw: unknown }): MoveInput {
  return {
    seq: Number.isInteger(message.seq) ? (message.seq as number) : 0,
    forward: clamp(Number(message.forward), -1, 1),
    strafe: clamp(Number(message.strafe), -1, 1),
    yaw: finiteYaw(Number(message.yaw)),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, value));
}

function finiteYaw(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function sanitizeName(raw: string): string {
  const cleaned = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 16);
  return cleaned || "Player";
}
