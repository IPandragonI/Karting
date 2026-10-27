import {
  addBroadphaseLayer,
  addObjectLayer,
  box,
  createWorld,
  createWorldSettings,
  cylinder,
  DOF_TRANSLATION_ONLY,
  enableCollision,
  MotionQuality,
  MotionType,
  registerAll,
  rigidBody,
  sphere,
  staticCompound,
  updateWorld,
  type Listener,
  type RigidBody,
  type World,
} from "crashcat";

// Thin wrapper around crashcat. The world holds: a ground slab, static wall boxes (tire walls
// and the outer boundary), static tire-stack props, dynamic cones, and the kart, a sphere
// restricted to translation so the arcade model alone decides its heading.

export const KART_RADIUS = 0.7;
export const GRAVITY = 20;

let registered = false;

/** A wall along a segment; `y1`/`y2` are the heights of its base at each end (default 0). */
export type WallSegment = {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  y1?: number;
  y2?: number;
  /** Wall height override (retaining walls under raised road). */
  height?: number;
};

export class Physics {
  readonly world: World;
  readonly kart: RigidBody;
  readonly cones: RigidBody[] = [];
  private readonly staticLayer: number;
  private readonly movingLayer: number;
  private readonly listener: Listener;
  /** Set by the contact listener when the kart touches a cone this step. */
  coneHit = 0;

  constructor(spawn: { x: number; z: number }) {
    if (!registered) {
      registerAll();
      registered = true;
    }
    const settings = createWorldSettings();
    settings.gravity = [0, -GRAVITY, 0];
    const bpStatic = addBroadphaseLayer(settings);
    const bpMoving = addBroadphaseLayer(settings);
    this.staticLayer = addObjectLayer(settings, bpStatic);
    this.movingLayer = addObjectLayer(settings, bpMoving);
    enableCollision(settings, this.movingLayer, this.staticLayer);
    enableCollision(settings, this.movingLayer, this.movingLayer);
    this.world = createWorld(settings);

    // Ground: a thick slab whose top face is y = 0, so nothing can tunnel through it.
    rigidBody.create(this.world, {
      shape: box.create({ halfExtents: [2000, 1, 2000] }),
      motionType: MotionType.STATIC,
      objectLayer: this.staticLayer,
      position: [0, -1, 0],
      friction: 0.8,
      restitution: 0,
    });

    this.kart = rigidBody.create(this.world, {
      shape: sphere.create({ radius: KART_RADIUS }),
      motionType: MotionType.DYNAMIC,
      objectLayer: this.movingLayer,
      position: [spawn.x, KART_RADIUS, spawn.z],
      mass: 150,
      // The arcade model sets the velocity every step; contact friction would fight it.
      friction: 0,
      restitution: 0.25,
      linearDamping: 0,
      angularDamping: 0,
      allowedDegreesOfFreedom: DOF_TRANSLATION_ONLY,
      // Discrete, not LINEAR_CAST: the kart moves at most 0.4 m per step, well under its 0.7 m
      // radius, so it cannot tunnel through a wall, and crashcat 0.0.5's CCD response reuses a
      // module-level constraint whose accumulated impulse is never reset. That leaked between
      // sessions and made identical inputs give different laps, which a deterministic
      // simulation must not allow (see sim/Simulation.ts).
      motionQuality: MotionQuality.DISCRETE,
      allowSleeping: false,
    });

    this.listener = {
      onContactAdded: (a, b) => {
        if (
          (a === this.kart && this.cones.includes(b)) ||
          (b === this.kart && this.cones.includes(a))
        ) {
          this.coneHit++;
        }
      },
    };
  }

  /**
   * All walls go into a single static body with a static-compound shape (crashcat builds a BVH
   * over the boxes). A body per wall segment cost ~0.4–0.8 ms per physics step in broadphase
   * bookkeeping alone; one compound body costs almost nothing extra.
   */
  addWalls(walls: { seg: WallSegment; halfThickness: number; height: number }[]) {
    const children = [];
    for (const { seg, halfThickness, height } of walls) {
      const dx = seg.x2 - seg.x1;
      const dz = seg.z2 - seg.z1;
      const y1 = seg.y1 ?? 0;
      const y2 = seg.y2 ?? 0;
      const flat = Math.hypot(dx, dz);
      if (flat < 1e-4) continue;
      const len = Math.hypot(flat, y2 - y1);
      // Box local +Z runs along the segment: yaw around Y by atan2(dx, dz), then pitch around the
      // box's X axis so it follows a slope (a positive X rotation tips +Z downwards).
      const yaw = Math.atan2(dx, dz) / 2;
      const pitch = -Math.atan2(y2 - y1, flat) / 2;
      const [sy, cy, sp, cp] = [Math.sin(yaw), Math.cos(yaw), Math.sin(pitch), Math.cos(pitch)];
      children.push({
        shape: box.create({ halfExtents: [halfThickness, height / 2, len / 2 + 0.05] }),
        position: [(seg.x1 + seg.x2) / 2, (y1 + y2) / 2 + height / 2, (seg.z1 + seg.z2) / 2] as [
          number,
          number,
          number,
        ],
        // q_yaw · q_pitch
        quaternion: [cy * sp, sy * cp, -sy * sp, cy * cp] as [number, number, number, number],
      });
    }
    if (children.length === 0) return;
    rigidBody.create(this.world, {
      shape: staticCompound.create({ children }),
      motionType: MotionType.STATIC,
      objectLayer: this.staticLayer,
      position: [0, 0, 0],
      friction: 0,
      restitution: 0.3,
    });
  }

  addTireStack(x: number, z: number) {
    rigidBody.create(this.world, {
      shape: cylinder.create({ radius: 0.42, halfHeight: 0.5 }),
      motionType: MotionType.STATIC,
      objectLayer: this.staticLayer,
      position: [x, 0.5, z],
      friction: 0,
      restitution: 0.35,
    });
  }

  addCone(x: number, z: number): RigidBody {
    const body = rigidBody.create(this.world, {
      shape: cylinder.create({ radius: 0.24, halfHeight: 0.36 }),
      motionType: MotionType.DYNAMIC,
      objectLayer: this.movingLayer,
      position: [x, 0.36, z],
      mass: 3,
      friction: 0.7,
      restitution: 0.3,
      angularDamping: 0.6,
      linearDamping: 0.3,
    });
    this.cones.push(body);
    return body;
  }

  step(dt: number) {
    updateWorld(this.world, this.listener, dt);
  }

  /** Lifts the kart back onto the surface (ground following; see Game.fixedStep). */
  setKartHeight(y: number) {
    const p = this.kart.position;
    rigidBody.setPosition(this.world, this.kart, [p[0], y, p[2]], false);
  }

  setKartVelocity(vx: number, vy: number, vz: number) {
    rigidBody.setLinearVelocity(this.world, this.kart, [vx, vy, vz]);
  }

  teleportKart(x: number, z: number, ground = 0) {
    rigidBody.setPosition(this.world, this.kart, [x, ground + KART_RADIUS, z], true);
    rigidBody.setLinearVelocity(this.world, this.kart, [0, 0, 0]);
  }
}
