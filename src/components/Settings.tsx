import { useEffect, useRef, useState } from "react";
import {
  getSettings,
  setSetting,
  setDefaultModel,
  deleteChatsOlderThan,
  type AppSettings,
} from "../lib/db";
import {
  hasApiKey,
  setApiKey,
  clearApiKey,
  keyErrorMessage,
  listReadyProviders,
} from "../lib/keys";
import { PROVIDER_LABELS, PROVIDERS, pickDefaultModel, type ProviderId } from "../lib/models";
import { ModelPicker } from "./ModelPicker";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  applyHotkey,
  clearHotkey,
  DEFAULT_HOTKEY,
  eventToAccelerator,
  formatHotkey,
  getActiveHotkey,
  isValidAccelerator,
} from "../lib/hotkey";
import { checkForAppUpdate, type AvailableUpdate } from "../lib/updater";

type Props = {
  onClose: () => void;
  onSaved: (s: AppSettings) => void;
  onNotify?: (text: string, kind?: "ok" | "err") => void;
  /** Hand discovered updates to App so one banner owns install/restart. */
  onUpdateFound?: (update: AvailableUpdate) => void;
  /** True while App is installing or needs manual restart. */
  updateLocked?: boolean;
  /** After a key save/clear so App can retarget empty chats. */
  onKeysChanged?: () => void;
  /** App registers a drain for pending debounced saves (e.g. before New Chat). */
  flushRef?: { current: (() => Promise<void>) | null };
};

export function Settings({
  onClose,
  onSaved,
  onNotify,
  onUpdateFound,
  updateLocked = false,
  onKeysChanged,
  flushRef,
}: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [keys, setKeys] = useState<Record<ProviderId, string>>({
    openai: "",
    anthropic: "",
    google: "",
  });
  const [hasKey, setHasKey] = useState<Record<ProviderId, boolean>>({
    openai: false,
    anthropic: false,
    google: false,
  });
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordBusy, setRecordBusy] = useState(false);
  const [hotkeyDraft, setHotkeyDraft] = useState<string | null>(null);
  const [hotkeyError, setHotkeyError] = useState("");
  const [keyError, setKeyError] = useState("");
  const [keyEpoch, setKeyEpoch] = useState(0);
  const [updateBusy, setUpdateBusy] = useState(false);
  const updateCheckGenRef = useRef(0);
  const saveTimer = useRef<number | null>(null);
  const settingsRef = useRef<AppSettings | null>(null);
  const lastGoodHotkeyRef = useRef(DEFAULT_HOTKEY);
  const persistGenRef = useRef(0);
  /** True when Defaults picker / syncDefaults intentionally changed provider+model. */
  const defaultsDirtyRef = useRef(false);
  const flushPendingSavesRef = useRef<() => Promise<void>>(async () => {});
  const recordingRef = useRef(false);
  /** Bumped on key save/clear / unmount so a late probe cannot overwrite hasKey. */
  const keyProbeGenRef = useRef(0);
  /** True once Record intends to clear — including while flush/clear are in flight. */
  const pausedForRecordRef = useRef(false);
  /** Bumped on unmount / new Record to cancel in-flight startRecording. */
  const recordGenRef = useRef(0);
  /** Settings snapshot deferred while recording; flushed when recording ends. */
  const deferredPersistRef = useRef<AppSettings | null>(null);
  /** Serializes persist bodies so flush can await every in-flight write. */
  const persistChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const persistImplRef = useRef<
    (
      s: AppSettings,
      opts?: { allowDuringPause?: boolean; flushDefaults?: boolean },
    ) => Promise<void>
  >(async () => {});
  const hotkeyDraftRef = useRef<string | null>(null);
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;
  const onKeysChangedRef = useRef(onKeysChanged);
  onKeysChangedRef.current = onKeysChanged;
  const mountedRef = useRef(true);

  // flushPendingSaves is stable (refs only); register once for App.

  async function probeKeys(
    gen: number,
    opts?: { notify?: boolean; retainError?: string },
  ): Promise<Record<ProviderId, boolean> | null> {
    const hk: Record<ProviderId, boolean> = {
      openai: false,
      anthropic: false,
      google: false,
    };
    let errMsg = "";
    for (const p of PROVIDERS) {
      try {
        hk[p] = await hasApiKey(p);
      } catch (err) {
        errMsg = keyErrorMessage(err);
        // Unreadable entry still exists — show Clear without treating as usable.
        if (/unreadable|Clear the key/i.test(errMsg)) hk[p] = true;
      }
    }
    if (!mountedRef.current || gen !== keyProbeGenRef.current) return null;
    setHasKey(hk);
    const displayErr = errMsg || opts?.retainError || "";
    if (displayErr) {
      setKeyError(displayErr);
      if (opts?.notify) onNotifyRef.current?.(displayErr, "err");
    } else {
      setKeyError("");
    }
    return hk;
  }

  /** Align default_provider/model with providers that have usable keys. */
  async function syncDefaultsFromKeys() {
    const readyResult = await listReadyProviders();
    if (!mountedRef.current || !readyResult.ok) return;
    const s = settingsRef.current;
    if (!s) return;
    const picked = pickDefaultModel(readyResult.ready, {
      provider: s.default_provider,
      modelId: s.default_model,
    });
    if (
      picked &&
      (picked.provider !== s.default_provider ||
        picked.modelId !== s.default_model)
    ) {
      patch({
        default_provider: picked.provider,
        default_model: picked.modelId,
      });
    }
  }

  useEffect(() => {
    return () => {
      updateCheckGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    const gen = keyProbeGenRef.current;
    void (async () => {
      const s = await getSettings();
      if (cancelled || gen !== keyProbeGenRef.current) return;
      setSettings(s);
      settingsRef.current = s;
      lastGoodHotkeyRef.current = s.hotkey.trim() || DEFAULT_HOTKEY;
      await probeKeys(gen, { notify: true });
    })();
    return () => {
      cancelled = true;
      mountedRef.current = false;
      keyProbeGenRef.current += 1;
    };
  }, []);

  function restorePausedHotkey() {
    if (!pausedForRecordRef.current) return;
    pausedForRecordRef.current = false;
    // Prefer settings snapshot — may already include a pre-clear flush not yet in lastGood.
    const accel =
      settingsRef.current?.hotkey.trim() || lastGoodHotkeyRef.current;
    void applyHotkey(accel).catch((err) => {
      const msg =
        (err as Error).message ||
        `Could not restore ${formatHotkey(accel)}. Rebind or restart.`;
      setHotkeyError(msg);
      onNotifyRef.current?.(msg, "err");
    });
  }

  function abortRecordingForHide() {
    if (!pausedForRecordRef.current && !recordingRef.current) return;
    recordGenRef.current += 1;
    recordingRef.current = false;
    setRecording(false);
    setRecordBusy(false);
    restorePausedHotkey();
    flushDeferredPersist();
  }

  function flushDeferredPersist(hotkeyOverride?: string) {
    const deferred = deferredPersistRef.current;
    deferredPersistRef.current = null;
    if (!deferred) return;
    const snapshot =
      hotkeyOverride != null
        ? { ...deferred, hotkey: hotkeyOverride }
        : deferred;
    void persist(snapshot);
  }

  useEffect(() => {
    recordingRef.current = recording;
    if (!recording) flushDeferredPersist();
  }, [recording]);

  // Hide/blur (CloseRequested → hide) does not unmount Settings — restore grab.
  useEffect(() => {
    let un: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) abortRecordingForHide();
      })
      .then((fn) => {
        un = fn;
      });
    return () => un?.();
  }, []);

  useEffect(() => {
    if (!recording) return;
    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        restorePausedHotkey();
        return;
      }
      const accel = eventToAccelerator(e);
      if (!accel || !settings) return;
      setHotkeyDraft(null);
      hotkeyDraftRef.current = null;
      // Invalidate in-flight Record starts so they cannot re-arm after capture.
      recordGenRef.current += 1;
      // Capture owns registration; merge into any deferred non-hotkey edits.
      pausedForRecordRef.current = false;
      if (deferredPersistRef.current) {
        deferredPersistRef.current = {
          ...deferredPersistRef.current,
          hotkey: accel,
        };
      }
      patch({ hotkey: accel });
      setRecording(false);
      setHotkeyError("");
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, settings]);

  // Close/unmount while paused (incl. flush/clear in flight) — restore + flush deferred.
  useEffect(() => {
    return () => {
      recordGenRef.current += 1;
      recordingRef.current = false;
      const hadPendingSave = saveTimer.current != null;
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const draft = hotkeyDraftRef.current;
      hotkeyDraftRef.current = null;
      const deferred = deferredPersistRef.current;
      deferredPersistRef.current = null;
      restorePausedHotkey();
      const base = settingsRef.current;
      if (draft != null && base) {
        const raw = draft.trim() || DEFAULT_HOTKEY;
        if (isValidAccelerator(raw)) {
          void persist({ ...base, hotkey: raw });
          return;
        }
      }
      // Prefer latest settingsRef over an older deferred snapshot.
      if (hadPendingSave && base) {
        void persist(base);
        return;
      }
      if (deferred) {
        // Keep deferred.hotkey (e.g. Reset-to-default during Record).
        void persist(deferred);
      }
    };
  }, []);

  function commitHotkeyDraft() {
    const draft = hotkeyDraft ?? hotkeyDraftRef.current;
    if (draft == null || !settings) return;
    const raw = draft.trim() || DEFAULT_HOTKEY;
    setHotkeyDraft(null);
    hotkeyDraftRef.current = null;
    if (!isValidAccelerator(raw)) {
      setHotkeyError(
        "Need at least one modifier (e.g. CommandOrControl+Shift+K).",
      );
      return;
    }
    setHotkeyError("");
    if (raw !== settings.hotkey) patch({ hotkey: raw });
  }

  async function startRecording() {
    if (recordingRef.current || recordBusy) return;
    const gen = ++recordGenRef.current;
    setRecordBusy(true);
    // Arm restore before any await so Close mid-flush still restores.
    pausedForRecordRef.current = true;
    setHotkeyDraft(null);
    hotkeyDraftRef.current = null;
    setHotkeyError("");
    // Flush pending debounce first so unrelated edits are not dropped.
    if (saveTimer.current && settingsRef.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      try {
        await persist(settingsRef.current, { allowDuringPause: true });
      } catch (err) {
        const msg = (err as Error).message || String(err);
        if (gen !== recordGenRef.current) {
          // Unmount may have drained deferred — report + retry via surviving notify.
          onNotifyRef.current?.(msg, "err");
          const snap = settingsRef.current;
          if (snap) {
            void persist(snap, { allowDuringPause: true }).catch((e) => {
              onNotifyRef.current?.(
                (e as Error).message || String(e),
                "err",
              );
            });
          }
          setRecordBusy(false);
          return;
        }
        setHotkeyError(msg);
        restorePausedHotkey();
        flushDeferredPersist();
        setRecordBusy(false);
        return;
      }
      if (gen !== recordGenRef.current) {
        setRecordBusy(false);
        return;
      }
    }
    try {
      await clearHotkey();
    } catch (err) {
      if (gen !== recordGenRef.current) {
        setRecordBusy(false);
        return;
      }
      setHotkeyError((err as Error).message || String(err));
      restorePausedHotkey();
      flushDeferredPersist();
      setRecordBusy(false);
      return;
    }
    if (gen !== recordGenRef.current) {
      // Superseded by unmount, capture, or a newer Record — owner restores.
      setRecordBusy(false);
      return;
    }
    setRecording(true);
    recordingRef.current = true;
    setRecordBusy(false);
  }

  function patch(partial: Partial<AppSettings>) {
    if (
      partial.default_provider !== undefined ||
      partial.default_model !== undefined
    ) {
      defaultsDirtyRef.current = true;
    }
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...partial };
      settingsRef.current = next;
      queueSave(next);
      return next;
    });
  }

  function queueSave(next: AppSettings) {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void persist(next);
    }, 250);
  }

  function persist(
    s: AppSettings,
    opts?: { allowDuringPause?: boolean; flushDefaults?: boolean },
  ): Promise<void> {
    const run = persistChainRef.current
      .catch(() => undefined)
      .then(() => persistImplRef.current(s, opts));
    persistChainRef.current = run;
    return run;
  }

  /**
   * Drain the Settings debounce (and any in-flight persist) so callers that
   * re-read the DB (e.g. New Chat) observe the latest defaults. Defaults are
   * written even while hotkey Record is active; the rest stays deferred.
   */
  const flushPendingSaves = async (): Promise<void> => {
    if (saveTimer.current && settingsRef.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      void persist(settingsRef.current, { flushDefaults: true });
    } else if (deferredPersistRef.current) {
      const deferred = deferredPersistRef.current;
      deferredPersistRef.current = null;
      void persist(deferred, { allowDuringPause: true, flushDefaults: true });
    }
    await persistChainRef.current.catch(() => undefined);
  };
  flushPendingSavesRef.current = flushPendingSaves;

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = () => flushPendingSavesRef.current();
    return () => {
      flushRef.current = null;
    };
  }, [flushRef]);

  persistImplRef.current = async function persistImpl(
    s: AppSettings,
    opts?: { allowDuringPause?: boolean; flushDefaults?: boolean },
  ) {
    if (
      recordingRef.current ||
      (pausedForRecordRef.current && !opts?.allowDuringPause)
    ) {
      // A New Chat flush must make defaults durable now — a deferred-only
      // return leaves getSettings() on the previous default until Record ends.
      if (opts?.flushDefaults && defaultsDirtyRef.current) {
        await setDefaultModel(s.default_provider, s.default_model);
        const cur = settingsRef.current;
        if (
          cur &&
          cur.default_provider === s.default_provider &&
          cur.default_model === s.default_model
        ) {
          defaultsDirtyRef.current = false;
        }
      }
      deferredPersistRef.current = s;
      return;
    }
    const gen = ++persistGenRef.current;
    const requested = s.hotkey.trim() || DEFAULT_HOTKEY;
    let hotkey = requested;
    let hotkeyOk = true;
    try {
      await applyHotkey(requested);
      setHotkeyError("");
      lastGoodHotkeyRef.current = requested;
      // Do not clear pausedForRecordRef here — Record start may be mid-flush.
    } catch (err) {
      hotkeyOk = false;
      setHotkeyError((err as Error).message || String(err));
      // Never persist a rejected combo — keep last known-good and re-bind if cleared.
      hotkey = lastGoodHotkeyRef.current;
      if (!getActiveHotkey()) {
        try {
          await applyHotkey(hotkey);
        } catch (restoreErr) {
          const msg =
            (restoreErr as Error).message ||
            `Could not restore ${formatHotkey(hotkey)}. Rebind or restart.`;
          setHotkeyError(msg);
          onNotifyRef.current?.(msg, "err");
        }
      } else {
        hotkey = getActiveHotkey() || lastGoodHotkeyRef.current;
        lastGoodHotkeyRef.current = hotkey;
      }
      // Only roll UI back if this request is still showing and not superseded.
      if (
        hotkey !== requested &&
        gen === persistGenRef.current
      ) {
        setSettings((prev) => {
          if (!prev || prev.hotkey !== requested) return prev;
          const next = { ...prev, hotkey };
          settingsRef.current = next;
          return next;
        });
      }
    }
    if (gen !== persistGenRef.current) return;
    await setSetting("resume_minutes", s.resume_minutes);
    await setSetting("always_on_top", s.always_on_top);
    await setSetting("show_tray", s.show_tray);
    // Skip defaults unless the Defaults UI dirtied them — a debounced flush of
    // unrelated edits must not restore pre-key-change provider/model over App sync.
    let default_provider = s.default_provider;
    let default_model = s.default_model;
    if (defaultsDirtyRef.current) {
      const saved = await setDefaultModel(s.default_provider, s.default_model);
      default_provider = saved.default_provider;
      default_model = saved.default_model;
      // Clear dirty only when this snapshot is still what the UI shows —
      // a newer Defaults edit that has not reached persist yet must stay dirty.
      if (gen === persistGenRef.current) {
        const cur = settingsRef.current;
        if (
          cur &&
          cur.default_provider === s.default_provider &&
          cur.default_model === s.default_model
        ) {
          defaultsDirtyRef.current = false;
        }
      }
    } else {
      const live = await getSettings();
      default_provider = live.default_provider;
      default_model = live.default_model;
    }
    await setSetting("web_search", true);
    await setSetting("hotkey", hotkey);
    if (gen !== persistGenRef.current) return;
    await getCurrentWindow().setAlwaysOnTop(s.always_on_top);
    onSaved({ ...s, hotkey, default_provider, default_model });
    setStatus(hotkeyOk ? "Saved" : "Saved (hotkey unchanged)");
  };

  async function saveKey(provider: ProviderId) {
    const value = keys[provider].trim();
    if (!value) return;
    // Invalidate in-flight probes (mount / other mutations) before awaiting keyring.
    keyProbeGenRef.current += 1;
    try {
      await setApiKey(provider, value);
      // App must refresh even if Close unmounted Settings mid-write.
      onKeysChangedRef.current?.();
      if (!mountedRef.current) return;
      // Keep a newer draft typed while the OS prompt was pending.
      setKeys((k) =>
        k[provider].trim() === value ? { ...k, [provider]: "" } : k,
      );
      setKeyEpoch((n) => n + 1);
      setStatus(`${PROVIDER_LABELS[provider]} key saved`);
      // Claim the latest gen after the write so a slower sibling mutation
      // cannot leave this provider stuck without Clear.
      const gen = ++keyProbeGenRef.current;
      await probeKeys(gen);
      await syncDefaultsFromKeys();
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = keyErrorMessage(err);
      setStatus("");
      onNotifyRef.current?.(msg, "err");
      // Failed mutations also invalidate — refresh so earlier successes keep Clear.
      const gen = ++keyProbeGenRef.current;
      await probeKeys(gen, { retainError: msg });
    }
  }

  async function clearKey(provider: ProviderId) {
    const draftAtStart = keys[provider];
    keyProbeGenRef.current += 1;
    try {
      await clearApiKey(provider);
      onKeysChangedRef.current?.();
      if (!mountedRef.current) return;
      // Keep a draft typed while the OS clear prompt was pending.
      setKeys((k) =>
        k[provider] === draftAtStart ? { ...k, [provider]: "" } : k,
      );
      setKeyEpoch((n) => n + 1);
      setStatus(`${PROVIDER_LABELS[provider]} key cleared`);
      const gen = ++keyProbeGenRef.current;
      await probeKeys(gen);
      await syncDefaultsFromKeys();
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = keyErrorMessage(err);
      setStatus("");
      onNotifyRef.current?.(msg, "err");
      const gen = ++keyProbeGenRef.current;
      await probeKeys(gen, { retainError: msg });
    }
  }

  if (!settings) return <div className="settings-panel">Loading…</div>;

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <h2>Settings</h2>
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="hint">Changes save automatically</p>

      <section>
        <h3>API keys (BYOK)</h3>
        {PROVIDERS.map((p) => (
          <div key={p} className="field">
            <span>
              {PROVIDER_LABELS[p]}
              {hasKey[p] ? " · saved" : ""}
            </span>
            <div className="key-row">
              <input
                type="password"
                placeholder={
                  hasKey[p] ? "•••••••• (paste new to replace)" : "Paste key"
                }
                value={keys[p]}
                onChange={(e) => setKeys({ ...keys, [p]: e.target.value })}
                onBlur={() => void saveKey(p)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveKey(p);
                }}
              />
              {hasKey[p] && (
                <button
                  type="button"
                  className="ghost"
                  // Prevent blur-save from racing with Clear on the same input.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void clearKey(p)}
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        ))}
        {keyError && <p className="hint error-text">{keyError}</p>}
      </section>

      <section>
        <h3>Defaults</h3>
        <ModelPicker
          provider={settings.default_provider}
          modelId={settings.default_model}
          refreshKey={keyEpoch}
          onChange={(provider, modelId) =>
            patch({ default_provider: provider, default_model: modelId })
          }
        />
        <label className="field" style={{ marginTop: 12 }}>
          <span>Resume last chat within (minutes)</span>
          <input
            type="number"
            min={0}
            value={settings.resume_minutes}
            onChange={(e) =>
              patch({ resume_minutes: Number(e.target.value) || 0 })
            }
          />
        </label>
      </section>

      <section>
        <h3>Window</h3>
        <label className="field">
          <span>Global hotkey</span>
          <div className="hotkey-row">
            <input
              className="hotkey-display"
              aria-label="Global hotkey accelerator"
              title={formatHotkey(settings.hotkey || DEFAULT_HOTKEY)}
              spellCheck={false}
              readOnly={recording}
              value={
                recording
                  ? "Press keys… (Esc cancel)"
                  : (hotkeyDraft ?? (settings.hotkey || DEFAULT_HOTKEY))
              }
              onChange={(e) => {
                if (recording || pausedForRecordRef.current) return;
                setHotkeyDraft(e.target.value);
                hotkeyDraftRef.current = e.target.value;
              }}
              onBlur={() => commitHotkeyDraft()}
              onKeyDown={(e) => {
                if (recording || pausedForRecordRef.current) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
                if (e.key === "Escape") {
                  // Commit so App's Escape can close Settings without losing the draft.
                  commitHotkeyDraft();
                }
              }}
            />
            <button
              type="button"
              className="ghost"
              disabled={recording || recordBusy}
              onClick={() => void startRecording()}
            >
              Record
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setHotkeyDraft(null);
                patch({ hotkey: DEFAULT_HOTKEY });
              }}
            >
              Reset
            </button>
          </div>
          <p className="hint">
            If Record opens another app, that combo is already taken — type the
            accelerator (e.g. CommandOrControl+Shift+Space) instead.
          </p>
          {hotkeyError && <p className="hint error-text">{hotkeyError}</p>}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.always_on_top}
            onChange={(e) => patch({ always_on_top: e.target.checked })}
          />
          Always on top
        </label>
      </section>

      <section>
        <h3>Updates</h3>
        <button
          type="button"
          className="ghost"
          disabled={updateBusy || updateLocked}
          onClick={() => {
            void (async () => {
              const gen = ++updateCheckGenRef.current;
              setUpdateBusy(true);
              setStatus("Checking for updates…");
              try {
                const result = await checkForAppUpdate();
                if (gen !== updateCheckGenRef.current) {
                  if (result.status === "available") result.update.dismiss();
                  return;
                }
                if (result.status === "none") {
                  setStatus("Up to date");
                  return;
                }
                if (result.status === "error") {
                  setStatus(result.message);
                  onNotifyRef.current?.(result.message, "err");
                  return;
                }
                setStatus(`Update ${result.update.version} available`);
                onUpdateFound?.(result.update);
              } catch (e) {
                if (gen !== updateCheckGenRef.current) return;
                const msg =
                  e instanceof Error
                    ? e.message
                    : typeof e === "string"
                      ? e
                      : "Update check failed";
                setStatus(msg);
                onNotifyRef.current?.(msg, "err");
              } finally {
                if (gen === updateCheckGenRef.current) setUpdateBusy(false);
              }
            })();
          }}
        >
          {updateBusy ? "Checking…" : "Check for updates"}
        </button>
      </section>

      <section>
        <h3>History</h3>
        <button
          type="button"
          className="danger"
          onClick={async () => {
            await deleteChatsOlderThan(180);
            setStatus("Deleted chats older than 6 months");
          }}
        >
          Delete chats older than 6 months
        </button>
      </section>

      {status && <p className="hint settings-status">{status}</p>}
    </div>
  );
}
