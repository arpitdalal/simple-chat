import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// @tanstack/react-virtual needs non-zero layout boxes in happy-dom
class RO {
  callback: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
  }
  observe(el: Element) {
    // notify so virtualizer measures scroller
    this.callback(
      [
        {
          target: el,
          contentRect: {
            width: 800,
            height: 640,
            top: 0,
            left: 0,
            bottom: 640,
            right: 800,
            x: 0,
            y: 0,
            toJSON() {},
          },
          borderBoxSize: [{ inlineSize: 800, blockSize: 640 }],
          contentBoxSize: [{ inlineSize: 800, blockSize: 640 }],
          devicePixelContentBoxSize: [{ inlineSize: 800, blockSize: 640 }],
        } as unknown as ResizeObserverEntry,
      ],
      this,
    );
  }
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", RO);

for (const [prop, value] of [
  ["offsetHeight", 640],
  ["offsetWidth", 800],
  ["clientHeight", 640],
  ["clientWidth", 800],
  ["scrollHeight", 2000],
  ["scrollWidth", 800],
] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get() {
      return value;
    },
  });
}

Element.prototype.getBoundingClientRect = function () {
  return {
    width: 800,
    height: 640,
    top: 0,
    left: 0,
    bottom: 640,
    right: 800,
    x: 0,
    y: 0,
    toJSON() {},
  } as DOMRect;
};
