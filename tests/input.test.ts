import { describe, expect, it } from "vitest";
import {
  assignKey,
  DEFAULT_BINDINGS,
  InputManager,
  keyLabel,
  parseBindings,
} from "@/game/InputManager";

/** Drives the manager's (private) key handlers the way window events would. */
function key(m: InputManager, type: "down" | "up", code: string, repeat = false) {
  const handler = (m as unknown as Record<string, (e: Partial<KeyboardEvent>) => void>)[
    type === "down" ? "onKeyDown" : "onKeyUp"
  ]!;
  handler({ code, repeat, target: null, preventDefault() {}, stopPropagation() {} });
}

describe("key bindings", () => {
  it("falls back to defaults for missing, corrupt or reserved entries", () => {
    expect(parseBindings(null)).toEqual(DEFAULT_BINDINGS);
    expect(parseBindings("{nope")).toEqual(DEFAULT_BINDINGS);
    const b = parseBindings(
      JSON.stringify({
        accelerate: ["KeyI", null],
        brake: ["Escape", "KeyK"],
        left: "KeyJ",
        right: ["KeyI", "KeyL"],
        drift: ["<script>", null],
      }),
    );
    expect(b.accelerate).toEqual(["KeyI", null]);
    // Reserved key dropped; malformed entry keeps the default.
    expect(b.brake).toEqual([null, "KeyK"]);
    expect(b.left).toEqual(DEFAULT_BINDINGS.left);
    // A key used twice keeps its first use only.
    expect(b.right).toEqual([null, "KeyL"]);
    expect(b.drift).toEqual([null, null]);
  });

  it("moves a key that is already used and reports the action that lost it", () => {
    const { bindings, displaced } = assignKey(DEFAULT_BINDINGS, "brake", 1, "KeyW");
    expect(displaced).toBe("accelerate");
    expect(bindings.brake).toEqual(["KeyS", "KeyW"]);
    expect(bindings.accelerate).toEqual([null, "ArrowUp"]);
    // Defaults are untouched (pure).
    expect(DEFAULT_BINDINGS.accelerate).toEqual(["KeyW", "ArrowUp"]);
    // Moving a key between the two slots of one action is not a conflict.
    const same = assignKey(DEFAULT_BINDINGS, "accelerate", 1, "KeyW");
    expect(same.displaced).toBeNull();
    expect(same.bindings.accelerate).toEqual([null, "KeyW"]);
    // Clearing a slot.
    expect(assignKey(DEFAULT_BINDINGS, "drift", 0, null).bindings.drift).toEqual([null, null]);
  });

  it("names keys for people, using the keyboard layout when available", () => {
    expect(keyLabel("KeyW")).toBe("W");
    expect(keyLabel("ArrowLeft")).toBe("←");
    expect(keyLabel("Digit3")).toBe("3");
    expect(keyLabel(null)).toBe("—");
    expect(keyLabel("KeyW", new Map([["KeyW", "z"]]))).toBe("Z");
  });

  it("drives with the bound keys and never leaves an input stuck after rebinding", () => {
    const m = new InputManager();
    m.enabled = true;
    key(m, "down", "KeyW");
    expect(m.read().throttle).toBe(1);
    // Rebinding while the key is held releases it.
    m.setBindings(assignKey(DEFAULT_BINDINGS, "accelerate", 0, "KeyI").bindings);
    expect(m.read().throttle).toBe(0);
    key(m, "down", "KeyI");
    key(m, "down", "ArrowLeft");
    expect(m.read()).toMatchObject({ throttle: 1, steer: -1 });
    key(m, "up", "KeyI");
    expect(m.read().throttle).toBe(0);
    // Losing focus releases everything.
    m.clear();
    expect(m.read().steer).toBe(0);
  });

  it("delivers presses once, and swallows the key being captured for remapping", () => {
    const m = new InputManager();
    m.enabled = true;
    const actions: string[] = [];
    m.onAction = (a) => actions.push(a);
    key(m, "down", "KeyC");
    key(m, "down", "KeyC", true);
    key(m, "down", "KeyG");
    expect(actions).toEqual(["camera", "ghost"]);
    let captured: string | null | undefined;
    m.captureKey((c) => (captured = c));
    key(m, "down", "KeyW");
    expect(captured).toBe("KeyW");
    // The captured key did not drive the kart or trigger anything.
    expect(m.read().throttle).toBe(0);
    m.captureKey((c) => (captured = c));
    key(m, "down", "Escape");
    expect(captured).toBeNull();
    expect(actions).toEqual(["camera", "ghost"]);
  });
});
