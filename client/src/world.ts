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
  WORLD_RADIUS,
} from "../../shared/config.js";
import type { Beam } from "../../shared/geometry.js";
import { facing } from "../../shared/movement.js";
import { Effects } from "./effects.js";
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
  | { kind: "overview" }
  | { kind: "title" };

/** Sounds the world asks the page to play, so the world itself stays free of audio. */
export type WorldSound = "shot" | "hit" | "collapse" | "fall";

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

const BAR_COUNT = 80;
const CAGE_HEIGHT = 9;
const CAGE_CLOSE_SPEED = 3.2; // meters per second that the cage closes in
/** How quickly the camera catches up with the player's facing, per second. Lower is calmer. */
const CAMERA_TURN_RATE = 5;
const CAGE_CLOSE_DELAY = 0.7; // seconds the cage waits while the floor breaks away
const SLAB_THICKNESS = 0.9;
const MIN_PIXEL_RATIO = 0.7;
const SNOW_RADIUS = 95;
const SNOW_HEIGHT = 75;
const BEAM_GROW_MS = 140;
const BEAM_HOLD_MS = 700;
const BEAM_FADE_MS = 500;
/** Title scene: seconds from standing off to the shot, and to the end of the loop. */
const TITLE_SHOT_AT = 2.6;
const TITLE_LOOP = 9;

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
  private floorMaterials: THREE.MeshStandardMaterial[] = [];
  private cageBars: THREE.InstancedMesh;
  private cageRings: THREE.Mesh[] = [];
  private targetRadius = START_RING_RADIUS;
  private shownRadius = START_RING_RADIUS;
  private closeDelay = 0;

  private beamGroup = new THREE.Group();
  private beams: TimedBeam[] = [];
  private facingMarker: THREE.Mesh;
  private characters = new Map<string, Stickman>();
  private titleActors = new Map<string, Stickman>();
  private title: { time: number; cycle: number; fired: boolean } | null = null;

  private snow!: THREE.Points;
  private snowSpeed!: Float32Array;
  private snowPhase!: Float32Array;
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
  private slowSeconds = 0;
  private lowPower = false;
  private sun!: THREE.DirectionalLight;
  private fallingCount = 0;
  /** Which way the follow camera looks. It trails the player's real facing a little, so turning feels calm. */
  private cameraYaw = 0;
  private followActive = false;
  private danger: THREE.Group | null = null;
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
    this.scene.background = new THREE.Color("#b9cfe6");
    this.scene.fog = new THREE.Fog("#c4d6e8", 90, 480);

    this.buildWorld();
    this.buildSnow();
    this.scene.add(this.floorGroup);
    this.buildFloor();

    // The cage bars and rings are rebuilt for each radius, so the cage can close in smoothly.
    this.cageBars = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.11, 0.11, CAGE_HEIGHT, 10).translate(0, CAGE_HEIGHT / 2, 0),
      new THREE.MeshStandardMaterial({ color: "#c3ccd6", roughness: 0.45, metalness: 0.3 }),
      BAR_COUNT,
    );
    this.cageBars.castShadow = true;
    this.cageBars.frustumCulled = false;
    this.scene.add(this.cageBars);
    const steel = new THREE.MeshStandardMaterial({ color: "#aab5c1", roughness: 0.45, metalness: 0.3 });
    const topRail = new THREE.MeshStandardMaterial({
      color: "#bfe8ff",
      emissive: "#3aa8d8",
      emissiveIntensity: 0.85,
      roughness: 0.4,
      metalness: 0.5,
    });
    for (const [y, material] of [
      [0.2, steel],
      [CAGE_HEIGHT * 0.5, steel],
      [CAGE_HEIGHT, topRail],
    ] as const) {
      // Built once at the full size. Closing the cage scales it, so no geometry is rebuilt while playing.
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(START_RING_RADIUS, material === topRail ? 0.2 : 0.14, 10, 160).rotateX(Math.PI / 2),
        material,
      );
      ring.position.y = y;
      ring.castShadow = true;
      ring.frustumCulled = false;
      this.cageRings.push(ring);
      this.scene.add(ring);
    }

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
   * Sets the cage radius. When it gets smaller, the floor levels outside it break away and fall,
   * and the cage closes in. Pass `animate: false` to jump straight to the new state.
   */
  setRing(radius: number, animate = true): void {
    if (Math.abs(radius - this.targetRadius) < 0.01) return;

    if (radius > this.targetRadius) {
      // A new match: the floor is whole again.
      this.targetRadius = radius;
      this.shownRadius = radius;
      this.buildFloor();
      this.applyRadius(radius);
      return;
    }

    this.targetRadius = radius;
    const lost = this.tiles.filter((tile) => !tile.falling && this.levels[tile.level] > radius + 0.01);
    if (!animate) {
      for (const tile of lost) this.removeTile(tile);
      this.shownRadius = radius;
      this.applyRadius(radius);
      return;
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
  }

  /**
   * Marks the outer band of ice that may break after this round, so nobody can say they were not warned.
   * Pass null to clear it.
   */
  setDanger(zone: { inner: number; outer: number; level: "possible" | "certain" } | null): void {
    if (this.danger) {
      this.scene.remove(this.danger);
      this.danger.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.danger = null;
    }
    if (!zone) return;

    const color = zone.level === "certain" ? "#ff3b30" : "#ffb020";
    const group = new THREE.Group();
    const band = new THREE.Mesh(
      new THREE.RingGeometry(zone.inner, zone.outer, 96, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }),
    );
    const edge = new THREE.Mesh(
      new THREE.RingGeometry(zone.inner - 0.09, zone.inner + 0.09, 96, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
    );
    band.position.y = 0.04;
    edge.position.y = 0.05;
    group.add(band, edge);
    this.scene.add(group);
    this.danger = group;
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
        character = new Stickman(state.id, state.name);
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
    const a = new Stickman("title-a");
    const b = new Stickman("title-b");
    a.setPose(-4.2, 0, Math.PI / 2);
    b.setPose(4.2, 0, -Math.PI / 2);
    this.titleActors.set("title-a", a);
    this.titleActors.set("title-b", b);
    this.scene.add(a.root, b.root);
    this.title = { time: 0, cycle: 0, fired: false };
    this.view = { kind: "title" };
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    for (const character of this.characters.values()) character.dispose();
    this.characters.clear();
    this.setTitleScene(false);
    this.clearBeams();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private actor(id: string): Stickman | undefined {
    return this.characters.get(id) ?? this.titleActors.get(id);
  }

  /**
   * The snow world: a pale sky, a snowfield with hills, mountains and pines, and the arena
   * as a circle of ice cut into the snow, over a deep crevasse.
   */
  private buildWorld(): void {
    const outer = this.levels[0];

    // Sky: a big inside-out sphere that fades from deep blue overhead to pale at the horizon.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1200, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: new THREE.Color("#5f88bb") },
          mid: { value: new THREE.Color("#b7cde4") },
          bottom: { value: new THREE.Color("#dfe9f3") },
        },
        vertexShader: `varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vDir;
          void main() {
            float h = vDir.y;
            vec3 color = h < 0.0 ? bottom : mix(mid, top, pow(h, 0.5));
            gl_FragColor = vec4(color, 1.0);
          }`,
      }),
    );
    this.scene.add(sky);

    // The snowfield, with a hole in the middle for the arena.
    const snowTexture = snowSurfaceTexture();
    snowTexture.repeat.set(70, 70);
    const ground = new THREE.Mesh(
      new THREE.RingGeometry(outer, WORLD_RADIUS, 160, 1).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: snowTexture, color: "#f4f8fc", roughness: 1, metalness: 0 }),
    );
    ground.receiveShadow = true;
    this.scene.add(ground);

    // A soft lip of snow around the edge of the hole.
    const lip = new THREE.Mesh(
      new THREE.TorusGeometry(outer + 0.5, 1.1, 10, 128).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: "#f6f9fc", roughness: 1 }),
    );
    lip.scale.y = 0.55;
    lip.position.y = 0.1;
    lip.receiveShadow = true;
    this.scene.add(lip);

    // The crevasse: icy walls going down into the dark, with a column that holds the arena up.
    const iceWall = new THREE.Mesh(
      new THREE.CylinderGeometry(outer, outer, PIT_DEPTH, 96, 1, true),
      new THREE.MeshStandardMaterial({
        map: iceSurfaceTexture(),
        color: "#9ec3dd",
        roughness: 0.35,
        emissive: "#12384f",
        emissiveIntensity: 0.5,
        side: THREE.BackSide,
      }),
    );
    iceWall.position.y = -PIT_DEPTH / 2;
    this.scene.add(iceWall);

    const abyss = new THREE.Mesh(
      new THREE.CircleGeometry(outer + 1, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#04101d" }),
    );
    abyss.position.y = -PIT_DEPTH;
    this.scene.add(abyss);

    const column = new THREE.Mesh(
      new THREE.CylinderGeometry(4.5, 7, PIT_DEPTH - SLAB_THICKNESS, 32),
      new THREE.MeshStandardMaterial({ color: "#86abc6", roughness: 0.4, emissive: "#102c40", emissiveIntensity: 0.4 }),
    );
    column.position.y = -(PIT_DEPTH + SLAB_THICKNESS) / 2;
    this.scene.add(column);

    this.buildScenery();

    this.scene.add(new THREE.HemisphereLight("#d3e3f4", "#9fb2c6", 1.05));
    const sun = new THREE.DirectionalLight("#fff1dc", 2.4);
    this.sun = sun;
    sun.position.set(-45, 62, 32);
    sun.castShadow = true;
    const shadowSize = this.touchDevice ? 1024 : 2048;
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    const extent = 30;
    sun.shadow.camera.left = -extent;
    sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent;
    sun.shadow.camera.bottom = -extent;
    sun.shadow.camera.far = 170;
    sun.shadow.radius = 4;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.05;
    this.scene.add(sun);
  }

  /** Rolling snow drifts, distant mountains, and pine trees. Each kind is drawn in a single call. */
  private buildScenery(): void {
    const random = seededRandom(7);
    const dummy = new THREE.Object3D();

    // Drifts: low, wide mounds of snow on the ground around the arena.
    const drifts = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 24, 12),
      new THREE.MeshStandardMaterial({ color: "#f1f6fb", roughness: 1 }),
      90,
    );
    for (let i = 0; i < 90; i++) {
      const angle = random() * Math.PI * 2;
      const distance = 75 + random() * 260;
      const width = 18 + random() * 40;
      dummy.position.set(Math.cos(angle) * distance, -width * 0.18, Math.sin(angle) * distance);
      dummy.scale.set(width, width * (0.25 + random() * 0.2), width * (0.7 + random() * 0.5));
      dummy.rotation.y = random() * Math.PI;
      dummy.updateMatrix();
      drifts.setMatrixAt(i, dummy.matrix);
    }
    drifts.receiveShadow = true;
    this.scene.add(drifts);

    // Mountains: tall cones, bluish rock below and white snow on top, in a ring far away.
    const mountainCount = 26;
    const rock = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 7),
      new THREE.MeshStandardMaterial({ color: "#8fa5bd", roughness: 1, flatShading: true }),
      mountainCount,
    );
    const caps = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 7),
      new THREE.MeshStandardMaterial({ color: "#f5f9fd", roughness: 1, flatShading: true }),
      mountainCount,
    );
    for (let i = 0; i < mountainCount; i++) {
      const angle = (i / mountainCount) * Math.PI * 2 + random() * 0.15;
      const distance = 330 + random() * 70;
      const width = 90 + random() * 90;
      const height = 90 + random() * 120;
      dummy.position.set(Math.cos(angle) * distance, height / 2 - 6, Math.sin(angle) * distance);
      dummy.scale.set(width, height, width);
      dummy.rotation.y = random() * Math.PI;
      dummy.updateMatrix();
      rock.setMatrixAt(i, dummy.matrix);
      // The snow cap is the top third of the mountain, sitting on it.
      dummy.position.set(Math.cos(angle) * distance, height * 0.68 - 6, Math.sin(angle) * distance);
      dummy.scale.set(width * 0.36, height * 0.34, width * 0.36);
      dummy.updateMatrix();
      caps.setMatrixAt(i, dummy.matrix);
    }
    this.scene.add(rock, caps);

    // Pine trees: a brown trunk, three stacked layers of dark green, and snow on top.
    const treeCount = 170;
    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.45, 0.6, 1, 8),
      new THREE.MeshStandardMaterial({ color: "#4d3a2c", roughness: 1 }),
      treeCount,
    );
    const layers = [0, 1, 2].map(
      () =>
        new THREE.InstancedMesh(
          new THREE.ConeGeometry(1, 1, 9),
          new THREE.MeshStandardMaterial({ color: "#22463a", roughness: 0.95 }),
          treeCount,
        ),
    );
    const snowTops = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 9),
      new THREE.MeshStandardMaterial({ color: "#f6f9fc", roughness: 1 }),
      treeCount,
    );
    for (let i = 0; i < treeCount; i++) {
      const angle = random() * Math.PI * 2;
      const distance = 58 + Math.pow(random(), 0.7) * 210;
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      const size = 1.8 + random() * 2.4;

      dummy.rotation.set(0, 0, 0);
      dummy.position.set(x, size * 0.9, z);
      dummy.scale.set(size * 0.5, size * 1.8, size * 0.5);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);

      layers.forEach((layer, tier) => {
        const radius = size * (2.3 - tier * 0.55);
        const tall = size * (2.6 - tier * 0.3);
        dummy.position.set(x, size * (2.1 + tier * 1.5), z);
        dummy.scale.set(radius, tall, radius);
        dummy.updateMatrix();
        layer.setMatrixAt(i, dummy.matrix);
      });
      dummy.position.set(x, size * 6.1, z);
      dummy.scale.set(size * 0.9, size * 1.3, size * 0.9);
      dummy.updateMatrix();
      snowTops.setMatrixAt(i, dummy.matrix);
    }
    // The trees are far from the arena, so their shadows never reach it. Skipping them saves a lot of drawing.
    for (const mesh of [trunks, ...layers, snowTops]) {
      this.scene.add(mesh);
    }
  }

  /** Snowfall: flakes drift down from above, swaying in a light wind, and start over at the top. */
  private buildSnow(): void {
    const count = this.touchDevice ? 1400 : 3600;
    const positions = new Float32Array(count * 3);
    this.snowSpeed = new Float32Array(count);
    this.snowPhase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * SNOW_RADIUS;
      positions[i * 3] = Math.cos(angle) * distance;
      positions[i * 3 + 1] = Math.random() * SNOW_HEIGHT;
      positions[i * 3 + 2] = Math.sin(angle) * distance;
      this.snowSpeed[i] = 2.2 + Math.random() * 3.2;
      this.snowPhase[i] = Math.random() * Math.PI * 2;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.snow = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        map: flakeTexture(),
        size: 0.7,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        color: "#ffffff",
      }),
    );
    this.snow.frustumCulled = false;
    this.scene.add(this.snow);
  }

  private updateSnow(dt: number, time: number): void {
    const positions = this.snow.geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = positions.array as Float32Array;
    for (let i = 0; i < this.snowSpeed.length; i++) {
      const base = i * 3;
      array[base + 1] -= this.snowSpeed[i] * dt;
      // A gentle sway, plus a light wind blowing to one side.
      array[base] += (Math.sin(time * 0.7 + this.snowPhase[i]) * 0.9 + 1.2) * dt;
      array[base + 2] += Math.cos(time * 0.5 + this.snowPhase[i]) * 0.6 * dt;
      if (array[base + 1] < 0 || Math.hypot(array[base], array[base + 2]) > SNOW_RADIUS) {
        // Start again at the top, somewhere over the arena.
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.sqrt(Math.random()) * SNOW_RADIUS;
        array[base] = Math.cos(angle) * distance;
        array[base + 1] = SNOW_HEIGHT;
        array[base + 2] = Math.sin(angle) * distance;
      }
    }
    positions.needsUpdate = true;
  }

  /**
   * The arena floor, built as concentric levels, each made of separate slabs.
   * Every level has its own edge, so the rings read clearly. When the ring shrinks,
   * the slabs of the outer level fall away one by one.
   */
  private buildFloor(): void {
    for (const tile of [...this.tiles]) this.removeTile(tile);
    for (const material of this.floorMaterials) material.dispose();
    this.floorMaterials = [];
    this.tiles = [];

    const texture = iceSurfaceTexture();
    texture.repeat.set(0.12, 0.12); // extruded faces use meters as UVs, so this is one pattern per ~8 m
    const edge = new THREE.MeshStandardMaterial({ color: "#bdeaff", emissive: "#2fa3d6", emissiveIntensity: 0.55, roughness: 0.4 });
    this.floorMaterials.push(edge);

    this.levels.forEach((outer, level) => {
      const isCenter = level === this.levels.length - 1;
      const inner = isCenter ? 0 : this.levels[level + 1];
      // Alternate the shade a little so neighboring levels are easy to tell apart.
      const material = new THREE.MeshStandardMaterial({
        map: texture,
        color: level % 2 === 0 ? "#e4f1fa" : "#bdd6e8",
        roughness: 0.38,
        metalness: 0.05,
      });
      this.floorMaterials.push(material);

      const segments = isCenter ? 1 : Math.max(10, Math.round(outer * 1.5));
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2 + 0.004;
        const a1 = ((i + 1) / segments) * Math.PI * 2 - 0.004;
        const geometry = isCenter ? slabGeometry(0, outer, 0, Math.PI * 2) : slabGeometry(inner, outer, a0, a1);
        // Center the slab on itself, so it tumbles around its own middle when it falls and not around the arena.
        geometry.computeBoundingBox();
        const middle = geometry.boundingBox!.getCenter(new THREE.Vector3());
        geometry.translate(-middle.x, -middle.y, -middle.z);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(middle);
        // Flat slabs do not need to cast shadows on anything.
        mesh.receiveShadow = true;
        this.floorGroup.add(mesh);
        this.tiles.push(this.newTile(mesh, level));
      }

      // The glowing edge of this level. It falls with the level.
      const rim = new THREE.Mesh(new THREE.TorusGeometry(outer - 0.06, 0.07, 6, 160).rotateX(Math.PI / 2), edge);
      rim.position.y = 0.02;
      rim.userData.rim = true;
      this.floorGroup.add(rim);
      this.tiles.push(this.newTile(rim, level));
    });
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
      this.cageBars.setMatrixAt(i, matrix);
    }
    this.cageBars.instanceMatrix.needsUpdate = true;

    const scale = radius / START_RING_RADIUS;
    for (const ring of this.cageRings) ring.scale.set(scale, 1, scale);
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
    const dt = Math.min(0.1, this.clock.getDelta());
    const now = performance.now();
    this.renderer.info.reset();

    this.adaptQuality(dt);
    this.updateTitle(dt);
    this.updateSnow(dt, now / 1000);
    this.updateFloor(dt);
    this.updateBeams(now);
    for (const character of this.characters.values()) character.update(dt);
    for (const actor of this.titleActors.values()) actor.update(dt);
    this.effects.update(dt);

    if (this.danger) {
      const pulse = 0.6 + 0.4 * Math.sin(now * 0.006);
      this.danger.children.forEach((child, index) => {
        ((child as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (index === 0 ? 0.22 : 0.9) * pulse;
      });
    }

    this.updateCamera(dt);
    // Shake is applied for this frame only, so it never builds up in the camera's real position.
    const shake = this.scratch.shake.set(0, 0, 0);
    if (this.shakeEnabled && this.shakeAmount > 0.01) {
      shake.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(this.shakeAmount * 0.35);
      this.camera.position.add(shake);
      this.shakeAmount *= Math.exp(-dt * 6);
    }

    // Bloom only matters while lasers are on screen, and it is the most expensive effect, so it sleeps otherwise.
    this.bloom.enabled = !this.touchDevice && !this.lowPower && this.beams.length > 0;
    this.composer.render();
    this.camera.position.sub(shake);
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
    if (document.hidden) return;
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
      } else if (++this.slowSeconds >= 2) {
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
    this.sun.castShadow = !on;
    this.snow.geometry.setDrawRange(0, on ? Math.floor(this.snowSpeed.length * 0.4) : this.snowSpeed.length);
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

    if (view.kind === "follow") {
      // The camera swings after the player's facing instead of locking to it, so a fast turn does not whip the view.
      if (!this.followActive) {
        this.cameraYaw = view.yaw;
        this.followActive = true;
      }
      const gap = Math.atan2(Math.sin(view.yaw - this.cameraYaw), Math.cos(view.yaw - this.cameraYaw));
      this.cameraYaw += gap * (1 - Math.exp(-dt * CAMERA_TURN_RATE));

      // Behind and above the player, looking down at them and the way the gun points.
      const f = facing(this.cameraYaw);
      const rx = -f.z;
      const rz = f.x;
      desired.set(view.x - f.x * 7.4 + rx * 1.7, 11.5, view.z - f.z * 7.4 + rz * 1.7);
      look.set(view.x + f.x * 6, 1.9, view.z + f.z * 6);
      // The follow camera tracks closely, which keeps turning from feeling floaty.
      rate = 16;
    } else if (view.kind === "title") {
      this.followActive = false;
      // A slow sweep around the two duelists. The menu sits on the left, so they sit right of center.
      const sweep = Math.PI / 2 + Math.sin(performance.now() * 0.00028) * 0.55;
      desired.set(Math.cos(sweep) * 17, 5.2, Math.sin(sweep) * 17);
      look.set(this.camera.aspect > 1.3 ? -4.2 : 0, 2.6, 0);
      rate = 3;
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

/** Snow: nearly white with very fine blue-grey grain, so it reads as snow up close without looking like noise. */
function snowSurfaceTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f2f6fa";
  ctx.fillRect(0, 0, size, size);
  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 255 * 0.045;
    image.data[i] = clamp255(image.data[i] + noise);
    image.data[i + 1] = clamp255(image.data[i + 1] + noise);
    image.data[i + 2] = clamp255(image.data[i + 2] + noise * 0.8);
  }
  ctx.putImageData(image, 0, 0);
  for (let i = 0; i < 60; i++) {
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    ctx.save();
    ctx.translate(Math.random() * size, Math.random() * size);
    const radius = 20 + Math.random() * 70;
    ctx.scale(radius, radius);
    gradient.addColorStop(0, "rgba(150,175,205,0.07)");
    gradient.addColorStop(1, "rgba(150,175,205,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
  return finishTexture(canvas, 1, 1);
}

/** Clear blue ice: soft cloudy depth with a few fine cracks. No thin repeating lines, so nothing shimmers. */
function iceSurfaceTexture(): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#c3dcee";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 70; i++) {
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    ctx.save();
    ctx.translate(Math.random() * size, Math.random() * size);
    const radius = 50 + Math.random() * 190;
    ctx.scale(radius, radius);
    const light = Math.random() < 0.5;
    gradient.addColorStop(0, light ? "rgba(255,255,255,0.22)" : "rgba(60,110,160,0.14)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
  // A few fine cracks that wander across the surface.
  ctx.lineCap = "round";
  for (let i = 0; i < 9; i++) {
    let x = Math.random() * size;
    let y = Math.random() * size;
    let angle = Math.random() * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let step = 0; step < 14; step++) {
      angle += (Math.random() - 0.5) * 0.9;
      x += Math.cos(angle) * (20 + Math.random() * 40);
      y += Math.sin(angle) * (20 + Math.random() * 40);
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 255 * 0.035;
    image.data[i] = clamp255(image.data[i] + noise);
    image.data[i + 1] = clamp255(image.data[i + 1] + noise);
    image.data[i + 2] = clamp255(image.data[i + 2] + noise);
  }
  ctx.putImageData(image, 0, 0);
  return finishTexture(canvas, 1, 1);
}

/** A soft round snowflake. */
function flakeTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.45, "rgba(255,255,255,0.85)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A small repeatable random generator, so the scenery looks the same on every visit. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function finishTexture(canvas: HTMLCanvasElement, repeatX: number, repeatY: number): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function clamp255(value: number): number {
  return Math.min(255, Math.max(0, value));
}
