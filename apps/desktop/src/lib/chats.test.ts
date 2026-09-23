import { describe, expect, it } from "vitest";
import {
  emptyChatNeedsRetarget,
  isEmptyNewChat,
  resolveStartupMode,
} from "./chats";

describe("emptyChatNeedsRetarget", () => {
  it("keeps chats whose provider is still keyed", () => {
    expect(emptyChatNeedsRetarget({ provider: "openai" }, ["openai", "google"])).toBe(
      false,
    );
  });
  it("retargets when the provider key is gone", () => {
    expect(emptyChatNeedsRetarget({ provider: "openai" }, ["google"])).toBe(true);
  });
});

describe("isEmptyNewChat", () => {
  it("true for fresh New Chat placeholder", () => {
    expect(
      isEmptyNewChat({ title: "New Chat", preview: "Ask AI anything…" }),
    ).toBe(true);
    expect(isEmptyNewChat({ title: "New Chat", preview: "  " })).toBe(true);
  });

  it("false once titled or previewed", () => {
    expect(
      isEmptyNewChat({ title: "New Chat", preview: "Hello world" }),
    ).toBe(false);
    expect(
      isEmptyNewChat({ title: "Domains", preview: "Ask AI anything…" }),
    ).toBe(false);
  });
});

describe("resolveStartupMode", () => {
  const now = 1_000_000;

  it("resumes when last chat is within window", () => {
    expect(
      resolveStartupMode(
        {
          last_chat_id: "c1",
          last_opened_at: now - 2 * 60 * 1000,
          resume_minutes: 5,
        },
        now,
      ),
    ).toBe("resume");
  });

  it("starts new when expired or missing last chat", () => {
    expect(
      resolveStartupMode(
        {
          last_chat_id: "c1",
          last_opened_at: now - 10 * 60 * 1000,
          resume_minutes: 5,
        },
        now,
      ),
    ).toBe("new");
    expect(
      resolveStartupMode(
        { last_chat_id: null, last_opened_at: now, resume_minutes: 5 },
        now,
      ),
    ).toBe("new");
  });
});
