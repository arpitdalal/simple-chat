type FocusHandler = (event: { payload: boolean }) => void;

const listeners = new Set<FocusHandler>();

const defaultMonitor = {
  name: "Mock",
  scaleFactor: 1,
  position: { x: 0, y: 0 },
  size: { width: 1920, height: 1080 },
};

export function getCurrentWindow() {
  return {
    async setAlwaysOnTop(_v: boolean) {},
    async startDragging() {},
    async hide() {},
    async show() {},
    async setFocus() {},
    async outerPosition() {
      return { x: 100, y: 100 };
    },
    async outerSize() {
      return { width: 1180, height: 820 };
    },
    async setPosition(_pos: unknown) {},
    async isVisible() {
      return true;
    },
    async onFocusChanged(handler: FocusHandler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}

export async function availableMonitors() {
  return [defaultMonitor];
}

export async function primaryMonitor() {
  return defaultMonitor;
}

export async function currentMonitor() {
  return defaultMonitor;
}

export async function cursorPosition() {
  return { x: 960, y: 540 };
}
