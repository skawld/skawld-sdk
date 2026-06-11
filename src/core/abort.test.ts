import { describe, expect, it } from "bun:test";
import { getEventListeners } from "node:events";
import { anySignal, throwIfAborted } from "./abort.js";
import { AbortError } from "./errors.js";

describe("anySignal", () => {
  it("fires when any input signal fires", () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = anySignal([a.signal, b.signal]);
    expect(combined.aborted).toBe(false);
    b.abort("via-b");
    expect(combined.aborted).toBe(true);
  });

  it("returns already-aborted signal if any input is already aborted", () => {
    const a = new AbortController();
    a.abort("pre");
    const b = new AbortController();
    const combined = anySignal([a.signal, b.signal]);
    expect(combined.aborted).toBe(true);
  });

  it("ignores undefined entries", () => {
    const a = new AbortController();
    const combined = anySignal([undefined, a.signal, undefined]);
    expect(combined.aborted).toBe(false);
    a.abort();
    expect(combined.aborted).toBe(true);
  });

  it("does not accumulate abort listeners on a reused caller signal (C5)", () => {
    // A server reusing one shutdown signal across many runs must not leak a
    // listener per run. AbortSignal.any uses weak listeners, so the public
    // listener list stays empty no matter how many combined signals are made.
    const caller = new AbortController();
    for (let i = 0; i < 25; i++) {
      // Simulate a completed run: build the combined signal and drop it.
      void anySignal([caller.signal, undefined]);
    }
    expect(getEventListeners(caller.signal, "abort").length).toBe(0);
  });
});

describe("throwIfAborted", () => {
  it("throws AbortError when signal is aborted", () => {
    const a = new AbortController();
    a.abort("stop");
    expect(() => throwIfAborted(a.signal)).toThrow(AbortError);
  });

  it("does nothing when signal is not aborted", () => {
    const a = new AbortController();
    expect(() => throwIfAborted(a.signal)).not.toThrow();
  });
});
