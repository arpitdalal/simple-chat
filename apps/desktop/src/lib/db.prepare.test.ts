import { describe, expect, it, vi } from "vitest";
import { prepareDb } from "./db";

describe("prepareDb", () => {
  it("enables WAL, verifies mode, and skips pinned when present", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 0 });
    const select = vi
      .fn()
      .mockResolvedValueOnce([{ journal_mode: "wal" }])
      .mockResolvedValueOnce([{ name: "id" }, { name: "pinned" }])
      .mockResolvedValueOnce([]);
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
      .mockResolvedValueOnce([{ name: "id" }, { name: "title" }])
      .mockResolvedValueOnce([]);
    await prepareDb({ execute, select } as never);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("ADD COLUMN pinned"),
    );
  });

  it("backfills Unicode-normalized chat search fields", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const select = vi
      .fn()
      .mockResolvedValueOnce([{ journal_mode: "wal" }])
      .mockResolvedValueOnce([{ name: "title_search" }])
      .mockResolvedValueOnce([{ id: "1", title: "École", preview: "Café" }]);
    await prepareDb({ execute, select } as never);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("WITH search_input"),
      expect.arrayContaining(["école", "café", "1"]),
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
