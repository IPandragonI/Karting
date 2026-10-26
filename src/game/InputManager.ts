import type { KartInput } from "./Vehicle";

// Keyboard, on-screen touch controls and gamepad, merged into one KartInput each frame.
// Discrete actions (reset, camera, ghost, pause) are delivered as callbacks on key press.
//
// Keyboard bindings are data: every bindable action has two key slots (physical key codes, so
// they follow key positions, not layouts). Held actions are derived from the set of keys
// physically down, never latched per action, so rebinding a key or losing focus cannot leave an
// input stuck. While a key is being captured for remapping, the game sees no keyboard input.

export type InputAction = "reset" | "pause" | "camera" | "ghost";
export type TouchControl = "left" | "right" | "gas" | "brake" | "drift";

export type BindableAction =
  "accelerate" | "brake" | "left" | "right" | "drift" | "reset" | "camera" | "ghost";

export const BINDABLE_ACTIONS: { id: BindableAction; label: string }[] = [
  { id: "accelerate", label: "Accelerate" },
  { id: "brake", label: "Brake / reverse" },
  { id: "left", label: "Steer left" },
  { id: "right", label: "Steer right" },
  { id: "drift", label: "Handbrake / drift" },
  { id: "reset", label: "Reset onto the track" },
  { id: "camera", label: "Change camera" },
  { id: "ghost", label: "Show / hide ghost" },
];

/** Two key slots per action (null: empty). */
export type Bindings = Record<BindableAction, [string | null, string | null]>;

export const DEFAULT_BINDINGS: Bindings = {
  accelerate: ["KeyW", "ArrowUp"],
  brake: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  drift: ["Space", null],
  reset: ["KeyR", null],
  camera: ["KeyC", null],
  ghost: ["KeyG", null],
};

/** Keys that keep their job: menu (Escape), performance overlay (F3), focus navigation (Tab). */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(["Escape", "F3", "Tab"]);

const HOLD_ACTIONS = ["accelerate", "brake", "left", "right", "drift"] as const;
const PRESS_ACTIONS = ["reset", "camera", "ghost"] as const;

export function cloneBindings(b: Bindings): Bindings {
  const out = {} as Bindings;
  for (const { id } of BINDABLE_ACTIONS) out[id] = [b[id][0], b[id][1]];
  return out;
}

/** Validates stored bindings; anything unusable falls back to the default for that action. */
export function parseBindings(text: string | null): Bindings {
  const out = cloneBindings(DEFAULT_BINDINGS);
  if (!text) return out;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const seen = new Set<string>();
    for (const { id } of BINDABLE_ACTIONS) {
      const v = raw[id];
      if (!Array.isArray(v) || v.length !== 2) continue;
      const slots = v.map((c) =>
        typeof c === "string" && /^[A-Za-z0-9]{1,24}$/.test(c) && !RESERVED_KEYS.has(c) ? c : null,
      ) as [string | null, string | null];
      // A key bound twice (hand-edited storage) only keeps its first use.
      for (let i = 0; i < 2; i++) {
        const c = slots[i];
        if (c && seen.has(c)) slots[i] = null;
        else if (c) seen.add(c);
      }
      out[id] = slots;
    }
  } catch {
    // Corrupt entry: defaults.
  }
  return out;
}

/**
 * Binds `code` to one slot of an action. A key does one thing only: if another action used it,
 * it is taken from there and that action is reported (`displaced`), so the UI can say so.
 */
export function assignKey(
  bindings: Bindings,
  action: BindableAction,
  slot: 0 | 1,
  code: string | null,
): { bindings: Bindings; displaced: BindableAction | null } {
  const next = cloneBindings(bindings);
  let displaced: BindableAction | null = null;
  if (code) {
    for (const { id } of BINDABLE_ACTIONS) {
      for (const k of [0, 1] as const) {
        if (next[id][k] === code && !(id === action && k === slot)) {
          next[id][k] = null;
          if (id !== action) displaced = id;
        }
      }
    }
  }
  next[action][slot] = code;
  return { bindings: next, displaced };
}

const KEY_NAMES: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Space: "Space",
  Enter: "Enter",
  Backspace: "Backspace",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  ControlLeft: "Left Ctrl",
  ControlRight: "Right Ctrl",
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  CapsLock: "Caps Lock",
};

/** Readable name of a key code, from the keyboard layout when the browser exposes it. */
export function keyLabel(code: string | null, layout?: Map<string, string> | null): string {
  if (!code) return "—";
  const fromLayout = layout?.get(code);
  if (fromLayout && fromLayout.trim()) return fromLayout.toUpperCase();
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}

/** True when the event comes from somewhere the user types (inputs, textareas, editable). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export class InputManager {
  private bindings: Bindings = cloneBindings(DEFAULT_BINDINGS);
  /** Key code → actions it triggers (rebuilt when bindings change). */
  private byCode = new Map<string, BindableAction[]>();
  /** Keys physically down (only bound ones are tracked). */
  private readonly pressed = new Set<string>();
  private touch = { left: false, right: false, gas: false, brake: false, drift: false };
  private readonly output: KartInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  /** When false, game keys are not captured (menus, editor) and the page behaves normally. */
  enabled = false;
  onAction: (action: InputAction) => void = () => {};
  /** Remapping: the next key press goes here instead of the game (Escape cancels with null). */
  private capture: ((code: string | null) => void) | null = null;

  constructor() {
    this.setBindings(DEFAULT_BINDINGS);
  }

  setBindings(bindings: Bindings) {
    this.bindings = cloneBindings(bindings);
    this.byCode.clear();
    for (const { id } of BINDABLE_ACTIONS) {
      for (const code of this.bindings[id]) {
        if (!code) continue;
        const list = this.byCode.get(code) ?? [];
        list.push(id);
        this.byCode.set(code, list);
      }
    }
    this.pressed.clear();
  }

  getBindings(): Bindings {
    return cloneBindings(this.bindings);
  }

  /** Waits for one key press (for remapping); the game ignores the keyboard meanwhile. */
  captureKey(callback: (code: string | null) => void) {
    this.pressed.clear();
    this.capture = callback;
  }

  cancelCapture() {
    this.capture = null;
  }

  get capturing() {
    return this.capture !== null;
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (this.capture) {
      // Swallow everything while capturing: no menu toggle, no driving, no page scrolling.
      e.preventDefault();
      e.stopPropagation();
      const done = this.capture;
      this.capture = null;
      done(e.code === "Escape" ? null : e.code);
      return;
    }
    if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Escape") {
      // Escape closes an open dialog (the browser does it); it must not also toggle the pause.
      if (!document.querySelector("dialog[open]")) this.onAction("pause");
      return;
    }
    if (!this.enabled) return;
    const actions = this.byCode.get(e.code);
    if (!actions) return;
    this.pressed.add(e.code);
    if (actions.some((a) => (HOLD_ACTIONS as readonly string[]).includes(a))) {
      // Stop arrows and space from scrolling the page or pressing a focused button.
      e.preventDefault();
    }
    if (!e.repeat) {
      for (const a of actions) {
        if ((PRESS_ACTIONS as readonly string[]).includes(a)) this.onAction(a as InputAction);
      }
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.pressed.delete(e.code);
  };

  private readonly onBlur = () => this.clear();

  attach() {
    // Capture phase: a key being captured for remapping never reaches other handlers.
    window.addEventListener("keydown", this.onKeyDown, { capture: true });
    window.addEventListener("keyup", this.onKeyUp, { capture: true });
    window.addEventListener("blur", this.onBlur);
  }

  detach() {
    window.removeEventListener("keydown", this.onKeyDown, { capture: true });
    window.removeEventListener("keyup", this.onKeyUp, { capture: true });
    window.removeEventListener("blur", this.onBlur);
  }

  setTouch(control: TouchControl, pressed: boolean) {
    this.touch[control] = pressed;
  }

  clear() {
    this.pressed.clear();
    for (const k of Object.keys(this.touch) as TouchControl[]) this.touch[k] = false;
  }

  /** True while any driving input is active (used to start the clock in free drive, hints…). */
  get active() {
    const o = this.output;
    return o.throttle > 0 || o.brake > 0 || o.steer !== 0 || o.handbrake;
  }

  private held(action: (typeof HOLD_ACTIONS)[number]): boolean {
    const [a, b] = this.bindings[action];
    return (a !== null && this.pressed.has(a)) || (b !== null && this.pressed.has(b));
  }

  read(): KartInput {
    const t = this.touch;
    let steer = (this.held("right") || t.right ? 1 : 0) - (this.held("left") || t.left ? 1 : 0);
    let throttle = this.held("accelerate") || t.gas ? 1 : 0;
    let brake = this.held("brake") || t.brake ? 1 : 0;
    let handbrake = this.held("drift") || t.drift;

    const pads =
      typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const x = pad.axes[0] ?? 0;
      if (Math.abs(x) > 0.15) steer = Math.max(-1, Math.min(1, steer + x));
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0, pad.buttons[0]?.pressed ? 1 : 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0, pad.buttons[1]?.pressed ? 1 : 0);
      handbrake ||= Boolean(pad.buttons[2]?.pressed || pad.buttons[5]?.pressed);
    }

    if (!this.enabled) {
      steer = 0;
      throttle = 0;
      brake = 0;
      handbrake = false;
    }
    this.output.steer = steer;
    this.output.throttle = throttle;
    this.output.brake = brake;
    this.output.handbrake = handbrake;
    return this.output;
  }
}
