import { GUNS, GUN_IDS, GunId, ROOM_CODE_LENGTH } from "../../shared/config.js";
import type { Beam } from "../../shared/geometry.js";
import type { ClientMessage, Phase, PublicPlayer, ServerMessage } from "../../shared/protocol.js";
import { Arena, type ActorState } from "./arena.js";
import { Audio } from "./audio.js";
import { colorFor } from "./stickman.js";

type ScreenName = "menu" | "lobby" | "game";

interface You {
  alive: boolean;
  seat: number | null;
  aimDeg: number;
  locked: boolean;
  gun: GunId;
}

const state = {
  socket: null as WebSocket | null,
  leaving: false,
  playerId: null as string | null,
  code: "",
  hostId: null as string | null,
  phase: "LOBBY" as Phase,
  round: 0,
  volley: 0,
  endsAt: 0,
  fireAt: 0,
  players: [] as PublicPlayer[],
  you: null as You | null,
  pendingGun: "pistol" as GunId,
  matchResult: "",
};

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
  menuGuns: byId("menu-guns"),
  roomCode: byId<HTMLButtonElement>("room-code"),
  lobbyResult: byId("lobby-result"),
  playerCount: byId("player-count"),
  playerList: byId<HTMLUListElement>("player-list"),
  lobbyGuns: byId("lobby-guns"),
  start: byId<HTMLButtonElement>("start"),
  leave: byId<HTMLButtonElement>("leave"),
  lobbyNote: byId("lobby-note"),
  hudRound: byId("hud-round"),
  hudAlive: byId("hud-alive"),
  hudPhase: byId("hud-phase"),
  timer: byId("timer"),
  scoreboard: byId("scoreboard"),
  controls: byId("controls"),
  controlsHint: byId("controls-hint"),
  aim: byId<HTMLInputElement>("aim"),
  aimValue: byId("aim-value"),
  lock: byId<HTMLButtonElement>("lock"),
  spectating: byId("spectating"),
  musicToggle: byId<HTMLButtonElement>("music-toggle"),
  banner: byId("banner"),
  toast: byId("toast"),
};

const arena = new Arena(ui.stage);
arena.setSeatClickHandler(onSeatClick);

// ---------- Setup ----------

ui.name.value = readSavedName();
renderGunPickers();
showScreen("menu");

ui.create.addEventListener("click", () => {
  const name = ui.name.value;
  saveName(name);
  connect((socket) => send({ type: "create", name, gun: state.pendingGun }, socket));
});

ui.join.addEventListener("click", () => {
  const code = ui.code.value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) {
    ui.menuError.textContent = `Room codes have ${ROOM_CODE_LENGTH} letters.`;
    return;
  }
  saveName(ui.name.value);
  connect((socket) => send({ type: "join", code, name: ui.name.value, gun: state.pendingGun }, socket));
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

ui.lock.addEventListener("click", () => send({ type: "lock" }));

ui.musicToggle.addEventListener("click", () => {
  audio.setMusic(!audio.isMusicOn);
  ui.musicToggle.textContent = audio.isMusicOn ? "Music on" : "Music off";
  ui.musicToggle.setAttribute("aria-pressed", String(audio.isMusicOn));
});

ui.aim.addEventListener("input", () => setAim(Number(ui.aim.value)));

window.addEventListener("keydown", (event) => {
  if (state.phase !== "HIDE" || !state.you?.alive || state.you.locked) return;
  const step = event.key === "ArrowLeft" || event.key === "a" ? -5 : event.key === "ArrowRight" || event.key === "d" ? 5 : 0;
  if (step === 0) return;
  event.preventDefault();
  setAim(((state.you.aimDeg + step) % 360 + 360) % 360);
});

setInterval(renderTimer, 200);

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
      state.phase = "HIDE";
      state.round = message.round;
      state.volley = message.volley;
      state.endsAt = message.endsAt;
      state.players = message.players;
      state.you = message.you;
      onHide();
      break;

    case "reveal":
      state.phase = "REVEAL";
      state.round = message.round;
      state.volley = message.volley;
      state.fireAt = message.fireAt;
      state.players = mergePlayers(message.players);
      onReveal(message.players);
      break;

    case "fire":
      state.phase = "FIRE";
      onFire(message.beams, message.eliminated);
      break;

    case "round_over":
      state.phase = "ROUND_BREAK";
      state.players = message.players;
      onRoundOver(message.winnerId);
      break;

    case "match_over":
      state.phase = "MATCH_OVER";
      state.players = message.players;
      state.matchResult = describeWinners(message.winnerIds);
      break;
  }
  renderHud();
}

// ---------- Screen handlers ----------

function onLobby(): void {
  const inLobby = state.phase === "LOBBY" || state.phase === "MATCH_OVER";
  if (inLobby) {
    showScreen("lobby");
    ui.lobbyResult.textContent = state.matchResult;
    ui.lobbyResult.classList.toggle("hidden", !state.matchResult);
    renderLobby();
  } else if (!ui.screens.game.classList.contains("hidden")) {
    renderLobby();
  } else {
    // Joined while a match is running: wait in the arena until the next round.
    showScreen("game");
    arena.showHide(null);
  }
}

function onHide(): void {
  showScreen("game");
  const you = state.you;
  const own: ActorState | null =
    you && state.playerId ? { id: state.playerId, seat: you.seat, aimDeg: you.aimDeg, gun: you.gun, alive: you.alive } : null;
  arena.showHide(own);
  if (you) {
    ui.aim.value = String(you.aimDeg);
    ui.aimValue.textContent = `${you.aimDeg}°`;
  }
  renderControls();
}

function onReveal(players: { id: string; seat: number | null; aimDeg: number; gun: GunId; alive: boolean }[]): void {
  arena.revealAll(players);
  audio.playRevealChime();
  showBanner("Reveal");
  renderControls();
}

function onFire(beams: Beam[], eliminated: string[]): void {
  const colorOf = (id: string) => GUNS[state.players.find((p) => p.id === id)?.gun ?? "pistol"].color;
  arena.fire(beams, eliminated, colorOf);

  // One shot sound per shooter, capped so a big shotgun volley does not stack too many sounds.
  const shooters = [...new Set(beams.map((beam) => beam.shooter))];
  shooters.slice(0, 8).forEach(() => audio.playShot());

  for (const id of eliminated) {
    const player = state.players.find((p) => p.id === id);
    if (player) player.alive = false;
  }
  if (eliminated.length > 0) {
    audio.playEliminated();
    const names = eliminated.map((id) => nameOf(id)).join(", ");
    showBanner(eliminated.length === 1 ? `${names} is down` : "Casualties");
  }
  if (state.you && eliminated.includes(state.playerId ?? "")) {
    state.you.alive = false;
  }
  renderControls();
}

function onRoundOver(winnerId: string | null): void {
  showBanner(winnerId ? `${nameOf(winnerId)} wins the round` : "No one survives");
  renderControls();
}

// ---------- Rendering ----------

function renderLobby(): void {
  ui.roomCode.textContent = state.code;
  ui.playerCount.textContent = `(${state.players.length})`;
  ui.playerList.replaceChildren(
    ...state.players.map((player) => {
      const li = document.createElement("li");
      const swatch = el("span", "swatch");
      swatch.style.background = colorFor(player.id);
      li.append(swatch, textNode(player.name), tag(GUNS[player.gun].name));
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

  const me = state.players.find((p) => p.id === state.playerId);
  renderGunCards(ui.lobbyGuns, me?.gun ?? state.pendingGun, (gun) => {
    send({ type: "gun", gun });
  });
}

function renderControls(): void {
  const you = state.you;
  const hiding = state.phase === "HIDE";
  const playing = hiding && you?.alive === true;

  ui.controls.classList.toggle("hidden", !playing);
  ui.spectating.classList.toggle("hidden", !(you && !you.alive && state.phase !== "LOBBY"));

  if (playing && you) {
    ui.controlsHint.textContent = you.seat === null
      ? "Click the ring to choose your seat. Nobody else can see it yet."
      : you.locked
        ? "Locked in. Waiting for the reveal."
        : "Seat chosen. Adjust your aim, then lock in.";
    ui.lock.disabled = you.seat === null || you.locked;
    ui.lock.textContent = you.locked ? "Locked in" : "Lock in";
    ui.aim.disabled = you.locked;
  }
}

function renderHud(): void {
  const alive = state.players.filter((p) => p.alive).length;
  ui.hudRound.textContent = state.round > 0 ? `Round ${state.round} of 5 · Volley ${state.volley}` : "Lobby";
  ui.hudAlive.textContent = `${alive} alive`;
  ui.hudPhase.textContent = phaseText();

  ui.scoreboard.replaceChildren(
    heading("Scoreboard"),
    listOf(
      [...state.players]
        .sort((a, b) => b.score - a.score)
        .map((player) => {
          const li = document.createElement("li");
          li.classList.toggle("out", !player.alive);
          const swatch = el("span", "swatch");
          swatch.style.background = colorFor(player.id);
          li.append(swatch, textNode(player.id === state.playerId ? `${player.name} (you)` : player.name));
          const score = el("span", "score", String(player.score));
          li.append(score);
          return li;
        }),
    ),
  );
  renderTimer();
  renderControls();
}

function renderTimer(): void {
  const target = state.phase === "HIDE" ? state.endsAt : state.phase === "REVEAL" ? state.fireAt : 0;
  if (!target) {
    ui.timer.textContent = "--";
    return;
  }
  const seconds = Math.max(0, Math.ceil((target - Date.now()) / 1000));
  ui.timer.textContent = String(seconds);
}

function phaseText(): string {
  switch (state.phase) {
    case "HIDE":
      return "Hidden · choose your seat and aim";
    case "REVEAL":
      return "Positions revealed";
    case "FIRE":
      return "Fire";
    case "ROUND_BREAK":
      return "Next round starting soon";
    case "RESULT":
      return "Results";
    default:
      return "";
  }
}

function renderGunPickers(): void {
  renderGunCards(ui.menuGuns, state.pendingGun, (gun) => {
    state.pendingGun = gun;
    renderGunPickers();
  });
}

function renderGunCards(container: HTMLElement, selected: GunId, onPick: (gun: GunId) => void): void {
  container.replaceChildren(
    ...GUN_IDS.map((id) => {
      const spec = GUNS[id];
      const button = document.createElement("button");
      button.className = "gun";
      button.type = "button";
      button.style.setProperty("--gun-color", spec.color);
      button.setAttribute("aria-pressed", String(id === selected));
      button.append(el("strong", "", spec.name), el("small", "", spec.blurb));
      button.addEventListener("click", () => onPick(id));
      return button;
    }),
  );
}

// ---------- Player actions ----------

function onSeatClick(seat: number): void {
  if (state.phase !== "HIDE" || !state.you?.alive || state.you.locked) return;
  send({ type: "choose", seat });
}

let pendingAim: number | null = null;
let aimTimer: number | null = null;

function setAim(deg: number): void {
  if (!state.you || state.you.locked) return;
  state.you.aimDeg = deg;
  ui.aim.value = String(deg);
  ui.aimValue.textContent = `${deg}°`;
  if (state.you.seat !== null) arena.setAim(state.you.seat, deg, state.you.gun);

  // Send at most ~10 aim updates per second. The last value always goes out.
  pendingAim = deg;
  if (aimTimer === null) {
    aimTimer = window.setTimeout(() => {
      aimTimer = null;
      if (pendingAim !== null) send({ type: "aim", aimDeg: pendingAim });
      pendingAim = null;
    }, 100);
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
  state.you = null;
  state.players = [];
  state.matchResult = "";
  state.round = 0;
  arena.showHide(null);
  showScreen("menu");
}

function mergePlayers(revealed: { id: string; name: string; gun: GunId; score: number; alive: boolean }[]): PublicPlayer[] {
  return revealed.map(({ id, name, gun, score, alive }) => ({ id, name, gun, score, alive }));
}

function nameOf(id: string): string {
  return state.players.find((p) => p.id === id)?.name ?? "Someone";
}

function describeWinners(ids: string[]): string {
  if (ids.length === 0) return "No winner this match.";
  const names = ids.map((id) => nameOf(id)).join(" & ");
  return `${names} won the match!`;
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
  ui.toast.style.background = positive ? "rgba(6, 95, 70, 0.92)" : "";
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.add("hidden"), 3000);
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function el(tag: string, className = "", text = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function textNode(text: string): Text {
  return document.createTextNode(text);
}

function tag(text: string, extra = ""): HTMLElement {
  return el("span", `tag ${extra}`.trim(), text);
}

function heading(text: string): HTMLElement {
  return el("h3", "", text);
}

function listOf(items: HTMLElement[]): HTMLElement {
  const list = document.createElement("ol");
  list.append(...items);
  return list;
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
