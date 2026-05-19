/**
 * Bounded FIFO buffer used by augments for recent-events tracking.
 * Forward-compat shape: when the Tier-2 telemetry pipeline lands, the same
 * push/snapshot API can be backed by a kernel-level event bus consumer
 * without changing the augment's call sites.
 */
export interface RingBuffer<T> {
  push(item: T): void;
  snapshot(): T[];
  clear(): void;
}

export function createRingBuffer<T>(maxSize: number): RingBuffer<T> {
  if (maxSize <= 0) {
    throw new Error(`createRingBuffer: maxSize must be > 0 (got ${maxSize})`);
  }
  let items: T[] = [];

  return {
    push(item: T): void {
      items.push(item);
      if (items.length > maxSize) {
        items = items.slice(items.length - maxSize);
      }
    },
    snapshot(): T[] {
      return items.slice();
    },
    clear(): void {
      items = [];
    },
  };
}
