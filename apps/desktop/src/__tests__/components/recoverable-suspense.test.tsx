// @vitest-environment happy-dom

import { lazy, type ReactElement, useEffect } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { RecoverableSuspense } from "../../components/RecoverableSuspense";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

describe("RecoverableSuspense", () => {
  it("remounts a stale fallback after the bounded recovery delay without refetching", async () => {
    vi.useFakeTimers();
    let fallbackMounts = 0;
    let loaderCalls = 0;
    const NeverSettles = lazy(() => {
      loaderCalls += 1;
      return new Promise<{ default: () => ReactElement }>(() => {
        // Deliberately pending: the test verifies boundary recovery, not a
        // dynamic-import retry.
      });
    });
    function Fallback(): ReactElement {
      useEffect(() => {
        fallbackMounts += 1;
      }, []);
      return <div>Loading</div>;
    }

    render(
      <RecoverableSuspense fallback={<Fallback />} recoveryDelayMs={250}>
        <NeverSettles />
      </RecoverableSuspense>,
    );
    expect(fallbackMounts).toBe(1);

    await act(() => vi.advanceTimersByTime(249));
    expect(fallbackMounts).toBe(1);
    await act(() => vi.advanceTimersByTime(1));
    expect(fallbackMounts).toBe(2);
    expect(loaderCalls).toBe(1);
  });

  it("cancels recovery once the lazy content commits", async () => {
    vi.useFakeTimers();
    let resolveModule!: (module: { default: () => ReactElement }) => void;
    let fallbackMounts = 0;
    const EventuallyReady = lazy(
      () =>
        new Promise<{ default: () => ReactElement }>((resolve) => {
          resolveModule = resolve;
        }),
    );
    function Fallback(): ReactElement {
      useEffect(() => {
        fallbackMounts += 1;
      }, []);
      return <div>Loading</div>;
    }

    render(
      <RecoverableSuspense fallback={<Fallback />} recoveryDelayMs={250}>
        <EventuallyReady />
      </RecoverableSuspense>,
    );
    await act(async () => {
      resolveModule({ default: () => <div>Ready</div> });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container?.textContent).toBe("Ready");

    await act(() => vi.advanceTimersByTime(10_000));
    expect(container?.textContent).toBe("Ready");
    expect(fallbackMounts).toBe(1);
  });
});
