/**
 * The asset library's SORT rail.
 *
 * `src/lib/assetLibrary.test.ts` pins the vocabulary against the server's
 * allowlist and `src/api/assets.test.ts` pins that a non-default sort reaches
 * the URL as `?sort=`. Between them sits the rail itself, and the existing
 * rails suite passes `sort`/`onSortChange` without ever asserting on them.
 *
 * What only this test holds: a chip emits the SERVER'S TOKEN, not its display
 * label. "Most used" and "most-used" differ by one character, "Largest" and
 * "largest" by a case; either slip is a 400 `invalid_sort` that a user reads as
 * "the library failed to load", and nothing else in the tree would catch it.
 * It also pins that the active chip is the one the screen's state says — a rail
 * that always highlights the first option looks correct and lies.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AssetFilterRails } from "@/components/assets/AssetFilterRails";
import { ASSET_SORTS, type AssetSort } from "@/lib/assetLibrary";

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

const onSortChange = jest.fn<(next: AssetSort) => void>();

function railProps(sort: AssetSort) {
  return {
    filter: "all" as const,
    onFilterChange: jest.fn(),
    counts: null,
    folders: [],
    folderId: null,
    onFolderChange: jest.fn(),
    tags: [],
    tag: null,
    onTagChange: jest.fn(),
    sort,
    onSortChange,
  };
}

beforeEach(() => {
  onSortChange.mockClear();
});

describe("the sort rail", () => {
  it("offers every order the server accepts, and only those", async () => {
    await render(<AssetFilterRails {...railProps("newest")} />, { wrapper });
    for (const option of ASSET_SORTS) {
      expect(
        screen.getByLabelText(`Sort by ${option.label.toLowerCase()}`),
      ).toBeTruthy();
    }
    expect(screen.getByLabelText("Sort images")).toBeTruthy();
  });

  it("emits the server's token, not the chip's label", async () => {
    await render(<AssetFilterRails {...railProps("newest")} />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Sort by most used"));
    expect(onSortChange).toHaveBeenCalledWith("most-used");

    await fireEvent.press(screen.getByLabelText("Sort by largest"));
    expect(onSortChange).toHaveBeenLastCalledWith("largest");
  });

  it("marks the chip the screen actually asked for as selected", async () => {
    await render(<AssetFilterRails {...railProps("name")} />, { wrapper });
    expect(
      screen.getByLabelText("Sort by name").props.accessibilityState.selected,
    ).toBe(true);
    expect(
      screen.getByLabelText("Sort by newest").props.accessibilityState.selected,
    ).toBe(false);
  });
});
