import * as THREE from "three";

interface Particle {
  alive: boolean;
  age: number;
  life: number;
  size: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Settles on the floor instead of falling through it. */
  settles: boolean;
}

/** A fixed pool of small spheres drawn in one call. Dead slots are scaled to nothing. */
class ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  private particles: Particle[];
  private next = 0;
  private liveCount = 0;
  private dummy = new THREE.Object3D();

  constructor(
    count: number,
    material: THREE.Material,
    private gravity: number,
  ) {
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), material, count);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.particles = Array.from({ length: count }, () => ({
      alive: false,
      age: 0,
      life: 1,
      size: 0.1,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      settles: false,
    }));
    this.hideAll();
  }

  spawn(position: THREE.Vector3, velocity: THREE.Vector3, size: number, life: number, settles: boolean): void {
    const particle = this.particles[this.next];
    this.next = (this.next + 1) % this.particles.length;
    if (!particle.alive) this.liveCount++;
    this.mesh.visible = true;
    particle.alive = true;
    particle.age = 0;
    particle.life = life;
    particle.size = size;
    particle.settles = settles;
    particle.position.copy(position);
    particle.velocity.copy(velocity);
  }

  update(dt: number): void {
    // Nothing alive means nothing to move, upload, or draw.
    if (this.liveCount === 0) return;
    this.particles.forEach((particle, index) => {
      if (!particle.alive) return;
      particle.age += dt;
      if (particle.age >= particle.life) {
        particle.alive = false;
        this.liveCount--;
        this.hide(index);
        return;
      }

      particle.velocity.y += this.gravity * dt;
      particle.position.addScaledVector(particle.velocity, dt);
      if (particle.position.y < particle.size * 0.4) {
        particle.position.y = particle.size * 0.4;
        if (particle.settles) {
          // Drops onto the floor and stops, like a splash that lands.
          particle.velocity.set(0, 0, 0);
        } else {
          particle.velocity.y *= -0.35;
        }
      }

      // Shrinks away over the last part of its life.
      const remaining = 1 - particle.age / particle.life;
      const scale = particle.size * Math.min(1, remaining * 3);
      this.dummy.position.copy(particle.position);
      this.dummy.scale.setScalar(scale);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(index, this.dummy.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.liveCount === 0) this.mesh.visible = false;
  }

  clear(): void {
    for (const particle of this.particles) particle.alive = false;
    this.liveCount = 0;
    this.mesh.visible = false;
    this.hideAll();
  }

  private hideAll(): void {
    this.particles.forEach((_, index) => this.hide(index));
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private hide(index: number): void {
    this.dummy.position.set(0, -1000, 0);
    this.dummy.scale.setScalar(0.0001);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(index, this.dummy.matrix);
  }
}

interface Flash {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  size: number;
}

/**
 * Short-lived effects: a red burst when a beam hits someone, sparks, and bright flashes at the
 * muzzle and at the point of impact. Everything is pooled, so firing does not allocate.
 */
export class Effects {
  private blood: ParticlePool;
  private sparks: ParticlePool;
  private flashes: Flash[] = [];
  private flashTexture: THREE.CanvasTexture;

  constructor(private scene: THREE.Scene) {
    this.blood = new ParticlePool(
      360,
      new THREE.MeshStandardMaterial({ color: "#8c0e14", roughness: 0.35, metalness: 0 }),
      -26,
    );
    this.sparks = new ParticlePool(
      160,
      new THREE.MeshBasicMaterial({ color: new THREE.Color("#ffb45a").multiplyScalar(2), toneMapped: false }),
      -14,
    );
    scene.add(this.blood.mesh, this.sparks.mesh);

    this.flashTexture = makeFlashTexture();
    for (let i = 0; i < 16; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.flashTexture,
          color: new THREE.Color("#ffb070").multiplyScalar(2),
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      sprite.visible = false;
      scene.add(sprite);
      this.flashes.push({ sprite, age: 0, life: 0.15, size: 1 });
    }
  }

  /** A burst of red droplets thrown along the beam and outward, which fall and settle on the floor. */
  bloodBurst(at: THREE.Vector3, direction: THREE.Vector3): void {
    for (let i = 0; i < 46; i++) {
      const spread = new THREE.Vector3(rand(-1, 1), rand(-0.2, 1.2), rand(-1, 1)).normalize();
      const velocity = direction.clone().multiplyScalar(rand(2, 9)).addScaledVector(spread, rand(2, 7));
      velocity.y += rand(2, 6);
      this.blood.spawn(at, velocity, rand(0.07, 0.2), rand(1.1, 1.9), true);
    }
    this.impactFlash(at, 2.2);
  }

  /** Orange sparks, thrown out in all directions. */
  sparkBurst(at: THREE.Vector3, direction: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      const spread = new THREE.Vector3(rand(-1, 1), rand(-0.3, 1), rand(-1, 1)).normalize();
      const velocity = direction.clone().multiplyScalar(rand(2, 8)).addScaledVector(spread, rand(1, 6));
      this.sparks.spawn(at, velocity, rand(0.04, 0.1), rand(0.25, 0.5), false);
    }
  }

  /** A quick bright flash with a few sparks, at the end of the gun. */
  muzzleFlash(at: THREE.Vector3, direction: THREE.Vector3): void {
    this.flash(at, 1.9, 0.12);
    this.sparkBurst(at, direction, 8);
  }

  /** A bright flash where a beam lands. */
  impactFlash(at: THREE.Vector3, size = 1.6): void {
    this.flash(at, size, 0.2);
  }

  update(dt: number): void {
    this.blood.update(dt);
    this.sparks.update(dt);
    for (const flash of this.flashes) {
      if (!flash.sprite.visible) continue;
      flash.age += dt;
      const t = flash.age / flash.life;
      if (t >= 1) {
        flash.sprite.visible = false;
        continue;
      }
      flash.sprite.scale.setScalar(flash.size * (1 - t * 0.6));
      (flash.sprite.material as THREE.SpriteMaterial).opacity = 1 - t;
    }
  }

  clear(): void {
    this.blood.clear();
    this.sparks.clear();
    for (const flash of this.flashes) flash.sprite.visible = false;
  }

  private flash(at: THREE.Vector3, size: number, life: number): void {
    const flash = this.flashes.find((candidate) => !candidate.sprite.visible) ?? this.flashes[0];
    flash.sprite.position.copy(at);
    flash.sprite.visible = true;
    flash.age = 0;
    flash.life = life;
    flash.size = size;
    flash.sprite.scale.setScalar(size);
  }
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** A soft round glow, white in the middle and clear at the edge. */
function makeFlashTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,200,140,0.8)");
  gradient.addColorStop(1, "rgba(255,120,40,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
