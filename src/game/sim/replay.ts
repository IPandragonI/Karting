import type { SectorResult } from "../RaceManager";
import type { TrackData } from "../track/Track";
import { canonicalTrack, Simulation, type SimInput } from "./Simulation";

// Replays an input trace through the simulation from the start of a session, exactly as the
// game ran it, and reports the laps it produces. Shared by the leaderboard server (which trusts
// nothing but this) and the tests.

export type ReplayedLap = {
  lap: number;
  time: number;
  sectors: number[];
  /** Physics step on which the lap was completed (1-based). */
  step: number;
};

export type ReplayResult = { laps: ReplayedLap[]; steps: number; raceable: boolean };

/** Runs `inputs` on `track`; stops after lap `stopAfterLap` when given. */
export function replay(track: TrackData, inputs: SimInput[], stopAfterLap?: number): ReplayResult {
  const sim = new Simulation(canonicalTrack(track));
  sim.start();
  const laps: ReplayedLap[] = [];
  let sectors: SectorResult[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const r = sim.step(inputs[i]!);
    for (const e of r.events) {
      if (e.type === "sector") sectors.push(e.sector);
      else if (e.type === "lapStart" || e.type === "missedCheckpoint") sectors = [];
      else if (e.type === "lap") {
        laps.push({ lap: e.lap, time: e.time, sectors: sectors.map((s) => s.time), step: i + 1 });
        sectors = [];
        if (stopAfterLap !== undefined && e.lap >= stopAfterLap)
          return { laps, steps: i + 1, raceable: sim.raceable };
      }
    }
  }
  return { laps, steps: inputs.length, raceable: sim.raceable };
}
