// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  type RemoteLoadResult,
  useRemoteResource,
} from "../../hooks/useRemoteResource";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

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
  document.body.replaceChildren();
});

function mount(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

describe("useRemoteResource identity boundaries", () => {
  it("masks the prior identity synchronously and ignores its late response", async () => {
    const alpha = deferred<RemoteLoadResult<string>>();
    const beta = deferred<RemoteLoadResult<string>>();
    const renders: Array<{
      identity: string;
      data: string | null;
      transport: string;
    }> = [];

    function Probe({ identity }: { identity: "alpha" | "beta" }): ReactElement {
      const resource = useRemoteResource(
        () => (identity === "alpha" ? alpha.promise : beta.promise),
        { identity },
      );
      renders.push({
        identity,
        data: resource.data,
        transport: resource.transport,
      });
      return (
        <output>{resource.data ?? `${identity}:${resource.transport}`}</output>
      );
    }

    mount(<Probe identity="alpha" />);
    renders.length = 0;
    act(() => root?.render(<Probe identity="beta" />));

    expect(renders.filter((render) => render.identity === "beta")).not.toEqual(
      [],
    );
    expect(
      renders
        .filter((render) => render.identity === "beta")
        .every((render) => render.data === null),
    ).toBe(true);
    expect(container?.textContent).not.toContain("alpha");

    await act(async () => {
      alpha.resolve({ data: "alpha evidence" });
      await Promise.resolve();
    });
    expect(container?.textContent).not.toContain("alpha evidence");

    await act(async () => {
      beta.resolve({ data: "beta evidence" });
      await Promise.resolve();
    });
    expect(container?.textContent).toBe("beta evidence");
  });
});
