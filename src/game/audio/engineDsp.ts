// Procedural kart engine: a single-cylinder two-stroke, the engine of a 125cc kart. It fires
// once per crank revolution, idles around 2 600 rpm and screams up to ~14 000 rpm (a 43–233 Hz
// firing rate), which is what separates a kart from a lawn mower's slow, steady four-stroke
// putter.
//
// Signal chain per firing: sharp exhaust pulse + band-passed combustion noise →
// three fixed body resonances (the "voice": they stay put while the firing rate sweeps under
// them) → expansion-chamber comb whose feedback swells in the mid/high revs ("coming on the
// pipe") → soft tanh saturation → throttle/rpm-tracking lowpass → DC blocker. Small cycle-to-cycle
// jitter in timing and strength keeps it from sounding like a loop; off throttle, weak and
// occasionally skipped firings give the characteristic two-stroke burble.
//
// The DSP is plain JavaScript source so the exact same code runs in the AudioWorklet (loaded
// from a Blob URL, no extra file to serve) and in unit tests under Node.

export const RPM_IDLE = 2600;
export const RPM_MAX = 14000;
/** Revs the engine holds while the centrifugal clutch slips at launch. */
const RPM_LAUNCH = 6400;
/** Below this the clutch disengages and the engine drops to idle. */
const RPM_CLUTCH = 4000;

export const ENGINE_DSP_SOURCE = /* js */ `
class KartEngineDsp {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.phase = 0;
    this.rpm = ${RPM_IDLE};
    this.load = 0;
    this.rpmK = 1 - Math.exp(-1 / (0.05 * sampleRate));
    this.loadK = 1 - Math.exp(-1 / (0.04 * sampleRate));
    this.cycleRate = 1;
    this.amp = 1;
    this.t = 1;
    this.seed = 1234567;
    // Body resonances (Chamberlin state-variable filters).
    this.fF = [420, 1180, 2650].map((f) => 2 * Math.sin(Math.PI * f / sampleRate));
    this.fQ = [0.32, 0.26, 0.22];
    this.fG = [1.0, 0.7, 0.42];
    this.low = [0, 0, 0];
    this.band = [0, 0, 0];
    // Noise band (rasp).
    this.nLow = 0;
    this.nBand = 0;
    // Expansion chamber comb.
    this.pipe = new Float32Array(2048);
    this.pipeIdx = 0;
    this.pipeLp = 0;
    this.pipeDelay = Math.min(2000, Math.max(8, Math.round(sampleRate * 0.0026)));
    // Intake: naive saw at the firing rate, lowpassed (the rate is low enough not to alias badly).
    this.sawLp = 0;
    this.sawK = 1 - Math.exp(-2 * Math.PI * 900 / sampleRate);
    // Output stages.
    this.lp = 0;
    this.lp2 = 0;
    this.dcX = 0;
    this.dcY = 0;
    this.dcR = 1 - 2 * Math.PI * 45 / sampleRate;
  }

  rand() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  process(out, n, targetRpm, targetLoad) {
    const sr = this.sr;
    for (let i = 0; i < n; i++) {
      this.rpm += (targetRpm - this.rpm) * this.rpmK;
      this.load += (targetLoad - this.load) * this.loadK;
      const rpm01 = Math.min(1, Math.max(0, (this.rpm - ${RPM_IDLE}) / (${RPM_MAX} - ${RPM_IDLE})));
      const load = this.load;

      this.phase += (this.rpm / 60 / sr) * this.cycleRate;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.t = 0;
        this.cycleRate = 1 + (this.rand() - 0.5) * 0.024;
        // Off throttle a two-stroke fires weakly and skips: the burble.
        const fuel = 0.25 + 0.75 * load;
        const skip = load < 0.15 && this.rand() < 0.12 * (1 - load / 0.15);
        this.amp = skip ? 0.15 : fuel * (0.9 + this.rand() * 0.2);
      }

      // Excitation: a sharp exhaust pulse and a short burst of combustion noise.
      const t = this.t;
      this.t += 1 / sr;
      const attack = Math.min(1, (t * sr) / 6);
      const pulse = this.amp * attack * Math.exp(-t / 0.0011);
      const white = this.rand() * 2 - 1;
      const burst = this.amp * Math.exp(-t / (0.0016 + 0.0012 * (1 - rpm01))) * white;

      // Rasp: noise band rising with rpm.
      const nf = 2 * Math.sin(Math.PI * Math.min(0.2, (1400 + 2600 * rpm01) / sr));
      this.nLow += nf * this.nBand;
      const nHigh = burst - this.nLow - 0.7 * this.nBand;
      this.nBand += nf * nHigh;
      const rasp = this.nBand * (0.5 + 0.7 * load);

      // Body resonances driven by the pulse (plus a little of the rasp).
      const excite = pulse * 1.6 + rasp * 0.35;
      let body = 0;
      for (let k = 0; k < 3; k++) {
        this.low[k] += this.fF[k] * this.band[k];
        const high = excite - this.low[k] - this.fQ[k] * this.band[k];
        this.band[k] += this.fF[k] * high;
        body += this.band[k] * this.fG[k];
      }

      // Intake hum: a soft saw at the firing rate gives the pitch some weight.
      this.sawLp += (this.phase * 2 - 1 - this.sawLp) * this.sawK;

      // Expansion chamber: feedback comb; feedback peaks around 9–12k rpm ("on the pipe").
      const onPipe = Math.exp(-Math.pow((rpm01 - 0.72) / 0.28, 2));
      let read = this.pipeIdx - this.pipeDelay;
      if (read < 0) read += this.pipe.length;
      this.pipeLp += (this.pipe[read] - this.pipeLp) * 0.35;
      const mix = body + this.sawLp * (0.12 + 0.1 * load) + rasp * 0.25;
      this.pipe[this.pipeIdx] = mix + this.pipeLp * (0.25 + 0.4 * onPipe);
      this.pipeIdx = (this.pipeIdx + 1) % this.pipe.length;
      const piped = mix + this.pipeLp * (0.5 + 0.4 * onPipe);

      // Saturation and tone.
      const drive = 1.4 + load * 1.6 + onPipe * 0.6;
      const shaped = Math.tanh(piped * drive) / Math.tanh(drive);
      const cutoff = 1500 + 5200 * (0.25 + 0.75 * load) * (0.35 + 0.65 * rpm01);
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
      this.lp += (shaped - this.lp) * a;
      this.lp2 += (this.lp - this.lp2) * a;

      // DC blocker (also trims the lowest boom).
      const y = this.lp2 - this.dcX + this.dcR * this.dcY;
      this.dcX = this.lp2;
      this.dcY = y;
      out[i] = y * 0.55;
    }
  }
}
`;

/** Worklet module: wraps the DSP in an AudioWorkletProcessor with rpm/load parameters. */
export const ENGINE_WORKLET_SOURCE = `${ENGINE_DSP_SOURCE}
class KartEngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "rpm", defaultValue: ${RPM_IDLE}, minValue: 500, maxValue: 20000, automationRate: "k-rate" },
      { name: "load", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }
  constructor() {
    super();
    this.dsp = new KartEngineDsp(sampleRate);
  }
  process(_inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    this.dsp.process(out, out.length, parameters.rpm[0], parameters.load[0]);
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor("kart-engine", KartEngineProcessor);
`;

/**
 * Gearless kart drivetrain: a centrifugal clutch, then revs locked to road speed. From a
 * standstill the clutch slips and the engine holds launch revs until the kart catches up.
 */
export function engineRpm(speed01: number, throttle: number): number {
  const wheelRpm = 3400 + Math.min(1.08, Math.max(0, speed01)) * (RPM_MAX - 3400);
  if (throttle > 0) return Math.max(wheelRpm, RPM_IDLE + throttle * (RPM_LAUNCH - RPM_IDLE));
  // Coasting: engine braking keeps it locked to the wheels until the clutch lets go.
  return wheelRpm < RPM_CLUTCH ? RPM_IDLE : wheelRpm;
}
