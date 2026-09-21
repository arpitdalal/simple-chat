import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hasApiKey, keyErrorMessage } from "../lib/keys";
import {
  CATALOG,
  PROVIDER_LABELS,
  PROVIDERS,
  resolveModel,
  type ModelDef,
  type ProviderId,
} from "../lib/models";

type Props = {
  provider: string;
  modelId: string;
  onChange: (provider: ProviderId, modelId: string) => void;
  disabled?: boolean;
  refreshKey?: number;
};

export function ModelPicker({
  provider,
  modelId,
  onChange,
  disabled,
  refreshKey = 0,
}: Props) {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState<ProviderId[]>([]);
  const [probeError, setProbeError] = useState("");
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const hiRef = useRef(0);
  const optionsRef = useRef<ModelDef[]>([]);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, bottom: 0 });

  const options = useMemo(() => {
    return CATALOG.filter((m) => {
      if (!ready.includes(m.provider)) return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        m.label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        PROVIDER_LABELS[m.provider].toLowerCase().includes(q)
      );
    });
  }, [ready, query]);

  optionsRef.current = options;
  hiRef.current = hi;

  useEffect(() => {
    void (async () => {
      const next: ProviderId[] = [];
      try {
        for (const p of PROVIDERS) {
          if (await hasApiKey(p)) next.push(p);
        }
        setProbeError("");
      } catch (err) {
        setProbeError(keyErrorMessage(err));
      }
      setReady(next);
    })();
  }, [refreshKey, open]);

  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex(
      (m) => m.id === modelId && m.provider === provider,
    );
    setHi(idx >= 0 ? idx : 0);
  }, [open, options, modelId, provider]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${hi}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      const list = optionsRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setHi((i) => (list.length ? (i + 1) % list.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setHi((i) =>
          list.length ? (i - 1 + list.length) % list.length : 0,
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const m = list[hiRef.current];
        if (m) {
          onChange(m.provider, m.id);
          setOpen(false);
        }
        return;
      }
    }
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onChange]);

  const current = resolveModel(provider, modelId);

  function pick(m: ModelDef) {
    onChange(m.provider, m.id);
    setOpen(false);
  }

  function toggle() {
    if (disabled) return;
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({
        left: r.left,
        bottom: window.innerHeight - r.top + 6,
      });
      setQuery("");
    }
    setOpen((v) => !v);
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="model-trigger"
        disabled={disabled}
        onClick={toggle}
        title="Select model"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="model-trigger-label">{current.label}</span>
        <span className="model-trigger-chevron" aria-hidden>
          ▾
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="model-menu"
            style={{ left: pos.left, bottom: pos.bottom }}
            role="listbox"
          >
            <input
              className="model-menu-search"
              placeholder="Search…"
              value={query}
              autoFocus
              onChange={(e) => {
                setQuery(e.target.value);
                setHi(0);
              }}
              onKeyDown={(e) => {
                // keep typing in search; arrows handled globally in capture
                if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
                  e.preventDefault();
                }
              }}
            />
            <div className="model-menu-list" ref={listRef}>
              {options.length === 0 ? (
                <div className="model-menu-empty">
                  {ready.length === 0
                    ? probeError || "Add an API key in Settings"
                    : "No matching models"}
                </div>
              ) : (
                options.map((m, i) => {
                  const selected =
                    m.id === modelId && m.provider === provider;
                  return (
                    <button
                      key={`${m.provider}:${m.id}`}
                      type="button"
                      data-idx={i}
                      role="option"
                      aria-selected={i === hi}
                      className={`model-menu-item ${selected ? "selected" : ""} ${i === hi ? "highlight" : ""}`}
                      onMouseEnter={() => setHi(i)}
                      onClick={() => pick(m)}
                    >
                      <span className="model-menu-name">{m.label}</span>
                      <span className="model-menu-provider">
                        {PROVIDER_LABELS[m.provider]}
                      </span>
                      {selected && (
                        <span className="model-menu-check" aria-hidden>
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
