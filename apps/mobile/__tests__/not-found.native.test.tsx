/**
 * A link that goes nowhere must land somewhere branded, with a way back.
 *
 * Without a `+not-found` route Expo Router shows its own "Unmatched Route"
 * page: an unstyled dark screen carrying the raw URL and a developer's
 * "Sitemap" link. Reached in-app on 2026-08-19 by opening a `moosewave://` link
 * with no matching route.
 *
 * The links that actually miss are outside the user's control — a campaign
 * email sent before a screen was renamed, a shared link opened on an older
 * build — so this screen has to (a) not blame them, (b) name the address for a
 * bug report, and (c) offer a way back into the app.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import NotFoundScreen from "../app/+not-found";

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

describe("the not-found screen", () => {
  it("mounts", async () => {
    await render(<NotFoundScreen />, { wrapper });
    expect(screen.getByText(/doesn't open anything/u)).toBeTruthy();
  });

  it("does not blame the reader", async () => {
    await render(<NotFoundScreen />, { wrapper });
    expect(screen.getByText(/Nothing is wrong with your account/u)).toBeTruthy();
  });

  it("offers a way back into the app", async () => {
    await render(<NotFoundScreen />, { wrapper });
    expect(screen.getByLabelText("Go to the dashboard")).toBeTruthy();
  });
});
