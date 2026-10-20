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
  PIT_RADIUS,
  PIT_WALL_HEIGHT,
  PLAYER_RADIUS,
  ringLevels,
  START_RING_RADIUS,
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
export type WorldSound = "shot" | "hit" | "collapse";

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
const CAGE_CLOSE_DELAY = 0.7; // seconds the cage waits while the floor breaks away
const SLAB_THICKNESS = 0.9;
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

  private clock = new THREE.Clock();
  private lookAt = new THREE.Vector3(0, 1, 0);
  private view: CameraView = { kind: "title" };
  private shakeAmount = 0;
  private resizeObserver: ResizeObserver;

  constructor(private host: HTMLElement) {
    // Post-processing bypasses the canvas's own anti-aliasing, so the render target is multisampled instead.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.88;
    this.host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
    this.scene.background = new THREE.Color("#0a0b0d");
    this.scene.fog = new THREE.Fog("#0a0b0d", 80, 190);

    this.buildPit();
    this.scene.add(this.floorGroup);
    this.buildFloor();

    // The cage bars and rings are rebuilt for each radius, so the cage can close in smoothly.
    this.cageBars = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.11, 0.11, CAGE_HEIGHT, 10).translate(0, CAGE_HEIGHT / 2, 0),
      new THREE.MeshStandardMaterial({ color: "#6b7078", roughness: 0.45, metalness: 0.85 }),
      BAR_COUNT,
    );
    this.cageBars.castShadow = true;
    this.cageBars.frustumCulled = false;
    this.scene.add(this.cageBars);
    const steel = new THREE.MeshStandardMaterial({ color: "#5a5f67", roughness: 0.45, metalness: 0.85 });
    const topRail = new THREE.MeshStandardMaterial({
      color: "#c9824f",
      emissive: "#a8501f",
      emissiveIntensity: 0.9,
      roughness: 0.5,
      metalness: 0.5,
    });
    for (const [y, material] of [
      [0.2, steel],
      [CAGE_HEIGHT * 0.5, steel],
      [CAGE_HEIGHT, topRail],
    ] as const) {
      const ring = new THREE.Mesh(new THREE.BufferGeometry(), material);
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
    // Bloom softens the laser beams. Phones skip it to stay smooth.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.45, 0.88);
    this.bloom.enabled = !this.touchDevice;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
    this.applyRadius(START_RING_RADIUS);

    this.renderer.setAnimationLoop(() => this.frame());
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
    this.renderer.setAnimationLoop(null);
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

  /** The pit: concrete walls, steel ribs and pipes, work lamps, and a deep drop below the floor. */
  private buildPit(): void {
    const outer = this.levels[0];
    const wallHeight = PIT_WALL_HEIGHT + PIT_DEPTH;
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(PIT_RADIUS, PIT_RADIUS, wallHeight, 96, 1, true),
      new THREE.MeshStandardMaterial({ map: concreteTexture("#74777b", 0.1, 10, 4), roughness: 0.95, side: THREE.BackSide }),
    );
    wall.position.y = PIT_WALL_HEIGHT - wallHeight / 2;
    wall.receiveShadow = true;
    this.scene.add(wall);

    // The ledge around the outside of the arena, and the shaft that drops away below it.
    const ledgeTexture = steelFloorTexture();
    ledgeTexture.repeat.set(PIT_RADIUS / 3, PIT_RADIUS / 3);
    const ledge = new THREE.Mesh(
      new THREE.RingGeometry(outer, PIT_RADIUS, 128).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: ledgeTexture, color: "#8a8c90", roughness: 0.7, metalness: 0.3 }),
    );
    ledge.receiveShadow = true;
    this.scene.add(ledge);

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(outer, outer, PIT_DEPTH, 96, 1, true),
      new THREE.MeshStandardMaterial({ map: concreteTexture("#4b4d51", 0.1, 10, 4), roughness: 0.95, side: THREE.BackSide }),
    );
    shaft.position.y = -PIT_DEPTH / 2;
    this.scene.add(shaft);

    const abyss = new THREE.Mesh(
      new THREE.CircleGeometry(outer + 1, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#150b08" }),
    );
    abyss.position.y = -PIT_DEPTH;
    this.scene.add(abyss);

    // A central column that holds the arena up. The outer levels fall past it.
    const steel = new THREE.MeshStandardMaterial({ color: "#454a51", roughness: 0.5, metalness: 0.75 });
    const column = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 7, PIT_DEPTH - SLAB_THICKNESS, 32), steel);
    column.position.y = -(PIT_DEPTH + SLAB_THICKNESS) / 2;
    this.scene.add(column);

    // Vertical steel ribs and horizontal pipes around the wall.
    for (let i = 0; i < 28; i++) {
      const angle = (i / 28) * Math.PI * 2;
      const rib = new THREE.Mesh(new THREE.BoxGeometry(2, PIT_WALL_HEIGHT, 1.3), steel);
      rib.position.set(Math.cos(angle) * (PIT_RADIUS - 0.7), PIT_WALL_HEIGHT / 2, Math.sin(angle) * (PIT_RADIUS - 0.7));
      rib.rotation.y = -angle + Math.PI / 2;
      rib.castShadow = true;
      rib.receiveShadow = true;
      this.scene.add(rib);
    }
    for (const y of [5, 13, 21]) {
      const pipe = new THREE.Mesh(new THREE.TorusGeometry(PIT_RADIUS - 1.5, 0.4, 14, 160).rotateX(Math.PI / 2), steel);
      pipe.position.y = y;
      this.scene.add(pipe);
    }

    // Work lamps on the wall. A few real lights keep the scene cheap enough for phones.
    const lampMaterial = new THREE.MeshStandardMaterial({ color: "#fff1d6", emissive: "#ffd9a0", emissiveIntensity: 1.6 });
    for (let i = 0; i < 14; i++) {
      const angle = (i / 14) * Math.PI * 2 + 0.13;
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 1.4), lampMaterial);
      lamp.position.set(Math.cos(angle) * (PIT_RADIUS - 2.4), 14, Math.sin(angle) * (PIT_RADIUS - 2.4));
      this.scene.add(lamp);
    }
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + 0.8;
      const light = new THREE.PointLight("#ffe2b8", 520, 80, 1.6);
      light.position.set(Math.cos(angle) * 24, 16, Math.sin(angle) * 24);
      this.scene.add(light);
    }

    this.scene.add(new THREE.HemisphereLight("#b6c3d6", "#25221f", 0.55));
    const key = new THREE.DirectionalLight("#fff0d8", 2.0);
    key.position.set(-10, 42, 20);
    key.castShadow = true;
    const shadowSize = this.touchDevice ? 1024 : 2048;
    key.shadow.mapSize.set(shadowSize, shadowSize);
    const extent = 28;
    key.shadow.camera.left = -extent;
    key.shadow.camera.right = extent;
    key.shadow.camera.top = extent;
    key.shadow.camera.bottom = -extent;
    key.shadow.camera.far = 110;
    key.shadow.radius = 3;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.04;
    this.scene.add(key);
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

    const texture = steelFloorTexture();
    texture.repeat.set(0.14, 0.14); // extruded faces use meters as UVs, so this is one plate per ~7 m
    const edge = new THREE.MeshStandardMaterial({ color: "#ff9a5a", emissive: "#d1561a", emissiveIntensity: 0.6, roughness: 0.5 });
    this.floorMaterials.push(edge);

    this.levels.forEach((outer, level) => {
      const isCenter = level === this.levels.length - 1;
      const inner = isCenter ? 0 : this.levels[level + 1];
      // Alternate the shade a little so neighboring levels are easy to tell apart.
      const material = new THREE.MeshStandardMaterial({
        map: texture,
        color: level % 2 === 0 ? "#d2d4d9" : "#a9acb3",
        roughness: 0.62,
        metalness: 0.35,
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
        mesh.receiveShadow = true;
        mesh.castShadow = true;
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
    this.floorGroup.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    this.tiles = this.tiles.filter((candidate) => candidate !== tile);
  }

  /** Rebuilds the cage for a radius. */
  private applyRadius(radius: number): void {
    this.shownRadius = radius;

    const matrix = new THREE.Matrix4();
    for (let i = 0; i < BAR_COUNT; i++) {
      const angle = (i / BAR_COUNT) * Math.PI * 2;
      matrix.makeTranslation(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      this.cageBars.setMatrixAt(i, matrix);
    }
    this.cageBars.instanceMatrix.needsUpdate = true;

    this.cageRings.forEach((ring, index) => {
      ring.geometry.dispose();
      ring.geometry = new THREE.TorusGeometry(radius, index === 2 ? 0.16 : 0.12, 10, 160).rotateX(Math.PI / 2);
    });
  }

  private resize(): void {
    const width = this.host.clientWidth || window.innerWidth;
    const height = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.bloom.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    const dt = Math.min(0.1, this.clock.getDelta());
    const now = performance.now();

    this.updateTitle(dt);
    this.updateFloor(dt);
    this.updateBeams(now);
    for (const character of this.characters.values()) character.update(dt);
    for (const actor of this.titleActors.values()) actor.update(dt);
    this.effects.update(dt);

    this.updateCamera(dt);
    // Shake is applied for this frame only, so it never builds up in the camera's real position.
    const shakeOffset = new THREE.Vector3();
    if (this.shakeAmount > 0.01) {
      shakeOffset.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(this.shakeAmount * 0.35);
      this.camera.position.add(shakeOffset);
      this.shakeAmount *= Math.exp(-dt * 6);
    }
    this.composer.render();
    this.camera.position.sub(shakeOffset);
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

    for (const tile of [...this.tiles]) {
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
    let desired: THREE.Vector3;
    let look: THREE.Vector3;
    let rate: number;

    if (view.kind === "follow") {
      // Behind and above the player, looking down at them and the way the gun points.
      const f = facing(view.yaw);
      const right = { x: -f.z, z: f.x };
      desired = new THREE.Vector3(view.x - f.x * 7.4 + right.x * 1.7, 11.5, view.z - f.z * 7.4 + right.z * 1.7);
      look = new THREE.Vector3(view.x + f.x * 6, 1.9, view.z + f.z * 6);
      // The follow camera tracks closely, which keeps turning from feeling floaty.
      rate = 16;
    } else if (view.kind === "title") {
      // A slow sweep around the two duelists. The menu sits on the left, so they sit right of center.
      const sweep = Math.PI / 2 + Math.sin(performance.now() * 0.00028) * 0.55;
      desired = new THREE.Vector3(Math.cos(sweep) * 17, 5.2, Math.sin(sweep) * 17);
      const shift = this.camera.aspect > 1.3 ? -4.2 : 0;
      look = new THREE.Vector3(shift, 2.6, 0);
      rate = 3;
    } else {
      // Frame the people who are still alive, and zoom in as they get fewer or closer together.
      const alive = [...this.characters.values()].filter((c) => c.isAlive).map((c) => c.root.position);
      const center = new THREE.Vector3();
      let spread = this.shownRadius * 0.9;
      if (alive.length > 0) {
        for (const position of alive) center.add(position);
        center.divideScalar(alive.length);
        spread = Math.max(...alive.map((position) => Math.hypot(position.x - center.x, position.z - center.z)), 4);
      }
      const squeeze = this.camera.aspect < 1.4 ? 1.3 : 1;
      const distance = Math.min(44, Math.max(20, (spread * 1.75 + 10) * squeeze));
      // A lower angle than straight down, so people show as figures and not as small dots.
      desired = new THREE.Vector3(center.x, distance * 0.66, center.z + distance * 0.75);
      look = new THREE.Vector3(center.x, 1.5, center.z);
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
    { radius: 0.09, color: new THREE.Color("#fff3ee").multiplyScalar(2.2), opacity: 1, additive: false },
    { radius: 0.22, color: new THREE.Color("#ff4a3a").multiplyScalar(2), opacity: 0.55, additive: true },
    { radius: 0.5, color: new THREE.Color("#ff2418").multiplyScalar(1.4), opacity: 0.22, additive: true },
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

/** Plain concrete: even grey with fine grain and soft stains. Detailed enough not to look pixelated up close. */
function concreteTexture(base: string, grain: number, repeatX: number, repeatY: number): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    ctx.save();
    ctx.translate(Math.random() * size, Math.random() * size);
    const radius = 40 + Math.random() * 160;
    ctx.scale(radius, radius);
    gradient.addColorStop(0, `rgba(0,0,0,${0.03 + Math.random() * 0.05})`);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 255 * grain;
    image.data[i] = clamp255(image.data[i] + noise);
    image.data[i + 1] = clamp255(image.data[i + 1] + noise);
    image.data[i + 2] = clamp255(image.data[i + 2] + noise);
  }
  ctx.putImageData(image, 0, 0);
  return finishTexture(canvas, repeatX, repeatY);
}

/** A dark steel floor: large plates with seams and rivets. No thin repeating lines, so nothing shimmers. */
function steelFloorTexture(): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#3a3d43";
  ctx.fillRect(0, 0, size, size);
  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 255 * 0.07;
    image.data[i] = clamp255(image.data[i] + noise);
    image.data[i + 1] = clamp255(image.data[i + 1] + noise);
    image.data[i + 2] = clamp255(image.data[i + 2] + noise);
  }
  ctx.putImageData(image, 0, 0);
  ctx.strokeStyle = "rgba(10,10,12,0.8)";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, size - 6, size - 6);
  ctx.strokeStyle = "rgba(10,10,12,0.5)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(150,155,165,0.35)";
  for (const [x, y] of [
    [28, 28],
    [size - 28, 28],
    [28, size - 28],
    [size - 28, size - 28],
    [size / 2 + 28, 28],
    [28, size / 2 + 28],
  ]) {
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
  }
  return finishTexture(canvas, 1, 1);
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
