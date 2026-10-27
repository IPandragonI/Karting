import {
  ENGINE_WORKLET_SOURCE,
  ENGINES,
  Gearbox,
  type EngineId,
  type EngineProfile,
} from "./audio/engineDsp";

// Procedural sound with Web Audio, no files to download:
// - engine: a racing engine synthesized in an AudioWorklet (see audio/engineDsp.ts), voiced per
//   vehicle (F1 V10, kart, V8, diesel); revs come from a sequential gearbox with ignition-cut
//   upshifts and blipped downshifts; a simple oscillator engine is the fallback where
//   AudioWorklet is unavailable;
// - tires: squeal while sliding (with a slight wobble so it never sounds static) and a duller
//   scrub under hard braking;
// - wind rising with speed, grass rumble off track, impacts and lap chimes.
//
// Browsers only start audio after a user gesture: `unlock()` is called on the first key press,
// click or touch anywhere, and `onStateChange` lets the HUD offer a "tap to enable sound" hint
// until then.

const MUTE_KEY = "karting:muted";
const VOLUME_KEY = "karting:volume";
const MASTER = 0.8;
export const DEFAULT_VOLUME = 0.8;

export type AudioState = "locked" | "running";

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineNode: AudioWorkletNode | null = null;
  private rpmParam: AudioParam | null = null;
  private loadParam: AudioParam | null = null;
  private fallback: { osc: OscillatorNode[]; filter: BiquadFilterNode } | null = null;
  private squealGain: GainNode | null = null;
  private squealFilter: BiquadFilterNode | null = null;
  private scrubGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private rumbleGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastImpact = 0;
  private profile: EngineProfile = ENGINES.f1;
  private readonly gearbox = new Gearbox(this.profile);
  private rpm: number = ENGINES.f1.idle;
  private load = 0;
  /** Time left of the fast rev change after a shift (s). */
  private shiftTime = 0;
  private wobble = 0;
  muted: boolean;
  /** Master volume, 0..1 (independent of mute). */
  volume = DEFAULT_VOLUME;
  onStateChange: (state: AudioState) => void = () => {};

  constructor() {
    let muted = false;
    try {
      muted = localStorage.getItem(MUTE_KEY) === "1";
      const v = Number(localStorage.getItem(VOLUME_KEY) ?? NaN);
      if (Number.isFinite(v) && v >= 0 && v <= 1) this.volume = v;
    } catch {
      // Storage unavailable (private mode): default to sound on.
    }
    this.muted = muted;
  }

  /** Gear engaged in the gearbox model (runs even before audio is unlocked). */
  get gear(): number {
    return this.gearbox.gear;
  }

  get gears(): number {
    return this.profile.gears.length;
  }

  /** Engine voice and gearbox of the selected vehicle. */
  setEngine(id: EngineId) {
    const profile: EngineProfile = ENGINES[id];
    if (profile === this.profile) return;
    this.profile = profile;
    this.gearbox.setProfile(profile);
    this.rpm = profile.idle;
    this.engineNode?.port.postMessage(profile);
  }

  get state(): AudioState {
    return this.ctx?.state === "running" ? "running" : "locked";
  }

  /** Call from a user gesture handler. Safe to call repeatedly. */
  unlock() {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.ctx.addEventListener("statechange", () => this.onStateChange(this.state));
      this.build(this.ctx);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private loopNoise(ctx: AudioContext, rate = 1) {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(0, Math.random() * 1.5);
    return src;
  }

  private build(ctx: AudioContext) {
    this.master = ctx.createGain();
    this.master.gain.value = this.masterGain();
    // Gentle bus compression keeps impacts and the engine from jumping out.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // Engine (worklet, or oscillator fallback).
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(this.master);
    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(
        new Blob([ENGINE_WORKLET_SOURCE], { type: "text/javascript" }),
      );
      ctx.audioWorklet
        .addModule(url)
        .then(() => {
          if (!this.engineGain) return;
          const node = new AudioWorkletNode(ctx, "racing-engine", {
            outputChannelCount: [1],
            processorOptions: { profile: this.profile },
          });
          node.connect(this.engineGain);
          this.engineNode = node;
          this.rpmParam = node.parameters.get("rpm") ?? null;
          this.loadParam = node.parameters.get("load") ?? null;
        })
        .catch((err) => {
          console.warn("Engine worklet unavailable, using the simple engine sound.", err);
          this.buildFallbackEngine(ctx);
        })
        .finally(() => URL.revokeObjectURL(url));
    } else {
      this.buildFallbackEngine(ctx);
    }

    // Tire squeal: noise through a resonant bandpass.
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = "bandpass";
    this.squealFilter.frequency.value = 1900;
    this.squealFilter.Q.value = 9;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.loopNoise(ctx).connect(this.squealFilter).connect(this.squealGain).connect(this.master);

    // Braking scrub: lower, wider band.
    const scrubFilter = ctx.createBiquadFilter();
    scrubFilter.type = "bandpass";
    scrubFilter.frequency.value = 650;
    scrubFilter.Q.value = 1.2;
    this.scrubGain = ctx.createGain();
    this.scrubGain.gain.value = 0;
    this.loopNoise(ctx, 0.8).connect(scrubFilter).connect(this.scrubGain).connect(this.master);

    // Wind.
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "lowpass";
    this.windFilter.frequency.value = 400;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.loopNoise(ctx, 0.6).connect(this.windFilter).connect(this.windGain).connect(this.master);

    // Grass rumble.
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = "lowpass";
    rumbleFilter.frequency.value = 240;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.loopNoise(ctx, 0.5).connect(rumbleFilter).connect(this.rumbleGain).connect(this.master);
  }

  /** Plain oscillators: much less convincing, only for browsers without AudioWorklet. */
  private buildFallbackEngine(ctx: AudioContext) {
    if (!this.engineGain || this.fallback) return;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1200;
    const osc = (["sawtooth", "square"] as const).map((type, i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = this.firing(this.rpm);
      o.detune.value = i * 7;
      o.connect(filter);
      o.start();
      return o;
    });
    const trim = ctx.createGain();
    trim.gain.value = 0.25;
    filter.connect(trim).connect(this.engineGain);
    this.fallback = { osc, filter };
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      // Not persisted; the toggle still works for this session.
    }
    this.applyMaster();
  }

  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume));
    try {
      localStorage.setItem(VOLUME_KEY, String(this.volume));
    } catch {
      // Not persisted; applies for this session.
    }
    this.applyMaster();
  }

  /** Perceptual curve: the slider's middle sounds like half as loud, not barely quieter. */
  private masterGain() {
    return this.muted ? 0 : MASTER * this.volume * this.volume * 1.5625;
  }

  private applyMaster() {
    if (this.ctx && this.master)
      this.master.gain.setTargetAtTime(this.masterGain(), this.ctx.currentTime, 0.05);
  }

  /** Firing rate of the engine at some revs (Hz): the pitch the fallback oscillators play. */
  private firing(rpm: number) {
    return (rpm / 60) * (this.profile.cylinders / 2);
  }

  /** Short mechanical click of a gear going in. */
  private clunk(strength: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1800;
    filter.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05 * strength, now);
    g.gain.exponentialRampToValueAtTime(0.0005, now + 0.04);
    src.connect(filter).connect(g).connect(this.master);
    src.start(now, Math.random());
    src.stop(now + 0.05);
  }

  /**
   * Continuous sounds, called every rendered frame. `speed01` is |forward speed| / max speed,
   * `accel01` the forward acceleration as a share of full throttle's (engine strain).
   * Pass `active = false` while paused or editing to fade everything out.
   */
  update(
    dt: number,
    active: boolean,
    speed01: number,
    throttle: number,
    slip: number,
    braking: number,
    offTrack: boolean,
    accel01 = 0,
  ) {
    const s = Math.min(1, Math.max(0, speed01));
    // The gearbox runs whatever the audio state, so the HUD's gear is always right.
    const box = this.gearbox.update(dt, s, active ? throttle : 0);
    if (box.shift) this.shiftTime = box.shift === "up" ? 0.1 : 0.14;
    else this.shiftTime = Math.max(0, this.shiftTime - dt);
    const ctx = this.ctx;
    if (
      !ctx ||
      !this.engineGain ||
      !this.squealGain ||
      !this.scrubGain ||
      !this.windGain ||
      !this.rumbleGain
    )
      return;
    const t = ctx.currentTime;
    if (box.shift && active) this.clunk(box.shift === "up" ? 1 : 0.6);

    // Revs: quick to rise on throttle, slower to fall (rotating mass), and snapping to the new
    // gear's revs during a shift (the clutchless gearbox takes a few hundredths of a second).
    const rate = this.shiftTime > 0 ? 30 : box.rpm > this.rpm ? 5 + throttle * 6 : 3.5;
    this.rpm += (box.rpm - this.rpm) * (1 - Math.exp(-rate * dt));
    const loadRate = this.shiftTime > 0 ? 45 : 12;
    this.load += (box.load - this.load) * (1 - Math.exp(-loadRate * dt));
    if (this.rpmParam && this.loadParam) {
      this.rpmParam.setTargetAtTime(this.rpm, t, 0.012);
      this.loadParam.setTargetAtTime(this.load, t, 0.012);
    } else if (this.fallback) {
      for (const o of this.fallback.osc)
        o.frequency.setTargetAtTime(this.firing(this.rpm), t, 0.03);
      this.fallback.filter.frequency.setTargetAtTime(600 + this.load * 1400 + s * 800, t, 0.05);
    }
    const strain = Math.min(1, Math.max(0, accel01));
    this.engineGain.gain.setTargetAtTime(
      active ? 0.5 + 0.28 * this.load + 0.14 * s + 0.1 * strain : 0,
      t,
      0.06,
    );

    this.wobble += dt * 7;
    const squeal = Math.pow(Math.min(1, slip), 1.4);
    this.squealGain.gain.setTargetAtTime(active ? squeal * 0.13 : 0, t, 0.05);
    this.squealFilter!.frequency.setTargetAtTime(
      1700 + squeal * 450 + Math.sin(this.wobble) * 70,
      t,
      0.04,
    );
    this.scrubGain.gain.setTargetAtTime(active ? Math.min(1, braking) * s * 0.18 : 0, t, 0.06);
    this.windGain.gain.setTargetAtTime(active ? s * s * 0.09 : 0, t, 0.2);
    this.windFilter!.frequency.setTargetAtTime(300 + s * 900, t, 0.2);
    this.rumbleGain.gain.setTargetAtTime(
      active && offTrack ? Math.min(1, s * 2) * 0.45 : 0,
      t,
      0.08,
    );
  }

  impact(strength: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const now = ctx.currentTime;
    if (now - this.lastImpact < 0.12) return;
    this.lastImpact = now;
    const v = Math.min(1, strength / 15);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 500 + v * 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * v + 0.08, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    src.connect(filter).connect(g).connect(this.master);
    src.start(now, Math.random());
    src.stop(now + 0.3);
    // Rubbery thump of the tire barrier.
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(110, now);
    thump.frequency.exponentialRampToValueAtTime(45, now + 0.15);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.45 * v, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    thump.connect(tg).connect(this.master);
    thump.start(now);
    thump.stop(now + 0.2);
  }

  beep(kind: "lap" | "best" | "error") {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const notes: Record<typeof kind, [number, number][]> = {
      lap: [
        [784, 0.09],
        [1047, 0.16],
      ],
      best: [
        [784, 0.08],
        [1047, 0.08],
        [1568, 0.24],
      ],
      error: [
        [330, 0.1],
        [262, 0.18],
      ],
    };
    let t = ctx.currentTime;
    for (const [freq, dur] of notes[kind]) {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + dur + 0.02);
      t += dur * 0.9;
    }
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
