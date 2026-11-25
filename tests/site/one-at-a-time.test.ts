import { describe, expect, it } from "vitest";
import { buttonState, createGate } from "@/components/useOneAtATime";
import { lostFocus } from "@/components/useFocusFallback";

/** A promise and its resolve. */
function later<T>() {
  let resolve!: (v: T) => void;
  return { promise: new Promise<T>((r) => (resolve = r)), resolve };
}

describe("one action at a time (UX-M2)", () => {
  // Fails if a second press sends a second request while the first works (the button is aria-disabled, so it can be pressed), or no press works after it.
  it("ignores an action while one works, and takes the next one after it", async () => {
    const busy: (string | null)[] = [];
    const run = createGate((key) => busy.push(key));
    const first = later<void>();
    const ran: string[] = [];
    const done = run("a", () => (ran.push("a"), first.promise));
    await run("b", async () => void ran.push("b"));
    expect(ran).toEqual(["a"]);
    first.resolve();
    await done;
    await run("c", async () => void ran.push("c"));
    expect(ran).toEqual(["a", "c"]);
    expect(busy).toEqual(["a", null, "c", null]);
  });

  // Fails if a page that is leaving (to checkout) takes another press, or a failed action locks the buttons.
  it("stays busy when the page leaves, and opens again after an error", async () => {
    const busy: (string | null)[] = [];
    const run = createGate((key) => busy.push(key));
    await expect(run("a", () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await run("b", async () => "leaving");
    await run("c", async () => undefined);
    expect(busy).toEqual(["a", null, "b"]);
  });

  // Fails if a working button is really disabled (it would drop the keyboard focus), or a button before hydration is not.
  it("a button is disabled only before hydration", () => {
    expect(buttonState(false, false)).toEqual({ disabled: true, "aria-disabled": undefined });
    expect(buttonState(true, true)).toEqual({ disabled: false, "aria-disabled": true });
    expect(buttonState(true, false)).toEqual({ disabled: false, "aria-disabled": undefined });
  });
});

describe("where the focus goes when an action removes its own element (UX-M2)", () => {
  // Fails if focus is moved while its element is still there, or taken from another element the visitor moved to.
  it("moves only a focus that was lost with its element", () => {
    const body = {};
    expect(lostFocus({ isConnected: false }, body, body)).toBe(true);
    expect(lostFocus({ isConnected: false }, null, body)).toBe(true);
    expect(lostFocus({ isConnected: true }, body, body)).toBe(false);
    expect(lostFocus({ isConnected: false }, {}, body)).toBe(false);
    expect(lostFocus(null, body, body)).toBe(false);
  });
});
