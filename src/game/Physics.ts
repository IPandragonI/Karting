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
  updateWorld,
  type Listener,
  type RigidBody,
  type World,
} from "crashcat";

// Thin wrapper around crashcat. The world holds: a ground slab, static wall boxes (tire walls
// and the outer boundary), static tire-stack props, dynamic cones, and the kart, a sphere
// restricted to translation so the arcade model alone decides its heading.

export const KART_RADIUS = 0.7;
const GRAVITY = 20;

let registered = false;

export type WallSegment = { x1: number; z1: number; x2: number; z2: number };

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
      motionQuality: MotionQuality.LINEAR_CAST,
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

  addWall(seg: WallSegment, halfThickness: number, height = 1.4) {
    const dx = seg.x2 - seg.x1;
    const dz = seg.z2 - seg.z1;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    // Box local +Z runs along the segment; rotate around Y by atan2(dx, dz).
    const angle = Math.atan2(dx, dz);
    rigidBody.create(this.world, {
      shape: box.create({ halfExtents: [halfThickness, height / 2, len / 2 + 0.05] }),
      motionType: MotionType.STATIC,
      objectLayer: this.staticLayer,
      position: [(seg.x1 + seg.x2) / 2, height / 2, (seg.z1 + seg.z2) / 2],
      quaternion: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
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

  setKartVelocity(vx: number, vy: number, vz: number) {
    rigidBody.setLinearVelocity(this.world, this.kart, [vx, vy, vz]);
  }

  teleportKart(x: number, z: number) {
    rigidBody.setPosition(this.world, this.kart, [x, KART_RADIUS, z], true);
    rigidBody.setLinearVelocity(this.world, this.kart, [0, 0, 0]);
  }
}
