import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import {
  BEAM_HEIGHT,
  BEAM_RANGE,
  MUZZLE_FORWARD,
  PIT_RADIUS,
  PIT_WALL_HEIGHT,
  START_RING_RADIUS,
} from "../../shared/config.js";
import type { Beam } from "../../shared/geometry.js";
import { facing } from "../../shared/movement.js";
import { Character, soldierTemplate } from "./soldier.js";

export interface CharacterState {
  id: string;
  x: number;
  z: number;
  yaw: number;
  alive: boolean;
}

export type CameraView = { kind: "follow"; x: number; z: number; yaw: number } | { kind: "overview" };

interface GrowingBeam {
  mesh: THREE.Mesh;
  length: number;
  startedAt: number;
}

const BAR_COUNT = 64;
const CAGE_HEIGHT = 4.6;
const CAGE_CLOSE_SPEED = 2.2; // meters per second that the cage closes in
const BEAM_GROW_MS = 140;

/**
 * The pit, the steel cage that shrinks, the characters, and the laser beams.
 * It draws what the server reports. It never decides hits or deaths.
 */
export class World {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private touchDevice = window.matchMedia("(pointer: coarse)").matches;

  private cageBars: THREE.InstancedMesh;
  private cageRings: THREE.Mesh[] = [];
  private dangerZone: THREE.Mesh;
  private targetRadius = START_RING_RADIUS;
  private shownRadius = START_RING_RADIUS;

  private beamGroup = new THREE.Group();
  private growing: GrowingBeam[] = [];
  private sight: THREE.Mesh;
  private characters = new Map<string, Character>();
  private clock = new THREE.Clock();
  private lookAt = new THREE.Vector3(0, 1, 0);
  private view: CameraView = { kind: "overview" };
  private resizeObserver: ResizeObserver;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: !this.touchDevice });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.touchDevice ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.05, 250);
    this.scene.background = new THREE.Color("#07080a");
    this.scene.fog = new THREE.Fog("#07080a", 45, 120);

    this.buildPit();

    // The cage bars and rings are rebuilt for each radius, so the cage can close in smoothly.
    this.cageBars = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.07, 0.07, CAGE_HEIGHT, 8).translate(0, CAGE_HEIGHT / 2, 0),
      new THREE.MeshStandardMaterial({ color: "#6b7078", roughness: 0.4, metalness: 0.9 }),
      BAR_COUNT,
    );
    this.cageBars.castShadow = true;
    this.scene.add(this.cageBars);
    const steel = new THREE.MeshStandardMaterial({ color: "#555a62", roughness: 0.4, metalness: 0.9 });
    const hot = new THREE.MeshStandardMaterial({ color: "#ff7a3d", emissive: "#ff5a1f", emissiveIntensity: 2.4 });
    for (const [y, material] of [
      [0.12, steel],
      [CAGE_HEIGHT * 0.5, steel],
      [CAGE_HEIGHT, hot],
    ] as const) {
      const ring = new THREE.Mesh(new THREE.BufferGeometry(), material);
      ring.position.y = y;
      this.cageRings.push(ring);
      this.scene.add(ring);
    }

    this.dangerZone = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: "#ff2e2e", transparent: true, opacity: 0.16, depthWrite: false }),
    );
    this.dangerZone.position.y = 0.02;
    this.scene.add(this.dangerZone);

    this.scene.add(this.beamGroup);

    // A faint sight line from the muzzle, so the player can see where they are aiming.
    this.sight = makeBeam(new THREE.Color("#ff3b3b"), 0.03, 0.4);
    this.sight.visible = false;
    this.scene.add(this.sight);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Bloom only lifts the bright laser and the cage glow. Phones skip it to stay smooth.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.4, 0.85);
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

  /** Sets the cage radius. It closes in smoothly instead of jumping. */
  setRing(radius: number): void {
    this.targetRadius = radius;
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
        character = new Character(soldierTemplate());
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

  /** Shows the sight line from a local player's gun, or hides it when `pose` is null. */
  setSight(pose: { x: number; z: number; yaw: number } | null): void {
    this.sight.visible = pose !== null;
    if (!pose) return;
    const f = facing(pose.yaw);
    const from = { x: pose.x + f.x * MUZZLE_FORWARD, z: pose.z + f.z * MUZZLE_FORWARD };
    this.sight.position.set(from.x, BEAM_HEIGHT, from.z);
    this.sight.lookAt(from.x + f.x, BEAM_HEIGHT, from.z + f.z);
    this.sight.scale.z = BEAM_RANGE;
  }

  /** Draws the beams. Each one grows out from its muzzle, then stays until the next hide phase. */
  fire(beams: Beam[]): void {
    this.clearBeams();
    const now = performance.now();
    for (const beam of beams) {
      const length = Math.hypot(beam.to.x - beam.from.x, beam.to.z - beam.from.z);
      const mesh = makeBeam(new THREE.Color("#ff2a2a").multiplyScalar(3), 0.07, 1);
      mesh.position.set(beam.from.x, BEAM_HEIGHT, beam.from.z);
      mesh.lookAt(beam.to.x, BEAM_HEIGHT, beam.to.z);
      mesh.scale.z = 0.0001;
      this.beamGroup.add(mesh);
      this.growing.push({ mesh, length, startedAt: now });
    }
  }

  clearBeams(): void {
    this.beamGroup.clear();
    this.growing = [];
  }

  /** Moves the camera. In follow mode it hangs behind and above the local player. */
  setView(view: CameraView): void {
    this.view = view;
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    for (const character of this.characters.values()) character.dispose();
    this.characters.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** The pit: concrete walls with ribs and pipes, a steel-grating floor, and lamps. */
  private buildPit(): void {
    const wallTexture = noiseTexture("#6f7175", 0.16, 14, 3);
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(PIT_RADIUS, PIT_RADIUS, PIT_WALL_HEIGHT, 72, 1, true),
      new THREE.MeshStandardMaterial({ map: wallTexture, roughness: 0.95, side: THREE.BackSide }),
    );
    wall.position.y = PIT_WALL_HEIGHT / 2;
    wall.receiveShadow = true;
    this.scene.add(wall);

    const floorTexture = gratingTexture();
    floorTexture.repeat.set(PIT_RADIUS / 2, PIT_RADIUS / 2);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(PIT_RADIUS, 96).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 0.6, metalness: 0.5 }),
    );
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Vertical steel ribs and horizontal pipes around the wall.
    const steel = new THREE.MeshStandardMaterial({ color: "#41464d", roughness: 0.5, metalness: 0.75 });
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2;
      const rib = new THREE.Mesh(new THREE.BoxGeometry(1.3, PIT_WALL_HEIGHT, 0.9), steel);
      rib.position.set(Math.cos(angle) * (PIT_RADIUS - 0.45), PIT_WALL_HEIGHT / 2, Math.sin(angle) * (PIT_RADIUS - 0.45));
      rib.rotation.y = -angle + Math.PI / 2;
      rib.castShadow = true;
      rib.receiveShadow = true;
      this.scene.add(rib);
    }
    for (const y of [3.2, 8.5, 13.5]) {
      const pipe = new THREE.Mesh(new THREE.TorusGeometry(PIT_RADIUS - 0.9, 0.28, 12, 120).rotateX(Math.PI / 2), steel);
      pipe.position.y = y;
      this.scene.add(pipe);
    }

    // Work lamps up the wall, each with a real light so the floor and the wall are lit.
    const lampMaterial = new THREE.MeshStandardMaterial({ color: "#fff1d6", emissive: "#ffd9a0", emissiveIntensity: 2 });
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 + 0.13;
      const x = Math.cos(angle) * (PIT_RADIUS - 1.6);
      const z = Math.sin(angle) * (PIT_RADIUS - 1.6);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.45, 0.9), lampMaterial);
      lamp.position.set(x, 9, z);
      this.scene.add(lamp);
      const light = new THREE.PointLight("#ffd9a0", 55, 38, 1.5);
      light.position.set(x * 0.9, 8.5, z * 0.9);
      this.scene.add(light);
    }

    this.scene.add(new THREE.HemisphereLight("#9fb0c8", "#1b1a18", 0.5));
    const key = new THREE.DirectionalLight("#ffeccd", 1.5);
    key.position.set(-8, 30, 14);
    key.castShadow = true;
    const shadowSize = this.touchDevice ? 1024 : 2048;
    key.shadow.mapSize.set(shadowSize, shadowSize);
    const extent = 20;
    key.shadow.camera.left = -extent;
    key.shadow.camera.right = extent;
    key.shadow.camera.top = extent;
    key.shadow.camera.bottom = -extent;
    key.shadow.camera.far = 80;
    key.shadow.radius = 3;
    key.shadow.bias = -0.0005;
    this.scene.add(key);
  }

  /** Rebuilds the cage and the danger zone for a radius. */
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
      ring.geometry = new THREE.TorusGeometry(radius, index === 2 ? 0.1 : 0.08, 8, 128).rotateX(Math.PI / 2);
    });

    this.dangerZone.geometry.dispose();
    this.dangerZone.geometry = new THREE.RingGeometry(radius, PIT_RADIUS, 96).rotateX(-Math.PI / 2);
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

    // The cage closes in at a steady speed when the ring shrinks.
    if (this.shownRadius !== this.targetRadius) {
      const step = CAGE_CLOSE_SPEED * dt;
      const next =
        Math.abs(this.targetRadius - this.shownRadius) <= step
          ? this.targetRadius
          : this.shownRadius + Math.sign(this.targetRadius - this.shownRadius) * step;
      this.applyRadius(next);
    }

    for (const beam of this.growing) {
      const t = Math.min(1, (now - beam.startedAt) / BEAM_GROW_MS);
      beam.mesh.scale.z = Math.max(0.0001, beam.length * (1 - Math.pow(1 - t, 3)));
    }
    this.growing = this.growing.filter((beam) => now - beam.startedAt < BEAM_GROW_MS);

    for (const character of this.characters.values()) character.update(dt);
    this.updateCamera(dt);
    this.composer.render();
  }

  private updateCamera(dt: number): void {
    const view = this.view;
    let desired: THREE.Vector3;
    let look: THREE.Vector3;
    if (view.kind === "follow") {
      // Behind and well above the player, looking down at them and the way the gun points.
      const f = facing(view.yaw);
      const right = { x: -f.z, z: f.x };
      desired = new THREE.Vector3(view.x - f.x * 4.4 + right.x * 0.9, 7.6, view.z - f.z * 4.4 + right.z * 0.9);
      look = new THREE.Vector3(view.x + f.x * 3.2, 0.9, view.z + f.z * 3.2);
    } else {
      // High over the pit, so the whole cage fits. Portrait screens pull back further.
      const pull = this.camera.aspect < 1 ? Math.min(2.2, 1 / (this.camera.aspect * 1.1)) : 1;
      desired = new THREE.Vector3(0, 30 * pull, 17 * pull);
      look = new THREE.Vector3(0, 0, 0);
    }
    const k = 1 - Math.exp(-dt * 8);
    this.camera.position.lerp(desired, k);
    this.lookAt.lerp(look, k);
    this.camera.lookAt(this.lookAt);
  }
}

/** A thin box from its origin along +Z, so it can be placed, aimed, and stretched to a length. */
function makeBeam(color: THREE.Color, thickness: number, opacity: number): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(thickness, thickness, 1);
  geometry.translate(0, 0, 0.5);
  const material = new THREE.MeshBasicMaterial({
    color,
    toneMapped: false,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  });
  return new THREE.Mesh(geometry, material);
}

/** A procedural concrete texture: plain grey with soft blotches and fine grain. */
function noiseTexture(base: string, grain: number, repeatX: number, repeatY: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 255 * grain;
    image.data[i] = clamp255(image.data[i] + noise);
    image.data[i + 1] = clamp255(image.data[i + 1] + noise);
    image.data[i + 2] = clamp255(image.data[i + 2] + noise);
  }
  ctx.putImageData(image, 0, 0);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.05})`;
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, 6 + Math.random() * 22, 0, Math.PI * 2);
    ctx.fill();
  }
  return finishTexture(canvas, repeatX, repeatY);
}

/** A dark steel floor: plates with seams and a cross pattern, like industrial grating. */
function gratingTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#2c2f34";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, size - 3, size - 3);
  ctx.strokeStyle = "rgba(120,126,135,0.35)";
  ctx.lineWidth = 2;
  for (let i = 16; i < size; i += 16) {
    ctx.beginPath();
    ctx.moveTo(i, 6);
    ctx.lineTo(i, size - 6);
    ctx.stroke();
  }
  for (let i = 0; i < 1200; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
  return finishTexture(canvas, 1, 1);
}

function finishTexture(canvas: HTMLCanvasElement, repeatX: number, repeatY: number): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function clamp255(value: number): number {
  return Math.min(255, Math.max(0, value));
}
