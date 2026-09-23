import { describe, expect, it } from "vitest";
import { trimRecentMessages } from "./memory";

describe("trimRecentMessages", () => {
  it("returns same array when within limit", () => {
    const msgs = [1, 2, 3];
    expect(trimRecentMessages(msgs, 5)).toBe(msgs);
    expect(trimRecentMessages(msgs, 3)).toBe(msgs);
  });

  it("keeps newest rows when over limit", () => {
    expect(trimRecentMessages([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });

  it("no-ops on non-positive limit", () => {
    const msgs = [1, 2];
    expect(trimRecentMessages(msgs, 0)).toBe(msgs);
    expect(trimRecentMessages(msgs, -1)).toBe(msgs);
  });
});
