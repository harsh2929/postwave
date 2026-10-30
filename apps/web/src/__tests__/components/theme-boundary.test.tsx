// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const nextThemes = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));

vi.mock("next-themes", () => ({
  ThemeProvider: ({
    children,
    ...props
  }: {
    children: ReactNode;
    [key: string]: unknown;
  }) => {
    nextThemes.props.push(props);
    return children;
  },
}));

import { ThemeProvider } from "@/components/theme-provider";
import { THEME_SCRIPT } from "@/lib/root-layout-scripts";

function installMatchMedia(prefersDark: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: prefersDark,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function runPrepaintTheme({
  path,
  storedTheme,
  prefersDark,
}: {
  path: string;
  storedTheme?: "light" | "dark" | "system";
  prefersDark: boolean;
}): void {
  window.history.replaceState(null, "", path);
  window.localStorage.clear();
  if (storedTheme) window.localStorage.setItem("theme", storedTheme);
  installMatchMedia(prefersDark);
  // Supply the browser globals as parameters so the exact immutable script body
  // executes without rewriting it for the test environment.
  Function("window", "document", "localStorage", "location", THEME_SCRIPT)(
    window,
    document,
    window.localStorage,
    window.location,
  );
}

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("color-scheme");
  document.body.innerHTML = "";
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  nextThemes.props.length = 0;
  vi.restoreAllMocks();
});

describe("root theme boundary", () => {
  it("keeps native control color-scheme on the same class contract", () => {
    const globalStyles = readFileSync(
      resolve(process.cwd(), "src/app/globals.css"),
      "utf8",
    );
    expect(globalStyles).toMatch(
      /html\s*\{[^}]*color-scheme:\s*light;[^}]*\}/s,
    );
    expect(globalStyles).toMatch(
      /html\.dark\s*\{[^}]*color-scheme:\s*dark;[^}]*\}/s,
    );
  });

  it("resolves the stored system theme before paint", () => {
    runPrepaintTheme({
      path: "/app/campaigns",
      storedTheme: "system",
      prefersDark: true,
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    runPrepaintTheme({
      path: "/app/campaigns",
      storedTheme: "system",
      prefersDark: false,
    });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("keeps fixed-light routes light even when dark is stored", () => {
    document.documentElement.classList.add("dark");
    runPrepaintTheme({
      path: "/docs/getting-started",
      storedTheme: "dark",
      prefersDark: true,
    });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("synchronously clears dashboard theme state when the boundary unmounts", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ThemeProvider attribute="class">Dashboard</ThemeProvider>);
    });
    expect(nextThemes.props.at(-1)).toMatchObject({
      attribute: "class",
      enableColorScheme: false,
    });

    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
    await act(async () => root.unmount());

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("");
  });
});
