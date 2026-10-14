import { describe, expect, it } from "vitest";
import { SerialLoader } from "../contract";

const tick = () => new Promise((r) => setTimeout(r, 0));

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

describe("SerialLoader", () => {
  it("poll() during an in-flight read neither aborts nor stacks a request", async () => {
    const g = gate();
    let calls = 0;
    let aborted = false;
    const l = new SerialLoader(async (signal) => {
      calls++;
      signal.addEventListener("abort", () => (aborted = true));
      await g.p;
    });
    l.refresh();
    await tick();
    expect(l.isFetching).toBe(true);
    for (let i = 0; i < 5; i++) expect(l.poll()).toBe(false);
    g.open();
    await tick();
    await tick();
    expect(calls).toBe(1);
    expect(aborted).toBe(false);
    expect(l.isFetching).toBe(false);
  });

  it("a read slower than the poll interval still completes (no abort loop)", async () => {
    let completed = 0;
    const g = gate();
    const l = new SerialLoader(async (signal) => {
      await g.p;
      if (!signal.aborted) completed++;
    });
    l.poll();
    for (let i = 0; i < 10; i++) l.poll(); // ten "ticks" while it runs
    g.open();
    await tick();
    await tick();
    expect(completed).toBe(1);
  });

  it("coalesces refreshes made during a read into exactly one follow-up", async () => {
    const gates = [gate(), gate()];
    let calls = 0;
    const l = new SerialLoader(async () => {
      const g = gates[calls++];
      await g?.p;
    });
    l.refresh();
    await tick();
    l.refresh();
    l.refresh();
    l.refresh();
    gates[0].open();
    await tick();
    await tick();
    expect(calls).toBe(2);
    gates[1].open();
    await tick();
    await tick();
    expect(calls).toBe(2);
    expect(l.isFetching).toBe(false);
  });

  it("a failing read releases the lock", async () => {
    let calls = 0;
    const l = new SerialLoader(async () => {
      calls++;
      throw new Error("rpc down");
    });
    l.refresh();
    await tick();
    expect(l.isFetching).toBe(false);
    expect(l.poll()).toBe(true);
    await tick();
    expect(calls).toBe(2);
  });

  it("dispose() aborts the in-flight read and stops further work", async () => {
    const g = gate();
    let aborted = false;
    let calls = 0;
    const l = new SerialLoader(async (signal) => {
      calls++;
      signal.addEventListener("abort", () => (aborted = true));
      await g.p;
    });
    l.refresh();
    await tick();
    l.refresh(); // queued
    l.dispose();
    g.open();
    await tick();
    await tick();
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
    expect(l.poll()).toBe(false);
  });
});
