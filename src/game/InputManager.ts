import type { KartInput } from "./Vehicle";

// Keyboard, on-screen touch controls and gamepad, merged into one KartInput each frame.
// Discrete actions (reset, pause) are delivered as callbacks on key press.

export type InputAction = "reset" | "pause";
export type TouchControl = "left" | "right" | "gas" | "brake" | "drift";

const KEY_BINDINGS: Record<string, keyof typeof EMPTY_HELD> = {
  KeyW: "up",
  ArrowUp: "up",
  KeyS: "down",
  ArrowDown: "down",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  Space: "drift",
};

const EMPTY_HELD = { up: false, down: false, left: false, right: false, drift: false };

/** True when the event comes from somewhere the user types (inputs, textareas, editable). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export class InputManager {
  private held = { ...EMPTY_HELD };
  private touch = { left: false, right: false, gas: false, brake: false, drift: false };
  private readonly output: KartInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  /** When false, game keys are not captured (menus, editor) and the page behaves normally. */
  enabled = false;
  onAction: (action: InputAction) => void = () => {};

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Escape") {
      this.onAction("pause");
      return;
    }
    if (!this.enabled) return;
    const binding = KEY_BINDINGS[e.code];
    if (binding) {
      this.held[binding] = true;
      // Stop arrows and space from scrolling the page or pressing a focused button.
      e.preventDefault();
    } else if (e.code === "KeyR" && !e.repeat) {
      this.onAction("reset");
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    const binding = KEY_BINDINGS[e.code];
    if (binding) this.held[binding] = false;
  };

  private readonly onBlur = () => this.clear();

  attach() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  detach() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
  }

  setTouch(control: TouchControl, pressed: boolean) {
    this.touch[control] = pressed;
  }

  clear() {
    this.held = { ...EMPTY_HELD };
    for (const k of Object.keys(this.touch) as TouchControl[]) this.touch[k] = false;
  }

  /** True while any driving input is active (used to start the clock in free drive, hints…). */
  get active() {
    const o = this.output;
    return o.throttle > 0 || o.brake > 0 || o.steer !== 0 || o.handbrake;
  }

  read(): KartInput {
    const h = this.held;
    const t = this.touch;
    let steer = (h.right || t.right ? 1 : 0) - (h.left || t.left ? 1 : 0);
    let throttle = h.up || t.gas ? 1 : 0;
    let brake = h.down || t.brake ? 1 : 0;
    let handbrake = h.drift || t.drift;

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
