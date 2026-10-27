// Endless time trial: lap timing, three sectors, checkpoints and records. Pure logic: the game
// feeds it the kart's progress every physics step and reacts to the events it returns.
//
// Flow: after a (re)start the kart is on its out lap; the clock starts the first time it
// crosses the start/finish line, then laps are timed back to back, forever.
//
// Sectors: the lap is split into three parts of equal distance along the race route (not
// regions of the map). Sector 1 and 2 end when the route distance passes 1/3 and 2/3 of the lap
// length; sector 3 ends at the finish line. Crossing times are interpolated inside the physics
// step, so S1 + S2 + S3 always equals the lap time exactly.
//
// Anti-cheat: checkpoints are spread over the circuit in race order and must be passed in
// order. Crossing the line only completes a lap once every checkpoint has been passed, and
// crossing it backwards voids the current lap, so rocking back and forth over the line or
// cutting across the infield never counts. A lap with a missed checkpoint is not counted and
// timing restarts from the line.

/** off: no valid circuit (free drive); outLap: waiting for the first line crossing. */
export type RacePhase = "off" | "outLap" | "timing";

/**
 * Sector colours, F1 style, against this circuit's records:
 * - purple: new personal best for the sector (beats the stored best);
 * - green: improves on your best of this session, but not the all-time best;
 * - yellow: slower than your best of this session (or than the record on your first lap);
 * - neutral: the first time this sector is ever timed on this circuit.
 */
export type SectorStatus = "purple" | "green" | "yellow" | "neutral";

export type SectorResult = {
  index: 0 | 1 | 2;
  time: number;
  /** Against the personal best before this sector (null when there was none). */
  delta: number | null;
  status: SectorStatus;
};

export type RaceEvent =
  | { type: "lapStart" }
  | { type: "sector"; sector: SectorResult }
  | { type: "lap"; lap: number; time: number; best: boolean; delta: number | null; record: boolean }
  | { type: "missedCheckpoint" };

export type RaceSnapshot = {
  phase: RacePhase;
  /** Lap being driven (1-based), 0 on the out lap. */
  lap: number;
  lapTime: number;
  laps: number[];
  /** Best lap of this session. */
  bestLap: number | null;
  /** Best lap ever on this circuit (persisted by the game). */
  recordLap: number | null;
  /** Sector being driven (0..2), or -1 when not timing a valid lap. */
  sector: number;
  /** Sectors completed on the current lap. */
  sectors: SectorResult[];
  /** Sectors of the last completed lap. */
  lastSectors: SectorResult[];
  /** All-time best sector times on this circuit. */
  bestSectors: (number | null)[];
};

export class RaceManager {
  phase: RacePhase = "off";
  readonly checkpoints: number[];
  private nextCheckpoint = 0;
  lapTime = 0;
  laps: number[] = [];
  bestLap: number | null = null;
  /** Route distances where sectors 1 and 2 end. */
  private readonly bounds: [number, number];
  private sector = -1;
  private sectorStart = 0;
  sectors: SectorResult[] = [];
  /** Sectors of the last completed lap. */
  lastSectors: SectorResult[] = [];
  readonly bestSectors: (number | null)[];
  private readonly sessionSectors: (number | null)[] = [null, null, null];

  constructor(
    /** Number of pieces in race order. */
    loopLength: number,
    /** Best lap ever on this track (from storage). */
    public recordLap: number | null,
    /** Total route length of one lap (for sector boundaries). */
    lapLength = 0,
    /** All-time best sector times on this track (from storage). */
    bestSectors: (number | null)[] = [null, null, null],
  ) {
    // Up to 8 checkpoints evenly spread; never the start piece itself (order 0).
    const count = Math.min(8, Math.max(1, loopLength - 1));
    const step = (loopLength - 1) / count;
    const cps = new Set<number>();
    for (let i = 1; i <= count; i++)
      cps.add(Math.min(loopLength - 1, Math.max(1, Math.round(i * step))));
    this.checkpoints = [...cps].sort((a, b) => a - b);
    this.bounds = [lapLength / 3, (lapLength * 2) / 3];
    this.bestSectors = [0, 1, 2].map((i) => bestSectors[i] ?? null);
  }

  /** (Re)start on the out lap. Session bests survive restarts. */
  start() {
    this.phase = "outLap";
    this.nextCheckpoint = 0;
    this.lapTime = 0;
    this.laps = [];
    this.sector = -1;
    this.sectors = [];
    this.lastSectors = [];
  }

  /** No valid circuit: drive freely without a clock. */
  stop() {
    this.phase = "off";
    this.lapTime = 0;
    this.sector = -1;
    this.sectors = [];
  }

  /** A valid lap is being timed (not voided by reversing over the line). */
  get timingLap() {
    return this.phase === "timing" && this.sector >= 0;
  }

  tick(dt: number) {
    if (this.phase === "timing") this.lapTime += dt;
  }

  /** The kart is on the piece at `order` in race order (call every step; repeats are fine). */
  onPiece(order: number) {
    if (this.phase !== "timing") return;
    if (
      this.nextCheckpoint < this.checkpoints.length &&
      order === this.checkpoints[this.nextCheckpoint]
    ) {
      this.nextCheckpoint++;
    }
  }

  /**
   * Route distance of the kart before and after the last step (`dt` long). Detects the sector 1
   * and 2 boundaries. Jumps (resets, laps wrapping) are ignored: a boundary only counts when
   * the kart drives across it, once per lap.
   */
  onProgress(prev: number, curr: number, dt: number): RaceEvent[] {
    if (this.phase !== "timing" || this.sector < 0 || this.sector > 1) return [];
    const bound = this.bounds[this.sector]!;
    if (!(prev < bound && curr >= bound) || curr - prev > 8) return [];
    const overshoot = ((curr - bound) / (curr - prev)) * dt;
    return [{ type: "sector", sector: this.completeSector(this.lapTime - overshoot) }];
  }

  private completeSector(at: number): SectorResult {
    const index = this.sector as 0 | 1 | 2;
    const time = at - this.sectorStart;
    const best = this.bestSectors[index] ?? null;
    const session = this.sessionSectors[index] ?? null;
    let status: SectorStatus;
    if (best === null) status = "neutral";
    else if (time < best) status = "purple";
    else if (session !== null && time < session) status = "green";
    else status = "yellow";
    const result: SectorResult = { index, time, delta: best === null ? null : time - best, status };
    if (best === null || time < best) this.bestSectors[index] = time;
    if (session === null || time < session) this.sessionSectors[index] = time;
    this.sectors = [...this.sectors, result];
    this.sectorStart = at;
    this.sector++;
    return result;
  }

  private beginLap(overshoot: number) {
    this.lapTime = overshoot;
    this.nextCheckpoint = 0;
    this.sector = 0;
    this.sectorStart = 0;
    this.sectors = [];
  }

  /**
   * The kart crossed the start/finish line during the last step. `overshoot` is the time (s)
   * spent past the line within that step, used to time laps precisely.
   */
  onLineCrossed(forward: boolean, overshoot: number): RaceEvent[] {
    if (this.phase === "off") return [];
    if (this.phase === "outLap") {
      if (!forward) return [];
      this.phase = "timing";
      this.beginLap(overshoot);
      return [{ type: "lapStart" }];
    }
    if (!forward) {
      // Reversing over the line voids the lap: no more sectors until a fresh lap begins.
      this.nextCheckpoint = 0;
      this.sector = -1;
      return [];
    }
    if (this.sector < 0) {
      // Voided lap (reversed over the line): start clean.
      this.beginLap(overshoot);
      return [];
    }
    if (this.nextCheckpoint < this.checkpoints.length) {
      // Rolling back and forth over the line right after it started is not worth a warning.
      if (this.nextCheckpoint === 0) return [];
      this.beginLap(overshoot);
      return [{ type: "missedCheckpoint" }];
    }

    const time = this.lapTime - overshoot;
    const events: RaceEvent[] = [];
    // Sector 3 ends at the line (a lap whose sector 2 boundary was skipped is closed out too,
    // so S1 + S2 + S3 keeps adding up to the lap).
    while (this.sector <= 2) events.push({ type: "sector", sector: this.completeSector(time) });

    this.laps.push(time);
    this.lastSectors = this.sectors;
    const previousBest = this.bestLap ?? this.recordLap;
    const best = previousBest === null || time < previousBest;
    // Against the record, like the live delta (the ghost is the record lap): a session best that
    // stays off the record still shows how far off it is.
    const delta = this.recordLap === null ? null : time - this.recordLap;
    if (this.bestLap === null || time < this.bestLap) this.bestLap = time;
    const record = this.recordLap === null || time < this.recordLap;
    if (record) this.recordLap = time;
    events.push({ type: "lap", lap: this.laps.length, time, best, delta, record });
    this.beginLap(overshoot);
    return events;
  }

  snapshot(): RaceSnapshot {
    return {
      phase: this.phase,
      lap: this.phase === "timing" ? this.laps.length + 1 : 0,
      lapTime: this.lapTime,
      laps: [...this.laps],
      bestLap: this.bestLap,
      recordLap: this.recordLap,
      sector: this.sector,
      sectors: [...this.sectors],
      lastSectors: [...this.lastSectors],
      bestSectors: [...this.bestSectors],
    };
  }
}

export function formatTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return "–:––.–––";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

/** Sector-style short time: "24.582" (or "1:04.582" past a minute). */
export function formatSplit(t: number): string {
  return t >= 60 ? formatTime(t) : t.toFixed(3);
}

export function formatDelta(d: number | null): string {
  if (d === null || !Number.isFinite(d)) return "";
  return `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(3)}`;
}
