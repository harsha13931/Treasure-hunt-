import { randomBytes } from "node:crypto";
import { createArena, pickCollapse, removeTiles, standingCount, startSpots, tileIndexAt, type Arena } from "../shared/arena.js";
import {
  BOT_SKILL,
  BotDifficulty,
  COLLAPSE_EVERY_ROUNDS,
  FIRE_MS,
  HIDE_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  QUICK_START_DELAY_MS,
  RECONNECT_GRACE_MS,
  REVEAL_MS,
  RESULT_MS,
  ROOM_SIZE,
  TICK_MS,
} from "../shared/config.js";
import { DEFAULT_MAP, isMapId, randomMap, type MapId } from "../shared/maps.js";
import { resolveVolley, Shooter, Target, Vec2 } from "../shared/geometry.js";
import { MoveInput, Pose, stepPose } from "../shared/movement.js";
import type { ClientMessage, FloorState, Phase, PublicPlayer, RevealPlayer, ServerMessage } from "../shared/protocol.js";
import { BotPlan, planBot, stepBot } from "./bot.js";

export type Send = (message: ServerMessage) => void;

/** A short record of a finished match, for the server log. It helps tune the game from real play. */
export interface MatchSummary {
  room: string;
  people: number;
  bots: number;
  volleys: number;
  seconds: number;
  /** Players knocked out by a laser, and by falling. */
  shot: number;
  fell: number;
  /** How many floor tiles were still standing when the match ended. */
  tilesLeft: number;
  winner: "person" | "bot" | "none";
}

export interface RoomOptions {
  /** Called when a match ends. */
  onMatchEnd?: (summary: MatchSummary) => void;
  /** Where each player starts a match. Tests use this to set up exact duels. Without it, players start well spread out. */
  spawn?: (index: number, count: number) => Pose;
  /** A source of randomness between 0 and 1. Tests pass a fixed one. */
  random?: () => number;
  /** A public room appears to Quick Match, and starts by itself once there are enough players. */
  isPublic?: boolean;
  /** Called once the last person has left, so the owner can forget the room. */
  onEmpty?: () => void;
}

interface Player {
  id: string;
  name: string;
  send: Send;
  bot: boolean;
  alive: boolean;
  locked: boolean;
  pose: Pose;
  /** Inputs received from the browser but not yet simulated. One is applied per tick. */
  queue: MoveInput[];
  /** Sequence number of the last input the server applied. The browser uses it to reconcile. */
  ack: number;
  /** What a bot has decided to do. Always null for people. */
  plan: BotPlan | null;
  /** Which of PLAYER_COLORS this player wears. No two players in a room share one. */
  color: number;
  /** A secret only this player's browser knows, so no one else can take their seat when reconnecting. */
  token: string;
  /** False while the connection is down. The player's spot is held for a while. */
  connected: boolean;
  dropTimer: ReturnType<typeof setTimeout> | null;
}

/** Caps how far a browser can run ahead of the server. About half a second of input. */
const MAX_QUEUED_INPUTS = 10;
const BOT_NAMES = ["Ace", "Blitz", "Cobra", "Dash", "Echo", "Fang", "Ghost", "Hawk"];
const noop: Send = () => {};

/**
 * One match room. The server runs the timers, the movement, the hits, the ring, and the bots.
 * The browser only predicts its own movement. It never decides hits or deaths.
 */
export class Room {
  readonly code: string;
  private players = new Map<string, Player>();
  private hostId: string | null = null;
  private phase: Phase = "LOBBY";
  private volley = 0;
  /** The floor: which tiles are still standing. */
  private arena: Arena = createArena(DEFAULT_MAP);
  /** The tiles that will fall at the end of this round, shown cracked to everyone. */
  private cracked: number[] = [];
  /** The shape of the coming collapse, such as "edge" or "trench". */
  private pattern = "none";
  private lastKills = 0;
  /** Who has been knocked out, in order. Used for the final ranking. */
  private knockedOut: string[] = [];
  private botSkill: number = BOT_SKILL.normal;
  private lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  private startsAt: number | null = null;
  readonly isPublic: boolean;
  private endsAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private spawn: ((index: number, count: number) => Pose) | null;
  private random: () => number;
  /** Where each living player stood at the last reveal. This is public, so bots may use it. */
  private lastRevealed = new Map<string, Vec2>();
  /** The latest reveal and volley, kept so a player who reconnects can be shown the same scene. */
  private lastRevealMessage: ServerMessage | null = null;
  private lastFireMessage: ServerMessage | null = null;
  private onEmpty: (() => void) | null;
  /** What the host picked for the next match, and the arena the current match is in. */
  private selectedMap: MapId | "random" = DEFAULT_MAP;
  private mapId: MapId = DEFAULT_MAP;
  private onMatchEnd: ((summary: MatchSummary) => void) | null;
  private matchStartedAt = 0;
  private tally = { shot: 0, fell: 0, bots: 0, people: 0 };

  constructor(code: string, options: RoomOptions = {}) {
    this.code = code;
    this.spawn = options.spawn ?? null;
    this.random = options.random ?? Math.random;
    this.isPublic = options.isPublic ?? false;
    // Public matches use a different arena each time.
    if (this.isPublic) this.selectedMap = "random";
    this.onEmpty = options.onEmpty ?? null;
    this.onMatchEnd = options.onMatchEnd ?? null;
  }

  /** True while the room is between matches and has a free spot, so a new player can join. */
  get isOpen(): boolean {
    return (this.phase === "LOBBY" || this.phase === "MATCH_OVER") && this.players.size < MAX_PLAYERS;
  }

  /** A room is empty when no people are left in it. Bots do not keep a room alive. */
  get isEmpty(): boolean {
    return this.people().length === 0;
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  /** How many floor tiles are still standing. */
  get tilesStanding(): number {
    return standingCount(this.arena);
  }

  join(name: string, send: Send): string {
    if (this.players.size >= MAX_PLAYERS) {
      throw new Error("This room is full.");
    }
    const id = randomBytes(8).toString("hex");
    this.players.set(id, this.newPlayer(id, sanitizeName(name), send, false));
    this.hostId ??= id;
    this.updateAutoStart();

    send({ type: "joined", code: this.code, playerId: id, token: this.players.get(id)!.token });
    this.broadcastLobby();
    return id;
  }

  /**
   * The connection of `send` dropped. Between matches that is the same as leaving. During a match the spot is
   * held for a while: the player stands where they are, locked in, and can come back with their token.
   */
  disconnect(id: string, send: Send): void {
    const player = this.players.get(id);
    // A late close from an old connection must not undo a reconnect that already happened.
    if (!player || player.send !== send) return;
    const inMatch = this.phase !== "LOBBY" && this.phase !== "MATCH_OVER";
    if (!inMatch) {
      this.leave(id);
      return;
    }
    player.connected = false;
    player.send = noop;
    if (this.phase === "HIDE" && player.alive && !player.locked) {
      this.lockPlayer(player, player.pose.yaw);
      this.revealIfEveryoneLocked();
    }
    if (player.dropTimer) clearTimeout(player.dropTimer);
    player.dropTimer = setTimeout(() => this.leave(id), RECONNECT_GRACE_MS);
    this.broadcastLobby();
  }

  /** Puts a returning player back in their seat and shows them where the match is. */
  reconnect(id: string, token: string, send: Send): void {
    const player = this.players.get(id);
    if (!player || player.bot || player.token !== token) {
      throw new Error("That match is no longer available.");
    }
    if (player.dropTimer) clearTimeout(player.dropTimer);
    player.dropTimer = null;
    player.connected = true;
    player.send = send;

    send({ type: "joined", code: this.code, playerId: id, token: player.token });
    this.broadcastLobby();
    if (this.phase === "HIDE") {
      this.sendHide(player, this.publicPlayers());
    } else if (this.phase === "REVEAL" || this.phase === "FIRE" || this.phase === "RESULT") {
      if (this.lastRevealMessage) send(this.lastRevealMessage);
      if (this.phase !== "REVEAL" && this.lastFireMessage) send(this.lastFireMessage);
    }
  }

  leave(id: string): void {
    const player = this.players.get(id);
    if (!player) return;
    if (player.dropTimer) clearTimeout(player.dropTimer);
    this.players.delete(id);

    if (this.hostId === id) {
      this.hostId = this.people()[0]?.id ?? null;
    }

    if (this.phase === "HIDE" && player.alive) {
      // A departing player may have been the one holding up the round.
      player.alive = false;
      this.knockedOut.push(id);
      if (this.livingPlayers().length < 2) {
        this.endMatch();
      } else {
        this.revealIfEveryoneLocked();
      }
    }
    this.updateAutoStart();
    this.broadcastLobby();
    if (this.isEmpty) this.onEmpty?.();
  }

  destroy(): void {
    for (const player of this.players.values()) {
      if (player.dropTimer) clearTimeout(player.dropTimer);
    }
    this.clearTimers();
    this.cancelAutoStart();
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

      case "inputs": {
        if (this.phase !== "HIDE" || !player.alive || player.locked || !Array.isArray(message.list)) return;
        // A browser sends a batch every tenth of a second. Only a sensible number of steps is accepted from each.
        for (const item of message.list.slice(0, MAX_QUEUED_INPUTS)) {
          if (player.queue.length >= MAX_QUEUED_INPUTS) break;
          player.queue.push(sanitizeInput(item));
        }
        return;
      }

      case "ping":
        // Answered by the connection itself. Nothing for the room to do.
        return;

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
        const people = this.people().length;
        const bots = Math.max(0, Math.min(ROOM_SIZE - people, Math.floor(Number(message.bots) || 0)));
        if (people + bots < MIN_PLAYERS) {
          throw new Error(`You need at least ${MIN_PLAYERS} players. Add a bot or wait for a friend.`);
        }
        const difficulty: BotDifficulty =
          message.difficulty && message.difficulty in BOT_SKILL ? message.difficulty : "normal";
        const chosen = message.map === "random" || isMapId(message.map) ? message.map : this.selectedMap;
        this.selectedMap = chosen;
        this.startMatch(bots, difficulty);
        return;
      }

      case "map": {
        if (player.id !== this.hostId) throw new Error("Only the host can choose the arena.");
        if (this.phase !== "LOBBY" && this.phase !== "MATCH_OVER") return;
        if (message.map !== "random" && !isMapId(message.map)) throw new Error("Unknown arena.");
        this.selectedMap = message.map;
        this.broadcastLobby();
        return;
      }

      case "leave":
        this.leave(player.id);
        return;

      default:
        throw new Error("Unknown message.");
    }
  }

  /** The lowest color not worn by anyone in the room. */
  private freeColor(): number {
    const used = new Set([...this.players.values()].map((player) => player.color));
    let color = 0;
    while (used.has(color)) color += 1;
    return color;
  }

  private newPlayer(id: string, name: string, send: Send, bot: boolean): Player {
    return {
      id,
      name,
      send,
      bot,
      alive: false,
      locked: false,
      pose: { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
      queue: [],
      ack: 0,
      plan: null,
      color: this.freeColor(),
      token: randomBytes(12).toString("hex"),
      connected: true,
      dropTimer: null,
    };
  }

  private startMatch(botCount: number, difficulty: BotDifficulty): void {
    this.clearTimers();
    this.cancelAutoStart();
    this.removeBots();
    this.botSkill = BOT_SKILL[difficulty];
    this.mapId = this.selectedMap === "random" ? randomMap() : this.selectedMap;

    for (let index = 0; index < botCount; index++) {
      const id = randomBytes(8).toString("hex");
      this.players.set(id, this.newPlayer(id, `Bot ${BOT_NAMES[index % BOT_NAMES.length]}`, noop, true));
    }

    this.arena = createArena(this.mapId);
    const all = [...this.players.values()];
    const spots = startSpots(this.arena, all.length, this.random);
    all.forEach((player, index) => {
      player.alive = true;
      player.locked = false;
      player.queue = [];
      player.ack = 0;
      player.plan = null;
      player.pose = this.spawn
        ? this.spawn(index, all.length)
        : { x: spots[index].x, z: spots[index].z, yaw: this.random() * Math.PI * 2 - Math.PI, vx: 0, vz: 0 };
    });
    this.matchStartedAt = Date.now();
    this.tally = { shot: 0, fell: 0, bots: botCount, people: all.length - botCount };
    this.cracked = [];
    this.lastKills = 0;
    this.knockedOut = [];
    this.volley = 0;
    this.lastRevealed.clear();
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

    // Decide now what this round holds: which tiles will fall at its end (everyone is shown them cracked),
    // after a quiet one always ends in a collapse, so stalling does not pay.
    const due = this.volley % COLLAPSE_EVERY_ROUNDS === 0 || (this.volley > 1 && this.lastKills === 0);
    const plan = due ? pickCollapse(this.arena, this.random) : { tiles: [], pattern: "none" };
    this.cracked = plan.tiles;
    this.pattern = plan.pattern;

    // When no person is left alive, the bots finish the match quickly so spectators are not kept waiting.
    const quick = this.livingPlayers().every((player) => player.bot);
    const known = [...this.lastRevealed.values()];
    for (const player of this.livingPlayers()) {
      player.locked = false;
      player.queue = [];
      player.plan = player.bot
        ? planBot(this.arena, player.pose, this.cracked, known, quick, Date.now(), this.botSkill, this.random)
        : null;
    }

    this.sendHideToAll();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.schedule(HIDE_MS, () => {
      for (const player of this.livingPlayers()) {
        if (!player.locked) this.lockPlayer(player, player.pose.yaw);
      }
      this.enterReveal();
    });

    // Anyone whose connection is down simply stands still, so they never hold the others up.
    for (const player of this.livingPlayers()) {
      if (!player.connected) this.lockPlayer(player, player.pose.yaw);
    }
    this.revealIfEveryoneLocked();
  }

  /** Runs one simulation step for every living player who is still moving. */
  private tick(): void {
    const now = Date.now();
    for (const player of this.livingPlayers()) {
      if (!player.locked) {
        if (player.bot && player.plan) {
          player.pose = stepBot(player.pose, player.plan, this.arena, TICK_MS / 1000);
          if (now >= player.plan.lockAt) player.locked = true;
        } else {
          const input = player.queue.shift();
          if (input) {
            player.pose = stepPose(player.pose, input, TICK_MS / 1000, this.arena);
            player.ack = input.seq;
          }
        }
      }
      this.sendSelf(player);
    }
    this.revealIfEveryoneLocked();
  }

  /** Applies any queued movement, then freezes the player in place facing the given yaw. */
  private lockPlayer(player: Player, yaw: number): void {
    while (player.queue.length > 0) {
      const input = player.queue.shift() as MoveInput;
      player.pose = stepPose(player.pose, input, TICK_MS / 1000, this.arena);
      player.ack = input.seq;
    }
    // Locking in means standing still, so the player stops dead.
    player.pose = { ...player.pose, yaw, vx: 0, vz: 0 };
    player.locked = true;
  }

  /**
   * Reveals once everyone has locked in. When every living person has locked in,
   * the bots lock in too, so people never wait on a bot that is still walking.
   */
  private revealIfEveryoneLocked(): void {
    if (this.phase !== "HIDE") return;
    const living = this.livingPlayers();
    if (living.length < 2) return;

    const people = living.filter((player) => !player.bot);
    if (people.length > 0 && people.every((player) => player.locked)) {
      for (const bot of living) {
        if (bot.bot) bot.locked = true;
      }
    }
    if (living.every((player) => player.locked)) {
      this.enterReveal();
    }
  }

  private enterReveal(): void {
    this.clearTimers();
    this.phase = "REVEAL";
    const fireAt = Date.now() + REVEAL_MS;
    const living = this.livingPlayers();
    const players: RevealPlayer[] = living.map((player) => ({
      id: player.id,
      name: player.name,
      x: player.pose.x,
      z: player.pose.z,
      yaw: player.pose.yaw,
    }));

    // Positions are public from this moment on, so bots may use them in later volleys.
    this.lastRevealed.clear();
    for (const player of living) this.lastRevealed.set(player.id, { x: player.pose.x, z: player.pose.z });

    const reveal: ServerMessage = { type: "reveal", map: this.mapId, volley: this.volley, fireAt, floor: this.floorState(), players };
    this.lastRevealMessage = reveal;
    this.lastFireMessage = null;
    this.broadcast(reveal);
    this.schedule(REVEAL_MS, () => this.enterFire());
  }

  private enterFire(): void {
    this.phase = "FIRE";
    const living = this.livingPlayers();
    const shooters: Shooter[] = living.map((player) => ({ id: player.id, pos: player.pose, yaw: player.pose.yaw }));
    const targets: Target[] = living.map((player) => ({ id: player.id, pos: player.pose }));

    const { beams, eliminated, kills } = resolveVolley(shooters, targets);
    for (const id of eliminated) {
      const player = this.players.get(id);
      if (player) player.alive = false;
      this.lastRevealed.delete(id);
      this.knockedOut.push(id);
    }
    this.lastKills = eliminated.length;
    this.tally.shot += eliminated.length;

    const fire: ServerMessage = { type: "fire", beams, eliminated, kills };
    this.lastFireMessage = fire;
    this.broadcast(fire);
    this.schedule(FIRE_MS, () => this.afterFire());
  }

  private afterFire(): void {
    this.phase = "RESULT";
    if (this.livingPlayers().length < 2) {
      this.schedule(RESULT_MS, () => this.endMatch());
      return;
    }
    if (this.cracked.length > 0) this.collapse();
    this.schedule(RESULT_MS, () => this.enterHide());
  }

  /** What the floor looks like now, for everyone who needs to draw it. */
  private floorState(): FloorState {
    const gone: number[] = [];
    this.arena.standing.forEach((standing, index) => {
      if (standing === 0) gone.push(index);
    });
    return { gone, cracked: this.cracked };
  }

  /**
   * The cracked tiles fall. Anyone standing on one falls with it and is out of the match.
   */
  private collapse(): void {
    const falling = new Set(this.cracked);
    const fallen: string[] = [];
    for (const player of this.livingPlayers()) {
      if (falling.has(tileIndexAt(this.arena.layout, player.pose.x, player.pose.z))) {
        player.alive = false;
        this.lastRevealed.delete(player.id);
        this.knockedOut.push(player.id);
        fallen.push(player.id);
      }
    }
    removeTiles(this.arena, this.cracked);
    this.tally.fell += fallen.length;
    this.broadcast({ type: "collapse", tiles: this.cracked, fallen, pattern: this.pattern });
    this.cracked = [];
  }

  private endMatch(): void {
    this.clearTimers();
    this.phase = "MATCH_OVER";
    const survivors = this.livingPlayers();
    const winnerId = survivors.length === 1 ? survivors[0].id : null;
    // First place is the survivor, then the last to be knocked out, back to the first.
    const ranking = [...survivors.map((player) => player.id), ...[...this.knockedOut].reverse()].filter(
      (id, index, all) => this.players.has(id) && all.indexOf(id) === index,
    );
    // Tell everyone who won while the bots are still in the list, then send the bots home.
    this.onMatchEnd?.({
      room: this.code,
      people: this.tally.people,
      bots: this.tally.bots,
      volleys: this.volley,
      seconds: Math.round((Date.now() - this.matchStartedAt) / 1000),
      shot: this.tally.shot,
      fell: this.tally.fell,
      tilesLeft: standingCount(this.arena),
      winner: winnerId === null ? "none" : this.players.get(winnerId)?.bot ? "bot" : "person",
    });
    this.broadcast({ type: "match_over", winnerId, players: this.publicPlayers(), ranking });
    this.removeBots();
    this.updateAutoStart();
    this.broadcastLobby();
  }

  /**
   * A public room starts by itself a few seconds after a second person arrives,
   * and stops waiting if people leave and there are too few again.
   */
  private updateAutoStart(): void {
    const between = this.phase === "LOBBY" || this.phase === "MATCH_OVER";
    const enough = this.people().length >= MIN_PLAYERS;
    if (this.isPublic && between && enough) {
      if (this.lobbyTimer === null) {
        this.startsAt = Date.now() + QUICK_START_DELAY_MS;
        this.lobbyTimer = setTimeout(() => {
          this.lobbyTimer = null;
          this.startsAt = null;
          if ((this.phase === "LOBBY" || this.phase === "MATCH_OVER") && this.people().length >= MIN_PLAYERS) {
            this.startMatch(0, "normal");
          }
        }, QUICK_START_DELAY_MS);
      }
    } else {
      this.cancelAutoStart();
    }
  }

  private cancelAutoStart(): void {
    if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
    this.lobbyTimer = null;
    this.startsAt = null;
  }

  // ----- helpers -----

  private removeBots(): void {
    for (const [id, player] of this.players) {
      if (player.bot) this.players.delete(id);
    }
  }

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

  private people(): Player[] {
    return [...this.players.values()].filter((player) => !player.bot);
  }

  private livingPlayers(): Player[] {
    return [...this.players.values()].filter((player) => player.alive);
  }

  private publicPlayers(): PublicPlayer[] {
    return [...this.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      alive: player.alive,
      bot: player.bot,
      color: player.color,
    }));
  }

  private broadcastLobby(): void {
    this.broadcast({
      type: "lobby",
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      players: this.publicPlayers(),
      startsAt: this.startsAt,
      map: this.selectedMap,
      isPublic: this.isPublic,
    });
  }

  /**
   * Hide messages are built per player. Each player gets only their own position.
   * Nobody else's position is included before the reveal.
   */
  private sendHideToAll(): void {
    const players = this.publicPlayers();
    for (const player of this.players.values()) {
      if (!player.bot) this.sendHide(player, players);
    }
  }

  private sendHide(player: Player, players: PublicPlayer[]): void {
    player.send({
      type: "hide",
      map: this.mapId,
      volley: this.volley,
      endsAt: this.endsAt,
      floor: this.floorState(),
      you: {
        alive: player.alive,
        x: player.pose.x,
        z: player.pose.z,
        yaw: player.pose.yaw,
        vx: player.pose.vx ?? 0,
        vz: player.pose.vz ?? 0,
        locked: player.locked,
      },
      players,
    });
  }

  private sendSelf(player: Player): void {
    if (!player.alive || player.bot) return;
    player.send({
      type: "self",
      x: player.pose.x,
      z: player.pose.z,
      yaw: player.pose.yaw,
      vx: player.pose.vx ?? 0,
      vz: player.pose.vz ?? 0,
      ack: player.ack,
      locked: player.locked,
    });
  }

  private broadcast(message: ServerMessage): void {
    for (const player of this.players.values()) {
      if (!player.bot) player.send(message);
    }
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
