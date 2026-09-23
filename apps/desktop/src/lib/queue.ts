export type Queue = {
  /** Enqueue `op`; runs FIFO after prior ops settle (rejections do not wedge). */
  run<T>(op: () => Promise<T>): Promise<T>;
  /** True while any op is queued or running. */
  isBusy(): boolean;
  /** Notify on every pending-count change. Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
};

/**
 * One primitive for every serialized side-effect stream (keychain, settings
 * writes, nav tasks). Busy is derived from the pending count — callers never
 * maintain a separate boolean that can disagree with the queue.
 */
export function createQueue(): Queue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        // A throwing subscriber must not wedge pending/tail or later ops.
        console.error("queue listener failed", err);
      }
    }
  }

  return {
    run<T>(op: () => Promise<T>): Promise<T> {
      pending += 1;
      emit();
      const result = tail.then(() => op());
      tail = result.then(
        () => {
          pending -= 1;
          emit();
        },
        () => {
          pending -= 1;
          emit();
        },
      );
      return result;
    },
    isBusy: () => pending > 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
