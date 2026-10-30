/**
 * Round-trip-shape guard for the organise sheet's tag read.
 *
 * `AssetOrganizePanel` is mounted by the asset DETAIL sheet whether or not
 * anyone opened the organise control, so keying its tag read on the asset id
 * alone spent a round trip (50-300ms on a phone) on every row TAP — for a
 * disclosure nobody had touched, competing with the preview the reader is
 * actually waiting for. A closed disclosure must not pay for its data.
 *
 * The other half matters just as much: the read must still happen the moment
 * the sheet opens, because the grid row carries no tags and the sheet is the
 * only place they are shown.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";

const tagListCalls: (string | null)[] = [];

jest.mock("@/hooks/useAssetOrganize", () => ({
  useAssetTagList: (assetId: string | null) => {
    tagListCalls.push(assetId);
    return { data: null, isLoading: false, isError: false };
  },
  useAssetOrganizeActions: () => ({
    busy: false,
    moveToFolder: jest.fn(),
    createFolderAndMove: jest.fn(),
    renameFolder: jest.fn(),
    deleteFolder: jest.fn(),
    addTag: jest.fn(),
    removeTag: jest.fn(),
  }),
}));

// eslint-disable-next-line import/first
import { AssetOrganizePanel } from "../src/components/assets/AssetOrganizePanel";

const ASSET = {
  id: "a1",
  filename: "hero.png",
  version: 3,
  folderId: null,
} as unknown as React.ComponentProps<typeof AssetOrganizePanel>["asset"];

function panel(visible: boolean) {
  return (
    <AssetOrganizePanel
      visible={visible}
      onClose={jest.fn()}
      assetId="a1"
      asset={ASSET}
      folders={[]}
      foldersLoading={false}
      foldersFailed={false}
    />
  );
}

describe("the closed organise sheet does not read this asset's tags", () => {
  it("passes no asset id while the sheet is shut, so the query stays disabled", async () => {
    tagListCalls.length = 0;

    await render(panel(false));

    expect(tagListCalls.length).toBeGreaterThan(0);
    // `useAssetTagList` is `enabled: … && Boolean(assetId)`, so a null id is
    // the disabled state — no request leaves for a control nobody opened.
    expect(tagListCalls.every((id) => id === null)).toBe(true);
  });

  it("still reads them the moment the sheet is open", async () => {
    tagListCalls.length = 0;

    await render(panel(true));

    expect(tagListCalls).toContain("a1");
  });
});
