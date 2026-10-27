// Procedural racing engines: a multi-cylinder four-stroke synthesized sample by sample, voiced per
// vehicle by an EngineProfile (a screaming F1 V10, a two-cylinder kart, a burbling V8, a diesel).
//
// Signal chain per firing (cylinders / 2 firings per crank revolution):
//   exhaust pulse + combustion noise burst, each cylinder slightly different (that unevenness puts
//   energy at the crank orders: the rasp of a real engine instead of a pure buzz)
//   → three fixed exhaust resonances (the "voice": they stay put while the firing rate sweeps
//   under them) + a tonal core locked to the firing rate (what makes an F1 engine scream)
//   → soft tanh saturation → load/rpm-tracking lowpass → DC blocker.
// Cycle-to-cycle jitter in timing and strength keeps it from looping. Off throttle at high revs
// (lifting, or the ignition cut of an upshift) unburnt fuel pops in the exhaust: crackles.
//
// The DSP is plain JavaScript source so the exact same code runs in the AudioWorklet (loaded from a
// Blob URL, no extra file to serve) and in unit tests under Node. The gearbox (`Gearbox`) runs on
// the main thread and only sends revs and load.

export type EngineProfile = {
  id: string;
  cylinders: number;
  idle: number;
  redline: number;
  /** Revs held while the clutch slips at launch. */
  launch: number;
  /**
   * Speed (share of the kart's top speed) at the redline in each gear; one entry: no gearbox.
   * The arcade kart reaches half its top speed in under a second, so the low gears are short and
   * the spacing widens up the box (each gear lasts a similar time).
   */
  gears: number[];
  /** Upshift / downshift points as shares of the redline. */
  shiftUp: number;
  shiftDown: number;
  /** Exhaust resonances: frequency (Hz), damping, gain. */
  formants: [number, number, number][];
  /** Level of the tonal core (harmonics of the firing rate). */
  tonal: number;
  /** Level of the combustion noise. */
  noise: number;
  /**
   * Level of the crank-rate (rpm / 60) component: the low "body" under the firing pitch that keeps
   * a high-revving engine from sounding thin.
   */
  sub: number;
  /** Cylinder-to-cylinder strength spread (0: perfectly even). */
  uneven: number;
  /** Lowpass: base cutoff and its range with load and revs (Hz). */
  cutoff: [number, number];
  /** Overrun crackles per second at the redline, off throttle. */
  crackle: number;
  /** Exhaust pulse decay (s, capped by the firing period). */
  pulse: number;
  gain: number;
};

export const ENGINES = {
  /**
   * V10 single-seater: a howl rather than a scream (revs kept below a real one's, voice and filter
   * lowered so it never turns piercing), seven quick shifts.
   */
  f1: {
    id: "f1",
    cylinders: 10,
    idle: 3200,
    redline: 10500,
    launch: 6400,
    gears: [0.24, 0.4, 0.55, 0.69, 0.83, 0.94, 1.05],
    shiftUp: 0.94,
    shiftDown: 0.6,
    formants: [
      [720, 0.26, 1],
      [1650, 0.24, 0.5],
      [3200, 0.22, 0.16],
    ],
    tonal: 0.45,
    noise: 0.28,
    sub: 0.5,
    uneven: 0.16,
    cutoff: [1500, 3600],
    crackle: 7,
    pulse: 0.0012,
    gain: 0.66,
  },
  /** Kart twin: gearless (centrifugal clutch), raspy, revs locked to road speed. */
  kart: {
    id: "kart",
    cylinders: 2,
    idle: 2600,
    redline: 13500,
    launch: 6400,
    gears: [1.06],
    shiftUp: 1,
    shiftDown: 0,
    formants: [
      [430, 0.3, 1],
      [1200, 0.26, 0.7],
      [2700, 0.22, 0.4],
    ],
    tonal: 0.25,
    noise: 0.55,
    sub: 0.2,
    uneven: 0.2,
    cutoff: [1600, 5400],
    crackle: 2,
    pulse: 0.0012,
    gain: 0.62,
  },
  /** Cross-plane V8 sports car: deep, uneven burble, six gears. */
  v8: {
    id: "v8",
    cylinders: 8,
    idle: 800,
    redline: 6600,
    launch: 3400,
    gears: [0.3, 0.47, 0.62, 0.76, 0.9, 1.04],
    shiftUp: 0.93,
    shiftDown: 0.5,
    formants: [
      [300, 0.32, 1],
      [780, 0.28, 0.5],
      [1800, 0.24, 0.22],
    ],
    tonal: 0.4,
    noise: 0.36,
    sub: 0.55,
    uneven: 0.45,
    cutoff: [850, 3000],
    crackle: 9,
    pulse: 0.002,
    gain: 0.7,
  },
  /** Six-cylinder truck diesel: low revs, clattery combustion, long gears. */
  diesel: {
    id: "diesel",
    cylinders: 6,
    idle: 700,
    redline: 3300,
    launch: 1500,
    gears: [0.32, 0.52, 0.7, 0.86, 1.04],
    shiftUp: 0.92,
    shiftDown: 0.52,
    formants: [
      [240, 0.34, 1],
      [760, 0.3, 0.55],
      [1900, 0.26, 0.45],
    ],
    tonal: 0.3,
    noise: 0.75,
    sub: 0.4,
    uneven: 0.25,
    cutoff: [700, 2600],
    crackle: 0,
    pulse: 0.0024,
    gain: 0.78,
  },
} satisfies Record<string, EngineProfile>;

export type EngineId = keyof typeof ENGINES;

export const ENGINE_DSP_SOURCE = /* js */ `
class EngineDsp {
  constructor(sampleRate, profile) {
    this.sr = sampleRate;
    this.seed = 1234567;
    this.rpmK = 1 - Math.exp(-1 / (0.03 * sampleRate));
    this.loadK = 1 - Math.exp(-1 / (0.02 * sampleRate));
    this.fire = 0;
    this.crank = 0;
    this.rev = 0;
    this.cyl = 0;
    this.cycleRate = 1;
    this.amp = 1;
    this.t = 1;
    this.pop = 0;
    this.popT = 1;
    this.low = [0, 0, 0];
    this.band = [0, 0, 0];
    this.nLow = 0;
    this.nBand = 0;
    this.lp = 0;
    this.lp2 = 0;
    this.dcX = 0;
    this.dcY = 0;
    this.dcR = 1 - 2 * Math.PI * 30 / sampleRate;
    this.setProfile(profile);
  }

  setProfile(p) {
    this.p = p;
    const sr = this.sr;
    this.rpm = this.rpm || p.idle;
    this.load = this.load || 0;
    this.fF = p.formants.map((f) => 2 * Math.sin(Math.PI * Math.min(f[0], sr * 0.2) / sr));
    this.fQ = p.formants.map((f) => f[1]);
    this.fG = p.formants.map((f) => f[2]);
    // Fixed per-cylinder character, from a seeded sequence so every session sounds the same.
    this.cylAmp = [];
    let s = 987654321;
    for (let k = 0; k < p.cylinders; k++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      this.cylAmp.push(1 + (s / 4294967296 - 0.5) * p.uneven * 2);
    }
    this.cyl = 0;
  }

  rand() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  process(out, n, targetRpm, targetLoad) {
    const sr = this.sr;
    const p = this.p;
    const span = Math.max(1, p.redline - p.idle);
    for (let i = 0; i < n; i++) {
      this.rpm += (targetRpm - this.rpm) * this.rpmK;
      this.load += (targetLoad - this.load) * this.loadK;
      const rpm01 = Math.min(1.1, Math.max(0, (this.rpm - p.idle) / span));
      const load = this.load;
      const firing = (this.rpm / 60) * (p.cylinders / 2);

      // Crank (two revolutions per cycle) for the low cycle-order weight.
      this.crank += this.rpm / 120 / sr;
      if (this.crank >= 1) this.crank -= 1;
      this.rev += this.rpm / 60 / sr;
      if (this.rev >= 1) this.rev -= 1;

      this.fire += (firing / sr) * this.cycleRate;
      if (this.fire >= 1) {
        this.fire -= 1;
        this.t = 0;
        this.cyl = (this.cyl + 1) % p.cylinders;
        this.cycleRate = 1 + (this.rand() - 0.5) * 0.02;
        const fuel = 0.22 + 0.78 * load;
        this.amp = fuel * this.cylAmp[this.cyl] * (0.94 + this.rand() * 0.12);
        // Overrun: off throttle at high revs, unburnt fuel ignites in the exhaust.
        if (load < 0.12 && rpm01 > 0.35 && this.rand() < (p.crackle * rpm01) / firing) {
          this.pop = 0.6 + this.rand() * 0.6;
          this.popT = 0;
        }
      }

      const t = this.t;
      this.t += 1 / sr;
      const tau = Math.min(p.pulse, 0.3 / firing);
      const attack = Math.min(1, (t * sr) / 4);
      const pulse = this.amp * attack * Math.exp(-t / tau);
      const white = this.rand() * 2 - 1;
      const burst = this.amp * Math.exp(-t / (tau * 1.6)) * white;

      // Combustion noise band, rising with revs.
      const nf = 2 * Math.sin(Math.PI * Math.min(0.2, (p.formants[1][0] * (0.7 + 0.6 * rpm01)) / sr));
      this.nLow += nf * this.nBand;
      const nHigh = burst - this.nLow - 0.8 * this.nBand;
      this.nBand += nf * nHigh;

      // Exhaust crackle: a short, low, noisy bang.
      let crack = 0;
      if (this.pop > 0) {
        this.popT += 1 / sr;
        crack = this.pop * Math.exp(-this.popT / 0.012) * (this.rand() * 2 - 1);
        if (this.popT > 0.08) this.pop = 0;
      }

      // Exhaust resonances driven by the pulse and the noise.
      const excite = pulse * 1.5 + this.nBand * p.noise + crack * 0.8;
      let body = 0;
      for (let k = 0; k < 3; k++) {
        this.low[k] += this.fF[k] * this.band[k];
        const high = excite - this.low[k] - this.fQ[k] * this.band[k];
        this.band[k] += this.fF[k] * high;
        body += this.band[k] * this.fG[k];
      }

      // Tonal core: the firing rate and two harmonics, phase-locked (continuous across firings).
      const ph = 2 * Math.PI * this.fire;
      const tone =
        (Math.sin(ph) + 0.45 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph)) * (0.35 + 0.65 * load);
      const cycle = Math.sin(2 * Math.PI * this.crank) * 0.15;
      // Body: the crank rate and its second order, swelling with load.
      const sub =
        (Math.sin(2 * Math.PI * this.rev) + 0.4 * Math.sin(4 * Math.PI * this.rev)) *
        p.sub *
        (0.3 + 0.7 * load) *
        0.22;

      const mix = body + (tone + cycle) * p.tonal * 0.35 + sub + crack * 0.5;
      const drive = 1.3 + load * 1.7 + rpm01 * 0.5;
      const shaped = Math.tanh(mix * drive) / Math.tanh(drive);
      const cutoff = p.cutoff[0] + p.cutoff[1] * (0.25 + 0.75 * load) * (0.3 + 0.7 * Math.min(1, rpm01));
      const a = 1 - Math.exp((-2 * Math.PI * Math.min(cutoff, sr * 0.45)) / sr);
      this.lp += (shaped - this.lp) * a;
      this.lp2 += (this.lp - this.lp2) * a;

      const y = this.lp2 - this.dcX + this.dcR * this.dcY;
      this.dcX = this.lp2;
      this.dcY = y;
      out[i] = y * p.gain;
    }
  }
}
`;

/** Worklet module: the DSP as an AudioWorkletProcessor (rpm/load parameters, profile by message). */
export const ENGINE_WORKLET_SOURCE = `${ENGINE_DSP_SOURCE}
class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "rpm", defaultValue: 1000, minValue: 200, maxValue: 20000, automationRate: "k-rate" },
      { name: "load", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }
  constructor(options) {
    super();
    this.dsp = new EngineDsp(sampleRate, options.processorOptions.profile);
    this.port.onmessage = (e) => this.dsp.setProfile(e.data);
  }
  process(_inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    this.dsp.process(out, out.length, parameters.rpm[0], parameters.load[0]);
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor("racing-engine", EngineProcessor);
`;

export type GearboxOutput = {
  rpm: number;
  load: number;
  gear: number;
  /** Shift that happened on this update. */
  shift: "up" | "down" | null;
};

/** Ignition cut of an upshift, and the throttle blip of a downshift (s). */
const UPSHIFT_CUT = 0.09;
const DOWNSHIFT_BLIP = 0.12;
/**
 * Minimum time in a gear before the next shift: short going up (the kart gains speed fast and
 * must not sit on the limiter), longer going down (no hunting between two gears).
 */
const UP_DWELL = 0.15;
const DOWN_DWELL = 0.35;

/**
 * Sequential gearbox and clutch feeding the engine sound: revs follow road speed in the current
 * gear, shifts happen at the profile's points with an ignition cut (upshift) or a throttle blip
 * (downshift). From a standstill the clutch slips and the engine holds launch revs.
 */
export class Gearbox {
  gear = 1;
  private cut = 0;
  private blip = 0;
  private dwell = 0;

  constructor(private profile: EngineProfile) {}

  setProfile(profile: EngineProfile) {
    this.profile = profile;
    this.gear = 1;
    this.cut = this.blip = this.dwell = 0;
  }

  /** Revs at this speed in a gear (no clutch slip). */
  wheelRpm(speed01: number, gear: number): number {
    const p = this.profile;
    return (Math.max(0, speed01) / p.gears[gear - 1]!) * p.redline;
  }

  update(dt: number, speed01: number, throttle: number): GearboxOutput {
    const p = this.profile;
    const top = p.gears.length;
    this.cut = Math.max(0, this.cut - dt);
    this.blip = Math.max(0, this.blip - dt);
    this.dwell = Math.max(0, this.dwell - dt);
    let shift: GearboxOutput["shift"] = null;

    if (this.dwell <= 0) {
      const wheel = this.wheelRpm(speed01, this.gear);
      if (this.gear < top && throttle > 0.2 && wheel > p.shiftUp * p.redline) {
        this.gear++;
        this.cut = UPSHIFT_CUT;
        this.dwell = UP_DWELL;
        shift = "up";
      } else if (
        this.gear > 1 &&
        wheel < p.shiftDown * p.redline &&
        this.wheelRpm(speed01, this.gear - 1) < p.shiftUp * p.redline * 0.95
      ) {
        this.gear--;
        this.blip = DOWNSHIFT_BLIP;
        this.dwell = DOWN_DWELL;
        shift = "down";
      }
    }

    const wheel = this.wheelRpm(speed01, this.gear);
    const clutch = p.idle * 1.25;
    let rpm: number;
    if (throttle > 0) rpm = Math.max(wheel, p.idle + throttle * (p.launch - p.idle));
    else rpm = wheel < clutch ? p.idle : wheel;
    if (this.blip > 0) rpm = Math.max(rpm, wheel * 1.08);
    rpm = Math.min(rpm, p.redline * 1.04);

    let load = throttle;
    if (this.cut > 0) load = 0;
    else if (this.blip > 0) load = Math.max(load, 0.65);
    return { rpm, load, gear: this.gear, shift };
  }
}
