import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import {
  BEAM_HALF_WIDTH,
  BEAM_HEIGHT,
  MUZZLE_FORWARD,
  PLAYER_RADIUS,
} from "../../shared/config.js";
import type { Twist } from "../../shared/config.js";
import { DEFAULT_MAP, type MapId } from "../../shared/maps.js";
import type { Beam } from "../../shared/geometry.js";
import { facing } from "../../shared/movement.js";
import { Effects } from "./effects.js";
import { layoutFor } from "../../shared/arena.js";
import { Floor } from "./floor.js";
import { buildMap, type MapScene } from "./maps/index.js";
import type { Actor } from "./actor.js";
import { Robot, robotReady } from "./robot.js";
import { Stickman } from "./stickman.js";

export interface CharacterState {
  id: string;
  /** Shown above the head. Leave out for the local player. */
  name?: string;
  x: number;
  z: number;
  yaw: number;
  alive: boolean;
}

export type CameraView =
  | { kind: "follow"; x: number; z: number; yaw: number }
  /** Watch a living player from behind, as a spectator. */
  | { kind: "spectate"; id: string }
  | { kind: "overview" }
  | { kind: "title" };

/** Sounds the world asks the page to play, so the world itself stays free of audio. */
export type WorldSound = "shot" | "hit" | "collapse" | "fall" | "step";

interface TimedBeam {
  group: THREE.Group;
  materials: THREE.MeshBasicMaterial[];
  baseOpacity: number[];
  length: number;
  startedAt: number;
}

const CAMERA_TURN_RATE = 5;
const MIN_PIXEL_RATIO = 0.7;
const SLOW_MOTION_SCALE = 0.3;
const BEAM_GROW_MS = 140;
const BEAM_HOLD_MS = 700;
const BEAM_FADE_MS = 500;
/** Title scene: seconds from standing off to the shot, and to the end of the loop. */
const TITLE_SHOT_AT = 2.6;
const TITLE_LOOP = 9;
// The opening scene: two robots walk in from opposite sides, face off, and shoot each other.
const INTRO_START_X = 16;
const INTRO_DUEL_X = 4.2;
const INTRO_WALK_SPEED = 4.6;
/** The stare-down before the shots, in seconds. */
const INTRO_HOLD = 1.0;
/** How long after the shots the title appears. */
const INTRO_REVEAL_AFTER = 1.5;

/**
 * The arena (scenery, tile floor and fence), the robots, the lasers and the effects. It draws what the server reports. It never decides hits or deaths.
 */
export class World {
  /** Called when the world wants a sound played. */
  onSound: ((sound: WorldSound) => void) | null = null;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private effects: Effects;
  private touchDevice = window.matchMedia("(pointer: coarse)").matches;

  /** The floor of the arena being played in. Each arena builds its own, once, and keeps it. */
  private floors = new Map<MapId, Floor>();
  private floor!: Floor;
  /** Arenas built so far. Each is built the first time it is needed, then kept. */
  private maps = new Map<MapId, MapScene>();
  private mapId: MapId | null = null;
  private mapScene!: MapScene;
  private fogNear = 90;
  private fogFar = 480;
  /** The twist of the round being shown: wide beams, fast walkers, or a blackout. */
  private twist: Twist = "none";
  private beamGroup = new THREE.Group();
  private beams: TimedBeam[] = [];
  private facingMarker: THREE.Mesh;
  private characters = new Map<string, Actor>();
  private titleActors = new Map<string, Actor>();
  private title: { time: number; cycle: number; fired: boolean } | null = null;
  private intro: {
    t: number;
    arrivedAt: number | null;
    firedAt: number | null;
    stepTimer: number;
    onReveal: () => void;
  } | null = null;

  /** Turn off to disable camera shake. Set from the settings screen. */
  shakeEnabled = true;

  private clock = new THREE.Clock();
  private lookAt = new THREE.Vector3(0, 1, 0);
  private view: CameraView = { kind: "title" };
  private shakeAmount = 0;
  private resizeObserver: ResizeObserver;

  // Performance. The resolution lowers itself when the device cannot keep up, and recovers when it can.
  private maxPixelRatio = 1;
  private pixelRatio = 1;
  private frameAverage = 1 / 60;
  private adaptTimer = 0;
  private qualityMode: "auto" | "low" | "high" = "auto";
  private timeScale = 1;
  private sceneElapsed = 0;
  private slowLeft = 0;
  private slowSeconds = 0;
  private lowPower = false;
  /** Which way the follow camera looks. It trails the player's real facing a little, so turning feels calm. */
  private cameraYaw = 0;
  private followActive = false;
  private followPose = { x: 0, z: 0, yaw: 0 };
  /** Reused every frame, so the render loop creates no garbage. */
  private scratch = {
    desired: new THREE.Vector3(),
    look: new THREE.Vector3(),
    center: new THREE.Vector3(),
    shake: new THREE.Vector3(),
  };

  constructor(private host: HTMLElement) {
    // Post-processing bypasses the canvas's own anti-aliasing, so the render target is multisampled instead.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    this.maxPixelRatio = Math.min(window.devicePixelRatio, this.touchDevice ? 1.5 : 1.75);
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    // The renderer counts a whole frame, not just its last pass, so the stats are meaningful.
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1600);
    this.effects = new Effects(this.scene);
    this.setMap(DEFAULT_MAP);

    this.scene.add(this.beamGroup);

    // A faint arrow on the floor showing which way the local player faces. There is no laser line.
    this.facingMarker = new THREE.Mesh(
      new THREE.ShapeGeometry(arrowShape()).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.facingMarker.scale.setScalar(1.4);
    this.facingMarker.visible = false;
    this.facingMarker.position.y = 0.05;
    this.scene.add(this.facingMarker);

    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: this.touchDevice ? 2 : 4,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Bloom softens the laser beams. The threshold is high, so bright snow does not glow. Phones skip it.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.4, 0.4, 1.35);
    this.bloom.enabled = !this.touchDevice;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /**
   * Moves the match to another arena: new scenery, light, floor and fence. Arenas are built the first time they
   * are needed and kept, so going back to one is instant. The floor is made whole again.
   */
  setMap(id: MapId): void {
    if (this.mapId === id) return;
    if (this.mapScene) this.scene.remove(this.mapScene.root);
    let next = this.maps.get(id);
    if (!next) {
      next = buildMap(id, { touch: this.touchDevice, layout: layoutFor(id) });
      this.maps.set(id, next);
    }
    this.mapId = id;
    this.mapScene = next;
    this.scene.add(next.root);
    this.scene.background = new THREE.Color(next.background);
    this.scene.fog = next.fog;
    this.fogNear = next.fog.near;
    this.fogFar = next.fog.far;
    this.renderer.toneMappingExposure = next.exposure;
    next.setLowPower(this.lowPower);
    next.sun.castShadow = !this.lowPower;

    // Each arena has its own floor, built once.
    let floor = this.floors.get(id);
    if (!floor) {
      const dust = id === "frost" ? "#e8f0f8" : id === "forest" ? "#b9b79a" : "#d9b48a";
      floor = new Floor(layoutFor(id), next, this.effects, dust, () => this.floorBroke());
      this.floors.set(id, floor);
    }
    if (this.floor) this.scene.remove(this.floor.group);
    this.floor = floor;
    this.floor.setState([], []);
    this.scene.add(floor.group);
    this.applyTwist();
  }

  /** One tile let go. A rumble now and then, not one for every tile. */
  private breakSoundCooldown = 0;
  private floorBroke(): void {
    if (performance.now() - this.breakSoundCooldown < 600) return;
    this.breakSoundCooldown = performance.now();
    this.onSound?.("collapse");
    this.shake(0.55);
  }

  /** Sets which tiles are gone and which are cracked, exactly as the server says. Nothing moves. */
  setFloor(gone: readonly number[], cracked: readonly number[], twist: Twist): void {
    this.floor.setState(gone, cracked);
    this.twist = twist;
    this.applyTwist();
  }

  /** The cracked tiles fall, one after another, into the drop. Returns how many fell. */
  collapse(tiles: readonly number[]): number {
    return this.floor.collapse(tiles);
  }

  /** A blackout round is dim, and the name tags go dark. */
  private applyTwist(): void {
    if (!this.mapScene) return;
    const dark = this.twist === "dark";
    this.renderer.toneMappingExposure = this.mapScene.exposure * (dark ? 0.5 : 1);
    this.mapScene.fog.near = dark ? 30 : this.fogNear;
    this.mapScene.fog.far = dark ? 140 : this.fogFar;
    for (const character of this.characters.values()) character.setLabelVisible(!dark);
  }

  /** These players were standing on tiles that just fell. They fall with them, into the drop. */
  plunge(ids: string[]): void {
    let any = false;
    for (const id of ids) {
      const character = this.characters.get(id);
      if (!character) continue;
      character.plunge(Math.random() * 0.5);
      any = true;
    }
    if (any) this.onSound?.("fall");
  }

  /** Makes the scene show exactly these characters. Missing ones are removed. */
  setCharacters(states: CharacterState[]): void {
    const keep = new Set(states.map((s) => s.id));
    for (const [id, character] of this.characters) {
      if (!keep.has(id)) {
        this.scene.remove(character.root);
        character.dispose();
        this.characters.delete(id);
      }
    }
    for (const state of states) {
      let character = this.characters.get(state.id);
      if (!character) {
        character = makeActor(state.id, state.name);
        character.setLabelVisible(this.twist !== "dark");
        this.characters.set(state.id, character);
        this.scene.add(character.root);
      }
      character.setPose(state.x, state.z, state.yaw);
      character.setAlive(state.alive);
    }
  }

  setPose(id: string, x: number, z: number, yaw: number): void {
    this.characters.get(id)?.setPose(x, z, yaw);
  }

  setAlive(id: string, alive: boolean): void {
    this.characters.get(id)?.setAlive(alive);
  }

  setMoving(id: string, moving: boolean): void {
    this.characters.get(id)?.setMoving(moving);
  }

  /** Shows a faint floor arrow in front of the local player, or hides it when `pose` is null. */
  setFacingMarker(pose: { x: number; z: number; yaw: number } | null): void {
    this.facingMarker.visible = pose !== null;
    if (!pose) return;
    const f = facing(pose.yaw);
    this.facingMarker.position.set(pose.x + f.x * 3.2, 0.05, pose.z + f.z * 3.2);
    this.facingMarker.rotation.y = pose.yaw;
  }

  /**
   * Draws the beams as soft glowing lasers: each grows out from its muzzle, holds for a moment,
   * then fades. A flash and sparks appear at each gun, and a red burst where a beam hits someone.
   */
  fire(beams: Beam[]): void {
    // A wide round fires beams about twice as thick, so they read as the danger they are.
    const thickness = this.twist === "wide" ? 2.4 : 1;
    this.clearBeams();
    const now = performance.now();
    let shots = 0;
    for (const beam of beams) {
      const from = new THREE.Vector3(beam.from.x, BEAM_HEIGHT, beam.from.z);
      const to = new THREE.Vector3(beam.to.x, BEAM_HEIGHT, beam.to.z);
      const length = from.distanceTo(to);
      const direction = to.clone().sub(from).normalize();

      const { group, materials } = makeLaser();
      group.position.copy(from);
      group.lookAt(to);
      group.scale.set(thickness, thickness, 0.0001);
      this.beamGroup.add(group);
      this.beams.push({ group, materials, baseOpacity: materials.map((m) => m.opacity), length, startedAt: now });

      this.effects.muzzleFlash(from, direction);
      this.actor(beam.shooter)?.kick();
      if (shots++ < 6) this.onSound?.("shot");

      if (beam.hit) {
        this.effects.bloodBurst(to, direction);
        this.onSound?.("hit");
      } else {
        // A beam that hits nothing still sparks where it ends.
        this.effects.sparkBurst(to, direction.clone().multiplyScalar(-0.4), 6);
      }
    }
    this.shake(0.55);
  }

  clearBeams(): void {
    for (const beam of this.beams) {
      beam.group.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
      for (const material of beam.materials) material.dispose();
    }
    this.beamGroup.clear();
    this.beams = [];
  }

  /** Moves the camera. In follow mode it hangs behind and above the local player. */
  setView(view: CameraView): void {
    this.view = view;
  }

  /** Shakes the camera. It settles by itself. */
  shake(amount: number): void {
    this.shakeAmount = Math.min(1.2, this.shakeAmount + amount);
  }

  /** The title screen: two stick men face each other, one fires, and the other falls. It repeats. */
  setTitleScene(on: boolean): void {
    if (on === (this.title !== null)) return;
    if (!on) {
      for (const actor of this.titleActors.values()) {
        this.scene.remove(actor.root);
        actor.dispose();
      }
      this.titleActors.clear();
      this.title = null;
      this.clearBeams();
      this.effects.clear();
      return;
    }

    this.setCharacters([]);
    const a = makeActor("title-a");
    const b = makeActor("title-b");
    a.setPose(-4.2, 0, Math.PI / 2);
    b.setPose(4.2, 0, -Math.PI / 2);
    this.titleActors.set("title-a", a);
    this.titleActors.set("title-b", b);
    this.scene.add(a.root, b.root);
    this.title = { time: 0, cycle: 0, fired: false };
    this.view = { kind: "title" };
  }

  /**
   * The opening scene. One robot walks in from each side, they stop and face each other, and both fire.
   * `onReveal` is called when the title should appear. Call this right after the title scene is shown.
   */
  playIntro(onReveal: () => void): void {
    const a = this.titleActors.get("title-a");
    const b = this.titleActors.get("title-b");
    if (!a || !b || !this.title) {
      onReveal();
      return;
    }
    this.clearBeams();
    a.setPose(-INTRO_START_X, 0, Math.PI / 2);
    b.setPose(INTRO_START_X, 0, -Math.PI / 2);
    a.setMoving(true);
    b.setMoving(true);
    this.intro = { t: 0, arrivedAt: null, firedAt: null, stepTimer: 0, onReveal };
  }

  /** Jumps to the end of the opening scene. */
  skipIntro(): void {
    const intro = this.intro;
    const a = this.titleActors.get("title-a");
    const b = this.titleActors.get("title-b");
    if (!intro || !a || !b) return;
    a.setPose(-INTRO_DUEL_X, 0, Math.PI / 2);
    b.setPose(INTRO_DUEL_X, 0, -Math.PI / 2);
    a.setMoving(false);
    b.setMoving(false);
    this.finishIntro();
  }

  get introPlaying(): boolean {
    return this.intro !== null;
  }

  private finishIntro(): void {
    const intro = this.intro;
    if (!intro) return;
    this.intro = null;
    // The duel carries on as the title backdrop, after the two have lain there for a moment.
    if (this.title) {
      this.title.time = TITLE_LOOP - 2.6;
      this.title.cycle = 1;
      this.title.fired = true;
    }
    intro.onReveal();
  }

  /** Runs the opening scene's timeline: walk in, stare down, fire, then hand over to the title. */
  private updateIntro(dt: number): void {
    const intro = this.intro;
    const a = this.titleActors.get("title-a");
    const b = this.titleActors.get("title-b");
    if (!intro || !a || !b) return;
    intro.t += dt;

    if (intro.arrivedAt === null) {
      const x = Math.max(INTRO_DUEL_X, INTRO_START_X - INTRO_WALK_SPEED * intro.t);
      a.setPose(-x, 0, Math.PI / 2);
      b.setPose(x, 0, -Math.PI / 2);
      intro.stepTimer += dt;
      if (intro.stepTimer >= 0.4) {
        intro.stepTimer = 0;
        this.onSound?.("step");
      }
      if (x <= INTRO_DUEL_X) {
        intro.arrivedAt = intro.t;
        a.setMoving(false);
        b.setMoving(false);
      }
      return;
    }

    if (intro.firedAt === null && intro.t >= intro.arrivedAt + INTRO_HOLD) {
      intro.firedAt = intro.t;
      const reach = INTRO_DUEL_X * 2 - PLAYER_RADIUS - BEAM_HALF_WIDTH;
      this.fire([
        { shooter: "title-a", from: { x: -INTRO_DUEL_X + MUZZLE_FORWARD, z: 0 }, to: { x: -INTRO_DUEL_X + reach, z: 0 }, hit: "title-b" },
        { shooter: "title-b", from: { x: INTRO_DUEL_X - MUZZLE_FORWARD, z: 0 }, to: { x: INTRO_DUEL_X - reach, z: 0 }, hit: "title-a" },
      ]);
      this.shake(0.9);
      this.slowMotion(1.1);
      window.setTimeout(() => {
        a.setAlive(false);
        b.setAlive(false);
      }, 140);
      return;
    }

    if (intro.firedAt !== null && intro.t >= intro.firedAt + INTRO_REVEAL_AFTER) this.finishIntro();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    for (const character of this.characters.values()) character.dispose();
    this.characters.clear();
    this.setTitleScene(false);
    this.clearBeams();
    for (const map of this.maps.values()) map.dispose();
    this.maps.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private actor(id: string): Actor | undefined {
    return this.characters.get(id) ?? this.titleActors.get(id);
  }

  private resize(): void {
    const width = this.host.clientWidth || window.innerWidth;
    const height = this.host.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.composer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.bloom.setSize(width * this.pixelRatio, height * this.pixelRatio);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Draws one frame. The page calls this once per animation frame, after it has updated its own state,
   * so the picture always shows the latest positions and camera.
   */
  render(): void {
    const elapsed = this.clock.getDelta();
    // The opening scene follows the clock, so a slow device sees it take as long as a fast one.
    this.sceneElapsed = Math.min(0.5, elapsed);
    const realDt = Math.min(0.1, elapsed);
    // Slow motion stretches the action but not the camera or the snow.
    if (this.slowLeft > 0) {
      this.slowLeft -= realDt;
      this.timeScale += (SLOW_MOTION_SCALE - this.timeScale) * Math.min(1, realDt * 14);
    } else {
      this.timeScale += (1 - this.timeScale) * Math.min(1, realDt * 5);
    }
    const dt = realDt * this.timeScale;
    const now = performance.now();
    this.renderer.info.reset();

    this.adaptQuality(realDt);
    this.updateTitle(dt);
    this.mapScene.update(realDt, now / 1000);
    this.floor.update(dt, now / 1000);
    this.updateBeams(now);
    for (const character of this.characters.values()) character.update(dt);
    for (const actor of this.titleActors.values()) actor.update(dt);
    this.effects.update(dt);

    this.updateCamera(realDt);
    // Shake is applied for this frame only, so it never builds up in the camera's real position.
    const shake = this.scratch.shake.set(0, 0, 0);
    if (this.shakeEnabled && this.shakeAmount > 0.01) {
      shake.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(this.shakeAmount * 0.35);
      this.camera.position.add(shake);
      this.shakeAmount *= Math.exp(-realDt * 6);
    }

    // Bloom only matters while lasers are on screen, and it is the most expensive effect, so it sleeps otherwise.
    this.bloom.enabled = !this.touchDevice && !this.lowPower && this.beams.length > 0;
    this.composer.render();
    this.camera.position.sub(shake);
  }

  /** Plays the next moments in slow motion, for the shot that decides a match. */
  slowMotion(seconds: number): void {
    this.slowLeft = seconds;
  }

  /**
   * "auto" adjusts to the device by itself. "low" draws at reduced resolution without shadows or glow, for
   * old phones. "high" keeps the full effects as long as the device can hold them.
   */
  setQuality(mode: "auto" | "low" | "high"): void {
    this.qualityMode = mode;
    this.slowSeconds = 0;
    if (mode === "low") {
      this.setLowPower(true);
      this.setPixelRatio(Math.min(this.maxPixelRatio, MIN_PIXEL_RATIO + 0.1));
    } else {
      this.setLowPower(false);
      this.setPixelRatio(this.maxPixelRatio);
    }
  }

  /** Frame rate, draw calls, and resolution, for the optional on-screen readout. */
  stats(): { fps: number; frameMs: number; drawCalls: number; triangles: number; pixelRatio: number; lowPower: boolean } {
    return {
      fps: 1 / this.frameAverage,
      frameMs: this.frameAverage * 1000,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      pixelRatio: this.pixelRatio,
      lowPower: this.lowPower,
    };
  }

  /**
   * Keeps the game smooth on any device. If frames are taking too long, the picture is drawn at a slightly
   * lower resolution until they are fast again. If it is still too slow at the lowest resolution,
   * shadows, bloom, and part of the snow are turned off too.
   */
  private adaptQuality(dt: number): void {
    if (document.hidden || this.qualityMode === "low") return;
    this.frameAverage += (dt - this.frameAverage) * 0.06;
    this.adaptTimer += dt;
    if (this.adaptTimer < 1) return;
    this.adaptTimer = 0;

    const slow = this.frameAverage > 1 / 42;
    const fast = this.frameAverage < 1 / 56;
    if (slow) {
      if (this.pixelRatio > MIN_PIXEL_RATIO + 0.01) {
        this.setPixelRatio(Math.max(MIN_PIXEL_RATIO, this.pixelRatio * 0.85));
        this.slowSeconds = 0;
      } else if (++this.slowSeconds >= 2 && this.qualityMode === "auto") {
        this.setLowPower(true);
      }
    } else if (fast) {
      this.slowSeconds = 0;
      if (this.pixelRatio < this.maxPixelRatio - 0.01) {
        this.setPixelRatio(Math.min(this.maxPixelRatio, this.pixelRatio * 1.06));
      } else if (this.lowPower) {
        this.setLowPower(false);
      }
    }
  }

  private setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio;
    this.resize();
  }

  private setLowPower(on: boolean): void {
    this.lowPower = on;
    this.mapScene.sun.castShadow = !on;
    this.mapScene.setLowPower(on);
  }

  private updateBeams(now: number): void {
    for (const beam of this.beams) {
      const age = now - beam.startedAt;
      const grow = Math.min(1, age / BEAM_GROW_MS);
      beam.group.scale.z = Math.max(0.0001, beam.length * (1 - Math.pow(1 - grow, 3)));
      const fade = Math.min(1, Math.max(0, (age - BEAM_HOLD_MS) / BEAM_FADE_MS));
      // A gentle flicker while the beam is up makes it feel like energy, not a solid bar.
      const flicker = 0.92 + 0.08 * Math.sin(age * 0.09);
      beam.materials.forEach((material, index) => {
        material.opacity = beam.baseOpacity[index] * (1 - fade) * flicker;
      });
      beam.group.visible = fade < 1;
    }
  }

  /** The title scene: wait, fire, fall, then start over with the shooter and target swapped. */
  private updateTitle(dt: number): void {
    const title = this.title;
    if (!title) return;
    if (this.intro) {
      this.updateIntro(this.sceneElapsed * this.timeScale);
      return;
    }
    title.time += dt;

    const shooter = this.titleActors.get(title.cycle % 2 === 0 ? "title-a" : "title-b");
    const target = this.titleActors.get(title.cycle % 2 === 0 ? "title-b" : "title-a");
    if (!shooter || !target) return;

    if (!title.fired && title.time >= TITLE_SHOT_AT) {
      title.fired = true;
      const from = shooter.root.position;
      const f = facing(shooter.root.rotation.y);
      const reach = Math.hypot(target.root.position.x - from.x, target.root.position.z - from.z) - PLAYER_RADIUS - BEAM_HALF_WIDTH;
      this.fire([
        {
          shooter: title.cycle % 2 === 0 ? "title-a" : "title-b",
          from: { x: from.x + f.x * MUZZLE_FORWARD, z: from.z + f.z * MUZZLE_FORWARD },
          to: { x: from.x + f.x * reach, z: from.z + f.z * reach },
          hit: title.cycle % 2 === 0 ? "title-b" : "title-a",
        },
      ]);
      // The hit lands a moment after the beam leaves the gun.
      window.setTimeout(() => target.setAlive(false), 140);
    }

    if (title.time >= TITLE_LOOP) {
      for (const actor of this.titleActors.values()) actor.reset();
      this.clearBeams();
      this.effects.clear();
      title.time = 0;
      title.cycle += 1;
      title.fired = false;
    }
  }

  private updateCamera(dt: number): void {
    const view = this.view;
    const { desired, look, center } = this.scratch;
    let rate: number;

    let follow: { x: number; z: number; yaw: number } | null = null;
    if (view.kind === "follow") {
      follow = view;
    } else if (view.kind === "spectate") {
      const target = this.characters.get(view.id);
      if (target?.isAlive) {
        follow = this.followPose;
        follow.x = target.root.position.x;
        follow.z = target.root.position.z;
        follow.yaw = target.root.rotation.y;
      }
    }

    if (follow) {
      // The camera swings after the player's facing instead of locking to it, so a fast turn does not whip the view.
      if (!this.followActive) {
        this.cameraYaw = follow.yaw;
        this.followActive = true;
      }
      const gap = Math.atan2(Math.sin(follow.yaw - this.cameraYaw), Math.cos(follow.yaw - this.cameraYaw));
      this.cameraYaw += gap * (1 - Math.exp(-dt * CAMERA_TURN_RATE));

      // Behind and above the player, looking down at them and the way the gun points.
      const f = facing(this.cameraYaw);
      const rx = -f.z;
      const rz = f.x;
      desired.set(follow.x - f.x * 9.2 + rx * 2.6, 12.8, follow.z - f.z * 9.2 + rz * 2.6);
      look.set(follow.x + f.x * 7, 1.6, follow.z + f.z * 7);
      // The follow camera tracks closely, which keeps turning from feeling floaty.
      rate = 16;
    } else if (view.kind === "title") {
      this.followActive = false;
      // A slow sweep around the two duelists. The menu sits on the left, so they sit right of center.
      if (this.intro) {
        // The opening shot: low and wide, easing in toward the two as they meet.
        const p = Math.min(1, this.intro.t / 5);
        desired.set(-4 + 8 * p, 3 + 1.3 * p, 22 - 8.5 * p);
        look.set(0, 2.7, 0);
        rate = 2.2;
      } else {
        const sweep = Math.PI / 2 + Math.sin(performance.now() * 0.00028) * 0.55;
        desired.set(Math.cos(sweep) * 14.5, 5.0, Math.sin(sweep) * 14.5);
        look.set(this.camera.aspect > 1.3 ? -4.2 : 0, 2.6, 0);
        rate = 3;
      }
    } else {
      this.followActive = false;
      // Frame the people who are still alive, and zoom in as they get fewer or closer together.
      center.set(0, 0, 0);
      let alive = 0;
      for (const character of this.characters.values()) {
        if (!character.isAlive) continue;
        center.add(character.root.position);
        alive += 1;
      }
      let spread = this.mapScene ? layoutFor(this.mapId as MapId).extent * 0.9 : 18;
      if (alive > 0) {
        center.divideScalar(alive);
        spread = 4;
        for (const character of this.characters.values()) {
          if (!character.isAlive) continue;
          const p = character.root.position;
          spread = Math.max(spread, Math.hypot(p.x - center.x, p.z - center.z));
        }
      }
      const squeeze = this.camera.aspect < 1.4 ? 1.3 : 1;
      const distance = Math.min(44, Math.max(20, (spread * 1.75 + 10) * squeeze));
      // A lower angle than straight down, so people show as figures and not as small dots.
      desired.set(center.x, distance * 0.66, center.z + distance * 0.75);
      look.set(center.x, 1.5, center.z);
      rate = 4;
    }

    const k = 1 - Math.exp(-dt * rate);
    this.camera.position.lerp(desired, k);
    this.lookAt.lerp(look, k);
    this.camera.lookAt(this.lookAt);
  }
}

/** One laser: a hot white core inside a wider, soft red glow. Both lie along +Z from the origin. */
function makeLaser(): { group: THREE.Group; materials: THREE.MeshBasicMaterial[] } {
  const group = new THREE.Group();
  const layers: Array<{ radius: number; color: THREE.Color; opacity: number; additive: boolean }> = [
    { radius: 0.045, color: new THREE.Color("#fff3ee").multiplyScalar(2.4), opacity: 1, additive: false },
    { radius: 0.11, color: new THREE.Color("#ff4a3a").multiplyScalar(2), opacity: 0.5, additive: true },
    { radius: 0.24, color: new THREE.Color("#ff2418").multiplyScalar(1.4), opacity: 0.16, additive: true },
  ];
  const materials: THREE.MeshBasicMaterial[] = [];
  for (const layer of layers) {
    const geometry = new THREE.CylinderGeometry(layer.radius, layer.radius, 1, 14, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
    const material = new THREE.MeshBasicMaterial({
      color: layer.color,
      transparent: true,
      opacity: layer.opacity,
      blending: layer.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    materials.push(material);
    group.add(new THREE.Mesh(geometry, material));
  }
  return { group, materials };
}

/** A flat arrow pointing along +Z (after the shape is laid on the floor). */
function arrowShape(): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.9);
  shape.lineTo(0.55, 0.1);
  shape.lineTo(0.22, 0.1);
  shape.lineTo(0.22, -0.7);
  shape.lineTo(-0.22, -0.7);
  shape.lineTo(-0.22, 0.1);
  shape.lineTo(-0.55, 0.1);
  shape.closePath();
  return shape;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** The robot when its model has loaded, and the stick man if it could not be. */
function makeActor(id: string, name?: string): Actor {
  return robotReady() ? new Robot(id, name) : new Stickman(id, name);
}
