type FocusHandler = (event: { payload: boolean }) => void;

const listeners = new Set<FocusHandler>();

export function getCurrentWindow() {
  return {
    async setAlwaysOnTop(_v: boolean) {},
    async startDragging() {},
    async hide() {},
    async show() {},
    async setFocus() {},
    async isVisible() {
      return true;
    },
    async onFocusChanged(handler: FocusHandler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}
