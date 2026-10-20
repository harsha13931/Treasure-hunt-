import { ROOM_CODE_LENGTH, ROOM_SIZE, START_RING_RADIUS, TICK_MS, type BotDifficulty } from "../../shared/config.js";
import type { Beam } from "../../shared/geometry.js";
import { facing, stepPose, type MoveInput, type Pose } from "../../shared/movement.js";
import type { ClientMessage, Phase, PublicPlayer, RevealPlayer, ServerMessage } from "../../shared/protocol.js";
import { Audio } from "./audio.js";
import { FloatingJoystick, HoldButton } from "./touch.js";
import { World } from "./world.js";

const HUD_INTERVAL_MS = 100;
const MINIMAP_INTERVAL_MS = 66;
const SCREENS = ["title", "home", "modes", "solo", "online", "lobby", "game", "results", "howto", "settings"] as const;
type ScreenName = (typeof SCREENS)[number];

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

interface SoloSettings {
  bots: number;
  difficulty: BotDifficulty;
}

interface Settings {
  music: boolean;
  volume: number;
  shake: boolean;
}

const state = {
  socket: null as WebSocket | null,
  leaving: false,
  screen: "home" as ScreenName,
  playerId: null as string | null,
  code: "",
  hostId: null as string | null,
  isPublic: false,
  startsAt: null as number | null,
  phase: "LOBBY" as Phase,
  players: [] as PublicPlayer[],
  volley: 0,
  endsAt: 0,
  fireAt: 0,
  radius: START_RING_RADIUS,
  me: null as Me | null,
  /** Our position predicted by stepping our own inputs, and the step before it (for smoothing). */
  current: { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 } as Pose,
  previous: { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 } as Pose,
  /** The facing the character is drawn with. It eases toward the real facing, so turning feels weighty. */
  viewYaw: 0,
  /** Inputs sent to the server but not yet confirmed by it. */
  pending: [] as { seq: number; input: MoveInput }[],
  seq: 0,
  accumulator: 0,
  moving: false,
  /** Positions of every living player, as shown at the last reveal. */
  revealed: [] as RevealPlayer[],
  ranking: [] as string[],
  winnerId: null as string | null,
  /** When set, the match starts as soon as the room is created. This is how Solo vs Bots works. */
  pendingStart: null as SoloSettings | null,
  /** The last solo setup, so Play Again can repeat it. */
  lastSolo: null as SoloSettings | null,
  showResults: false,
};

const keys = new Set<string>();
let pointerLocked = false;
let stepTimer = 0;
let lastCountdown = 0;
let lastFrame = performance.now();
let lastHud = 0;
const shownText = new WeakMap<HTMLElement, string>();
let perfOverlay: HTMLElement | null = null;
let lastPerf = 0;
let lastMinimap = 0;
let difficulty: BotDifficulty = "normal";

const settings = loadSettings();
const audio = new Audio();

const ui = {
  stage: byId("stage"),
  screens: Object.fromEntries(SCREENS.map((name) => [name, byId(name)])) as Record<ScreenName, HTMLElement>,
  name: byId<HTMLInputElement>("name"),
  startGame: byId<HTMLButtonElement>("start-game"),
  play: byId<HTMLButtonElement>("play"),
  modeSolo: byId<HTMLButtonElement>("mode-solo"),
  soloBots: byId<HTMLInputElement>("solo-bots"),
  soloBotCount: byId("solo-bot-count"),
  difficulty: byId("difficulty"),
  soloStart: byId<HTMLButtonElement>("solo-start"),
  soloError: byId("solo-error"),
  quick: byId<HTMLButtonElement>("quick"),
  create: byId<HTMLButtonElement>("create"),
  code: byId<HTMLInputElement>("code"),
  join: byId<HTMLButtonElement>("join"),
  menuError: byId("menu-error"),
  lobbyKind: byId("lobby-kind"),
  roomCode: byId<HTMLButtonElement>("room-code"),
  lobbyHint: byId("lobby-hint"),
  lobbyTimer: byId("lobby-timer"),
  playerCount: byId("player-count"),
  playerList: byId<HTMLUListElement>("player-list"),
  botsRow: byId("bots-row"),
  lobbyBots: byId<HTMLInputElement>("lobby-bots"),
  lobbyBotCount: byId("lobby-bot-count"),
  start: byId<HTMLButtonElement>("start"),
  leave: byId<HTMLButtonElement>("leave"),
  lobbyNote: byId("lobby-note"),
  resultTitle: byId("result-title"),
  ranking: byId<HTMLOListElement>("ranking"),
  again: byId<HTMLButtonElement>("again"),
  toMenu: byId<HTMLButtonElement>("to-menu"),
  setMusic: byId<HTMLInputElement>("set-music"),
  setVolume: byId<HTMLInputElement>("set-volume"),
  volumeLabel: byId("volume-label"),
  setShake: byId<HTMLInputElement>("set-shake"),
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
  leaveGame: byId<HTMLButtonElement>("leave-game"),
  countdown: byId("countdown"),
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
applySettings();
showScreen("title");
if (new URLSearchParams(location.search).has("perf")) startPerfOverlay();

// The world asks for sounds, and the page plays them.
world.onSound = (sound) => {
  if (sound === "shot") audio.playShot();
  else if (sound === "hit") audio.playHit();
  else audio.playCollapse();
};

// Buttons that only move between screens.
document.querySelectorAll<HTMLElement>("[data-go]").forEach((element) => {
  element.addEventListener("click", () => showScreen(element.dataset.go as ScreenName));
});

// A soft click on every menu button. Music can only start after the first tap, so it starts here too.
document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("button") && !target.closest(".pad-btn")) audio.playClick();
  if (settings.music && !audio.isMusicOn) audio.setMusic(true);
});

// The first tap. It unlocks sound, and on a phone it goes fullscreen and landscape before the menu appears.
ui.startGame.addEventListener("click", () => {
  enterLandscape();
  showScreen("home");
});

ui.play.addEventListener("click", () => {
  saveName(ui.name.value);
  showScreen("modes");
});

ui.modeSolo.addEventListener("click", () => showScreen("solo"));

ui.soloBots.addEventListener("input", () => {
  ui.soloBotCount.textContent = ui.soloBots.value;
});

ui.difficulty.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
  button.addEventListener("click", () => {
    difficulty = button.dataset.difficulty as BotDifficulty;
    ui.difficulty.querySelectorAll("button").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
  });
});

ui.soloStart.addEventListener("click", () => {
  ui.soloError.textContent = "";
  const solo: SoloSettings = { bots: Number(ui.soloBots.value), difficulty };
  state.pendingStart = solo;
  state.lastSolo = solo;
  enterLandscape();
  connect(
    (socket) => send({ type: "create", name: playerName() }, socket),
    (message) => {
      ui.soloError.textContent = message;
    },
  );
});

ui.quick.addEventListener("click", () => {
  ui.menuError.textContent = "";
  state.pendingStart = null;
  state.lastSolo = null;
  enterLandscape();
  connect((socket) => send({ type: "quick", name: playerName() }, socket));
});

ui.create.addEventListener("click", () => {
  ui.menuError.textContent = "";
  state.pendingStart = null;
  state.lastSolo = null;
  enterLandscape();
  connect((socket) => send({ type: "create", name: playerName() }, socket));
});

ui.join.addEventListener("click", () => {
  const code = ui.code.value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) {
    ui.menuError.textContent = `Room codes have ${ROOM_CODE_LENGTH} letters.`;
    return;
  }
  ui.menuError.textContent = "";
  state.pendingStart = null;
  state.lastSolo = null;
  enterLandscape();
  connect((socket) => send({ type: "join", code, name: playerName() }, socket));
});

ui.code.addEventListener("keydown", (event) => {
  if (event.key === "Enter") ui.join.click();
});

ui.name.addEventListener("keydown", (event) => {
  if (event.key === "Enter") ui.play.click();
});

ui.roomCode.addEventListener("click", () => {
  void navigator.clipboard?.writeText(state.code).then(() => showToast("Room code copied.", true), () => {});
});

ui.lobbyBots.addEventListener("input", () => renderLobby());

ui.start.addEventListener("click", () => {
  send({ type: "start", bots: Number(ui.lobbyBots.value), difficulty });
});

ui.leave.addEventListener("click", () => leaveRoom());
ui.leaveGame.addEventListener("click", () => {
  if (window.confirm("Leave this match?")) leaveRoom();
});

ui.again.addEventListener("click", () => {
  state.showResults = false;
  if (state.lastSolo) {
    // Solo: run the same match again straight away.
    send({ type: "start", bots: state.lastSolo.bots, difficulty: state.lastSolo.difficulty });
  } else {
    showScreen("lobby");
  }
});
ui.toMenu.addEventListener("click", () => leaveRoom());

ui.lock.addEventListener("click", () => lockIn());

ui.musicToggle.addEventListener("click", () => {
  settings.music = !audio.isMusicOn;
  applySettings();
  saveSettings();
});

ui.setMusic.addEventListener("change", () => {
  settings.music = ui.setMusic.checked;
  applySettings();
  saveSettings();
});
ui.setVolume.addEventListener("input", () => {
  settings.volume = Number(ui.setVolume.value) / 100;
  applySettings();
  saveSettings();
});
ui.setShake.addEventListener("change", () => {
  settings.shake = ui.setShake.checked;
  applySettings();
  saveSettings();
});

// Keys are read by code, so they work the same on any keyboard layout.
window.addEventListener("keydown", (event) => {
  const typing = (event.target as HTMLElement).tagName === "INPUT";
  if (typing) return;
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

function connect(then: (socket: WebSocket) => void, onFail?: (message: string) => void): void {
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
    showToast("Disconnected from the server.");
    resetToHome();
  });
  socket.addEventListener("error", () => {
    const message = "Could not reach the server.";
    if (onFail) onFail(message);
    else ui.menuError.textContent = message;
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
      if (state.screen === "game" || state.screen === "lobby" || state.screen === "results") {
        showToast(message.message);
      } else {
        ui.soloError.textContent = message.message;
        ui.menuError.textContent = message.message;
      }
      break;

    case "lobby":
      state.code = message.code;
      state.hostId = message.hostId;
      state.phase = message.phase;
      state.players = message.players;
      state.startsAt = message.startsAt;
      state.isPublic = message.isPublic;
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
      showBanner("The floor breaks away");
      break;

    case "match_over":
      onMatchOver(message);
      break;
  }
  renderHud();
}

// ---------- Phase handlers ----------

function onLobby(): void {
  const between = state.phase === "LOBBY" || state.phase === "MATCH_OVER";
  if (between) {
    // Solo: the room exists now, so start the match.
    if (state.pendingStart && state.phase === "LOBBY") {
      const solo = state.pendingStart;
      state.pendingStart = null;
      send({ type: "start", bots: solo.bots, difficulty: solo.difficulty });
      return;
    }
    if (state.showResults) {
      showScreen("results");
    } else {
      showScreen("lobby");
    }
    return;
  }
  if (state.screen !== "game") {
    // Joined while a match is running. Watch until the next match starts.
    showScreen("game");
    world.setCharacters([]);
  }
}

function onHide(message: Extract<ServerMessage, { type: "hide" }>): void {
  showScreen("game");
  state.phase = "HIDE";
  state.showResults = false;
  state.volley = message.volley;
  state.endsAt = message.endsAt;
  state.radius = message.radius;
  state.players = message.players;
  state.revealed = [];
  world.setRing(message.radius, false);
  world.clearBeams();

  const you = message.you;
  const me: Me = { id: state.playerId ?? "", alive: you.alive, locked: you.locked, yaw: you.yaw };
  state.me = me;
  state.current = { x: you.x, z: you.z, yaw: you.yaw, vx: you.vx, vz: you.vz };
  state.previous = { ...state.current };
  state.viewYaw = you.yaw;
  state.pending = [];
  state.moving = false;

  world.setCharacters(you.alive ? [{ id: me.id, x: you.x, z: you.z, yaw: you.yaw, alive: true }] : []);

  if (you.alive && !readFlag("seen-tip")) {
    showBanner(isTouchDevice ? "Walk, aim, then Lock in" : "Walk, aim, then press Space", 3200);
    writeFlag("seen-tip");
  }
}

/** Our own state from the server. The browser's prediction is eased toward it, never snapped. */
function onSelf(message: Extract<ServerMessage, { type: "self" }>): void {
  const me = state.me;
  if (!me) return;
  me.locked = message.locked;

  // Drop inputs the server has applied, then replay the rest on top of its position.
  state.pending = state.pending.filter((p) => p.seq > message.ack);
  let pose: Pose = { x: message.x, z: message.z, yaw: me.yaw, vx: message.vx, vz: message.vz };
  for (const pending of state.pending) {
    pose = stepPose(pose, pending.input, DT, state.radius);
  }

  const dx = pose.x - state.current.x;
  const dz = pose.z - state.current.z;
  if (Math.hypot(dx, dz) > 3) {
    // Far off, for example after being pushed by the shrinking ring. Jump to the server's answer.
    state.current = { ...pose, yaw: me.yaw };
    state.previous = { ...state.current };
  } else {
    // Usually the two agree exactly. When they do not, close the gap a little each time instead of jerking.
    state.current.x += dx * 0.35;
    state.current.z += dz * 0.35;
    state.previous.x += dx * 0.35;
    state.previous.z += dz * 0.35;
  }
}

function onReveal(message: Extract<ServerMessage, { type: "reveal" }>): void {
  state.phase = "REVEAL";
  state.volley = message.volley;
  state.fireAt = message.fireAt;
  state.radius = message.radius;
  state.revealed = message.players;
  lastCountdown = 0;
  world.setRing(message.radius, false);
  if (state.me) {
    state.me.locked = true;
    const own = message.players.find((p) => p.id === state.me?.id);
    if (own) {
      state.current = { x: own.x, z: own.z, yaw: own.yaw, vx: 0, vz: 0 };
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

  for (const id of eliminated) {
    world.setAlive(id, false);
    const player = state.players.find((p) => p.id === id);
    if (player) player.alive = false;
  }
  if (eliminated.length > 0) {
    const names = eliminated.map((id) => nameOf(id));
    showBanner(names.length === 1 ? `${names[0]} is out` : `${names.join(" and ")} are out`);
  } else {
    showBanner("Fire!", 900);
  }
  if (state.me && eliminated.includes(state.me.id)) {
    state.me.alive = false;
    audio.playEliminated();
    showToast("You were hit. You are out of the match.");
  }
}

function onMatchOver(message: Extract<ServerMessage, { type: "match_over" }>): void {
  state.phase = "MATCH_OVER";
  state.players = message.players;
  state.ranking = message.ranking;
  state.winnerId = message.winnerId;
  const wasPlaying = state.me !== null;
  if (wasPlaying) audio.playResult(message.winnerId === state.playerId);

  state.me = null;
  world.setCharacters([]);
  state.showResults = wasPlaying;
  renderResults();
  if (wasPlaying) showScreen("results");
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

  // The drawn facing eases toward the real one, so quick flicks of the mouse do not make the camera jump.
  if (me) {
    state.viewYaw = wrapAngle(state.viewYaw + wrapAngle(me.yaw - state.viewYaw) * (1 - Math.exp(-dt * 18)));
  }

  // Footsteps while the local player walks.
  if (state.moving && canTurn()) {
    stepTimer += dt;
    if (stepTimer >= 0.4) {
      stepTimer = 0;
      audio.playFootstep();
    }
  } else {
    stepTimer = 0.25;
  }

  state.accumulator += dt;
  while (state.accumulator >= DT) {
    state.accumulator -= DT;
    stepInput();
  }

  if (me?.alive && state.phase === "HIDE" && state.screen === "game") {
    // Draw between the last two steps so motion stays smooth at any frame rate.
    const alpha = state.accumulator / DT;
    const x = state.previous.x + (state.current.x - state.previous.x) * alpha;
    const z = state.previous.z + (state.current.z - state.previous.z) * alpha;
    world.setPose(me.id, x, z, state.viewYaw);
    world.setMoving(me.id, state.moving);
    world.setView({ kind: "follow", x, z, yaw: state.viewYaw });
    world.setFacingMarker({ x, z, yaw: state.viewYaw });
  } else if (state.screen !== "game") {
    // Menus and lobby: the camera sweeps around the title duel.
    world.setView({ kind: "title" });
    world.setFacingMarker(null);
  } else {
    // Reveal, firing, and spectating use the overview camera, which zooms in on whoever is alive.
    world.setView({ kind: "overview" });
    world.setFacingMarker(null);
  }

  // The text on screen only needs to change a few times a second. Writing it every frame costs real time.
  if (now - lastHud >= HUD_INTERVAL_MS) {
    lastHud = now;
    renderHud();
  }
  if (state.screen === "game" && now - lastMinimap >= MINIMAP_INTERVAL_MS) {
    lastMinimap = now;
    drawMinimap();
  }

  // One loop does everything: input, then the camera, then the picture, so the picture is never a frame behind.
  world.render();
  if (perfOverlay) updatePerf(now);
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
  state.moving = Math.hypot(state.current.vx ?? 0, state.current.vz ?? 0) > 0.5;
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

// ---------- Screens and the HUD ----------

function showScreen(name: ScreenName): void {
  state.screen = name;
  for (const key of SCREENS) {
    ui.screens[key].classList.toggle("hidden", key !== name);
  }
  // Menus play over the title duel. The match itself has its own camera.
  world.setTitleScene(name !== "game");
  ui.leaveGame.classList.toggle("hidden", name !== "game");
  if (name === "online") ui.menuError.textContent = "";
  if (name === "lobby") renderLobby();
}

function renderLobby(): void {
  const people = state.players.length;
  const isHost = state.playerId !== null && state.playerId === state.hostId;

  ui.lobbyKind.textContent = state.isPublic ? "Quick Match" : "Private room";
  ui.roomCode.textContent = state.code;
  ui.roomCode.classList.toggle("hidden", state.isPublic);
  ui.lobbyHint.textContent = state.isPublic
    ? "A public match. It starts a few seconds after a second player joins."
    : "Share this code. Friends join from Play Online.";
  ui.playerCount.textContent = `(${people})`;
  ui.playerList.replaceChildren(
    ...state.players.map((player) => {
      const li = document.createElement("li");
      li.append(textNode(player.name));
      if (player.id === state.hostId) li.append(tag("Host", "host"));
      if (player.id === state.playerId) li.append(tag("You", "you"));
      return li;
    }),
  );

  // The host can add bots to any room. A match always needs at least two players in total.
  const maxBots = Math.max(0, ROOM_SIZE - people);
  ui.lobbyBots.max = String(maxBots);
  if (Number(ui.lobbyBots.value) > maxBots) ui.lobbyBots.value = String(maxBots);
  const bots = Number(ui.lobbyBots.value);
  ui.lobbyBotCount.textContent = String(bots);
  ui.botsRow.classList.toggle("hidden", !isHost || maxBots === 0);

  const total = people + bots;
  ui.start.classList.toggle("hidden", !isHost);
  ui.start.disabled = total < 2;
  if (!isHost) {
    ui.lobbyNote.textContent = "Waiting for the host to start.";
  } else if (total < 2) {
    ui.lobbyNote.textContent = "You need at least 2 players. Add a bot, or wait for someone to join.";
  } else {
    ui.lobbyNote.textContent = `${people} ${people === 1 ? "player" : "players"}${bots > 0 ? ` and ${bots} ${bots === 1 ? "bot" : "bots"}` : ""} will play.`;
  }
}

function renderResults(): void {
  const mine = state.playerId;
  const place = mine ? state.ranking.indexOf(mine) + 1 : 0;
  if (state.winnerId === null) {
    ui.resultTitle.textContent = "No one survived. It's a draw.";
  } else if (state.winnerId === mine) {
    ui.resultTitle.textContent = "You won!";
  } else if (place > 0) {
    ui.resultTitle.textContent = `You finished ${ordinal(place)}`;
  } else {
    ui.resultTitle.textContent = `${nameOf(state.winnerId)} won`;
  }

  ui.ranking.replaceChildren(
    ...state.ranking.map((id) => {
      const li = document.createElement("li");
      li.append(textNode(nameOf(id)));
      if (id === mine) li.classList.add("you");
      return li;
    }),
  );
}

function renderHud(): void {
  setText(ui.aliveCount, String(state.players.filter((p) => p.alive).length));
  setText(ui.ringRadius, state.radius.toFixed(1));
  setText(ui.phase, phaseText());

  const target = state.phase === "HIDE" ? state.endsAt : state.phase === "REVEAL" ? state.fireAt : 0;
  setText(ui.timer, target ? String(Math.max(0, Math.ceil((target - Date.now()) / 1000))) : "--");

  // The lobby countdown for a public match.
  if (state.screen === "lobby") {
    const waiting = state.startsAt !== null ? Math.max(0, Math.ceil((state.startsAt - Date.now()) / 1000)) : null;
    ui.lobbyTimer.classList.toggle("hidden", waiting === null);
    if (waiting !== null) setText(ui.lobbyTimer, `Match starts in ${waiting}`);
  }

  // The big countdown before the lasers fire.
  const secondsToFire = Math.max(0, Math.ceil((state.fireAt - Date.now()) / 1000));
  const counting = state.phase === "REVEAL" && state.screen === "game" && secondsToFire > 0;
  ui.countdown.classList.toggle("hidden", !counting);
  if (counting) {
    setText(ui.countdown, String(secondsToFire));
    if (secondsToFire !== lastCountdown) {
      lastCountdown = secondsToFire;
      audio.playCountdown(secondsToFire === 1);
      // Restart the pop-in animation for each new number.
      ui.countdown.style.animation = "none";
      void ui.countdown.offsetWidth;
      ui.countdown.style.animation = "";
    }
  }

  const me = state.me;
  const hiding = state.phase === "HIDE" && me?.alive === true;
  ui.controls.classList.toggle("hidden", !hiding);
  ui.lock.disabled = me?.locked === true;
  setText(ui.lock, me?.locked ? "Locked in" : "Lock in");
  const controlsHelp = isTouchDevice
    ? "Left side walks · right side turns"
    : "WASD to walk · mouse to look (click the screen) · Space to lock in";
  setText(ui.controlsHint, me?.locked ? "Locked in. Hold still until the reveal." : controlsHelp);

  // The phone controls only appear while the player can still move.
  const showTouch = isTouchDevice && hiding && me?.locked === false;
  ui.touchUi.classList.toggle("hidden", !showTouch);
  if (!showTouch) {
    for (const control of [moveStick, lookStick, forwardButton, backButton, turnLeftButton, turnRightButton]) {
      control.reset();
    }
  }

  const inMatch = state.screen === "game";
  const outOfGame = inMatch && state.phase !== "LOBBY" && state.phase !== "MATCH_OVER" && (!me || !me.alive);
  ui.spectating.classList.toggle("hidden", !outOfGame);
}

/** Sets an element's text only when it changed, so an unchanged HUD costs nothing. */
function setText(element: HTMLElement, value: string): void {
  if (shownText.get(element) === value) return;
  shownText.set(element, value);
  element.textContent = value;
}

/** Optional readout, switched on with ?perf=1 in the address. */
function startPerfOverlay(): void {
  const element = document.createElement("pre");
  element.className = "perf";
  document.body.append(element);
  perfOverlay = element;
}
function updatePerf(now: number): void {
  if (!perfOverlay || now - lastPerf < 500) return;
  lastPerf = now;
  const s = world.stats();
  perfOverlay.textContent =
    `${s.fps.toFixed(0)} fps  ${s.frameMs.toFixed(1)} ms\n` +
    `${s.drawCalls} draws  ${(s.triangles / 1000).toFixed(0)}k tris\n` +
    `res ${s.pixelRatio.toFixed(2)}x${s.lowPower ? "  low power" : ""}`;
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

/** Top-left map: the floor that is left, you, and everyone once they are revealed. */
function drawMinimap(): void {
  const ctx = ui.minimap.getContext("2d");
  if (!ctx) return;
  const size = ui.minimap.width;
  const half = size / 2;
  const view = 20; // meters shown from the center to the edge of the map
  const scale = half / view;
  const toPx = (x: number, z: number) => ({ x: half + x * scale, y: half + z * scale });

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "rgba(10, 18, 30, 0.55)";
  ctx.fillRect(0, 0, size, size);

  ctx.save();
  ctx.beginPath();
  ctx.arc(half, half, state.radius * scale, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(190, 220, 240, 0.28)";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#9be4ff";
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
      if (p.id !== state.me?.id) dot(p.x, p.z, "#ffffff", 4);
    }
  }

  const me = state.me;
  if (me?.alive) {
    const p = state.current;
    dot(p.x, p.z, "#ffb36b", 5);
    const f = facing(me.yaw);
    const tip = toPx(p.x + f.x * 2.6, p.z + f.z * 2.6);
    const base = toPx(p.x, p.z);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.strokeStyle = "#ffb36b";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// ---------- Helpers ----------

function leaveRoom(): void {
  state.leaving = true;
  send({ type: "leave" });
  state.socket?.close();
  resetToHome();
}

function resetToHome(): void {
  state.phase = "LOBBY";
  state.playerId = null;
  state.me = null;
  state.players = [];
  state.revealed = [];
  state.ranking = [];
  state.showResults = false;
  state.pendingStart = null;
  state.lastSolo = null;
  state.startsAt = null;
  world.setCharacters([]);
  showScreen("home");
  setText(ui.timer, "--");
}

function playerName(): string {
  return ui.name.value.trim() || "Player";
}

function nameOf(id: string): string {
  return state.players.find((p) => p.id === id)?.name ?? "Someone";
}

function ordinal(n: number): string {
  const suffix = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffix[(v - 20) % 10] ?? suffix[v] ?? suffix[0]}`;
}

/** Pushes the saved settings into the audio, the world, and the controls on screen. */
function applySettings(): void {
  audio.setVolume(settings.volume);
  world.shakeEnabled = settings.shake;
  audio.setMusic(settings.music);

  ui.setMusic.checked = settings.music;
  ui.setVolume.value = String(Math.round(settings.volume * 100));
  ui.volumeLabel.textContent = `${Math.round(settings.volume * 100)}%`;
  ui.setShake.checked = settings.shake;
  ui.musicToggle.textContent = settings.music ? "Music on" : "Music off";
  ui.musicToggle.setAttribute("aria-pressed", String(settings.music));
}

function loadSettings(): Settings {
  const fallback: Settings = { music: false, volume: 0.8, shake: true };
  try {
    const raw = localStorage.getItem("laser-ring:settings");
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      music: parsed.music === true,
      volume: typeof parsed.volume === "number" ? Math.min(1, Math.max(0, parsed.volume)) : fallback.volume,
      shake: parsed.shake !== false,
    };
  } catch {
    return fallback;
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem("laser-ring:settings", JSON.stringify(settings));
  } catch {
    // Storage can be blocked. Settings then last only until the page closes.
  }
}

function readFlag(name: string): boolean {
  try {
    return localStorage.getItem(`laser-ring:${name}`) === "1";
  } catch {
    return false;
  }
}

function writeFlag(name: string): void {
  try {
    localStorage.setItem(`laser-ring:${name}`, "1");
  } catch {
    // Not remembered. The tip may show again next time.
  }
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
