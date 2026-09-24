import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getSettings,
  openOrCreateChat,
  setResumeState,
  setSetting,
  type Chat,
} from "./db";
import { getChatSession } from "./chat-runtime";
import { onMainWindowHidden, onMainWindowShown } from "./memory";
import type { Queue } from "./queue";

type ResumeLifecycleOptions = {
  navGenRef: RefObject<number>;
  showResumeGenRef: RefObject<number>;
  activeIdRef: RefObject<string | null>;
  suppressResumeTimestampRef: RefObject<boolean>;
  bootWasHiddenRef: RefObject<boolean>;
  settingsFlushRef: RefObject<(() => Promise<void>) | null>;
  navQueue: Queue;
  setActiveIdNow: (id: string) => void;
  setActiveChat: (chat: Chat) => void;
  refreshChats: () => Promise<void>;
  upsertChat: (chat: Chat) => void;
  focusComposer: () => void;
  notify: (text: string, kind?: "ok" | "err") => void;
};

export function useResumeLifecycle(options: ResumeLifecycleOptions) {
  const {
    navGenRef,
    showResumeGenRef,
    activeIdRef,
    suppressResumeTimestampRef,
    bootWasHiddenRef,
    settingsFlushRef,
    navQueue,
    setActiveIdNow,
    setActiveChat,
    refreshChats,
    upsertChat,
    focusComposer,
    notify,
  } = options;
  const readyRef = useRef(false);
  const pendingShowRef = useRef(false);
  const pendingShowAtRef = useRef(0);
  const resumeShowRef = useRef<((hiddenAt: number) => void) | null>(null);
  const lastShownHiddenAtRef = useRef(0);
  const hiddenWriteFailedRef = useRef(false);
  const resumePersistenceFailedRef = useRef(false);
  const lastHiddenWriteRef = useRef<Promise<unknown> | null>(null);
  const [showResumeChain] = useState(() => ({ current: Promise.resolve() }));
  const setActiveChatRef = useRef(setActiveChat);

  useEffect(() => {
    setActiveChatRef.current = setActiveChat;
  }, [setActiveChat]);

  const markReady = useCallback(() => {
    readyRef.current = true;
    if (!pendingShowRef.current) return;
    pendingShowRef.current = false;
    const pendingHiddenAt = pendingShowAtRef.current;
    pendingShowAtRef.current = 0;
    resumeShowRef.current?.(pendingHiddenAt);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onMainWindowHidden((hiddenAt) => {
      if (hiddenAt <= lastShownHiddenAtRef.current) return;
      showResumeGenRef.current += 1;
      pendingShowRef.current = false;
      pendingShowAtRef.current = 0;
      hiddenWriteFailedRef.current = false;
      const write = setSetting("last_opened_at", hiddenAt);
      lastHiddenWriteRef.current = write;
      void write.catch((err) => {
        hiddenWriteFailedRef.current = true;
        console.error("resume timestamp failed", err);
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showResumeGenRef]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const onShown = (hiddenAt: number) => {
      if (!readyRef.current) {
        pendingShowRef.current = true;
        pendingShowAtRef.current = hiddenAt;
        return;
      }
      if (hiddenAt > 0) lastShownHiddenAtRef.current = hiddenAt;
      const gen = navGenRef.current;
      const resumeGen = showResumeGenRef.current;
      const isStale = () =>
        cancelled || gen !== navGenRef.current || resumeGen !== showResumeGenRef.current;
      showResumeChain.current = showResumeChain.current
        .catch(() => undefined)
        .then(async () => {
          if (isStale()) return;
          await navQueue.run(async () => {
            if (isStale()) return;
            let chat: Chat | null = null;
            let priorChatId: string | null = null;
            let settingsFlushFailed = false;
            try {
              if (hiddenAt > 0) {
                const write = setSetting("last_opened_at", hiddenAt);
                lastHiddenWriteRef.current = write;
                void write.catch((err) => {
                  hiddenWriteFailedRef.current = true;
                  console.error("resume timestamp failed", err);
                });
              }
              const hiddenWrite = lastHiddenWriteRef.current;
              let hiddenWriteFailed = hiddenWriteFailedRef.current;
              hiddenWriteFailedRef.current = false;
              if (hiddenWrite) {
                try {
                  await hiddenWrite;
                } catch (err) {
                  hiddenWriteFailed = true;
                  console.error("resume timestamp failed", err);
                } finally {
                  if (lastHiddenWriteRef.current === hiddenWrite) {
                    lastHiddenWriteRef.current = null;
                  }
                }
              }
              try {
                await settingsFlushRef.current?.();
              } catch (err) {
                settingsFlushFailed = true;
                console.error("settings flush failed", err);
              }
              if (isStale()) return;
              const settingsSnapshot = await getSettings();
              if (isStale()) return;
              priorChatId = settingsSnapshot.last_chat_id;
              const resumeSettings = settingsFlushFailed || hiddenWriteFailed || resumePersistenceFailedRef.current
                ? { ...settingsSnapshot, last_opened_at: 0 }
                : settingsSnapshot;
              const resumedChat = await openOrCreateChat(resumeSettings);
              chat = resumedChat;
              const discardStaleChat = async () => {
                if (resumedChat.id === priorChatId) return;
                try {
                  await getChatSession(resumedChat.id).delete();
                } catch (err) {
                  console.error("stale resume cleanup failed", err);
                }
                await setSetting("last_chat_id", activeIdRef.current);
              };
              if (isStale()) {
                await discardStaleChat();
                return;
              }
              suppressResumeTimestampRef.current = false;
              try {
                await setResumeState(Date.now(), resumedChat.id);
                resumePersistenceFailedRef.current = false;
              } catch (err) {
                resumePersistenceFailedRef.current = true;
                console.error("resume state persistence failed", err);
                notify((err as Error).message || String(err), "err");
              }
              if (isStale()) {
                await discardStaleChat();
                return;
              }
              setActiveIdNow(resumedChat.id);
              setActiveChatRef.current(resumedChat);
              await refreshChats();
              if (isStale()) return;
              upsertChat(resumedChat);
              focusComposer();
            } catch (err) {
              if (chat && chat.id !== priorChatId && activeIdRef.current !== chat.id) {
                try {
                  await getChatSession(chat.id).delete();
                } catch (cleanupError) {
                  console.error("stale resume cleanup failed", cleanupError);
                }
                await setSetting("last_chat_id", activeIdRef.current).catch(() => undefined);
              }
              console.error("resume on show failed", err);
              notify((err as Error).message || String(err), "err");
            }
          });
        });
    };
    resumeShowRef.current = onShown;
    void onMainWindowShown(onShown).then(async (fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
      if (!bootWasHiddenRef.current) return;
      const visible = await getCurrentWindow().isVisible().catch(() => false);
      if (!cancelled && visible) onShown(0);
    });
    return () => {
      cancelled = true;
      resumeShowRef.current = null;
      unlisten?.();
    };
  }, [activeIdRef, bootWasHiddenRef, focusComposer, navGenRef, navQueue, notify, refreshChats, setActiveIdNow, settingsFlushRef, showResumeGenRef, suppressResumeTimestampRef, upsertChat]);

  return { markReady };
}
