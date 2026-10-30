// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Staging, with service workers blocked by the browser: every page threw
// "Cannot read properties of undefined (reading 'waiting')".
//
// Source: Serwist's automatic registration. @serwist/next injects sw-entry
// into every page, and with `register` on (its default) it calls
// window.serwist.register() without awaiting it. That method reads
// `registration.waiting`; a browser that blocks service workers resolves the
// registration to undefined, so the read throws as an unhandled rejection.
// PwaRegistrar also registered the same worker, so the page had two
// registration paths.
//
// Now PwaRegistrar is the one path (next.config.mjs `register: false`), and
// it treats a missing or refused registration as "no offline support here":
// a debug log, no error. Both halves run for real below: Serwist's own
// sw-entry with the value the config gives it, and PwaRegistrar.
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { injectManifestOptions } from "@serwist/next/schema";

const toastMocks = vi.hoisted(() => ({ message: vi.fn() }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    message: toastMocks.message,
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/forms/newsletter" }));

type Register = (
  url: string,
  options?: RegistrationOptions,
) => Promise<unknown>;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

function stubServiceWorker(
  register: Register,
  controller: unknown = null,
): void {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn(register),
      controller,
      ready: new Promise(() => undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));
  }
}

let debug: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  toastMocks.message.mockReset();
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Serwist's automatic registration", () => {
  /** The `register` value next.config.mjs hands @serwist/next. */
  function configuredRegister(): boolean {
    const config = readFileSync(
      resolve(process.cwd(), "next.config.mjs"),
      "utf8",
    );
    const options = /withSerwist = mod\.default\(\{([\s\S]*?)\n {2}\}\);/.exec(
      config,
    )?.[1];
    if (!options)
      throw new Error("Serwist options not found in next.config.mjs");
    const explicit = /^\s{4}register:\s*(true|false),/m.exec(options)?.[1];
    if (explicit) return explicit === "true";
    // Absent means Serwist's own default, read from its schema.
    return injectManifestOptions.parse({
      swSrc: "src/app/sw.ts",
      swDest: "public/sw.js",
    }).register;
  }

  it("does not run where a blocked browser would make it throw", async () => {
    const register = configuredRegister();
    stubServiceWorker(async () => undefined); // blocked: no registration
    vi.stubGlobal("caches", {});
    (window as unknown as { __SERWIST_SW_ENTRY: unknown }).__SERWIST_SW_ENTRY =
      {
        sw: "/sw.js",
        scope: "/",
        register,
        cacheOnNavigation: false,
        reloadOnOnline: false,
      };

    const swEntry = resolve(
      realpathSync(resolve(process.cwd(), "node_modules/@serwist/next")),
      "dist/sw-entry.mjs",
    );
    await import(/* @vite-ignore */ pathToFileURL(swEntry).href);
    await flush();

    expect(unhandled.map(String)).toEqual([]);
    expect(navigator.serviceWorker.register).not.toHaveBeenCalled();
  });
});

describe("PwaRegistrar", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(): Promise<void> {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const { PwaRegistrar } = await import("@/components/pwa-registrar");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(PwaRegistrar));
    });
    await act(flush);
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("degrades quietly when the browser blocks service workers", async () => {
    stubServiceWorker(async () => undefined);
    await mount();

    expect(navigator.serviceWorker.register).toHaveBeenCalledTimes(1);
    expect(unhandled.map(String)).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      "[pwa] service worker registration unavailable in this browser",
    );
  });

  it("degrades quietly when registration is refused", async () => {
    stubServiceWorker(async () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    await mount();

    expect(unhandled.map(String)).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      "[pwa] service worker registration failed",
      expect.any(DOMException),
    );
  });

  it("still offers a waiting update when registration works", async () => {
    const waiting = { postMessage: vi.fn() };
    stubServiceWorker(
      async () => ({
        waiting,
        installing: null,
        navigationPreload: { enable: async () => undefined },
        addEventListener: vi.fn(),
      }),
      { scriptURL: "/sw.js" },
    );
    await mount();

    expect(toastMocks.message).toHaveBeenCalledWith(
      "Update available",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(debug).not.toHaveBeenCalled();
  });
});
