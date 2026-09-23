import { beforeEach, describe, expect, it } from "vitest";
import {
  abortedDraftsRef,
  discardChatMirrors,
  finalizeChatDeletion,
  isChatDead,
  lastClearedNonceRef,
  localAddsRef,
  markChatDead,
  pendingSendsRef,
  resetChatRuntime,
  stopChat,
  streamsRef,
  titleCancelsRef,
  turnCancelsRef,
  unmarkChatDead,
} from "./chat-runtime";

describe("chat-runtime", () => {
  beforeEach(() => {
    resetChatRuntime();
  });

  it("unmarkChatDead restores a chat after a failed delete without losing mirrors or controllers", () => {
    const streamAc = new AbortController();
    streamsRef.current.set("c1", { ac: streamAc, anchor: "u1", text: "" });
    localAddsRef.current.set("c1", []);
    abortedDraftsRef.current.set("c1", [
      { text: "draft", images: [], gen: 0 },
    ]);

    markChatDead("c1");
    expect(isChatDead("c1")).toBe(true);
    // No irreversible discard until finalize — failed delete must not lose state
    expect(streamAc.signal.aborted).toBe(false);
    expect(localAddsRef.current.has("c1")).toBe(true);
    expect(abortedDraftsRef.current.has("c1")).toBe(true);

    unmarkChatDead("c1");
    expect(isChatDead("c1")).toBe(false);
    expect(streamAc.signal.aborted).toBe(false);
    expect(localAddsRef.current.has("c1")).toBe(true);
    expect(abortedDraftsRef.current.has("c1")).toBe(true);
  });

  it("finalizeChatDeletion aborts and drops mirrors only after a successful delete", () => {
    const streamAc = new AbortController();
    const turnAc = new AbortController();
    streamsRef.current.set("c1", { ac: streamAc, anchor: "u1", text: "" });
    turnCancelsRef.current.set("c1", [turnAc]);
    localAddsRef.current.set("c1", []);
    pendingSendsRef.current.set("c1", []);
    abortedDraftsRef.current.set("c1", [
      { text: "draft", images: [], gen: 0 },
    ]);

    markChatDead("c1");
    expect(streamAc.signal.aborted).toBe(false);
    expect(localAddsRef.current.has("c1")).toBe(true);

    finalizeChatDeletion("c1");
    expect(streamAc.signal.aborted).toBe(true);
    expect(turnAc.signal.aborted).toBe(true);
    expect(localAddsRef.current.has("c1")).toBe(false);
    expect(pendingSendsRef.current.has("c1")).toBe(false);
    expect(abortedDraftsRef.current.has("c1")).toBe(false);
    expect(turnCancelsRef.current.has("c1")).toBe(false);
  });

  it("markChatDead only sets the dead flag (no abort, no mirror drop)", () => {
    const streamAc = new AbortController();
    const turnAc = new AbortController();
    const titleAc = new AbortController();
    streamsRef.current.set("c1", {
      ac: streamAc,
      anchor: "u1",
      text: "partial",
    });
    turnCancelsRef.current.set("c1", [turnAc]);
    titleCancelsRef.current.set("c1", [titleAc]);
    localAddsRef.current.set("c1", []);
    pendingSendsRef.current.set("c1", []);
    abortedDraftsRef.current.set("c1", [
      { text: "draft", images: [], gen: 0 },
    ]);

    markChatDead("c1");

    expect(isChatDead("c1")).toBe(true);
    expect(streamAc.signal.aborted).toBe(false);
    expect(turnAc.signal.aborted).toBe(false);
    expect(titleAc.signal.aborted).toBe(false);
    expect(localAddsRef.current.has("c1")).toBe(true);
    expect(pendingSendsRef.current.has("c1")).toBe(true);
    expect(abortedDraftsRef.current.has("c1")).toBe(true);
    expect(turnCancelsRef.current.has("c1")).toBe(true);
    expect(titleCancelsRef.current.has("c1")).toBe(true);
  });

  it("discardChatMirrors only drops local mirrors (chat stays alive)", () => {
    localAddsRef.current.set("c1", []);
    pendingSendsRef.current.set("c1", []);
    abortedDraftsRef.current.set("c1", [
      { text: "draft", images: [], gen: 0 },
    ]);
    const turnAc = new AbortController();
    turnCancelsRef.current.set("c1", [turnAc]);

    discardChatMirrors("c1");

    expect(isChatDead("c1")).toBe(false);
    expect(turnAc.signal.aborted).toBe(false);
    expect(localAddsRef.current.has("c1")).toBe(false);
    expect(pendingSendsRef.current.has("c1")).toBe(false);
    expect(abortedDraftsRef.current.has("c1")).toBe(false);
    expect(turnCancelsRef.current.has("c1")).toBe(true);
  });

  it("clear nonce is module-scoped and survives conceptual remounts", () => {
    lastClearedNonceRef.current = 42;
    // Remount = new ChatView instance, but module state is shared.
    expect(lastClearedNonceRef.current).toBe(42);
    resetChatRuntime();
    expect(lastClearedNonceRef.current).toBe(0);
  });

  it("stopChat aborts stream, turns, and title gens", () => {
    const streamAc = new AbortController();
    const turnAc = new AbortController();
    const titleAc = new AbortController();
    streamsRef.current.set("c1", { ac: streamAc, anchor: "u1", text: "" });
    turnCancelsRef.current.set("c1", [turnAc]);
    titleCancelsRef.current.set("c1", [titleAc]);

    stopChat("c1");

    expect(streamAc.signal.aborted).toBe(true);
    expect(turnAc.signal.aborted).toBe(true);
    expect(titleAc.signal.aborted).toBe(true);
    expect(isChatDead("c1")).toBe(false);
  });
});
