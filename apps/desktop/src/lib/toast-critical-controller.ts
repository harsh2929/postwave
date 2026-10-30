import {
  clearPersistedCriticalNoticesForTests,
  type CriticalNoticeCode,
  type CriticalNoticeCopy,
  getCriticalNoticeCopy,
  loadPersistedCriticalNotices,
  persistCriticalNotice,
  removePersistedCriticalNotice,
} from "./toast-critical-notices";

export interface CriticalToastBridge {
  show(
    code: CriticalNoticeCode,
    copy: CriticalNoticeCopy,
    recordTelemetry: boolean,
  ): void;
  remove(code: CriticalNoticeCode): void;
}

let operations: Promise<void> = Promise.resolve();
let generation = 0;
let hydrated = false;

function enqueue(operation: () => void): void {
  const expectedGeneration = generation;
  operations = operations
    .catch(() => undefined)
    .then(() => {
      if (expectedGeneration === generation) operation();
    });
}

export function raiseCriticalNotice(
  code: CriticalNoticeCode,
  bridge: CriticalToastBridge,
): void {
  enqueue(() => {
    persistCriticalNotice(code);
    bridge.show(code, getCriticalNoticeCopy(code), true);
  });
}

export function resolveCriticalNotice(
  code: CriticalNoticeCode,
  bridge: CriticalToastBridge,
): void {
  enqueue(() => {
    removePersistedCriticalNotice(code);
    bridge.remove(code);
  });
}

export function dismissCriticalNotice(code: CriticalNoticeCode): void {
  enqueue(() => removePersistedCriticalNotice(code));
}

export function hydrateCriticalNotices(bridge: CriticalToastBridge): void {
  if (hydrated) return;
  hydrated = true;
  enqueue(() => {
    for (const notice of loadPersistedCriticalNotices()) {
      bridge.show(notice.code, getCriticalNoticeCopy(notice.code), false);
    }
  });
}

/** @internal Reset lazy-controller state for focused renderer tests. */
export function resetCriticalNoticeController(options?: {
  preservePersistedCritical?: boolean;
}): void {
  generation += 1;
  operations = Promise.resolve();
  hydrated = false;
  if (options?.preservePersistedCritical !== true) {
    clearPersistedCriticalNoticesForTests();
  }
}

/** @internal Await serialized critical work in focused renderer tests. */
export async function flushCriticalNoticeOperations(): Promise<void> {
  await operations;
}
