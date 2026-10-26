// Best-lap ghost: records the kart's pose over a lap on a fixed time grid, and plays it back in
// sync with the current lap clock. Pure data (no three.js) so it is unit-testable; the game owns
// persistence and the view.
//
// Samples are taken at GHOST_RATE on lap time (t = 0, step, 2·step…), interpolated from the
// physics steps around each grid time, so playback is independent of the frame or physics rate.
// A 60 s lap is 1200 samples × 16 bytes ≈ 19 KB.

export const GHOST_RATE = 20;
const STRIDE = 4; // x, y, z, yaw
/** Laps longer than this are not recorded (bounded memory and storage). */
const MAX_SECONDS = 600;
/** A larger move between two samples is a reset (teleport): playback snaps instead of sliding. */
const JUMP = 6;

export type GhostLap = {
  /** Lap time (s); playback ends there. */
  time: number;
  /** Seconds between samples. */
  step: number;
  /** x, y, z, yaw per sample, sample k at lap time k·step. */
  samples: Float32Array;
};

export type GhostPose = { x: number; y: number; z: number; yaw: number };

function wrapAngle(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export class GhostRecorder {
  private data: number[] = [];
  private next = 0;
  private lastT = 0;
  private last: GhostPose = { x: 0, y: 0, z: 0, yaw: 0 };
  private recording = false;
  readonly step = 1 / GHOST_RATE;

  /**
   * Start a lap. Pass the pose at a time at or before lap time 0 (the previous physics step: the
   * lap started inside the step, so its time is the step's overshoot minus the step length).
   */
  begin(t: number, x: number, y: number, z: number, yaw: number) {
    this.data = [];
    this.next = 0;
    this.lastT = t;
    this.last = { x, y, z, yaw };
    this.recording = t <= 0;
  }

  /** Stop recording the current lap (it can no longer become a ghost). */
  cancel() {
    this.recording = false;
  }

  /** Pose after each physics step, at lap time `t`. */
  push(t: number, x: number, y: number, z: number, yaw: number) {
    if (!this.recording || t <= this.lastT) return;
    const l = this.last;
    const dyaw = wrapAngle(yaw - l.yaw);
    let g = this.next * this.step;
    while (g <= t) {
      if (this.next * this.step > MAX_SECONDS) {
        this.recording = false;
        return;
      }
      const f = (g - this.lastT) / (t - this.lastT);
      this.data.push(
        l.x + (x - l.x) * f,
        l.y + (y - l.y) * f,
        l.z + (z - l.z) * f,
        wrapAngle(l.yaw + dyaw * f),
      );
      this.next++;
      g = this.next * this.step;
    }
    this.lastT = t;
    l.x = x;
    l.y = y;
    l.z = z;
    l.yaw = yaw;
  }

  /** The lap ended at `time`: the recording as a ghost, or null if it does not cover the lap. */
  finish(time: number): GhostLap | null {
    const ok = this.recording && time > 0 && (this.next - 1) * this.step >= time - this.step;
    this.recording = false;
    if (!ok) return null;
    return { time, step: this.step, samples: Float32Array.from(this.data) };
  }
}

/** Pose of the ghost at lap time `t`; false when outside the lap (before start or finished). */
export function sampleGhost(lap: GhostLap, t: number, out: GhostPose): boolean {
  if (!(t >= 0) || t > lap.time) return false;
  const n = lap.samples.length / STRIDE;
  if (n === 0) return false;
  const u = Math.min(t / lap.step, n - 1);
  const i = Math.min(Math.floor(u), n - 2);
  const s = lap.samples;
  if (i < 0) {
    out.x = s[0]!;
    out.y = s[1]!;
    out.z = s[2]!;
    out.yaw = s[3]!;
    return true;
  }
  const a = i * STRIDE;
  const b = a + STRIDE;
  let f = u - i;
  if (Math.hypot(s[b]! - s[a]!, s[b + 2]! - s[a + 2]!) > JUMP) f = f < 0.5 ? 0 : 1;
  out.x = s[a]! + (s[b]! - s[a]!) * f;
  out.y = s[a + 1]! + (s[b + 1]! - s[a + 1]!) * f;
  out.z = s[a + 2]! + (s[b + 2]! - s[a + 2]!) * f;
  out.yaw = s[a + 3]! + wrapAngle(s[b + 3]! - s[a + 3]!) * f;
  return true;
}

// ─── Storage format ─────────────────────────────────────────────────────────

type StoredGhost = { v: 1; time: number; step: number; savedAt: number; data: string };

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeGhost(lap: GhostLap, savedAt = Date.now()): string {
  const bytes = new Uint8Array(lap.samples.buffer, lap.samples.byteOffset, lap.samples.byteLength);
  const stored: StoredGhost = {
    v: 1,
    time: lap.time,
    step: lap.step,
    savedAt,
    data: toBase64(bytes),
  };
  return JSON.stringify(stored);
}

/** Parses a stored ghost; null when missing, corrupt or inconsistent. */
export function decodeGhost(text: string | null): (GhostLap & { savedAt: number }) | null {
  if (!text) return null;
  try {
    const s = JSON.parse(text) as Partial<StoredGhost>;
    if (s.v !== 1 || typeof s.data !== "string") return null;
    const time = Number(s.time);
    const step = Number(s.step);
    if (!(time > 0 && time <= MAX_SECONDS && step > 0 && step <= 1)) return null;
    const bytes = fromBase64(s.data);
    if (bytes.length % (STRIDE * 4) !== 0) return null;
    const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    const n = samples.length / STRIDE;
    if (n < 2 || (n - 1) * step < time - step) return null;
    for (const v of samples) if (!Number.isFinite(v)) return null;
    return { time, step, samples, savedAt: Number(s.savedAt) || 0 };
  } catch {
    return null;
  }
}

// ─── Live delta ─────────────────────────────────────────────────────────────

/**
 * A reference lap as "time at each point of the route": for every ghost sample (lap time k·step),
 * the kart's progress along the route from the start line. Comparing positions, not elapsed
 * time against the total, is what makes the live delta meaningful: reaching a given corner
 * earlier than on the reference lap shows as ahead, wherever that corner is on the lap.
 */
export type ReferenceCurve = {
  /** Non-decreasing route progress (m) of sample k. */
  progress: Float32Array;
  step: number;
  time: number;
};

/**
 * Builds the curve from a ghost lap. `progressAt` returns the route progress of a position (0 at
 * the line, up to `lapLength`), or null when the position is off the circuit.
 */
export function buildReference(
  lap: GhostLap,
  lapLength: number,
  progressAt: (x: number, y: number, z: number) => number | null,
): ReferenceCurve | null {
  const n = lap.samples.length / STRIDE;
  if (n < 2 || !(lapLength > 0)) return null;
  const progress = new Float32Array(n);
  const s = lap.samples;
  let prev = 0;
  for (let k = 0; k < n; k++) {
    let p = progressAt(s[k * STRIDE]!, s[k * STRIDE + 1]!, s[k * STRIDE + 2]!) ?? prev;
    if (k === 0) {
      // The first sample sits on the line, possibly a hair before it (progress ≈ lap length).
      prev = p > lapLength / 2 ? 0 : p;
    } else {
      // Unwrap across the line, and never go backwards (a wobble or a reset is not progress).
      while (p - prev < -lapLength / 2) p += lapLength;
      while (p - prev > lapLength / 2) p -= lapLength;
      prev = Math.max(prev, p);
    }
    progress[k] = prev;
  }
  return { progress, step: lap.step, time: lap.time };
}

/** Lap time at which the reference lap reached route progress `p`. */
export function referenceTime(ref: ReferenceCurve, p: number): number {
  const pr = ref.progress;
  const n = pr.length;
  if (p <= pr[0]!) return 0;
  if (p >= pr[n - 1]!) return ref.time;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pr[mid]! < p) lo = mid;
    else hi = mid;
  }
  const a = pr[lo]!;
  const b = pr[hi]!;
  const f = b > a ? (p - a) / (b - a) : 0;
  return Math.min(ref.time, (lo + f) * ref.step);
}
