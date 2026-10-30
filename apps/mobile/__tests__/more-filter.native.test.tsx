import { describe, expect, it } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import More from "../app/(tabs)/more";

/**
 * More is the app's REAL navigation surface: 24 of its 29 screens are reachable
 * only from here, spread over six sections in manifest order. Favourites and
 * Recents took the top off that scroll for destinations you already know you
 * want; this covers the other half — "where is DMARC?" — which previously had
 * no answer but reading six section lists.
 *
 * Three things are pinned, because each of them is a way the feature could ship
 * broken and still look fine in a screenshot:
 *
 *   1. Typing actually NARROWS.
 *   2. Zero matches says so. `MoreSection` renders null when it has no rows —
 *      right while browsing, and exactly wrong under a search box, where it
 *      would leave a blank screen that reads as a broken filter.
 *   3. Clearing restores the browse view, sections and all.
 *
 * `render` in this harness resolves asynchronously and React 19 flushes the
 * state update from `fireEvent` on a later tick, so every assertion after a
 * keystroke goes through `waitFor` rather than reading the tree synchronously.
 */

async function mount() {
  return await render(React.createElement(More), {
    wrapper: ({ children }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        {children}
      </SafeAreaProvider>
    ),
  });
}

const FILTER_LABEL = "Filter the More menu";

async function type(text: string): Promise<void> {
  fireEvent.changeText(screen.getByLabelText(FILTER_LABEL), text);
}

describe("More menu filter", () => {
  it("renders the manifest sections when no query is typed", async () => {
    await mount();
    expect(screen.getByLabelText(FILTER_LABEL)).toBeTruthy();
    expect(screen.getByText("Audience")).toBeTruthy();
    expect(screen.getByText("Account")).toBeTruthy();
  });

  it("collapses to one ranked list and drops non-matches", async () => {
    await mount();
    await type("dmarc");
    // The six section headings are replaced by ONE heading carrying an exact,
    // uncompacted count. The count is deliberately not asserted as a literal:
    // the ranker is the palette's shared `rankFuzzy`, whose loose-subsequence
    // tier legitimately admits more than the obvious hit, and pinning the
    // number here would make this test a change-detector for that ranking.
    // Two nodes carry the count on purpose — the section heading and
    // SearchField's polite live region — so this asserts presence, not
    // uniqueness.
    await waitFor(() =>
      expect(screen.getAllByText(/^\d+ match(es)?$/u).length).toBeGreaterThan(
        0,
      ),
    );
    expect(screen.queryByText("Audience")).toBeNull();
    // What DOES matter: the destination the query names is present.
    //
    // The visible label comes from `labelFor()` in @postwave/nav, which the
    // route manifest renders — NOT from the mobile-local route registry. This
    // asserted "DMARC reports" from the latter, so it was checking a string
    // the menu never displays.
    expect(screen.getByText("DMARC")).toBeTruthy();
  });

  it("announces the count with a real plural, not \"3 matchs\"", async () => {
    // SearchField built its live-region announcement as `${noun}s`, so the two
    // screens that count MATCHES announced "3 matchs" — a defect only a
    // VoiceOver user would ever encounter, which is why it survived.
    await mount();
    await type("a");
    await waitFor(() =>
      expect(screen.getAllByText(/^\d+ matches$/u).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/matchs/u)).toBeNull();
  });

  it("states zero matches instead of rendering a blank screen", async () => {
    await mount();
    await type("zzzz-no-such-screen");
    await waitFor(() =>
      expect(screen.getByText("No matching destination")).toBeTruthy(),
    );
  });

  it("restores the browse view when the query is cleared", async () => {
    await mount();
    await type("dmarc");
    await waitFor(() => expect(screen.queryByText("Audience")).toBeNull());
    await type("");
    await waitFor(() => expect(screen.getByText("Audience")).toBeTruthy());
  });

  /**
   * MAP#73. The six section headings above are a CLAIM about coverage, and a
   * user who scans Content and finds no Referrals concludes Moosewave has none
   * rather than that it has one on desktop. The closing block is what stops
   * the taxonomy reading as exhaustive — so it has to actually render, and it
   * has to disappear under a filter (where the screen is answering "where is
   * X", not "what does this app not do").
   */
  it("closes the browse view by naming what is NOT on this phone", async () => {
    await mount();
    expect(screen.getByText("Not on this phone")).toBeTruthy();
    expect(screen.getByText("Referrals")).toBeTruthy();
    expect(screen.getByText("Affiliates")).toBeTruthy();
  });

  it("hides the not-on-this-phone block while filtering", async () => {
    await mount();
    await type("dmarc");
    await waitFor(() =>
      expect(screen.queryByText("Not on this phone")).toBeNull(),
    );
  });
});
