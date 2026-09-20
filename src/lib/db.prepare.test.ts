import { describe, expect, it, vi } from "vitest";
import { prepareDb } from "./db";

describe("prepareDb", () => {
  it("enables WAL, verifies mode, and skips pinned when present", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 0 });
    const select = vi
      .fn()
      .mockResolvedValueOnce([{ journal_mode: "wal" }])
      .mockResolvedValueOnce([{ name: "id" }, { name: "pinned" }]);
    await prepareDb({ execute, select } as never);
    expect(execute).toHaveBeenCalledWith("PRAGMA journal_mode=WAL;");
    expect(select).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode;");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("adds pinned when legacy chats table lacks it", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 0 });
    const select = vi
      .fn()
      .mockResolvedValueOnce([{ journal_mode: "wal" }])
      .mockResolvedValueOnce([{ name: "id" }, { name: "title" }]);
    await prepareDb({ execute, select } as never);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("ADD COLUMN pinned"),
    );
  });

  it("throws when journal_mode is not wal", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 0 });
    const select = vi.fn().mockResolvedValueOnce([{ journal_mode: "delete" }]);
    await expect(prepareDb({ execute, select } as never)).rejects.toThrow(
      /expected wal/,
    );
  });
});
