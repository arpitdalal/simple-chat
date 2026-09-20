import { describe, expect, it, vi } from "vitest";
import { prepareDb } from "./db";

describe("prepareDb", () => {
  it("enables WAL and tolerates pinned column already existing", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rowsAffected: 0 })
      .mockRejectedValueOnce(new Error("duplicate column name: pinned"));
    await prepareDb({ execute } as never);
    expect(execute).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode=WAL;");
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("ADD COLUMN pinned"),
    );
  });

  it("adds pinned when legacy chats table lacks it", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 0 });
    await prepareDb({ execute } as never);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-duplicate ALTER failures", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rowsAffected: 0 })
      .mockRejectedValueOnce(new Error("no such table: chats"));
    await expect(prepareDb({ execute } as never)).rejects.toThrow(
      /no such table/,
    );
  });
});
