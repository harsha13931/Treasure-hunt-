import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { BEAM_HEIGHT, PIT_RADIUS, PIT_WALL_HEIGHT, START_RING_RADIUS } from "../../shared/config.js";
import type { Beam } from "../../shared/geometry.js";
import { facing } from "../../shared/movement.js";
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

export type CameraView = { kind: "follow"; x: number; z: number; yaw: number } | { kind: "overview" };

interface TimedBeam {
  mesh: THREE.Mesh;
  length: number;
  startedAt: number;
}

const BAR_COUNT = 72;
const CAGE_HEIGHT = 6.5;
const CAGE_CLOSE_SPEED = 3; // meters per second that the cage closes in
const BEAM_GROW_MS = 140;
const BEAM_HOLD_MS = 700;
const BEAM_FADE_MS = 500;

/**
 * The pit, the steel cage that shrinks, the stick men, and the laser beams.
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
  private beams: TimedBeam[] = [];
  private facingMarker: THREE.Mesh;
  private characters = new Map<string, Stickman>();
  private clock = new THREE.Clock();
  private lookAt = new THREE.Vector3(0, 1, 0);
  private view: CameraView = { kind: "overview" };
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

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 300);
    this.scene.background = new THREE.Color("#0b0c0e");
    this.scene.fog = new THREE.Fog("#0b0c0e", 70, 160);

    this.buildPit();

    // The cage bars and rings are rebuilt for each radius, so the cage can close in smoothly.
    this.cageBars = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.09, 0.09, CAGE_HEIGHT, 10).translate(0, CAGE_HEIGHT / 2, 0),
      new THREE.MeshStandardMaterial({ color: "#6b7078", roughness: 0.45, metalness: 0.85 }),
      BAR_COUNT,
    );
    this.cageBars.castShadow = true;
    this.scene.add(this.cageBars);
    const steel = new THREE.MeshStandardMaterial({ color: "#5a5f67", roughness: 0.45, metalness: 0.85 });
    const topRail = new THREE.MeshStandardMaterial({ color: "#c9824f", emissive: "#a8501f", emissiveIntensity: 0.9, roughness: 0.5, metalness: 0.5 });
    for (const [y, material] of [
      [0.15, steel],
      [CAGE_HEIGHT * 0.5, steel],
      [CAGE_HEIGHT, topRail],
    ] as const) {
      const ring = new THREE.Mesh(new THREE.BufferGeometry(), material);
      ring.position.y = y;
      ring.castShadow = true;
      this.cageRings.push(ring);
      this.scene.add(ring);
    }

    // The floor outside the cage is a darker, slightly red hazard zone.
    this.dangerZone = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: "#5a1a1a", transparent: true, opacity: 0.32, depthWrite: false }),
    );
    this.dangerZone.position.y = 0.03;
    this.scene.add(this.dangerZone);

    this.scene.add(this.beamGroup);

    // A faint arrow on the floor showing which way the local player faces. There is no laser line.
    this.facingMarker = new THREE.Mesh(
      new THREE.ShapeGeometry(arrowShape()).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.facingMarker.visible = false;
    this.facingMarker.position.y = 0.05;
    this.scene.add(this.facingMarker);

    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: this.touchDevice ? 2 : 4,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Bloom only lifts the bright laser beams. Phones skip it to stay smooth.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.3, 0.92);
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
    this.facingMarker.position.set(pose.x + f.x * 2.6, 0.05, pose.z + f.z * 2.6);
    this.facingMarker.rotation.y = pose.yaw;
  }

  /** Draws the beams. Each grows out from its muzzle, holds for a moment, then fades away. */
  fire(beams: Beam[]): void {
    this.clearBeams();
    const now = performance.now();
    for (const beam of beams) {
      const length = Math.hypot(beam.to.x - beam.from.x, beam.to.z - beam.from.z);
      const geometry = new THREE.BoxGeometry(0.1, 0.1, 1).translate(0, 0, 0.5);
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color("#ff3030").multiplyScalar(2.5),
        toneMapped: false,
        transparent: true,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(beam.from.x, BEAM_HEIGHT, beam.from.z);
      mesh.lookAt(beam.to.x, BEAM_HEIGHT, beam.to.z);
      mesh.scale.z = 0.0001;
      this.beamGroup.add(mesh);
      this.beams.push({ mesh, length, startedAt: now });
    }
  }

  clearBeams(): void {
    for (const beam of this.beams) {
      beam.mesh.geometry.dispose();
      (beam.mesh.material as THREE.Material).dispose();
    }
    this.beamGroup.clear();
    this.beams = [];
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
    this.clearBeams();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** The pit: concrete walls with ribs and pipes, a steel floor, and a few work lamps. */
  private buildPit(): void {
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(PIT_RADIUS, PIT_RADIUS, PIT_WALL_HEIGHT, 96, 1, true),
      new THREE.MeshStandardMaterial({ map: concreteTexture("#74777b", 0.1, 10, 2), roughness: 0.95, side: THREE.BackSide }),
    );
    wall.position.y = PIT_WALL_HEIGHT / 2;
    wall.receiveShadow = true;
    this.scene.add(wall);

    const floorTexture = steelFloorTexture();
    floorTexture.repeat.set(PIT_RADIUS / 3, PIT_RADIUS / 3);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(PIT_RADIUS, 128).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 0.62, metalness: 0.35 }),
    );
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Vertical steel ribs and horizontal pipes around the wall.
    const steel = new THREE.MeshStandardMaterial({ color: "#454a51", roughness: 0.5, metalness: 0.75 });
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2;
      const rib = new THREE.Mesh(new THREE.BoxGeometry(1.8, PIT_WALL_HEIGHT, 1.2), steel);
      rib.position.set(Math.cos(angle) * (PIT_RADIUS - 0.6), PIT_WALL_HEIGHT / 2, Math.sin(angle) * (PIT_RADIUS - 0.6));
      rib.rotation.y = -angle + Math.PI / 2;
      rib.castShadow = true;
      rib.receiveShadow = true;
      this.scene.add(rib);
    }
    for (const y of [4, 11, 18]) {
      const pipe = new THREE.Mesh(new THREE.TorusGeometry(PIT_RADIUS - 1.3, 0.36, 14, 144).rotateX(Math.PI / 2), steel);
      pipe.position.y = y;
      this.scene.add(pipe);
    }

    // Work lamps on the wall. A few real lights keep the scene cheap enough for phones.
    const lampMaterial = new THREE.MeshStandardMaterial({ color: "#fff1d6", emissive: "#ffd9a0", emissiveIntensity: 1.6 });
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 + 0.13;
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 1.2), lampMaterial);
      lamp.position.set(Math.cos(angle) * (PIT_RADIUS - 2.1), 12, Math.sin(angle) * (PIT_RADIUS - 2.1));
      this.scene.add(lamp);
    }
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + 0.8;
      const light = new THREE.PointLight("#ffe2b8", 420, 70, 1.6);
      light.position.set(Math.cos(angle) * 22, 14, Math.sin(angle) * 22);
      this.scene.add(light);
    }

    this.scene.add(new THREE.HemisphereLight("#b6c3d6", "#25221f", 0.55));
    const key = new THREE.DirectionalLight("#fff0d8", 2.0);
    key.position.set(-10, 38, 18);
    key.castShadow = true;
    const shadowSize = this.touchDevice ? 1024 : 2048;
    key.shadow.mapSize.set(shadowSize, shadowSize);
    const extent = 26;
    key.shadow.camera.left = -extent;
    key.shadow.camera.right = extent;
    key.shadow.camera.top = extent;
    key.shadow.camera.bottom = -extent;
    key.shadow.camera.far = 100;
    key.shadow.radius = 3;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.04;
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
      ring.geometry = new THREE.TorusGeometry(radius, index === 2 ? 0.14 : 0.1, 10, 160).rotateX(Math.PI / 2);
    });

    this.dangerZone.geometry.dispose();
    this.dangerZone.geometry = new THREE.RingGeometry(radius, PIT_RADIUS, 128).rotateX(-Math.PI / 2);
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

    this.updateBeams(now);
    for (const character of this.characters.values()) character.update(dt);
    this.updateCamera(dt);
    this.composer.render();
  }

  private updateBeams(now: number): void {
    for (const beam of this.beams) {
      const age = now - beam.startedAt;
      const grow = Math.min(1, age / BEAM_GROW_MS);
      beam.mesh.scale.z = Math.max(0.0001, beam.length * (1 - Math.pow(1 - grow, 3)));
      const fade = Math.min(1, Math.max(0, (age - BEAM_HOLD_MS) / BEAM_FADE_MS));
      (beam.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - fade;
      beam.mesh.visible = fade < 1;
    }
  }

  private updateCamera(dt: number): void {
    const view = this.view;
    let desired: THREE.Vector3;
    let look: THREE.Vector3;
    let rate: number;
    if (view.kind === "follow") {
      // Behind and well above the player, looking down at them and the way the gun points.
      const f = facing(view.yaw);
      const right = { x: -f.z, z: f.x };
      desired = new THREE.Vector3(view.x - f.x * 5 + right.x * 1.1, 8.2, view.z - f.z * 5 + right.z * 1.1);
      look = new THREE.Vector3(view.x + f.x * 4, 1.3, view.z + f.z * 4);
      // The follow camera tracks closely, which keeps turning from feeling floaty.
      rate = 16;
    } else {
      // High over the pit, so the whole cage fits.
      const pull = this.camera.aspect < 1.4 ? Math.min(1.8, 1.4 / this.camera.aspect) : 1;
      desired = new THREE.Vector3(0, 33 * pull, 19 * pull);
      look = new THREE.Vector3(0, 0, 0);
      rate = 5;
    }
    const k = 1 - Math.exp(-dt * rate);
    this.camera.position.lerp(desired, k);
    this.lookAt.lerp(look, k);
    this.camera.lookAt(this.lookAt);
  }
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
  ctx.fillStyle = "#34373c";
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
