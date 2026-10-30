/**
 * Private podcast feeds — the render contract (register: private podcast feed
 * token management, messaging-support).
 *
 * The boundary itself is pinned in src/lib/privateFeedBoundary.test.ts, which
 * quotes desktop and the routeauth manifest. This file pins the part a reader
 * experiences, and the four ways a "held back" screen goes wrong:
 *
 *  - it says something the platform does not say → the copy is asserted
 *    against the exported constants, which the boundary test holds to desktop;
 *  - it offers a Retry, turning a product boundary into a transient failure;
 *  - it grows a control — anything that mints, rotates, reveals or revokes a
 *    feed token would put a live bearer credential on a phone, which is the
 *    exact thing the first checklist item holds;
 *  - it shouts the hold at a viewer who could never act on it.
 *
 * The last test pins the mount, because a disclosure nobody can reach is the
 * same as no disclosure.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { PrivateFeedGateRow } from "@/components/archive/PrivateFeedGateRow";
import {
  PRIVATE_PODCAST_GATE_TITLE,
  PRIVATE_PODCAST_MOBILE_NOTE,
  PRIVATE_PODCAST_NO_CHANGE_NOTE,
  PRIVATE_PODCAST_RELEASE_CHECKLIST,
  PRIVATE_PODCAST_UNAVAILABLE_REASON,
} from "@/lib/privateFeedBoundary";

const ROW = "Private subscriber feeds are review gated";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

async function openSheet() {
  await render(<PrivateFeedGateRow canAdmin />, { wrapper });
  await fireEvent.press(screen.getByLabelText(ROW));
}

describe("PrivateFeedGateRow", () => {
  it("renders nothing at all below admin", async () => {
    await render(<PrivateFeedGateRow canAdmin={false} />, { wrapper });
    expect(screen.queryByLabelText(ROW)).toBeNull();
    expect(screen.queryByText(PRIVATE_PODCAST_GATE_TITLE)).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("is one quiet row until an admin presses it", async () => {
    await render(<PrivateFeedGateRow canAdmin />, { wrapper });
    expect(screen.getByLabelText(ROW)).toBeTruthy();
    expect(screen.queryByText(PRIVATE_PODCAST_GATE_TITLE)).toBeNull();
  });

  it("states the hold in the platform's own words", async () => {
    await openSheet();
    expect(screen.getByText(PRIVATE_PODCAST_GATE_TITLE)).toBeTruthy();
    expect(screen.getByText(PRIVATE_PODCAST_UNAVAILABLE_REASON)).toBeTruthy();
    expect(screen.getByText(PRIVATE_PODCAST_NO_CHANGE_NOTE)).toBeTruthy();
    expect(screen.getByText(PRIVATE_PODCAST_MOBILE_NOTE)).toBeTruthy();
    for (const item of PRIVATE_PODCAST_RELEASE_CHECKLIST) {
      expect(screen.getByText(`•  ${item}`)).toBeTruthy();
    }
  });

  it("offers no retry, because nothing failed", async () => {
    await openSheet();
    for (const label of [/retry/iu, /try again/iu, /refresh/iu]) {
      expect(screen.queryByText(label)).toBeNull();
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });

  it("grows no control that could touch a feed token", async () => {
    await openSheet();
    for (const verb of [/mint/iu, /rotate/iu, /revoke/iu, /reveal/iu, /copy/iu]) {
      expect(screen.queryByLabelText(verb)).toBeNull();
    }
    // Close is the only action the sheet adds; the row that opened it is the
    // only other button on screen.
    const buttons = screen.getAllByRole("button");
    expect(
      buttons.map((node) => node.props.accessibilityLabel).sort(),
    ).toEqual(["Close the private feed release hold", ROW]);
  });

  it("never renders a token, a feed URL or a subscriber email", async () => {
    await openSheet();
    const rendered = JSON.stringify(screen.toJSON());
    expect(rendered).not.toMatch(/feed\/[A-Za-z0-9_-]{8,}\.xml/u);
    expect(rendered).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/u);
    expect(rendered).not.toContain("/api/public/podcast/");
  });

  it("closes back to the row", async () => {
    await openSheet();
    await fireEvent.press(
      screen.getByLabelText("Close the private feed release hold"),
    );
    expect(screen.getByLabelText(ROW)).toBeTruthy();
  });

  it("is mounted on the archive screen", () => {
    const source = readFileSync(
      join(process.cwd(), "app/(tabs)/archive.tsx"),
      "utf8",
    );
    expect(source).toContain("<PrivateFeedGateRow");
    // The admin gate the archive already computes for the other admin verb.
    expect(source).toContain("canAdmin={canUnpublish}");
  });

  it("wires no podcast token transport anywhere in the app", () => {
    const roots = ["src", "app"].map((dir) => join(process.cwd(), dir));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/u.test(entry.name)) continue;
        if (full.includes("privateFeedBoundary")) continue;
        if (readFileSync(full, "utf8").includes("/podcast/subscribers/")) {
          offenders.push(full);
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
