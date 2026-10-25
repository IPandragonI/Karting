// Race rules: countdown, lap timing, checkpoints and records. Pure logic: the game feeds it the
// kart's progress every physics step and reacts to the events it returns.
//
// Anti-cheat: checkpoints are spread over the circuit in race order and must be passed in
// order. Crossing the line only completes a lap once every checkpoint has been passed, and
// crossing it backwards voids the current lap, so rocking back and forth over the line or
// cutting across the infield never counts.

export type RacePhase = "idle" | "countdown" | "racing" | "finished";

export type RaceEvent =
  | { type: "countdown"; lights: number }
  | { type: "go" }
  | { type: "lap"; lap: number; time: number; best: boolean; delta: number | null }
  | { type: "missedCheckpoint" }
  | { type: "finish"; total: number; bestLap: number; newRecord: boolean };

export const COUNTDOWN_LIGHT_INTERVAL = 0.7;
export const COUNTDOWN_LIGHTS = 5;

export type RaceSnapshot = {
  phase: RacePhase;
  lap: number;
  totalLaps: number;
  lapTime: number;
  totalTime: number;
  laps: number[];
  bestLap: number | null;
  /** Best lap stored for this track before the session started. */
  recordLap: number | null;
};

export class RaceManager {
  phase: RacePhase = "idle";
  readonly checkpoints: number[];
  private nextCheckpoint = 0;
  private countdownTime = 0;
  private lightsShown = 0;
  lapTime = 0;
  totalTime = 0;
  laps: number[] = [];
  /** Best lap of this session. */
  bestLap: number | null = null;

  constructor(
    /** Number of pieces in race order. */
    private readonly loopLength: number,
    readonly totalLaps: number,
    /** Best lap ever on this track (from storage). */
    public recordLap: number | null,
  ) {
    // Up to 8 checkpoints evenly spread; never the start piece itself (order 0).
    const count = Math.min(8, Math.max(1, loopLength - 1));
    const step = (loopLength - 1) / count;
    const cps = new Set<number>();
    for (let i = 1; i <= count; i++)
      cps.add(Math.min(loopLength - 1, Math.max(1, Math.round(i * step))));
    this.checkpoints = [...cps].sort((a, b) => a - b);
  }

  startCountdown() {
    this.phase = "countdown";
    this.countdownTime = 0;
    this.lightsShown = 0;
    this.nextCheckpoint = 0;
    this.lapTime = 0;
    this.totalTime = 0;
    this.laps = [];
  }

  /** Free drive: no countdown, no clock, no records. */
  startFree() {
    this.phase = "idle";
  }

  get countdownLights() {
    return this.lightsShown;
  }

  /** Advance timers. Returns countdown/go events. */
  tick(dt: number): RaceEvent[] {
    const events: RaceEvent[] = [];
    if (this.phase === "countdown") {
      this.countdownTime += dt;
      const lights = Math.min(
        COUNTDOWN_LIGHTS,
        Math.floor(this.countdownTime / COUNTDOWN_LIGHT_INTERVAL),
      );
      while (this.lightsShown < lights) {
        this.lightsShown++;
        events.push({ type: "countdown", lights: this.lightsShown });
      }
      if (this.countdownTime >= (COUNTDOWN_LIGHTS + 1) * COUNTDOWN_LIGHT_INTERVAL) {
        this.phase = "racing";
        this.lightsShown = 0;
        events.push({ type: "go" });
      }
    } else if (this.phase === "racing") {
      this.lapTime += dt;
      this.totalTime += dt;
    }
    return events;
  }

  /** The kart is on the piece at `order` in race order (call every step; repeats are fine). */
  onPiece(order: number) {
    if (this.phase !== "racing") return;
    if (
      this.nextCheckpoint < this.checkpoints.length &&
      order === this.checkpoints[this.nextCheckpoint]
    ) {
      this.nextCheckpoint++;
    }
  }

  /**
   * The kart crossed the start/finish line during the last step. `overshoot` is the time (s)
   * spent past the line within that step, used to time laps precisely.
   */
  onLineCrossed(forward: boolean, overshoot: number): RaceEvent[] {
    if (this.phase !== "racing") return [];
    if (!forward) {
      this.nextCheckpoint = 0;
      return [];
    }
    if (this.nextCheckpoint < this.checkpoints.length) {
      // The standing start crosses the line right after GO; only complain mid-lap.
      return this.nextCheckpoint > 0 ? [{ type: "missedCheckpoint" }] : [];
    }

    const time = this.lapTime - overshoot;
    this.laps.push(time);
    const previousBest = this.bestLap ?? this.recordLap;
    const best = previousBest === null || time < previousBest;
    const delta = previousBest === null ? null : time - previousBest;
    if (this.bestLap === null || time < this.bestLap) this.bestLap = time;
    this.lapTime = overshoot;
    this.nextCheckpoint = 0;
    const events: RaceEvent[] = [{ type: "lap", lap: this.laps.length, time, best, delta }];

    if (this.laps.length >= this.totalLaps) {
      this.phase = "finished";
      this.totalTime -= overshoot;
      const bestLap = Math.min(...this.laps);
      const newRecord = this.recordLap === null || bestLap < this.recordLap;
      if (newRecord) this.recordLap = bestLap;
      events.push({ type: "finish", total: this.totalTime, bestLap, newRecord });
    }
    return events;
  }

  snapshot(): RaceSnapshot {
    return {
      phase: this.phase,
      lap: Math.min(this.laps.length + 1, this.totalLaps),
      totalLaps: this.totalLaps,
      lapTime: this.lapTime,
      totalTime: this.totalTime,
      laps: [...this.laps],
      bestLap: this.bestLap,
      recordLap: this.recordLap,
    };
  }
}

export function formatTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return "–:––.–––";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}
