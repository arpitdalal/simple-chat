import { describe, expect, it, vi } from "vitest";
import { createQueue } from "./queue";

describe("createQueue", () => {
  it("runs ops FIFO and reports busy from pending count", async () => {
    const q = createQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const first = q.run(async () => {
      await firstGate;
      order.push("first");
      return 1;
    });
    const second = q.run(async () => {
      order.push("second");
      return 2;
    });

    expect(q.isBusy()).toBe(true);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(["first", "second"]);
    expect(q.isBusy()).toBe(false);
  });

  it("a rejection does not wedge later ops", async () => {
    const q = createQueue();
    await expect(
      q.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(q.run(async () => "ok")).resolves.toBe("ok");
    expect(q.isBusy()).toBe(false);
  });

  it("stays busy until every overlapping op settles", async () => {
    const q = createQueue();
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const gateB = new Promise<void>((r) => {
      releaseB = r;
    });

    const a = q.run(() => gateA);
    const b = q.run(() => gateB);
    expect(q.isBusy()).toBe(true);
    releaseA();
    await a;
    expect(q.isBusy()).toBe(true);
    releaseB();
    await b;
    expect(q.isBusy()).toBe(false);
  });

  it("notifies subscribers on pending changes", async () => {
    const q = createQueue();
    const seen: boolean[] = [];
    const unsub = q.subscribe(() => seen.push(q.isBusy()));
    await q.run(async () => undefined);
    unsub();
    expect(seen).toEqual([true, false]);
  });

  it("a throwing subscriber does not wedge later ops", async () => {
    const q = createQueue();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    q.subscribe(() => {
      throw new Error("listener boom");
    });
    await expect(
      q.run(async () => {
        throw new Error("op boom");
      }),
    ).rejects.toThrow("op boom");
    await expect(q.run(async () => "ok")).resolves.toBe("ok");
    expect(q.isBusy()).toBe(false);
    spy.mockRestore();
  });
});
