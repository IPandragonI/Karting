// Procedural sound with WebAudio, no files to download:
// - engine: two detuned oscillators through a lowpass, pitch from speed, a fast tremolo for the
//   buzzy two-stroke character, louder on throttle;
// - tire squeal: looped noise through a resonant bandpass, gain from slip;
// - grass rumble: low-passed noise while off track;
// - impacts and UI beeps: short synthesized one-shots.
// The context is created on the first user gesture (browsers block audio before that).

const MUTE_KEY = "karting:muted";

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineOsc: OscillatorNode[] = [];
  private engineFilter: BiquadFilterNode | null = null;
  private tremolo: OscillatorNode | null = null;
  private squealGain: GainNode | null = null;
  private squealFilter: BiquadFilterNode | null = null;
  private rumbleGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastImpact = 0;
  muted: boolean;

  constructor() {
    let muted = false;
    try {
      muted = localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      // Storage unavailable (private mode): default to sound on.
    }
    this.muted = muted;
  }

  /** Call from a user gesture handler. Safe to call repeatedly. */
  unlock() {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.build(this.ctx);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private build(ctx: AudioContext) {
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    this.master.connect(ctx.destination);

    // White noise buffer shared by squeal, rumble and impacts.
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // Engine.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 700;
    this.engineFilter.Q.value = 2;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    const tremoloDepth = ctx.createGain();
    tremoloDepth.gain.value = 0.35;
    const tremoloGain = ctx.createGain();
    tremoloGain.gain.value = 0.65;
    this.tremolo = ctx.createOscillator();
    this.tremolo.type = "square";
    this.tremolo.frequency.value = 30;
    this.tremolo.connect(tremoloDepth).connect(tremoloGain.gain);
    for (const [type, detune] of [
      ["sawtooth", 0],
      ["square", -1200],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 60;
      o.detune.value = detune;
      o.connect(this.engineFilter);
      o.start();
      this.engineOsc.push(o);
    }
    this.engineFilter.connect(tremoloGain).connect(this.engineGain).connect(this.master);
    this.tremolo.start();

    // Tire squeal.
    const squealSrc = ctx.createBufferSource();
    squealSrc.buffer = this.noise;
    squealSrc.loop = true;
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = "bandpass";
    this.squealFilter.frequency.value = 1700;
    this.squealFilter.Q.value = 7;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    squealSrc.connect(this.squealFilter).connect(this.squealGain).connect(this.master);
    squealSrc.start();

    // Grass rumble.
    const rumbleSrc = ctx.createBufferSource();
    rumbleSrc.buffer = this.noise;
    rumbleSrc.loop = true;
    rumbleSrc.playbackRate.value = 0.5;
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = "lowpass";
    rumbleFilter.frequency.value = 260;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    rumbleSrc.connect(rumbleFilter).connect(this.rumbleGain).connect(this.master);
    rumbleSrc.start();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      // Not persisted; the toggle still works for this session.
    }
    if (this.ctx && this.master)
      this.master.gain.setTargetAtTime(muted ? 0 : 0.7, this.ctx.currentTime, 0.05);
  }

  /**
   * Continuous sounds, called every frame. `speed01` is |speed| / max speed.
   * Pass `active = false` in menus and pauses to fade everything out.
   */
  update(active: boolean, speed01: number, throttle: number, slip: number, offTrack: number) {
    const ctx = this.ctx;
    if (
      !ctx ||
      !this.engineGain ||
      !this.engineFilter ||
      !this.tremolo ||
      !this.squealGain ||
      !this.rumbleGain
    )
      return;
    const t = ctx.currentTime;
    const s = Math.min(1, speed01);
    const freq = 55 + s * 150 + throttle * 12;
    for (const o of this.engineOsc) o.frequency.setTargetAtTime(freq, t, 0.06);
    this.tremolo.frequency.setTargetAtTime(freq * 0.5, t, 0.06);
    this.engineFilter.frequency.setTargetAtTime(500 + s * 1500 + throttle * 600, t, 0.08);
    this.engineGain.gain.setTargetAtTime(active ? 0.07 + throttle * 0.06 + s * 0.04 : 0, t, 0.1);
    this.squealGain.gain.setTargetAtTime(active ? Math.min(1, slip) * 0.16 : 0, t, 0.05);
    this.squealFilter!.frequency.setTargetAtTime(1500 + slip * 500, t, 0.1);
    this.rumbleGain.gain.setTargetAtTime(active ? offTrack * Math.min(1, s * 2) * 0.5 : 0, t, 0.08);
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
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(110, now);
    thump.frequency.exponentialRampToValueAtTime(45, now + 0.15);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.4 * v, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    thump.connect(tg).connect(this.master);
    thump.start(now);
    thump.stop(now + 0.2);
  }

  beep(kind: "count" | "go" | "lap" | "best" | "finish" | "error") {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const notes: Record<typeof kind, [number, number][]> = {
      count: [[440, 0.15]],
      go: [[880, 0.45]],
      lap: [
        [660, 0.1],
        [880, 0.16],
      ],
      best: [
        [660, 0.09],
        [880, 0.09],
        [1320, 0.22],
      ],
      finish: [
        [523, 0.12],
        [659, 0.12],
        [784, 0.12],
        [1047, 0.4],
      ],
      error: [
        [220, 0.12],
        [180, 0.2],
      ],
    };
    let t = ctx.currentTime;
    for (const [freq, dur] of notes[kind]) {
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
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
