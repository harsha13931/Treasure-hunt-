import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import {
  BEAM_HALF_WIDTH,
  BEAM_HEIGHT,
  MUZZLE_FORWARD,
  PIT_DEPTH,
  PLAYER_RADIUS,
  ringLevels,
  START_RING_RADIUS,
} from "../../shared/config.js";
import { DEFAULT_MAP, type MapId } from "../../shared/maps.js";
import type { Beam } from "../../shared/geometry.js";
import { facing } from "../../shared/movement.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Effects } from "./effects.js";
import { BAR_COUNT, SLAB_THICKNESS } from "./maps/common.js";
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

interface Tile {
  mesh: THREE.Mesh;
  /** Index of the floor level this piece belongs to. 0 is the outermost ring. */
  level: number;
  falling: boolean;
  delay: number;
  /** Where the piece rests while the floor is whole. */
  home: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
}

const CAGE_CLOSE_SPEED = 3.2; // meters per second that the cage closes in
/** How quickly the camera catches up with the player's facing, per second. Lower is calmer. */
const CAMERA_TURN_RATE = 5;
const CAGE_CLOSE_DELAY = 0.7; // seconds the cage waits while the floor breaks away
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
 * The pit, the multi-level floor and the cage that closes in, the stick men, the lasers,
 * and the effects. It draws what the server reports. It never decides hits or deaths.
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

  private levels = ringLevels();
  private floorGroup = new THREE.Group();
  private tiles: Tile[] = [];
  /** Each floor level that is still whole, drawn as a single mesh. */
  private levelMeshes = new Map<number, THREE.Mesh>();
  /** The arenas built so far. Each is built the first time it is needed, then kept. */
  private maps = new Map<MapId, MapScene>();
  private mapId: MapId | null = null;
  private mapScene!: MapScene;
  private targetRadius = START_RING_RADIUS;
  private shownRadius = START_RING_RADIUS;
  private closeDelay = 0;

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
  private fallingCount = 0;
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
    this.scene.add(this.floorGroup);
    this.setMap(DEFAULT_MAP);

    this.scene.add(this.beamGroup);
    this.effects = new Effects(this.scene);

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
    this.applyRadius(START_RING_RADIUS);
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
      next = buildMap(id, { touch: this.touchDevice, levels: this.levels });
      this.maps.set(id, next);
    }
    this.mapId = id;
    this.mapScene = next;
    this.scene.add(next.root);
    this.scene.background = new THREE.Color(next.background);
    this.scene.fog = next.fog;
    this.renderer.toneMappingExposure = next.exposure;
    next.setLowPower(this.lowPower);
    next.sun.castShadow = !this.lowPower;

    this.targetRadius = START_RING_RADIUS;
    this.shownRadius = START_RING_RADIUS;
    this.buildFloor();
    this.applyRadius(START_RING_RADIUS);
  }

  /**
   * Sets the cage radius. When it gets smaller, the floor levels outside it break away and fall,
   * and the cage closes in. Pass `animate: false` to jump straight to the new state.
   * Returns how many pieces of floor broke away, which is zero when nothing changed.
   */
  setRing(radius: number, animate = true): number {
    if (Math.abs(radius - this.targetRadius) < 0.01) return 0;

    if (radius > this.targetRadius) {
      // A new match: the floor is whole again.
      this.targetRadius = radius;
      this.shownRadius = radius;
      this.buildFloor();
      this.applyRadius(radius);
      return 0;
    }

    this.targetRadius = radius;
    // A level that is about to break splits into slabs first, so the slabs can fall one by one.
    for (const level of [...this.levelMeshes.keys()]) {
      if (this.levels[level] <= radius + 0.01) continue;
      if (animate) this.explodeLevel(level);
      else {
        this.discardLevelMesh(this.levelMeshes.get(level) as THREE.Mesh);
        this.levelMeshes.delete(level);
      }
    }
    const lost = this.tiles.filter((tile) => !tile.falling && this.levels[tile.level] > radius + 0.01);
    if (!animate) {
      for (const tile of lost) this.removeTile(tile);
      this.shownRadius = radius;
      this.applyRadius(radius);
      return 0;
    }

    this.fallingCount += lost.length;
    for (const tile of lost) {
      tile.falling = true;
      tile.delay = Math.random() * 0.8;
      const outward = new THREE.Vector3(tile.home.x, 0, tile.home.z);
      if (outward.lengthSq() < 0.01) outward.set(rand(-1, 1), 0, rand(-1, 1));
      outward.normalize();
      tile.velocity.copy(outward).multiplyScalar(1 + Math.random() * 2.5);
      tile.spin.set(rand(-1.8, 1.8), rand(-0.8, 0.8), rand(-1.8, 1.8));
      if (tile.mesh.userData.rim) {
        // The glowing edge is one big ring, so it drops straight down instead of flipping across the arena.
        tile.velocity.set(0, 0, 0);
        tile.spin.set(0, 0, 0);
      }
    }
    if (lost.length > 0) {
      this.closeDelay = CAGE_CLOSE_DELAY;
      this.shake(0.9);
      this.onSound?.("collapse");
    }
    return lost.length;
  }

  /** These players were standing on ice that just broke. They fall with it, into the crevasse. */
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
      group.scale.z = 0.0001;
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

  /**
   * The arena floor, built as concentric levels, each made of separate slabs.
   * Every level has its own edge, so the rings read clearly. When the ring shrinks,
   * the slabs of the outer level fall away one by one.
   */
  private buildFloor(): void {
    for (const tile of [...this.tiles]) this.removeTile(tile);
    for (const mesh of this.levelMeshes.values()) this.discardLevelMesh(mesh);
    this.levelMeshes.clear();
    this.tiles = [];
    const { floor } = this.mapScene;

    this.levels.forEach((outer, level) => {
      // While a level is whole it is drawn as one piece, which keeps the number of draw calls low.
      // It only splits into separate slabs at the moment it breaks and has to fall apart.
      const slabs = this.levelSlabs(level);
      const merged = mergeGeometries(slabs.map((slab) => slab.geometry), false);
      for (const slab of slabs) slab.geometry.dispose();
      const whole = new THREE.Mesh(merged, floor.levelMaterial(level));
      whole.receiveShadow = true;
      this.floorGroup.add(whole);
      this.levelMeshes.set(level, whole);

      // The glowing edge of this level. It falls with the level.
      const rim = new THREE.Mesh(new THREE.TorusGeometry(outer - 0.06, 0.07, 6, 160).rotateX(Math.PI / 2), floor.edge);
      rim.position.y = 0.02;
      rim.userData.rim = true;
      this.floorGroup.add(rim);
      this.tiles.push(this.newTile(rim, level));
    });
  }

  /** The slabs that make up one floor level, each shaped like a slice of the ring and sitting in place. */
  private levelSlabs(level: number): Array<{ geometry: THREE.BufferGeometry }> {
    const outer = this.levels[level];
    const isCenter = level === this.levels.length - 1;
    const inner = isCenter ? 0 : this.levels[level + 1];
    const segments = isCenter ? 1 : Math.max(10, Math.round(outer * 1.5));
    const slabs: Array<{ geometry: THREE.BufferGeometry }> = [];
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2 + 0.004;
      const a1 = ((i + 1) / segments) * Math.PI * 2 - 0.004;
      slabs.push({ geometry: isCenter ? slabGeometry(0, outer, 0, Math.PI * 2) : slabGeometry(inner, outer, a0, a1) });
    }
    return slabs;
  }

  /** Splits a whole level into its separate slabs, so each can fall by itself. */
  private explodeLevel(level: number): void {
    const whole = this.levelMeshes.get(level);
    if (!whole) return;
    const material = whole.material as THREE.Material;
    this.discardLevelMesh(whole);
    this.levelMeshes.delete(level);
    for (const { geometry } of this.levelSlabs(level)) {
      // Center the slab on itself, so it tumbles around its own middle when it falls and not around the arena.
      geometry.computeBoundingBox();
      const middle = geometry.boundingBox!.getCenter(new THREE.Vector3());
      geometry.translate(-middle.x, -middle.y, -middle.z);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(middle);
      mesh.receiveShadow = true;
      this.floorGroup.add(mesh);
      this.tiles.push(this.newTile(mesh, level));
    }
  }

  private discardLevelMesh(mesh: THREE.Mesh): void {
    this.floorGroup.remove(mesh);
    mesh.geometry.dispose();
  }

  private newTile(mesh: THREE.Mesh, level: number): Tile {
    return {
      mesh,
      level,
      falling: false,
      delay: 0,
      home: mesh.position.clone(),
      velocity: new THREE.Vector3(),
      spin: new THREE.Vector3(),
    };
  }

  private removeTile(tile: Tile): void {
    if (tile.falling) this.fallingCount -= 1;
    this.floorGroup.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    this.tiles = this.tiles.filter((candidate) => candidate !== tile);
  }

  /** Moves the cage bars and sizes the rails for a radius. Cheap enough to run every frame. */
  private applyRadius(radius: number): void {
    this.shownRadius = radius;

    const matrix = new THREE.Matrix4();
    for (let i = 0; i < BAR_COUNT; i++) {
      const angle = (i / BAR_COUNT) * Math.PI * 2;
      matrix.makeTranslation(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      this.mapScene.cage.bars.setMatrixAt(i, matrix);
    }
    this.mapScene.cage.bars.instanceMatrix.needsUpdate = true;

    const scale = radius / START_RING_RADIUS;
    for (const ring of this.mapScene.cage.rings) ring.scale.set(scale, 1, scale);
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
    this.updateFloor(dt);
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

  /** The cage closes in after the floor breaks away, and the broken slabs fall into the pit. */
  private updateFloor(dt: number): void {
    if (this.shownRadius !== this.targetRadius) {
      if (this.closeDelay > 0) {
        this.closeDelay -= dt;
      } else {
        const step = CAGE_CLOSE_SPEED * dt;
        const next =
          Math.abs(this.targetRadius - this.shownRadius) <= step
            ? this.targetRadius
            : this.shownRadius + Math.sign(this.targetRadius - this.shownRadius) * step;
        this.applyRadius(next);
      }
    }

    if (this.fallingCount === 0) return;
    for (const tile of this.tiles.slice()) {
      if (!tile.falling) continue;
      if (tile.delay > 0) {
        // The slab shudders before it lets go.
        tile.delay -= dt;
        tile.mesh.position.y = tile.home.y + Math.sin(performance.now() * 0.06 + tile.level) * 0.05;
        continue;
      }
      tile.velocity.y -= 30 * dt;
      tile.mesh.position.addScaledVector(tile.velocity, dt);
      tile.mesh.rotation.x += tile.spin.x * dt;
      tile.mesh.rotation.y += tile.spin.y * dt;
      tile.mesh.rotation.z += tile.spin.z * dt;
      if (tile.mesh.position.y < -PIT_DEPTH) this.removeTile(tile);
    }
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
      let spread = this.shownRadius * 0.9;
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

/** A flat slab shaped like a slice of a ring, with its top at floor level. */
function slabGeometry(inner: number, outer: number, start: number, end: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  if (inner <= 0) {
    shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
  } else {
    shape.absarc(0, 0, outer, start, end, false);
    shape.absarc(0, 0, inner, end, start, true);
    shape.closePath();
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: SLAB_THICKNESS, bevelEnabled: false, curveSegments: 6 });
  // The shape is built upright. Lay it flat, then sink it so the top surface sits at y = 0.
  // Laying it flat mirrors the angle: a point at angle a lands at (cos a, -sin a) on the floor.
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -SLAB_THICKNESS, 0);
  geometry.computeBoundingSphere();
  return geometry;
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
