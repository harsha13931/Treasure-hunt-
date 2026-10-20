import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { GUNS, GunId, RING_RADIUS, SEAT_COUNT } from "../../shared/config.js";
import { Beam, directionFromDeg, muzzlePosition, seatPosition } from "../../shared/geometry.js";
import { createStickman, Stickman } from "./stickman.js";

const BEAM_HEIGHT = 1.25;
const BEAM_GROW_MS = 260;
const FALL_SECONDS = 0.7;

export interface ActorState {
  id: string;
  seat: number | null;
  aimDeg: number;
  gun: GunId;
  alive: boolean;
}

interface Actor {
  figure: Stickman;
  alive: boolean;
  fall: number; // 0 = standing, 1 = lying down
}

interface GrowingBeam {
  mesh: THREE.Mesh;
  length: number;
  startedAt: number;
}

/**
 * The 3D arena: a dark ring, floor grid, stars, stick figures, guns and lasers.
 * It only draws what the server has told it. It never decides hits.
 */
export class Arena {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private seatMarkers: THREE.Mesh[] = [];
  private selectedMarker: THREE.Mesh;
  private ownRing: THREE.Mesh;
  private aimGroup = new THREE.Group();
  private beamGroup = new THREE.Group();
  private actors = new Map<string, Actor>();
  private growingBeams: GrowingBeam[] = [];
  private clock = new THREE.Clock();
  private ownId: string | null = null;
  private onSeatClick: ((seat: number) => void) | null = null;
  private resizeObserver: ResizeObserver;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);

    this.buildLights();
    this.buildFloor();
    this.buildStars();
    this.buildSeatMarkers();

    this.selectedMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.52, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#facc15", transparent: true, opacity: 0.95 }),
    );
    this.selectedMarker.visible = false;
    this.ownRing = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.7, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#facc15", transparent: true, opacity: 0.6 }),
    );
    this.ownRing.visible = false;
    this.scene.add(this.selectedMarker, this.ownRing, this.aimGroup, this.beamGroup);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.9, 0.5, 0.2);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.renderer.domElement.addEventListener("pointerdown", this.handlePointer);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();

    this.renderer.setAnimationLoop(() => this.frame());
  }

  setSeatClickHandler(handler: (seat: number) => void): void {
    this.onSeatClick = handler;
  }

  /** Hide phase: only the local player's figure and seat choices are shown. Other players are not created. */
  showHide(own: ActorState | null): void {
    this.clearActors();
    this.clearAim();
    this.clearBeams();
    this.ownId = own?.id ?? null;
    this.setSeatMarkersVisible(true);

    if (!own || own.seat === null || !own.alive) {
      this.setSelectedSeat(null);
      this.ownRing.visible = false;
      return;
    }
    this.addActor(own);
    this.setSelectedSeat(own.seat);
    this.placeRing(this.ownRing, own.seat);
    this.setAim(own.seat, own.aimDeg, own.gun);
  }

  /** Reveal: every player with a seat appears at once. */
  revealAll(players: ActorState[]): void {
    this.clearActors();
    this.clearAim();
    this.setSelectedSeat(null);
    this.setSeatMarkersVisible(false);
    this.ownRing.visible = false;

    for (const player of players) {
      if (player.seat !== null) this.addActor(player);
    }
    const own = this.ownId ? players.find((p) => p.id === this.ownId) : undefined;
    if (own?.seat !== undefined && own.seat !== null) {
      this.placeRing(this.ownRing, own.seat);
      this.ownRing.visible = true;
    }
  }

  /** Fire phase: draws each beam and marks the eliminated players as fallen. */
  fire(beams: Beam[], eliminated: string[], colorOf: (shooterId: string) => string): void {
    this.clearBeams();
    const now = performance.now();
    for (const beam of beams) {
      const length = Math.hypot(beam.to.x - beam.from.x, beam.to.z - beam.from.z);
      const mesh = makeBeamMesh(colorOf(beam.shooter), 1);
      mesh.position.set(beam.from.x, BEAM_HEIGHT, beam.from.z);
      mesh.lookAt(beam.to.x, BEAM_HEIGHT, beam.to.z);
      mesh.scale.z = 0.0001;
      this.beamGroup.add(mesh);
      this.growingBeams.push({ mesh, length, startedAt: now });
    }
    for (const id of eliminated) {
      const actor = this.actors.get(id);
      if (actor) actor.alive = false;
    }
  }

  setAim(seat: number | null, aimDeg: number, gun: GunId): void {
    this.clearAim();
    if (seat === null) return;
    const spec = GUNS[gun];
    const origin = muzzlePosition(seat, aimDeg);
    const length = Math.min(spec.range, RING_RADIUS * 2.2);
    for (const spread of spec.spreadDeg) {
      const dir = directionFromDeg(aimDeg + spread);
      const line = makeBeamMesh(spec.color, 0.25);
      line.position.set(origin.x, BEAM_HEIGHT, origin.z);
      line.lookAt(origin.x + dir.x, BEAM_HEIGHT, origin.z + dir.z);
      line.scale.z = length;
      this.aimGroup.add(line);
    }
  }

  setSeatMarkersVisible(visible: boolean): void {
    for (const marker of this.seatMarkers) marker.visible = visible;
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointer);
    this.clearActors();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private setSelectedSeat(seat: number | null): void {
    if (seat === null) {
      this.selectedMarker.visible = false;
      return;
    }
    this.placeRing(this.selectedMarker, seat);
    this.selectedMarker.visible = true;
  }

  private placeRing(ring: THREE.Mesh, seat: number): void {
    const pos = seatPosition(seat);
    ring.position.set(pos.x, 0.035, pos.z);
  }

  private addActor(state: ActorState): void {
    if (state.seat === null) return;
    const figure = createStickman(state.id, state.gun);
    const pos = seatPosition(state.seat);
    const dir = directionFromDeg(state.aimDeg);
    figure.root.position.set(pos.x, 0, pos.z);
    // The figure faces its aim direction. The model faces +Z, so turn it toward (dir.x, dir.z).
    figure.root.rotation.y = Math.atan2(dir.x, dir.z);
    this.scene.add(figure.root);
    this.actors.set(state.id, { figure, alive: state.alive, fall: state.alive ? 0 : 1 });
    figure.body.rotation.x = state.alive ? 0 : Math.PI / 2;
  }

  private clearActors(): void {
    for (const actor of this.actors.values()) {
      this.scene.remove(actor.figure.root);
      actor.figure.dispose();
    }
    this.actors.clear();
  }

  private clearAim(): void {
    this.aimGroup.clear();
  }

  private clearBeams(): void {
    this.beamGroup.clear();
    this.growingBeams = [];
  }

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight("#93c5fd", "#0b1020", 0.6));

    const key = new THREE.DirectionalLight("#fff1e0", 2.2);
    key.position.set(7, 18, 9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -14;
    key.shadow.camera.right = 14;
    key.shadow.camera.top = 14;
    key.shadow.camera.bottom = -14;
    key.shadow.radius = 4;
    key.shadow.bias = -0.0005;
    this.scene.add(key);

    // A cool glow over the middle of the ring, where the lasers cross.
    const core = new THREE.PointLight("#38bdf8", 14, 18, 1.6);
    core.position.set(0, 2.5, 0);
    this.scene.add(core);
  }

  private buildFloor(): void {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(RING_RADIUS + 2, 128).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: "#0d1426", roughness: 0.85, metalness: 0.05 }),
    );
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Concentric rings and spokes give the floor a radar-like design.
    const lineMaterial = new THREE.LineBasicMaterial({ color: "#1e3a8a", transparent: true, opacity: 0.55 });
    for (const radius of [2.5, 5, 7.5]) {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(a) * radius, 0.01, Math.sin(a) * radius));
      }
      this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial));
    }
    const spokes: THREE.Vector3[] = [];
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const pos = seatPosition(seat);
      spokes.push(new THREE.Vector3(0, 0.01, 0), new THREE.Vector3(pos.x, 0.01, pos.z));
    }
    this.scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokes), lineMaterial));

    // The glowing edge of the ring.
    const edge = new THREE.Mesh(
      new THREE.TorusGeometry(RING_RADIUS, 0.04, 16, 160).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: "#0ea5e9", emissive: "#0ea5e9", emissiveIntensity: 2.2 }),
    );
    edge.position.y = 0.04;
    this.scene.add(edge);
  }

  private buildStars(): void {
    const count = 900;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Stars on a large dome above the arena.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.9 + 0.05);
      const r = 120 + Math.random() * 60;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = Math.abs(r * Math.cos(phi)) + 10;
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.scene.add(
      new THREE.Points(
        geometry,
        new THREE.PointsMaterial({ color: "#c7d2fe", size: 0.9, sizeAttenuation: true, transparent: true, opacity: 0.8 }),
      ),
    );
  }

  private buildSeatMarkers(): void {
    const material = new THREE.MeshBasicMaterial({ color: "#64748b", transparent: true, opacity: 0.45 });
    const geometry = new THREE.CircleGeometry(0.32, 24).rotateX(-Math.PI / 2);
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const marker = new THREE.Mesh(geometry, material);
      const pos = seatPosition(seat);
      marker.position.set(pos.x, 0.03, pos.z);
      this.scene.add(marker);
      this.seatMarkers.push(marker);
    }
  }

  private handlePointer = (event: PointerEvent): void => {
    if (!this.onSeatClick) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return;

    // Angle of the click around the ring, mapped to the nearest seat.
    let turns = Math.atan2(hit.z, hit.x) / (Math.PI * 2);
    if (turns < 0) turns += 1;
    this.onSeatClick(Math.round(turns * SEAT_COUNT) % SEAT_COUNT);
  };

  private resize(): void {
    const width = this.host.clientWidth || window.innerWidth;
    const height = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.bloom.setSize(width, height);
    this.camera.aspect = width / height;
    // Close enough that the stick figures read clearly. Portrait screens pull back so the whole ring fits.
    this.camera.position.set(0, 15, width / height < 1 ? 30 : 19);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    const dt = this.clock.getDelta();
    const now = performance.now();

    for (const beam of this.growingBeams) {
      const t = Math.min(1, (now - beam.startedAt) / BEAM_GROW_MS);
      beam.mesh.scale.z = Math.max(0.0001, beam.length * (1 - Math.pow(1 - t, 3)));
    }

    // Eliminated figures tip over. Living figures stand back up.
    const step = dt / FALL_SECONDS;
    for (const actor of this.actors.values()) {
      actor.fall = actor.alive ? Math.max(0, actor.fall - step) : Math.min(1, actor.fall + step);
      actor.figure.body.rotation.x = actor.fall * (Math.PI / 2);
    }

    this.selectedMarker.rotation.y += dt * 0.8;
    this.composer.render();
  }
}

function makeBeamMesh(color: string, opacity: number): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(0.035, 0.035, 1);
  geometry.translate(0, 0, 0.5);
  const material = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
  return new THREE.Mesh(geometry, material);
}
