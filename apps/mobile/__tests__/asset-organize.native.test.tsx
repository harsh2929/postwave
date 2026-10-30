/**
 * Asset organising from the phone — the mobile half of desktop's Assets.tsx
 * folder/tag authoring. The pure halves (normaliser mirrors, 409-before-the-
 * tap, answer-body parses) are vitest-pinned in src/lib/assetOrganize.test.ts
 * and src/api/assets.test.ts. What only a render can pin is the SURFACE
 * contract:
 *   - tapping a folder row files the image there; the current folder offers
 *     no re-file; "Remove from folder" is a first-class row;
 *   - a taken folder name disables Create and says why BEFORE the tap;
 *   - the tag field previews the server's normalisation before the tap and
 *     hands the caller the NORMALISED tag;
 *   - a failed tag read says so instead of claiming "No tags yet".
 *
 * Rendered via a RELATIVE import: jest.routes.config.cjs has no asset-
 * component stub today, but the campaigns suites' convention is relative
 * imports for directly-rendered components, and it keeps this suite immune to
 * a future mapping.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";

import { AssetOrganizeSheet } from "../src/components/assets/AssetOrganizeSheet";

const FOLDERS = [
  { id: "f1", name: "Newsletters", createdAt: null, assetCount: 3 },
  { id: "f2", name: "Launches", createdAt: null, assetCount: 0 },
];

function sheet(
  over: Partial<React.ComponentProps<typeof AssetOrganizeSheet>> = {},
) {
  return (
    <AssetOrganizeSheet
      visible
      onClose={jest.fn()}
      assetId="a1"
      assetFilename="hero.png"
      currentFolderId={null}
      folders={FOLDERS}
      foldersLoading={false}
      foldersFailed={false}
      tags={["hero"]}
      tagsLoading={false}
      tagsFailed={false}
      busy={false}
      onMove={jest.fn()}
      onCreateFolder={jest.fn()}
      onRenameFolder={jest.fn()}
      onDeleteFolder={jest.fn()}
      onAddTag={jest.fn()}
      onRemoveTag={jest.fn()}
      {...over}
    />
  );
}

describe("asset organise sheet — folders", () => {
  it("files the image into a tapped folder", async () => {
    const onMove = jest.fn();
    const result = await render(sheet({ onMove }));
    await fireEvent.press(result.getByLabelText("Launches"));
    expect(onMove).toHaveBeenCalledWith("f2", "Launches");
  });

  it("offers no re-file into the current folder, and a first-class way out", async () => {
    const onMove = jest.fn();
    const result = await render(sheet({ onMove, currentFolderId: "f1" }));
    const current = result.getByLabelText("Newsletters, current folder");
    expect(current.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(current);
    expect(onMove).not.toHaveBeenCalled();

    await fireEvent.press(result.getByLabelText("Remove from folder"));
    expect(onMove).toHaveBeenCalledWith(null, null);
  });

  it("creates with the normalised name in one gesture", async () => {
    const onCreateFolder = jest.fn();
    const result = await render(sheet({ onCreateFolder }));
    await fireEvent.changeText(
      result.getByLabelText("Name for a new folder"),
      "  Q3   Launch ",
    );
    await fireEvent.press(result.getByLabelText("Create"));
    expect(onCreateFolder).toHaveBeenCalledWith("Q3 Launch");
  });

  it("says a taken name is a 409 BEFORE the tap, and disables Create", async () => {
    const onCreateFolder = jest.fn();
    const result = await render(sheet({ onCreateFolder }));
    await fireEvent.changeText(
      result.getByLabelText("Name for a new folder"),
      "Newsletters",
    );
    expect(
      result.getByText(/already exists — tap it in the list above/),
    ).toBeTruthy();
    const create = result.getByLabelText("Create");
    expect(create.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(create);
    expect(onCreateFolder).not.toHaveBeenCalled();
  });
});

describe("asset organise sheet — tags", () => {
  it("previews the server's normalisation before the tap and adds the normalised tag", async () => {
    const onAddTag = jest.fn();
    const result = await render(sheet({ onAddTag }));
    await fireEvent.changeText(
      result.getByLabelText("Tag to add"),
      "Q3 Launch!",
    );
    expect(result.getByText(/Will be saved as “q3 launch”/)).toBeTruthy();
    await fireEvent.press(result.getByLabelText("Add tag"));
    expect(onAddTag).toHaveBeenCalledWith("q3 launch");
  });

  it("removes a tag from its chip", async () => {
    const onRemoveTag = jest.fn();
    const result = await render(sheet({ onRemoveTag }));
    await fireEvent.press(result.getByLabelText("Remove the hero tag"));
    expect(onRemoveTag).toHaveBeenCalledWith("hero");
  });

  it("a failed tag read says so instead of claiming the image is untagged", async () => {
    const result = await render(sheet({ tags: null, tagsFailed: true }));
    expect(result.getByText(/couldn't be loaded/)).toBeTruthy();
    expect(result.queryByText("No tags yet.")).toBeNull();
  });
});
