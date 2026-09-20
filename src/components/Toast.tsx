import { useEffect } from "react";

export type ToastKind = "ok" | "err";

export type ToastState = {
  text: string;
  kind: ToastKind;
} | null;

type Props = {
  toast: ToastState;
  onDismiss: () => void;
};

/** Bottom snackbar — auto-dismisses. */
export function Toast({ toast, onDismiss }: Props) {
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(onDismiss, 2800);
    return () => window.clearTimeout(id);
  }, [toast, onDismiss]);

  if (!toast) return null;
  return (
    <div
      className={`toast toast-${toast.kind}`}
      role={toast.kind === "err" ? "alert" : "status"}
    >
      {toast.text}
    </div>
  );
}
