import { FINAL_TILES, TILE_SPACING, createArena, removeTiles, standingCount, type Arena } from "../../shared/arena.js";
import { HIDE_MS, PLAYER_COLORS, REVEAL_MS, ROOM_CODE_LENGTH, ROOM_SIZE, TICK_MS, TWIST_SPEED_SCALE, type BotDifficulty, type Twist } from "../../shared/config.js";
import { DEFAULT_MAP, isMapId } from "../../shared/maps.js";
import type { Beam, Kill } from "../../shared/geometry.js";
import { facing, stepPose, type MoveInput, type Pose } from "../../shared/movement.js";
import type { ClientMessage, FloorState, Phase, PublicPlayer, RevealPlayer, ServerMessage } from "../../shared/protocol.js";
import { Audio } from "./audio.js";
import { assignColors, colorFor } from "./stickman.js";
import type { VoicePart } from "./audio.js";
import { haptic } from "./haptics.js";
import { renderMapPicker, type MapChoice } from "./mapart.js";
import { FloatingJoystick, HoldButton } from "./touch.js";
import { loadRobot } from "./robot.js";
import { World } from "./world.js";

let introSkipListener: (() => void) | null = null;

/** Called when the opening scene reaches its end: the title and the Start Game button appear. */
function revealTitle(): void {
  document.body.classList.remove("intro");
  ui.screens.title.classList.add("ready");
  if (introSkipListener) {
    window.removeEventListener("pointerdown", introSkipListener);
    window.removeEventListener("keydown", introSkipListener);
    introSkipListener = null;
  }
}

/** Movement is sent in batches this often, ten times a second, which halves the traffic on a phone connection. */
const INPUT_BATCH_MS = 100;
const HUD_INTERVAL_MS = 100;
const MINIMAP_INTERVAL_MS = 66;
const SCREENS = ["title", "home", "modes", "solo", "online", "lobby", "game", "results", "howto", "settings"] as const;
type ScreenName = (typeof SCREENS)[number];

/** Simulation step in seconds. Matches the server exactly so the prediction lines up. */
const DT = TICK_MS / 1000;
const MOUSE_SENSITIVITY = 0.0017;
const KEY_TURN_SPEED = 1.5;
/** Fastest turn when the turn stick is pushed all the way over, in radians per second. */
const STICK_TURN_SPEED = 1.9;
/** How long a line stays in the elimination feed. */
const FEED_MS = 7000;
const FEED_MAX = 5;
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
  map: MapChoice;
}

interface Settings {
  music: boolean;
  volume: number;
  shake: boolean;
  voice: boolean;
  quality: "auto" | "low" | "high";
  /** The arena picked last time, used for solo matches and as the lobby default. */
  map: MapChoice;
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
  /** Which tiles of the floor are still there, as the server last said. */
  arena: createArena(DEFAULT_MAP) as Arena,
  /** Tiles that fall after this round. */
  cracked: [] as number[],
  twist: "none" as Twist,
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
  /** The arena the host chose, as the lobby last said. */
  lobbyMap: DEFAULT_MAP as MapChoice,
  /** The player an eliminated spectator is watching. */
  spectateId: null as string | null,
};

const keys = new Set<string>();
let pointerLocked = false;
let stepTimer = 0;
let lastCountdown = 0;
let voiceReady = false;
let lastFrame = performance.now();
let lastHud = 0;
const outbox: MoveInput[] = [];
let lastFlush = 0;
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
  setVoice: byId<HTMLInputElement>("set-voice"),
  quality: byId("quality"),
  minimap: byId<HTMLCanvasElement>("minimap"),
  aliveCount: byId("alive-count"),
  ringRadius: byId("ring-radius"),
  roundCard: byId("round-card"),
  roundTitle: byId("round-title"),
  roundSub: byId("round-sub"),
  phase: byId("phase"),
  timer: byId("timer"),
  controls: byId("controls"),
  controlsHint: byId("controls-hint"),
  lock: byId<HTMLButtonElement>("lock"),
  spectating: byId("spectating"),
  specPrev: byId<HTMLButtonElement>("spec-prev"),
  specNext: byId<HTMLButtonElement>("spec-next"),
  specName: byId("spec-name"),
  specHint: byId("spec-hint"),
  touchUi: byId("touch-ui"),
  musicToggle: byId<HTMLButtonElement>("music-toggle"),
  leaveGame: byId<HTMLButtonElement>("leave-game"),
  countdown: byId("countdown"),
  banner: byId("banner"),
  feed: byId("killfeed"),
  roster: byId<HTMLUListElement>("roster"),
  lockLabel: document.querySelector("#lock span") as HTMLElement,
  musicLabel: document.querySelector("#music-toggle span") as HTMLElement,
  net: byId("net"),
  timerArc: document.getElementById("timer-arc") as unknown as SVGCircleElement,
  timerRing: document.querySelector(".timer-ring") as HTMLElement,
  soloMaps: byId("solo-maps"),
  lobbyMaps: byId("lobby-maps"),
  botIcons: byId("bot-icons"),
  avatar: byId("avatar"),
  loader: byId("loader"),
  loaderText: byId("loader-text"),
  loaderFill: byId("loader-fill"),
  resultKicker: byId("result-kicker"),
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
// Load the fonts and the robot first, with a loading bar, then show the title and play the opening scene.
void (async () => {
  setLoader("Loading", 0.15);
  // The fonts are loaded up front, so the first name tags and the menus never appear in a stand-in font.
  await Promise.race([
    Promise.all([document.fonts.load("800 84px Oxanium"), document.fonts.load("700 16px Oxanium"), document.fonts.load("500 16px Inter")]),
    new Promise((done) => window.setTimeout(done, 2500)),
  ]);
  setLoader("Loading", 0.45);
  await loadRobot();
  setLoader("Ready", 1);
  showScreen("title");
  // The opening scene plays once, when the game opens. It is skipped when coming straight back into a match.
  const params = new URLSearchParams(location.search);
  const skipIntro = params.has("nointro") || loadSession() !== null;
  if (skipIntro) {
    revealTitle();
  } else {
    document.body.classList.add("intro");
    world.playIntro(revealTitle);
    const skip = (): void => world.skipIntro();
    window.addEventListener("pointerdown", skip, { once: true });
    window.addEventListener("keydown", skip, { once: true });
    introSkipListener = skip;
  }
  hideLoader();
})();
if (new URLSearchParams(location.search).has("perf")) startPerfOverlay();
// A handle for testing from the browser console. Only present when the address has ?debug.
if (new URLSearchParams(location.search).has("debug")) (window as unknown as { __world: World }).__world = world;

// The world asks for sounds, and the page plays them.
world.onSound = (sound) => {
  // Before the first tap the browser keeps audio locked. Sounds are skipped then, so none burst out later.
  if (!audio.isRunning) return;
  if (sound === "step") audio.playFootstep();
  else if (sound === "shot") audio.playShot();
  else if (sound === "hit") audio.playHit();
  else if (sound === "fall") audio.playFall();
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
  if (!voiceReady) {
    // The first tap: start fetching the announcer's phrases, so they are ready long before the first knock-out.
    voiceReady = true;
    void audio.prepareVoice();
  }
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

function renderBotIcons(): void {
  const count = Number(ui.soloBots.value);
  ui.soloBotCount.textContent = String(count);
  ui.botIcons.replaceChildren(
    ...Array.from({ length: count }, (_, index) => {
      const chip = document.createElement("span");
      chip.style.background = PLAYER_COLORS[(index + 1) % PLAYER_COLORS.length];
      chip.style.animationDelay = `${index * 30}ms`;
      chip.innerHTML = '<svg class="icon"><use href="#i-bot" /></svg>';
      return chip;
    }),
  );
}
ui.soloBots.addEventListener("input", renderBotIcons);
renderBotIcons();

/** The arena for a solo match. `?map=forest` in the address overrides it, which is handy for testing. */
function soloMap(): MapChoice {
  const forced = new URLSearchParams(location.search).get("map");
  return forced === "random" || isMapId(forced) ? forced : settings.map;
}

function renderSoloMaps(): void {
  renderMapPicker(ui.soloMaps, soloMap(), (choice) => {
    settings.map = choice;
    saveSettings();
    renderSoloMaps();
  });
}
renderSoloMaps();

ui.name.addEventListener("input", () => {
  ui.avatar.textContent = (ui.name.value.trim()[0] ?? "P").toUpperCase();
});
ui.avatar.textContent = (ui.name.value.trim()[0] ?? "P").toUpperCase();

ui.difficulty.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
  button.addEventListener("click", () => {
    difficulty = button.dataset.difficulty as BotDifficulty;
    ui.difficulty.querySelectorAll("button").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
  });
});

ui.soloStart.addEventListener("click", () => {
  ui.soloError.textContent = "";
  const solo: SoloSettings = { bots: Number(ui.soloBots.value), difficulty, map: soloMap() };
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
    send({ type: "start", bots: state.lastSolo.bots, difficulty: state.lastSolo.difficulty, map: state.lastSolo.map });
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
ui.quality.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
  button.addEventListener("click", () => {
    settings.quality = button.dataset.quality as Settings["quality"];
    applySettings();
    saveSettings();
  });
});
ui.setVoice.addEventListener("change", () => {
  settings.voice = ui.setVoice.checked;
  applySettings();
  saveSettings();
  if (settings.voice) void audio.announce([{ phrase: "you_win" }]);
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
  // Eliminated players use the turn keys to flip between the people still playing.
  if (state.screen === "game" && state.me?.alive !== true && !event.repeat) {
    if (event.code === "KeyQ" || event.code === "ArrowLeft") cycleSpectate(-1);
    if (event.code === "KeyE" || event.code === "ArrowRight") cycleSpectate(1);
  }
});
ui.specPrev.addEventListener("click", () => cycleSpectate(-1));
ui.specNext.addEventListener("click", () => cycleSpectate(1));
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

/** Shows the loading screen with a message and a bar. */
function setLoader(text: string, progress: number): void {
  ui.loader.classList.remove("done");
  ui.loaderText.textContent = text;
  ui.loaderFill.style.width = `${Math.round(progress * 100)}%`;
}

function hideLoader(): void {
  ui.loader.classList.add("done");
}

/** How many times to try again when the server does not answer, which is what a sleeping free-plan server does. */
const WAKE_ATTEMPTS = 8;

function connect(then: (socket: WebSocket) => void, onFail?: (message: string) => void, attempt = 0): void {
  if (state.socket?.readyState === WebSocket.OPEN) {
    then(state.socket);
    return;
  }
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/ws`);
  state.socket = socket;
  state.leaving = false;

  let opened = false;
  // A server that has gone to sleep takes up to a minute to wake. Say so, instead of looking frozen.
  const slow = window.setTimeout(() => {
    if (!opened && attempt < WAKE_ATTEMPTS) setLoader("Waking up the server. This can take up to a minute.", 0.1 + 0.1 * attempt);
  }, 3000);
  socket.addEventListener("open", () => {
    opened = true;
    lastPong = performance.now();
    window.clearTimeout(slow);
    hideLoader();
    then(socket);
    send({ type: "ping", t: performance.now() }, socket);
  });
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
    if (state.socket === socket) setNet(null);
    if (!opened || state.leaving || state.socket !== socket) return;
    if (reconnecting) {
      retryRejoin();
      return;
    }
    // A match in progress can be rejoined, so try that before giving up.
    if (state.playerId && loadSession()) {
      reconnecting = true;
      reconnectAttempts = 0;
      showToast("Connection lost. Reconnecting…");
      retryRejoin(500);
      return;
    }
    showToast("Disconnected from the server.");
    resetToHome();
  });
  socket.addEventListener("error", () => {
    if (opened) return;
    window.clearTimeout(slow);
    if (state.socket === socket && !state.leaving && attempt < WAKE_ATTEMPTS) {
      setLoader("Waking up the server. This can take up to a minute.", 0.1 + 0.1 * attempt);
      window.setTimeout(() => {
        if (state.socket === socket) connect(then, onFail, attempt + 1);
      }, 4000);
      return;
    }
    hideLoader();
    const message = "Could not reach the server.";
    if (onFail) onFail(message);
    else ui.menuError.textContent = message;
  });
}

// ---------- Connection health ----------

let lastPong = performance.now();

/** Shows how good the connection is: three bars and the delay in milliseconds. */
function setNet(rtt: number | null): void {
  ui.net.classList.toggle("hidden", rtt === null && state.socket?.readyState !== WebSocket.OPEN);
  if (rtt === null) {
    ui.net.className = "net poor";
    setText(ui.net.querySelector("b") as HTMLElement, "…");
    return;
  }
  ui.net.className = `net ${rtt < 120 ? "good" : rtt < 280 ? "fair" : "poor"}`;
  setText(ui.net.querySelector("b") as HTMLElement, `${rtt}`);
}

// A heartbeat every few seconds. It measures the delay, and it notices a connection that has silently died, which a
// phone leaving signal does without telling anyone, so the game can reconnect at once instead of freezing.
window.setInterval(() => {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (performance.now() - lastPong > 12_000) {
    setNet(null);
    socket.close();
    return;
  }
  send({ type: "ping", t: performance.now() });
}, 4000);

/** The network came back, or the tab came back to the front: do not wait for the next timer to reconnect. */
function nudgeReconnect(): void {
  if (document.hidden || state.leaving) return;
  const socket = state.socket;
  if (reconnecting) {
    if (socket?.readyState !== WebSocket.CONNECTING) retryRejoin(0);
  } else if (state.playerId && loadSession() && socket?.readyState !== WebSocket.OPEN) {
    reconnecting = true;
    reconnectAttempts = 0;
    retryRejoin(0);
  } else if (socket?.readyState === WebSocket.OPEN) {
    send({ type: "ping", t: performance.now() });
  }
}
window.addEventListener("online", nudgeReconnect);
document.addEventListener("visibilitychange", nudgeReconnect);

// ---------- Reconnecting ----------

const SESSION_KEY = "laser-ring:session";
const RECONNECT_ATTEMPTS = 20;
const RECONNECT_DELAY_MS = 1500;
let reconnecting = false;
let reconnectAttempts = 0;

interface Session {
  code: string;
  playerId: string;
  token: string;
}

function saveSession(session: Session | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Without storage, a page reload simply cannot rejoin.
  }
}

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Session>) : null;
    if (parsed && typeof parsed.code === "string" && typeof parsed.playerId === "string" && typeof parsed.token === "string") {
      return { code: parsed.code, playerId: parsed.playerId, token: parsed.token };
    }
  } catch {
    // Treat unreadable data as no session.
  }
  return null;
}

/** Tries to get back into the same seat. Called again after each failure, a few seconds apart. */
function retryRejoin(delay = RECONNECT_DELAY_MS): void {
  const session = loadSession();
  if (!session || ++reconnectAttempts > RECONNECT_ATTEMPTS) {
    giveUpReconnecting("Could not get back into the match.");
    return;
  }
  window.setTimeout(() => {
    if (!reconnecting) return;
    connect(
      (socket) => send({ type: "rejoin", ...session }, socket),
      () => {},
      WAKE_ATTEMPTS,
    );
  }, delay);
}

function giveUpReconnecting(message: string): void {
  reconnecting = false;
  saveSession(null);
  showToast(message);
  resetToHome();
}

// A page reload in the middle of a match: try to take the same seat back.
if (loadSession()) {
  reconnecting = true;
  reconnectAttempts = RECONNECT_ATTEMPTS - 2;
  retryRejoin(0);
}

function send(message: ClientMessage, socket: WebSocket | null = state.socket): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function handle(message: ServerMessage): void {
  switch (message.type) {
    case "pong":
      lastPong = performance.now();
      setNet(Math.round(lastPong - message.t));
      break;

    case "joined":
      state.playerId = message.playerId;
      state.code = message.code;
      saveSession({ code: message.code, playerId: message.playerId, token: message.token });
      if (reconnecting) {
        reconnecting = false;
        showToast("Reconnected.", true);
      }
      break;

    case "error":
      if (reconnecting) {
        giveUpReconnecting(message.message);
        break;
      }
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
      assignColors(message.players);
      state.startsAt = message.startsAt;
      state.isPublic = message.isPublic;
      state.lobbyMap = message.map;
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
      onFire(message.beams, message.eliminated, message.kills ?? []);
      break;

    case "collapse":
      onCollapse(message.tiles, message.fallen ?? []);
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
      send({ type: "start", bots: solo.bots, difficulty: solo.difficulty, map: solo.map });
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
  audio.setIntensity(0.45);
  if (message.volley === 1) outReasons.clear();
  state.showResults = false;
  state.volley = message.volley;
  state.endsAt = message.endsAt;
  state.players = message.players;
  assignColors(message.players);
  void audio.prepareVoice(message.players.map((p) => p.name));
  state.revealed = [];
  world.setMap(message.map);
  applyFloor(message.map, message.floor);
  world.clearBeams();
  announceRound(message.volley, message.floor);

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
    pose = stepPose(pose, pending.input, DT, state.arena, speedScale());
  }

  const dx = pose.x - state.current.x;
  const dz = pose.z - state.current.z;
  if (Math.hypot(dx, dz) > 3) {
    // Far off, for example after a correction from the server. Jump to the server's answer.
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
  audio.setIntensity(1);
  state.volley = message.volley;
  state.fireAt = message.fireAt;
  state.revealed = message.players;
  lastCountdown = 0;
  world.setMap(message.map);
  applyFloor(message.map, message.floor);
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

function onFire(beams: Beam[], eliminated: string[], kills: Kill[]): void {
  state.phase = "FIRE";
  world.fire(beams);

  for (const id of eliminated) {
    world.setAlive(id, false);
    const player = state.players.find((p) => p.id === id);
    if (player) player.alive = false;
  }

  // Announce every knock-out by name: who went down, and whose laser did it.
  for (const kill of kills) {
    addFeed(kill.victim, `was eliminated by`, kill.killers);
    outReasons.set(kill.victim, `Shot by ${kill.killers.map((id) => nameOf(id)).join(" and ")}`);
  }
  renderRoster();
  // The shot that ends the match gets a moment of slow motion.
  if (kills.length > 0 && state.players.filter((p) => p.alive).length <= 1) world.slowMotion(1.8);
  if (kills.length > 0) {
    // The same news is spoken, so players who are busy watching the fight still hear who went down.
    for (const kill of kills.slice(0, 3)) void audio.announce(killVoice(kill));
  }
  if (kills.length === 1) {
    showBanner(killText(kills[0]), 2600);
  } else if (kills.length > 1) {
    showBanner(`${kills.length} players eliminated`, 2200);
  } else {
    showBanner("Fire!", 900);
  }
  if (state.me && eliminated.includes(state.me.id)) {
    state.me.alive = false;
    audio.playEliminated();
    haptic([120, 60, 260]);
    const by = kills.find((k) => k.victim === state.me?.id)?.killers ?? [];
    showToast(by.length ? `${joinNames(by)} eliminated you. You are out of the match.` : "You were hit. You are out of the match.");
  }
}

/** A player as the announcer says them: "you" for the local player, otherwise by name (or by color). */
function voicePlayer(id: string): VoicePart {
  if (id === state.playerId) return { phrase: "you" };
  const player = state.players.find((p) => p.id === id);
  return { name: player?.name ?? "", color: player?.color ?? 0 };
}

function killVoice(kill: Kill): VoicePart[] {
  const parts: VoicePart[] =
    kill.victim === state.playerId ? [{ phrase: "you_were_eliminated_by" }] : [voicePlayer(kill.victim), { phrase: "was_eliminated_by" }];
  kill.killers.forEach((id, index) => {
    if (index > 0) parts.push({ phrase: "and" });
    parts.push(voicePlayer(id));
  });
  return parts;
}

/** "Ben was eliminated by Ann". Written for "You" too: "You were eliminated by Ann". */
function killText(kill: Kill): string {
  return `${displayName(kill.victim)} ${kill.victim === state.playerId ? "were" : "was"} eliminated by ${joinNames(kill.killers)}`;
}

/** Takes the floor exactly as the server describes it. Nothing animates. */
function applyFloor(map: MapChoice, floor: FloorState): void {
  state.arena = createArena(map as Parameters<typeof createArena>[0]);
  removeTiles(state.arena, floor.gone);
  state.cracked = floor.cracked;
  state.twist = floor.twist;
  world.setFloor(floor.gone, floor.cracked, floor.twist);
}

/** How fast we walk this round. */
function speedScale(): number {
  return state.twist === "fast" ? TWIST_SPEED_SCALE : 1;
}

/** The title card for a round, and what is special about it: cracks in the floor, or a twist. */
let roundCardTimer: number | null = null;
function announceRound(volley: number, floor: FloorState): void {
  const twistText: Record<Twist, string> = { none: "", wide: "Wide beams", fast: "Speed boost", dark: "Blackout" };
  let sub = `${state.players.filter((p) => p.alive).length} players left`;
  if (floor.twist !== "none") {
    sub = twistText[floor.twist];
    void audio.announce([{ phrase: `twist_${floor.twist}` }]);
  } else if (floor.cracked.length > 0) {
    sub = "The floor is cracking";
    void audio.announce([{ phrase: "cracking" }]);
  }
  setText(ui.roundTitle, `Round ${volley}`);
  setText(ui.roundSub, sub);
  ui.roundCard.classList.add("show");
  if (roundCardTimer !== null) clearTimeout(roundCardTimer);
  roundCardTimer = window.setTimeout(() => ui.roundCard.classList.remove("show"), 2400);
}

/** The cracked tiles fell. Anyone standing on them fell too. */
function onCollapse(tiles: number[], fallen: string[]): void {
  removeTiles(state.arena, tiles);
  state.cracked = [];
  world.collapse(tiles);
  onFallen(fallen, tiles.length > 0);
}

function onFallen(fallen: string[], floorBroke: boolean): void {
  if (fallen.length === 0) {
    // Only say the floor broke if some of it really did.
    if (floorBroke) {
      if (standingCount(state.arena) <= FINAL_TILES) {
        showBanner("Final stand", 2400);
        void audio.announce([{ phrase: "final_stand" }]);
      } else {
        showBanner("The floor collapses");
      }
    }
    return;
  }
  for (const id of fallen) {
    const player = state.players.find((p) => p.id === id);
    if (player) player.alive = false;
    addFeed(id, "fell into the crevasse", []);
    outReasons.set(id, "Fell with the floor");
  }
  renderRoster();
  world.plunge(fallen);
  for (const id of fallen.slice(0, 3)) {
    void audio.announce(id === state.playerId ? [{ phrase: "you_fell" }] : [voicePlayer(id), { phrase: "fell" }]);
  }
  const first = fallen[0];
  showBanner(
    fallen.length === 1
      ? `${displayName(first)} fell into the crevasse`
      : `${fallen.length} players fell into the crevasse`,
    2600,
  );
  if (state.me && fallen.includes(state.me.id)) {
    state.me.alive = false;
    audio.playEliminated();
    haptic([200, 80, 300]);
    showToast("The floor gave way under you. You are out of the match.");
  }
}

/** "You" for the local player, and the player's name for everyone else. */
function displayName(id: string): string {
  return id === state.playerId ? "You" : nameOf(id);
}

function joinNames(ids: string[]): string {
  const names = ids.map((id) => displayName(id));
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Adds one line to the elimination feed, with player names in their own colors. */
function addFeed(victim: string, action: string, killers: string[]): void {
  const line = document.createElement("li");
  const name = (id: string): HTMLElement => {
    const span = document.createElement("strong");
    span.textContent = displayName(id);
    span.style.color = colorFor(id);
    return span;
  };
  const wording = victim === state.playerId ? action.replace(/^was /, "were ") : action;
  line.append(name(victim), textNode(` ${wording}`));
  killers.forEach((id, index) => {
    line.append(textNode(index === 0 ? " " : index === killers.length - 1 ? " and " : ", "), name(id));
  });
  if (victim === state.playerId || killers.includes(state.playerId ?? "")) line.classList.add("mine");
  ui.feed.prepend(line);
  while (ui.feed.children.length > FEED_MAX) ui.feed.lastElementChild?.remove();
  window.setTimeout(() => line.remove(), FEED_MS);
}

function onMatchOver(message: Extract<ServerMessage, { type: "match_over" }>): void {
  state.phase = "MATCH_OVER";
  state.players = message.players;
  assignColors(message.players);
  state.ranking = message.ranking;
  state.winnerId = message.winnerId;
  const wasPlaying = state.me !== null;
  if (wasPlaying) {
    audio.playResult(message.winnerId === state.playerId);
    if (message.winnerId) {
      void audio.announce(
        message.winnerId === state.playerId ? [{ phrase: "you_win" }] : [voicePlayer(message.winnerId), { phrase: "wins" }],
      );
    }
  }

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
    // A light push turns slowly and a full push turns fast, so small corrections are easy while walking in a curve.
    const stick = lookStick.value.x;
    const eased = stick * (0.35 + 0.65 * Math.abs(stick));
    const turn = clampUnit(eased + axis(turnRightButton.pressed, turnLeftButton.pressed));
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
    // Reveal and firing use the overview camera. An eliminated player follows the player they picked.
    const watched = spectateTarget();
    world.setView(watched ? { kind: "spectate", id: watched } : { kind: "overview" });
    world.setFacingMarker(null);
  }

  if (outbox.length > 0 && now - lastFlush >= INPUT_BATCH_MS) flushInputs();

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
  state.current = { ...stepPose(state.current, input, DT, state.arena, speedScale()), yaw: me.yaw };
  state.moving = Math.hypot(state.current.vx ?? 0, state.current.vz ?? 0) > 0.5;
  outbox.push(input);
}

/** Sends the movement steps made since the last batch. */
function flushInputs(): void {
  lastFlush = performance.now();
  if (outbox.length === 0) return;
  send({ type: "inputs", list: outbox.splice(0, outbox.length) });
}

function lockIn(): void {
  const me = state.me;
  if (!me || !canTurn() || me.locked) return;
  me.locked = true;
  state.moving = false;
  flushInputs();
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
  document.body.dataset.screen = name;
  for (const key of SCREENS) {
    ui.screens[key].classList.toggle("hidden", key !== name);
  }
  // Menus play over the title duel. The match itself has its own camera.
  world.setTitleScene(name !== "game");
  audio.setScene(name === "game" ? "match" : "menu");
  if (name !== "game") audio.setIntensity(0.3);
  ui.leaveGame.classList.toggle("hidden", name !== "game");
  if (name === "online") ui.menuError.textContent = "";
  if (name === "lobby") renderLobby();
}

function renderLobby(): void {
  const people = state.players.length;
  const isHost = state.playerId !== null && state.playerId === state.hostId;

  ui.lobbyKind.textContent = state.isPublic ? "Quick Match" : "Private room";
  ui.roomCode.replaceChildren(textNode(state.code), copyIcon());
  ui.roomCode.classList.toggle("hidden", state.isPublic);
  ui.lobbyHint.textContent = state.isPublic
    ? "A public match in a random arena. It starts a few seconds after a second player joins."
    : "Share this code. Friends join from Play Online. Choose the arena below.";
  ui.playerCount.textContent = `${people} / ${ROOM_SIZE}`;

  // The host can add bots to any room. A match always needs at least two players in total.
  const maxBots = Math.max(0, ROOM_SIZE - people);
  ui.lobbyBots.max = String(maxBots);
  if (Number(ui.lobbyBots.value) > maxBots) ui.lobbyBots.value = String(maxBots);
  const bots = Number(ui.lobbyBots.value);
  ui.lobbyBotCount.textContent = String(bots);
  ui.botsRow.classList.toggle("hidden", !isHost || maxBots === 0);

  // One slot for each seat in the room: people, then bots that will be added, then empty seats.
  const slots: HTMLElement[] = state.players.map((player) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "color-dot";
    dot.style.background = PLAYER_COLORS[player.color % PLAYER_COLORS.length];
    const name = document.createElement("span");
    name.className = "nm";
    name.textContent = player.name;
    li.append(dot, name);
    if (player.id === state.hostId) li.append(tag("Host", "host"));
    if (player.id === state.playerId) li.append(tag("You", "you"));
    return li;
  });
  for (let i = 0; i < ROOM_SIZE - people; i++) {
    const li = document.createElement("li");
    if (i < bots) {
      const dot = document.createElement("span");
      dot.className = "color-dot";
      dot.style.background = "#60728c";
      const name = document.createElement("span");
      name.className = "nm";
      name.textContent = "Bot";
      li.append(dot, name, tag("Bot", "bot"));
    } else {
      li.className = "empty";
      li.textContent = "Waiting for player…";
    }
    slots.push(li);
  }
  ui.playerList.replaceChildren(...slots);

  const locked = !isHost || state.isPublic;
  renderMapPicker(ui.lobbyMaps, state.isPublic ? "random" : state.lobbyMap, (choice) => send({ type: "map", map: choice }), locked);

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

function copyIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.innerHTML = '<use href="#i-copy" />';
  return svg;
}

function renderResults(): void {
  const mine = state.playerId;
  const place = mine ? state.ranking.indexOf(mine) + 1 : 0;
  const won = state.winnerId !== null && state.winnerId === mine;
  ui.resultTitle.classList.toggle("win", won);
  ui.resultTitle.classList.toggle("lose", !won && state.winnerId !== null && place > 0);
  if (state.winnerId === null) {
    ui.resultKicker.textContent = "Nobody left standing";
    ui.resultTitle.textContent = "Draw";
  } else if (won) {
    ui.resultKicker.textContent = "Last one standing";
    ui.resultTitle.textContent = "Victory";
  } else if (place > 0) {
    ui.resultKicker.textContent = `You finished ${ordinal(place)}`;
    ui.resultTitle.textContent = "Defeat";
  } else {
    ui.resultKicker.textContent = "Match over";
    ui.resultTitle.textContent = `${nameOf(state.winnerId)} wins`;
  }

  ui.ranking.replaceChildren(
    ...state.ranking.map((id) => {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "color-dot";
      dot.style.background = colorFor(id);
      li.append(dot, textNode(nameOf(id)));
      if (id === mine) li.classList.add("you");
      return li;
    }),
  );
}

function renderHud(): void {
  setText(ui.ringRadius, String(standingCount(state.arena)));
  setText(ui.phase, phaseText());
  renderRoster();

  const target = state.phase === "HIDE" ? state.endsAt : state.phase === "REVEAL" ? state.fireAt : 0;
  const secondsLeft = target ? Math.max(0, Math.ceil((target - Date.now()) / 1000)) : null;
  setText(ui.timer, secondsLeft === null ? "--" : String(secondsLeft));
  // The ring around the number empties as the time runs out, and turns red for the last few seconds.
  const total = state.phase === "HIDE" ? HIDE_MS : REVEAL_MS;
  const fraction = target ? Math.min(1, Math.max(0, (target - Date.now()) / total)) : 1;
  ui.timerArc.style.strokeDashoffset = String(175.93 * (1 - fraction));
  ui.timerRing.classList.toggle("urgent", secondsLeft !== null && secondsLeft <= 5 && state.phase === "HIDE");

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
      haptic(secondsToFire === 1 ? 40 : 15);
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
  setText(ui.lockLabel, me?.locked ? "Locked in" : "Lock in");
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
  if (outOfGame) {
    const watched = spectateTarget();
    const others = spectatable().length;
    setText(ui.specName, watched ? `Watching ${nameOf(watched)}` : "Watching the match");
    setText(
      ui.specHint,
      state.phase === "HIDE"
        ? "Everyone is hiding their spots. You can follow a player once they are revealed."
        : others > 1
          ? "You are out. Switch players with ◀ ▶ or Q E."
          : "You are out. Watching the rest of the match.",
    );
    ui.specPrev.disabled = ui.specNext.disabled = others < 2;
  }
}

/** Living players an eliminated spectator can follow. Positions are only public after the reveal. */
function spectatable(): string[] {
  if (state.phase === "HIDE") return [];
  return state.revealed
    .filter((p) => p.id !== state.playerId && state.players.find((q) => q.id === p.id)?.alive)
    .map((p) => p.id);
}

/** Who the spectator is watching now. Moves on by itself when that player is knocked out. */
function spectateTarget(): string | null {
  if (state.me?.alive) return null;
  const list = spectatable();
  if (list.length === 0) {
    state.spectateId = null;
  } else if (!state.spectateId || !list.includes(state.spectateId)) {
    state.spectateId = list[0];
  }
  return state.spectateId;
}

function cycleSpectate(direction: 1 | -1): void {
  const list = spectatable();
  if (list.length < 2) return;
  const index = state.spectateId ? list.indexOf(state.spectateId) : -1;
  state.spectateId = list[(index + direction + list.length) % list.length];
  audio.playClick();
  renderHud();
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

/** Why each player is out, shown under their name in the roster. */
const outReasons = new Map<string, string>();
const rosterRows = new Map<string, HTMLLIElement>();
let rosterOrder = "";

/** The list of players on the left: each in their own color, with who you are, and who has been knocked out. */
function renderRoster(): void {
  const players = state.players;
  setText(ui.aliveCount, String(players.filter((p) => p.alive).length));

  const order = players.map((p) => p.id).join(",");
  if (order !== rosterOrder) {
    // A new match, or someone joined or left: rebuild the rows in order.
    rosterOrder = order;
    for (const row of rosterRows.values()) row.remove();
    rosterRows.clear();
    for (const player of players) {
      const row = document.createElement("li");
      row.innerHTML = '<span class="chip"></span><span class="who"><span class="nm"></span><span class="how"></span></span><span class="state"><svg class="icon"><use href="#i-check" /></svg></span>';
      const chip = row.querySelector<HTMLElement>(".chip") as HTMLElement;
      chip.style.background = PLAYER_COLORS[player.color % PLAYER_COLORS.length];
      chip.style.setProperty("--c", PLAYER_COLORS[player.color % PLAYER_COLORS.length]);
      rosterRows.set(player.id, row);
      ui.roster.append(row);
    }
  }

  for (const player of players) {
    const row = rosterRows.get(player.id);
    if (!row) continue;
    const you = player.id === state.playerId;
    row.classList.toggle("you", you);
    setText(row.querySelector(".nm") as HTMLElement, you ? `${player.name} (you)` : player.name);
    const wasOut = row.classList.contains("out");
    if (!player.alive && !wasOut) {
      // Just knocked out: flash red and shake once, then settle into the dimmed, struck-through look.
      row.classList.add("out", "just-out");
      row.querySelector("use")?.setAttribute("href", "#i-skull");
      window.setTimeout(() => row.classList.remove("just-out"), 1200);
    } else if (player.alive && wasOut) {
      row.classList.remove("out", "just-out");
      row.querySelector("use")?.setAttribute("href", "#i-check");
    }
    setText(row.querySelector(".how") as HTMLElement, player.alive ? "" : (outReasons.get(player.id) ?? "Eliminated"));
  }
}

function phaseText(): string {
  switch (state.phase) {
    case "HIDE":
      if (!state.me?.alive) return "Watching";
      return state.twist === "dark" ? "Blackout: hide and aim" : state.twist === "fast" ? "Speed boost: hide and aim" : state.twist === "wide" ? "Wide beams: hide and aim" : "Hide and aim";
    case "REVEAL":
      return "Revealed";
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
  const layout = state.arena.layout;
  // Fit the whole floor, whatever its shape, with a little margin.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const t of layout.tiles) {
    minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x);
    minZ = Math.min(minZ, t.z); maxZ = Math.max(maxZ, t.z);
  }
  const span = Math.max(maxX - minX, maxZ - minZ) + TILE_SPACING * 1.4;
  const scale = size / span;
  const midX = (minX + maxX) / 2;
  const midZ = (minZ + maxZ) / 2;
  const toPx = (x: number, z: number) => ({ x: half + (x - midX) * scale, y: half + (z - midZ) * scale });

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "rgba(10, 18, 30, 0.55)";
  ctx.fillRect(0, 0, size, size);

  const crackedSet = new Set(state.cracked);
  const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 180);
  const radius = (TILE_SPACING / Math.sqrt(3)) * scale * 0.94;
  for (const t of layout.tiles) {
    if (!state.arena.standing[t.index]) continue;
    const c = toPx(t.x, t.z);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 6 + (i * Math.PI) / 3;
      const px = c.x + Math.cos(angle) * radius;
      const py = c.y + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = crackedSet.has(t.index) ? `rgba(255, 140, 60, ${0.45 + pulse * 0.4})` : "rgba(190, 220, 240, 0.32)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = crackedSet.has(t.index) ? "#ffb36b" : "rgba(155, 228, 255, 0.55)";
    ctx.stroke();
  }

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
  saveSession(null);
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
  ui.feed.replaceChildren();
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
  ui.setVoice.checked = settings.voice;
  world.setQuality(settings.quality);
  ui.quality.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.quality === settings.quality));
  });
  audio.setVoice(settings.voice);
  ui.musicLabel.textContent = settings.music ? "Music on" : "Music off";
  ui.musicToggle.setAttribute("aria-pressed", String(settings.music));
}

function loadSettings(): Settings {
  const fallback: Settings = { music: true, volume: 0.8, shake: true, voice: true, quality: "auto", map: DEFAULT_MAP };
  try {
    const raw = localStorage.getItem("laser-ring:settings");
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      music: parsed.music !== false,
      volume: typeof parsed.volume === "number" ? Math.min(1, Math.max(0, parsed.volume)) : fallback.volume,
      shake: parsed.shake !== false,
      voice: parsed.voice !== false,
      quality: parsed.quality === "low" || parsed.quality === "high" ? parsed.quality : "auto",
      map: parsed.map === "random" || isMapId(parsed.map) ? parsed.map : DEFAULT_MAP,
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
