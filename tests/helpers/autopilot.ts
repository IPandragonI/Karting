import { canonicalTrack, Simulation } from "@/game/sim/Simulation";
import { quantizeInput, TraceRecorder } from "@/game/sim/trace";
import type { TrackData } from "@/game/track/Track";

/**
 * Drives a session the way the game does (quantized input, recorded every step) with a simple
 * autopilot that aims a few metres ahead on the race path (`offset` metres to the side of it, to
 * scrape the walls). Returns the lap times and the encoded input trace.
 */
export function drive(
  track: TrackData,
  laps: number,
  offset = 0,
  gain = 2.5,
  maxSteps = 60 * 60 * 3,
) {
  const sim = new Simulation(canonicalTrack(track));
  sim.start();
  const loop = sim.path.pieces.filter((p) => p.order >= 0).sort((a, b) => a.order - b.order);
  const pts = loop.flatMap((p) => p.points);
  const tangents = loop.flatMap((p) => p.tangents);
  const rec = new TraceRecorder();
  const times: number[] = [];
  let idx = 0;
  for (let step = 0; step < maxSteps && times.length < laps; step++) {
    const { x, z } = sim.currPos;
    let best = idx;
    let bd = Infinity;
    for (let k = -3; k < 30; k++) {
      const i = (idx + k + pts.length) % pts.length;
      const d = (pts[i]!.x - x) ** 2 + (pts[i]!.z - z) ** 2;
      if (d < bd) [bd, best] = [d, i];
    }
    idx = best;
    const j = (idx + 8) % pts.length;
    const t = pts[j]!;
    const tn = tangents[j]!;
    let ang = Math.atan2(t.x - tn.z * offset - x, t.z + tn.x * offset - z) - sim.kart.yaw;
    ang = Math.atan2(Math.sin(ang), Math.cos(ang));
    const speed = Math.hypot(sim.kart.vx, sim.kart.vz);
    const input = quantizeInput(
      {
        steer: Math.max(-1, Math.min(1, -ang * gain)),
        throttle: Math.abs(ang) > 0.5 && speed > 12 ? 0.3 : 1,
        brake: Math.abs(ang) > 0.7 && speed > 14 ? 0.6 : 0,
        handbrake: false,
      },
      false,
    );
    rec.push(input);
    for (const e of sim.step(input).events) if (e.type === "lap") times.push(e.time);
  }
  return { times, trace: rec.encode(), steps: rec.steps };
}
