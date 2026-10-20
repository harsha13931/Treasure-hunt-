import { ROOM_CODE_LENGTH, START_RING_RADIUS, TICK_MS } from "../../shared/config.js";
import type { Beam } from "../../shared/geometry.js";
import { facing, stepPose, type MoveInput, type Pose } from "../../shared/movement.js";
import type { ClientMessage, Phase, PublicPlayer, RevealPlayer, ServerMessage } from "../../shared/protocol.js";
import { Audio } from "./audio.js";
import { FloatingJoystick, HoldButton } from "./touch.js";
import { World } from "./world.js";

type ScreenName = "menu" | "lobby" | "game";

/** Simulation step in seconds. Matches the server exactly so the prediction lines up. */
const DT = TICK_MS / 1000;
const MOUSE_SENSITIVITY = 0.0025;
const KEY_TURN_SPEED = 2.2;
/** Fastest turn when the turn stick is pushed all the way over, in radians per second. */
const STICK_TURN_SPEED = 2.8;
const isTouchDevice = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;

interface Me {
  id: string;
  alive: boolean;
  locked: boolean;
  /** Facing direction, set by the mouse or the Q and E keys during the hide phase. */
  yaw: number;
}

const state = {
  socket: null as WebSocket | null,
  leaving: false,
  playerId: null as string | null,
  code: "",
  hostId: null as string | null,
  phase: "LOBBY" as Phase,
  players: [] as PublicPlayer[],
  volley: 0,
  endsAt: 0,
  fireAt: 0,
  radius: START_RING_RADIUS,
  me: null as Me | null,
  /** Our position predicted by stepping our own inputs, and the step before it (for smoothing). */
  current: { x: 0, z: 0, yaw: 0 } as Pose,
  previous: { x: 0, z: 0, yaw: 0 } as Pose,
  /** Inputs sent to the server but not yet confirmed by it. */
  pending: [] as { seq: number; input: MoveInput }[],
  seq: 0,
  accumulator: 0,
  moving: false,
  /** Positions of every living player, as shown at the last reveal. */
  revealed: [] as RevealPlayer[],
  matchResult: "",
};

const keys = new Set<string>();
let pointerLocked = false;
let lastFrame = performance.now();

const audio = new Audio();

const ui = {
  stage: byId("stage"),
  screens: {
    menu: byId("menu"),
    lobby: byId("lobby"),
    game: byId("game"),
  } satisfies Record<ScreenName, HTMLElement>,
  name: byId<HTMLInputElement>("name"),
  code: byId<HTMLInputElement>("code"),
  create: byId<HTMLButtonElement>("create"),
  join: byId<HTMLButtonElement>("join"),
  menuError: byId("menu-error"),
  roomCode: byId<HTMLButtonElement>("room-code"),
  lobbyResult: byId("lobby-result"),
  playerCount: byId("player-count"),
  playerList: byId<HTMLUListElement>("player-list"),
  start: byId<HTMLButtonElement>("start"),
  leave: byId<HTMLButtonElement>("leave"),
  lobbyNote: byId("lobby-note"),
  minimap: byId<HTMLCanvasElement>("minimap"),
  aliveCount: byId("alive-count"),
  ringRadius: byId("ring-radius"),
  phase: byId("phase"),
  timer: byId("timer"),
  controls: byId("controls"),
  controlsHint: byId("controls-hint"),
  lock: byId<HTMLButtonElement>("lock"),
  spectating: byId("spectating"),
  touchUi: byId("touch-ui"),
  musicToggle: byId<HTMLButtonElement>("music-toggle"),
  banner: byId("banner"),
  toast: byId("toast"),
};

const world = new World(ui.stage);
const canvas = world.domElement;
const moveStick = new FloatingJoystick(byId("zone-move"), byId("stick-move"));
const lookStick = new FloatingJoystick(byId("zone-look"), byId("stick-look"));
const forwardButton = new HoldButton(byId("btn-forward"));
const backButton = new HoldButton(byId("btn-back"));
const turnLeftButton = new HoldButton(byId("btn-turn-left"));
const turnRightButton = new HoldButton(byId("btn-turn-right"));
document.body.classList.toggle("touch", isTouchDevice);

// ---------- Setup ----------

ui.name.value = readSavedName();
showScreen("menu");

ui.create.addEventListener("click", () => {
  const name = ui.name.value;
  saveName(name);
  enterLandscape();
  connect((socket) => send({ type: "create", name }, socket));
});

ui.join.addEventListener("click", () => {
  const code = ui.code.value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) {
    ui.menuError.textContent = `Room codes have ${ROOM_CODE_LENGTH} letters.`;
    return;
  }
  saveName(ui.name.value);
  enterLandscape();
  connect((socket) => send({ type: "join", code, name: ui.name.value }, socket));
});

ui.code.addEventListener("keydown", (event) => {
  if (event.key === "Enter") ui.join.click();
});

ui.name.addEventListener("keydown", (event) => {
  if (event.key === "Enter") ui.create.click();
});

ui.roomCode.addEventListener("click", () => {
  void navigator.clipboard?.writeText(state.code).then(() => showToast("Room code copied.", true), () => {});
});

ui.start.addEventListener("click", () => send({ type: "start" }));

ui.leave.addEventListener("click", () => {
  state.leaving = true;
  send({ type: "leave" });
  state.socket?.close();
  resetToMenu();
});

ui.lock.addEventListener("click", () => lockIn());

ui.musicToggle.addEventListener("click", () => {
  audio.setMusic(!audio.isMusicOn);
  ui.musicToggle.textContent = audio.isMusicOn ? "Music on" : "Music off";
  ui.musicToggle.setAttribute("aria-pressed", String(audio.isMusicOn));
});

// Keys are read by code, so they work the same on any keyboard layout.
window.addEventListener("keydown", (event) => {
  if (isGameKey(event.code)) event.preventDefault();
  keys.add(event.code);
  if (event.code === "Space" && !event.repeat) lockIn();
});
window.addEventListener("keyup", (event) => keys.delete(event.code));
window.addEventListener("blur", () => keys.clear());

canvas.addEventListener("click", () => {
  if (!isTouchDevice && state.phase === "HIDE" && state.me?.alive && !pointerLocked) {
    void canvas.requestPointerLock?.();
  }
});

document.addEventListener("pointerlockchange", () => {
  pointerLocked = document.pointerLockElement === canvas;
});

document.addEventListener("mousemove", (event) => {
  const me = state.me;
  if (!pointerLocked || !me || !canTurn()) return;
  me.yaw = wrapAngle(me.yaw - event.movementX * MOUSE_SENSITIVITY);
});

requestAnimationFrame(loop);

// ---------- Networking ----------

function connect(then: (socket: WebSocket) => void): void {
  if (state.socket?.readyState === WebSocket.OPEN) {
    then(state.socket);
    return;
  }
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/ws`);
  state.socket = socket;
  state.leaving = false;

  socket.addEventListener("open", () => then(socket));
  socket.addEventListener("message", (event) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data) as ServerMessage;
    } catch {
      return;
    }
    handle(message);
  });
  socket.addEventListener("close", () => {
    if (state.leaving) return;
    showToast("Disconnected from the server. Refresh the page to play again.");
    resetToMenu();
  });
  socket.addEventListener("error", () => {
    ui.menuError.textContent = "Could not reach the server.";
  });
}

function send(message: ClientMessage, socket: WebSocket | null = state.socket): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function handle(message: ServerMessage): void {
  switch (message.type) {
    case "joined":
      state.playerId = message.playerId;
      state.code = message.code;
      break;

    case "error":
      if (ui.screens.menu.classList.contains("hidden")) {
        showToast(message.message);
      } else {
        ui.menuError.textContent = message.message;
      }
      break;

    case "lobby":
      state.code = message.code;
      state.hostId = message.hostId;
      state.phase = message.phase;
      state.players = message.players;
      onLobby();
      break;

    case "hide":
      onHide(message);
      break;

    case "self":
      onSelf(message);
      break;

    case "reveal":
      onReveal(message);
      break;

    case "fire":
      onFire(message.beams, message.eliminated);
      break;

    case "ring":
      state.radius = message.radius;
      world.setRing(message.radius);
      showBanner("The ring shrinks");
      break;

    case "match_over":
      state.phase = "MATCH_OVER";
      state.players = message.players;
      state.matchResult = describeWinner(message.winnerId);
      state.me = null;
      world.setCharacters([]);
      break;
  }
  renderHud();
}

// ---------- Phase handlers ----------

function onLobby(): void {
  const inLobby = state.phase === "LOBBY" || state.phase === "MATCH_OVER";
  if (inLobby) {
    showScreen("lobby");
    ui.lobbyResult.textContent = state.matchResult;
    ui.lobbyResult.classList.toggle("hidden", !state.matchResult);
    renderLobby();
  } else if (ui.screens.game.classList.contains("hidden")) {
    // Joined while a match is running. Watch until the next match starts.
    showScreen("game");
    world.setCharacters([]);
  }
}

function onHide(message: Extract<ServerMessage, { type: "hide" }>): void {
  showScreen("game");
  state.phase = "HIDE";
  state.volley = message.volley;
  state.endsAt = message.endsAt;
  state.radius = message.radius;
  state.players = message.players;
  state.revealed = [];
  world.setRing(message.radius);
  world.clearBeams();

  const you = message.you;
  const me: Me = { id: state.playerId ?? "", alive: you.alive, locked: you.locked, yaw: you.yaw };
  state.me = me;
  state.current = { x: you.x, z: you.z, yaw: you.yaw };
  state.previous = { ...state.current };
  state.pending = [];
  state.moving = false;

  world.setCharacters(you.alive ? [{ id: me.id, x: you.x, z: you.z, yaw: you.yaw, alive: true }] : []);
}

/** Our own state from the server. The browser's prediction is corrected to match it. */
function onSelf(message: Extract<ServerMessage, { type: "self" }>): void {
  const me = state.me;
  if (!me) return;
  me.locked = message.locked;

  // Drop inputs the server has applied, then replay the rest on top of its position.
  state.pending = state.pending.filter((p) => p.seq > message.ack);
  let pose: Pose = { x: message.x, z: message.z, yaw: me.yaw };
  for (const pending of state.pending) {
    pose = stepPose(pose, pending.input, DT, state.radius);
  }
  state.current = { ...pose, yaw: me.yaw };
  state.previous = { ...state.current };
}

function onReveal(message: Extract<ServerMessage, { type: "reveal" }>): void {
  state.phase = "REVEAL";
  state.volley = message.volley;
  state.fireAt = message.fireAt;
  state.radius = message.radius;
  state.revealed = message.players;
  world.setRing(message.radius);
  if (state.me) {
    state.me.locked = true;
    const own = message.players.find((p) => p.id === state.me?.id);
    if (own) {
      state.current = { x: own.x, z: own.z, yaw: own.yaw };
      state.previous = { ...state.current };
    }
  }
  world.setCharacters(
    message.players.map((p) => ({
      id: p.id,
      name: p.id === state.me?.id ? undefined : p.name,
      x: p.x,
      z: p.z,
      yaw: p.yaw,
      alive: true,
    })),
  );
  audio.playRevealChime();
  showBanner("Revealed");
}

function onFire(beams: Beam[], eliminated: string[]): void {
  state.phase = "FIRE";
  world.fire(beams);

  // One shot sound per shooter, capped so a crowded volley does not stack too many sounds.
  const shooters = [...new Set(beams.map((beam) => beam.shooter))];
  shooters.slice(0, 8).forEach(() => audio.playShot());

  for (const id of eliminated) {
    world.setAlive(id, false);
    const player = state.players.find((p) => p.id === id);
    if (player) player.alive = false;
  }
  if (eliminated.length > 0) {
    audio.playEliminated();
    const names = eliminated.map((id) => nameOf(id));
    showBanner(names.length === 1 ? `${names[0]} is out` : `${names.join(" and ")} are out`);
  }
  if (state.me && eliminated.includes(state.me.id)) {
    state.me.alive = false;
    showToast("You were hit. You are out of the game.");
  }
}

// ---------- Local simulation ----------

function loop(now: number): void {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;

  const me = state.me;
  if (me && canTurn() && !pointerLocked) {
    if (keys.has("KeyQ")) me.yaw = wrapAngle(me.yaw + KEY_TURN_SPEED * dt);
    if (keys.has("KeyE")) me.yaw = wrapAngle(me.yaw - KEY_TURN_SPEED * dt);
  }
  if (me && canTurn()) {
    // Pushing right turns right, which lowers the yaw. The joystick and the turn buttons both count.
    const turn = clampUnit(lookStick.value.x + axis(turnRightButton.pressed, turnLeftButton.pressed));
    me.yaw = wrapAngle(me.yaw - turn * STICK_TURN_SPEED * dt);
  }

  state.accumulator += dt;
  while (state.accumulator >= DT) {
    state.accumulator -= DT;
    stepInput();
  }

  if (me?.alive && state.phase === "HIDE") {
    // Draw between the last two steps so motion stays smooth at any frame rate.
    const alpha = state.accumulator / DT;
    const x = state.previous.x + (state.current.x - state.previous.x) * alpha;
    const z = state.previous.z + (state.current.z - state.previous.z) * alpha;
    world.setPose(me.id, x, z, me.yaw);
    world.setMoving(me.id, state.moving);
    world.setView({ kind: "follow", x, z, yaw: me.yaw });
    world.setFacingMarker({ x, z, yaw: me.yaw });
  } else {
    // Reveal, firing, and spectating all use the overview camera.
    world.setView({ kind: "overview" });
    world.setFacingMarker(null);
  }

  renderHud();
  requestAnimationFrame(loop);
}

/** One simulation step. Sends the input to the server and predicts the result. */
function stepInput(): void {
  if (!canTurn()) {
    state.moving = false;
    state.previous = { ...state.current };
    return;
  }
  const me = state.me as Me;
  const input: MoveInput = {
    seq: ++state.seq,
    forward: clampUnit(
      axis(keys.has("KeyW") || keys.has("ArrowUp") || forwardButton.pressed, keys.has("KeyS") || keys.has("ArrowDown") || backButton.pressed) +
        moveStick.value.y,
    ),
    strafe: clampUnit(
      axis(keys.has("KeyD") || keys.has("ArrowRight"), keys.has("KeyA") || keys.has("ArrowLeft")) + moveStick.value.x,
    ),
    yaw: me.yaw,
  };
  state.pending.push({ seq: input.seq, input });
  state.previous = { ...state.current };
  state.current = { ...stepPose(state.current, input, DT, state.radius), yaw: me.yaw };
  state.moving = input.forward !== 0 || input.strafe !== 0;
  send({ type: "input", ...input });
}

function lockIn(): void {
  const me = state.me;
  if (!me || !canTurn() || me.locked) return;
  me.locked = true;
  state.moving = false;
  send({ type: "lock", yaw: me.yaw });
  if (pointerLocked) document.exitPointerLock();
  renderHud();
}

/** True while the local player can still move or turn. */
function canTurn(): boolean {
  return state.phase === "HIDE" && state.me?.alive === true && !state.me.locked;
}

// ---------- Rendering of the HUD ----------

function renderLobby(): void {
  ui.roomCode.textContent = state.code;
  ui.playerCount.textContent = `(${state.players.length})`;
  ui.playerList.replaceChildren(
    ...state.players.map((player) => {
      const li = document.createElement("li");
      li.append(textNode(player.name));
      if (player.id === state.hostId) li.append(tag("Host", "host"));
      if (player.id === state.playerId) li.append(tag("You", "you"));
      return li;
    }),
  );

  const isHost = state.playerId !== null && state.playerId === state.hostId;
  const enoughPlayers = state.players.length >= 2;
  ui.start.classList.toggle("hidden", !isHost);
  ui.start.disabled = !enoughPlayers;
  ui.lobbyNote.textContent = enoughPlayers
    ? isHost
      ? "Everyone is in. Start when you're ready."
      : "Waiting for the host to start."
    : "Waiting for at least one more player.";
}

function renderHud(): void {
  ui.aliveCount.textContent = String(state.players.filter((p) => p.alive).length);
  ui.ringRadius.textContent = state.radius.toFixed(1);
  ui.phase.textContent = phaseText();

  const target = state.phase === "HIDE" ? state.endsAt : state.phase === "REVEAL" ? state.fireAt : 0;
  ui.timer.textContent = target ? String(Math.max(0, Math.ceil((target - Date.now()) / 1000))) : "--";

  const me = state.me;
  const hiding = state.phase === "HIDE" && me?.alive === true;
  ui.controls.classList.toggle("hidden", !hiding);
  ui.lock.disabled = me?.locked === true;
  ui.lock.textContent = me?.locked ? "Locked in" : "Lock in";
  const controlsHelp = isTouchDevice
    ? "Left side walks · right side turns"
    : "WASD to walk · mouse to look (click the screen) · Space to lock in";
  ui.controlsHint.textContent = me?.locked ? "Locked in. Hold still until the reveal." : controlsHelp;

  // The phone controls only appear while the player can still move.
  const showTouch = isTouchDevice && hiding && me?.locked === false;
  ui.touchUi.classList.toggle("hidden", !showTouch);
  if (!showTouch) {
    for (const control of [moveStick, lookStick, forwardButton, backButton, turnLeftButton, turnRightButton]) {
      control.reset();
    }
  }

  const outOfGame = state.phase !== "LOBBY" && state.phase !== "MATCH_OVER" && (!me || !me.alive);
  ui.spectating.classList.toggle("hidden", !outOfGame);

  drawMinimap();
}

function phaseText(): string {
  switch (state.phase) {
    case "HIDE":
      return state.me?.alive ? "Hidden · walk and set your aim" : "Watching";
    case "REVEAL":
      return "Revealed · stand your ground";
    case "FIRE":
      return "Lasers firing";
    case "RESULT":
      return "Results";
    case "MATCH_OVER":
      return "Match over";
    default:
      return "";
  }
}

/** Top-left map: the ring, the red zone outside it, you, and everyone once they are revealed. */
function drawMinimap(): void {
  const ctx = ui.minimap.getContext("2d");
  if (!ctx) return;
  const size = ui.minimap.width;
  const half = size / 2;
  const view = 18; // meters shown from the center to the edge of the map
  const scale = half / view;
  const toPx = (x: number, z: number) => ({ x: half + x * scale, y: half + z * scale });

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "rgba(120, 20, 20, 0.35)";
  ctx.fillRect(0, 0, size, size);

  // Clear the inside of the ring.
  ctx.save();
  ctx.beginPath();
  ctx.arc(half, half, state.radius * scale, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(40, 38, 34, 0.9)";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#ff6b3d";
  ctx.stroke();
  ctx.restore();

  const dot = (x: number, z: number, color: string, radius: number) => {
    const p = toPx(x, z);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };

  // Other players appear only once the positions are public.
  if (state.phase === "REVEAL" || state.phase === "FIRE" || state.phase === "RESULT") {
    for (const p of state.revealed) {
      if (p.id !== state.me?.id) dot(p.x, p.z, "#e5e7eb", 4);
    }
  }

  const me = state.me;
  if (me?.alive) {
    const p = state.current;
    dot(p.x, p.z, "#9fd8ff", 5);
    const f = facing(me.yaw);
    const tip = toPx(p.x + f.x * 2.2, p.z + f.z * 2.2);
    const base = toPx(p.x, p.z);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.strokeStyle = "#9fd8ff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// ---------- Helpers ----------

function showScreen(name: ScreenName): void {
  for (const key of Object.keys(ui.screens) as ScreenName[]) {
    ui.screens[key].classList.toggle("hidden", key !== name);
  }
}

function resetToMenu(): void {
  state.phase = "LOBBY";
  state.playerId = null;
  state.me = null;
  state.players = [];
  state.matchResult = "";
  state.revealed = [];
  world.setCharacters([]);
  showScreen("menu");
}

function nameOf(id: string): string {
  return state.players.find((p) => p.id === id)?.name ?? "Someone";
}

function describeWinner(winnerId: string | null): string {
  if (winnerId === null) return "No one survived. It's a draw.";
  if (winnerId === state.playerId) return "You are the last one standing!";
  return `${nameOf(winnerId)} is the last one standing.`;
}

function isGameKey(code: string): boolean {
  return ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(code);
}

function axis(positive: boolean, negative: boolean): number {
  return (positive ? 1 : 0) - (negative ? 1 : 0);
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

/** On a phone, goes full screen and locks to landscape. Browsers only allow this after a tap, and some refuse. */
function enterLandscape(): void {
  if (!isTouchDevice) return;
  const lockOrientation = () => {
    const orientation = screen.orientation as ScreenOrientation & { lock?: (type: string) => Promise<void> };
    void orientation.lock?.("landscape").catch(() => {});
  };
  const request = document.documentElement.requestFullscreen?.bind(document.documentElement);
  if (request) {
    void request().then(lockOrientation, () => {});
  } else {
    lockOrientation();
  }
}

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function showBanner(text: string, ms = 1400): void {
  ui.banner.textContent = text;
  ui.banner.classList.add("show");
  window.setTimeout(() => ui.banner.classList.remove("show"), ms);
}

let toastTimer: number | null = null;
function showToast(text: string, positive = false): void {
  ui.toast.textContent = text;
  ui.toast.classList.remove("hidden");
  ui.toast.style.background = positive ? "rgba(6, 95, 70, 0.94)" : "";
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.add("hidden"), 3000);
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function textNode(text: string): Text {
  return document.createTextNode(text);
}

function tag(text: string, extra = ""): HTMLElement {
  const node = document.createElement("span");
  node.className = `tag ${extra}`.trim();
  node.textContent = text;
  return node;
}

function readSavedName(): string {
  try {
    return localStorage.getItem("laser-ring:name") ?? "";
  } catch {
    return "";
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem("laser-ring:name", name.trim());
  } catch {
    // Storage can be blocked. The name simply won't be remembered.
  }
}
