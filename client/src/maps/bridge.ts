import * as THREE from "three";
import { TILE_SIZE } from "../../../shared/arena.js";
import {
  addGrain,
  Bin,
  blotches,
  buildStraightFence,
  CAGE_HEIGHT,
  Drift,
  dotTexture,
  finishTexture,
  makeCanvas,
  makeLights,
  scatter,
  seededRandom,
  skyDome,
  SLAB_THICKNESS,
  type MapContext,
  type MapScene,
} from "./common.js";

const CANYON_FLOOR = -150;

/**
 * Canyon Crossing: a round wooden deck hung in the middle of a canyon at sunset. Red rock walls rise on every side,
 * rope bridges run off to the cliffs, a river glitters far below and embers drift up on the warm wind. There is no
 * ground around the deck, only air, so the ice-free drop feels real when planks give way.
 */
export function buildBridge(context: MapContext): MapScene {
  const bin = new Bin();
  const root = new THREE.Group();
  const { layout } = context;
  // How far the deck reaches along its length and across it, so the rope bridges and railings can meet it.
  const halfLength = Math.max(...layout.tiles.map((t) => Math.abs(t.x))) + TILE_SIZE * 0.87;
  const halfDepth = Math.max(...layout.tiles.map((t) => Math.abs(t.z))) + TILE_SIZE;
  const random = seededRandom(41);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  root.add(skyDome("#2f3b78", "#ea8a68", "#ffd29a"));

  // The sun: a big soft glow low over the far rim of the canyon.
  const glowTexture = dotTexture();
  bin.add(glowTexture);
  const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color: "#ffd9a0", transparent: true, opacity: 0.95, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
  sunGlow.position.set(-620, 150, -760);
  sunGlow.scale.set(520, 520, 1);
  root.add(sunGlow);

  // The canyon floor, a very long way down, with a bright river winding through it.
  const rockTexture = canyonRockTexture();
  rockTexture.repeat.set(40, 40);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(1600, 1600).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: rockTexture, color: "#9a6a52", roughness: 1 }),
  );
  floor.position.y = CANYON_FLOOR;
  root.add(floor);
  const river = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 1600).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: "#3b93b8", emissive: "#2a7fa0", emissiveIntensity: 0.5, roughness: 0.2, metalness: 0.2 }),
  );
  river.position.set(0, CANYON_FLOOR + 0.5, 0);
  root.add(river);

  // Canyon walls: tall, flat-faced columns of red rock all around, in warm and dark bands.
  const wallCount = 70;
  const walls = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1.15, 1, 7), new THREE.MeshStandardMaterial({ map: rockTexture, color: "#ffffff", roughness: 1, flatShading: true }), wallCount);
  for (let i = 0; i < wallCount; i++) {
    const angle = (i / wallCount) * Math.PI * 2 + random() * 0.08;
    const near = i % 2 === 0;
    const distance = near ? 150 + random() * 80 : 300 + random() * 140;
    const width = near ? 26 + random() * 34 : 60 + random() * 80;
    const top = near ? 5 + random() * 55 : 50 + random() * 120;
    const height = top - CANYON_FLOOR;
    dummy.position.set(Math.cos(angle) * distance, CANYON_FLOOR + height / 2, Math.sin(angle) * distance);
    dummy.scale.set(width, height, width * (0.8 + random() * 0.5));
    dummy.rotation.set(0, random() * 3, 0);
    dummy.updateMatrix();
    walls.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.065 + random() * 0.035, 0.4 + random() * 0.2, 0.5 + random() * 0.14);
    walls.setColorAt(i, color);
  }
  root.add(walls);

  // The spires the deck is hung from: pillars of rock rising from the canyon floor.
  const spireMaterial = new THREE.MeshStandardMaterial({ map: rockTexture, color: "#b0745a", roughness: 1, flatShading: true });
  for (const x of [-halfLength * 0.6, 0, halfLength * 0.6]) {
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 10, -CANYON_FLOOR - SLAB_THICKNESS, 9), spireMaterial);
    spire.position.set(x, CANYON_FLOOR / 2 - SLAB_THICKNESS / 2, 0);
    root.add(spire);
  }

  // Two rope bridges run off from the deck to ledges on the cliffs. They are scenery: the cage is in the way.
  const plankMaterial = new THREE.MeshStandardMaterial({ map: plankTexture(), color: "#a8794a", roughness: 1 });
  const ropeMaterial = new THREE.MeshStandardMaterial({ color: "#c9aa7a", roughness: 1 });
  const bridgeLength = 70;
  const plankCount = 46;
  const planks = new THREE.InstancedMesh(new THREE.BoxGeometry(5.2, 0.35, 1.3), plankMaterial, plankCount * 2);
  for (const side of [-1, 1]) {
    for (let i = 0; i < plankCount; i++) {
      const t = (i + 0.5) / plankCount;
      dummy.position.set(side * (halfLength + 0.6 + t * bridgeLength), -sag(t, 5), 0);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 0.95);
      dummy.updateMatrix();
      planks.setMatrixAt((side < 0 ? 0 : plankCount) + i, dummy.matrix);
    }
    for (const lane of [-2.5, 2.5]) {
      const points = Array.from({ length: 24 }, (_, k) => {
        const t = k / 23;
        return new THREE.Vector3(side * (halfLength + 0.6 + t * bridgeLength), -sag(t, 5) + 1.5, lane);
      });
      const rope = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 40, 0.14, 6), ropeMaterial);
      root.add(rope);
    }
    // The ledge the bridge reaches, a slab of rock jutting out from the cliff.
    const ledge = new THREE.Mesh(new THREE.BoxGeometry(34, 12, 44), new THREE.MeshStandardMaterial({ map: rockTexture, color: "#b9805f", roughness: 1, flatShading: true }));
    ledge.position.set(side * (halfLength + bridgeLength + 18), -8, 0);
    root.add(ledge);
  }
  root.add(planks);

  // Layers of haze in the canyon, so the depth reads.
  for (const [y, opacity] of [[-45, 0.16], [-95, 0.22]] as const) {
    const haze = new THREE.Mesh(
      new THREE.CircleGeometry(520, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#ffc9a0", transparent: true, opacity, depthWrite: false }),
    );
    haze.position.y = y;
    root.add(haze);
  }

  // Embers and dust drifting up on the warm wind.
  const dot = dotTexture();
  bin.add(dot);
  const embers = new Drift(
    { count: context.touch ? 120 : 300, radius: 90, height: 60, fall: [-2.4, -0.7], wind: 1.6, sway: 0.8, size: 0.6, color: "#ffb15a", opacity: 0.9, additive: true },
    dot,
  );
  root.add(embers.points);

  const { hemisphere, sun } = makeLights({
    sky: "#ffe6cc",
    ground: "#a98068",
    skyIntensity: 1.2,
    sun: "#ffd2a0",
    sunIntensity: 2.7,
    sunPosition: [52, 38, -44],
    touch: context.touch,
  });
  root.add(hemisphere, sun);

  // The deck: wide planks, warm in one tint and darker in the next. The edge is banded with glowing brass.
  const planksTexture = plankTexture();
  planksTexture.repeat.set(0.16, 0.16);
  const tileMaterial = new THREE.MeshStandardMaterial({ map: planksTexture, color: "#ffffff", roughness: 0.85, metalness: 0 });
  const edge = new THREE.MeshStandardMaterial({ color: "#ffd9a0", emissive: "#ff9a3c", emissiveIntensity: 0.65, roughness: 0.4, metalness: 0.5 });

  // The railing along both sides: dark wooden posts strung with rope, with a warm lantern rail on top.
  const lantern = new THREE.MeshStandardMaterial({ color: "#ffe2b0", emissive: "#ff9d3a", emissiveIntensity: 0.9, roughness: 0.5 });
  const fence = buildStraightFence(halfLength, halfDepth, {
    post: new THREE.CylinderGeometry(0.16, 0.2, CAGE_HEIGHT * 0.6, 8).translate(0, (CAGE_HEIGHT * 0.6) / 2, 0),
    postMaterial: new THREE.MeshStandardMaterial({ color: "#5a3a26", roughness: 1 }),
    rails: [
      { y: 1.2, tube: 0.12, material: ropeMaterial },
      { y: CAGE_HEIGHT * 0.3, tube: 0.12, material: ropeMaterial },
      { y: CAGE_HEIGHT * 0.58, tube: 0.16, material: lantern },
    ],
  });
  root.add(fence.posts, ...fence.rails);

  return {
    root,
    background: "#f0b890",
    fog: new THREE.Fog("#f0b890", 160, 820),
    exposure: 1.02,
    sun,
    floor: { material: tileMaterial, edge, tints: ["#f0cf9c", "#cfa56e"] },
    fence,
    update: (dt, time) => {
      embers.update(dt, time);
      // The river shimmers.
      (river.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.45 + 0.15 * Math.sin(time * 1.3);
    },
    setLowPower: (on) => embers.setFraction(on ? 0.4 : 1),
    dispose: () => {
      bin.add(edge);
      bin.add(tileMaterial);
      bin.add(planksTexture);
      bin.disposeAll(root);
    },
  };
}

/** How far a rope bridge sags at fraction `t` along its length. */
function sag(t: number, depth: number): number {
  return depth * (1 - Math.pow(2 * t - 1, 2));
}

function canyonRockTexture(): THREE.CanvasTexture {
  const size = 512;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = "#cfa07a";
  ctx.fillRect(0, 0, size, size);
  // Horizontal strata in warm reds, browns and cream.
  for (let y = 0; y < size; y += 4 + Math.random() * 14) {
    const r = 170 + Math.random() * 70;
    ctx.fillStyle = `rgba(${r},${r * 0.68},${r * 0.5},${0.2 + Math.random() * 0.3})`;
    ctx.fillRect(0, y, size, 3 + Math.random() * 12);
  }
  blotches(ctx, size, 60, 20, 90, ["rgba(60,25,15,0.25)", "rgba(240,190,140,0.2)"]);
  addGrain(ctx, size, 0.08);
  return finishTexture(canvas, 1, 2);
}

/** Wide wooden planks laid side by side, each a little different, with grain and the odd knot. */
function plankTexture(): THREE.CanvasTexture {
  const size = 512;
  const { canvas, ctx } = makeCanvas(size);
  const plankHeight = size / 8;
  for (let i = 0; i < 8; i++) {
    const shade = 150 + Math.random() * 60;
    ctx.fillStyle = `rgb(${shade},${shade * 0.72},${shade * 0.46})`;
    ctx.fillRect(0, i * plankHeight, size, plankHeight);
    // Grain: long thin streaks along the plank.
    for (let g = 0; g < 26; g++) {
      ctx.strokeStyle = `rgba(70,40,20,${0.05 + Math.random() * 0.12})`;
      ctx.lineWidth = 1 + Math.random() * 1.5;
      const y = i * plankHeight + Math.random() * plankHeight;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(size * 0.3, y + (Math.random() - 0.5) * 6, size * 0.7, y + (Math.random() - 0.5) * 6, size, y);
      ctx.stroke();
    }
    if (Math.random() < 0.6) {
      ctx.fillStyle = "rgba(60,32,16,0.45)";
      ctx.beginPath();
      ctx.ellipse(Math.random() * size, i * plankHeight + plankHeight / 2, 6, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // The gap between planks, and the nails at the ends.
    ctx.fillStyle = "rgba(20,10,5,0.7)";
    ctx.fillRect(0, i * plankHeight, size, 2);
  }
  addGrain(ctx, size, 0.05);
  return finishTexture(canvas, 1, 1);
}
