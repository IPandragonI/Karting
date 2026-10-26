import type { KartInput } from "../Vehicle";
import type { SimInput } from "./Simulation";

// Input traces: what the player did on every physics step of a session, quantized so that the
// recorded value is exactly the value the simulation used. Run-length encoded (keyboard input
// changes a few times a second), then base64.
//
// Binary layout: "KT" | u8 version | u32 step count | runs × 6 bytes
//   (u16 run length, i8 steer × 127, u8 throttle × 255, u8 brake × 255, u8 flags: 1 handbrake,
//   2 reset). A reset is only ever on the first step of its run.

const VERSION = 1;
/** Longest session a trace can describe (10 minutes of driving). */
export const MAX_TRACE_STEPS = 36000;
const MAX_RUN = 65535;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The input the simulation actually runs on: steer to 1/127, pedals to 1/255. (`+ 0` turns a
 * negative zero, which Math.round returns for small negative values, into the +0 a trace stores:
 * −0 and +0 differ in a few functions, atan2 among them, and the replay must match bit for bit.)
 */
export function quantizeInput(raw: KartInput, reset: boolean): SimInput {
  return {
    steer: Math.round(clamp(raw.steer, -1, 1) * 127) / 127 + 0,
    throttle: Math.round(clamp(raw.throttle, 0, 1) * 255) / 255 + 0,
    brake: Math.round(clamp(raw.brake, 0, 1) * 255) / 255 + 0,
    handbrake: raw.handbrake,
    reset,
  };
}

type Packed = [steer: number, throttle: number, brake: number, flags: number];

function pack(i: SimInput): Packed {
  return [
    Math.round(i.steer * 127),
    Math.round(i.throttle * 255),
    Math.round(i.brake * 255),
    (i.handbrake ? 1 : 0) | (i.reset ? 2 : 0),
  ];
}

function unpack([steer, throttle, brake, flags]: Packed): SimInput {
  return {
    steer: steer / 127,
    throttle: throttle / 255,
    brake: brake / 255,
    handbrake: (flags & 1) !== 0,
    reset: (flags & 2) !== 0,
  };
}

/** Records a session's inputs, step by step. */
export class TraceRecorder {
  private runs: { n: number; v: Packed }[] = [];
  private count = 0;

  get steps() {
    return this.count;
  }

  /** False once the session is longer than a trace can describe (no more recording). */
  get full() {
    return this.count >= MAX_TRACE_STEPS;
  }

  clear() {
    this.runs = [];
    this.count = 0;
  }

  push(input: SimInput) {
    if (this.full) return;
    const v = pack(input);
    const last = this.runs.at(-1);
    if (
      last &&
      last.n < MAX_RUN &&
      !(v[3] & 2) &&
      last.v[0] === v[0] &&
      last.v[1] === v[1] &&
      last.v[2] === v[2] &&
      last.v[3] === v[3]
    ) {
      last.n++;
    } else {
      this.runs.push({ n: 1, v });
    }
    this.count++;
  }

  /** The first `steps` steps (default: all), encoded. */
  encode(steps = this.count): string {
    const runs: { n: number; v: Packed }[] = [];
    let left = Math.min(steps, this.count);
    for (const r of this.runs) {
      if (left <= 0) break;
      const n = Math.min(r.n, left);
      runs.push({ n, v: r.v });
      left -= n;
    }
    const bytes = new Uint8Array(7 + runs.length * 6);
    const view = new DataView(bytes.buffer);
    bytes[0] = 75; // K
    bytes[1] = 84; // T
    bytes[2] = VERSION;
    view.setUint32(3, Math.min(steps, this.count));
    runs.forEach((r, k) => {
      const o = 7 + k * 6;
      view.setUint16(o, r.n);
      view.setInt8(o + 2, r.v[0]);
      bytes[o + 3] = r.v[1];
      bytes[o + 4] = r.v[2];
      bytes[o + 5] = r.v[3];
    });
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
}

/** Decodes and validates a trace; throws with a readable reason when it is malformed. */
export function decodeTrace(text: string): SimInput[] {
  if (typeof text !== "string" || text.length > 400_000 || !/^[A-Za-z0-9+/=]*$/.test(text))
    throw new Error("malformed trace");
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length < 7 || bytes[0] !== 75 || bytes[1] !== 84 || bytes[2] !== VERSION)
    throw new Error("unknown trace format");
  if ((bytes.length - 7) % 6 !== 0) throw new Error("truncated trace");
  const view = new DataView(bytes.buffer);
  const steps = view.getUint32(3);
  if (steps < 1 || steps > MAX_TRACE_STEPS) throw new Error("trace too long");
  const out: SimInput[] = [];
  for (let o = 7; o < bytes.length; o += 6) {
    const n = view.getUint16(o);
    const v: Packed = [view.getInt8(o + 2), bytes[o + 3]!, bytes[o + 4]!, bytes[o + 5]!];
    if (n < 1 || v[0] < -127 || v[3] > 3 || (n > 1 && v[3] & 2)) throw new Error("malformed trace");
    const input = unpack(v);
    for (let k = 0; k < n; k++) out.push(k === 0 ? input : { ...input, reset: false });
    if (out.length > steps) throw new Error("trace length mismatch");
  }
  if (out.length !== steps) throw new Error("trace length mismatch");
  return out;
}
