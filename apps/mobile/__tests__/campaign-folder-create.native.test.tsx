/**
 * Folder CREATE from the campaign folder-picker sheet — the mobile half of
 * "create a campaign folder" (desktop: useCampaignRowActions "New folder").
 *
 * The pure halves (trim mirror, exact/case conflict classification, 201-body
 * parse) are vitest-pinned in src/lib/campaignFolders.test.ts and
 * src/api/campaignOrganize.test.ts. What only a render can pin is the SURFACE
 * contract:
 *   - the sheet now offers a create field at all (its absence used to be
 *     recorded in this very file's header as deliberate);
 *   - the caption warns about the exact/case outcome BEFORE the tap;
 *   - Create hands the caller the NORMALISED name, and an empty or pending
 *     field cannot fire.
 *
 * Rendered via a RELATIVE import: jest.routes.config.cjs maps
 * `@/components/campaigns/*` to a null stub to keep route-suite composition
 * cheap, and a stub would make every assertion here vacuous.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";

import { CampaignFolderPickerSheet } from "../src/components/campaigns/CampaignBulkSheets";

const FOLDERS = [{ id: "f1", name: "Newsletters", campaignCount: 3 }];

function sheet(
  over: Partial<React.ComponentProps<typeof CampaignFolderPickerSheet>> = {},
) {
  return (
    <CampaignFolderPickerSheet
      visible
      onClose={jest.fn()}
      count={2}
      folders={FOLDERS}
      foldersLoading={false}
      foldersFailed={false}
      onPick={jest.fn()}
      onCreate={jest.fn()}
      pending={false}
      {...over}
    />
  );
}

describe("campaign folder create (picker sheet)", () => {
  it("creates with the trimmed name in one gesture", async () => {
    const onCreate = jest.fn();
    const result = await render(sheet({ onCreate }));
    await fireEvent.changeText(
      result.getByLabelText("Name for a new folder"),
      "  Q3 Launch  ",
    );
    await fireEvent.press(result.getByLabelText("Create"));
    expect(onCreate).toHaveBeenCalledWith("Q3 Launch");
  });

  it("refuses an empty name and a create while one is in flight", async () => {
    const onCreate = jest.fn();
    const result = await render(sheet({ onCreate }));
    const create = result.getByLabelText("Create");
    expect(create.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(create);
    expect(onCreate).not.toHaveBeenCalled();

    const pending = await render(sheet({ onCreate, pending: true }));
    await fireEvent.changeText(
      pending.getByLabelText("Name for a new folder"),
      "Launches",
    );
    expect(
      pending.getByLabelText("Filing…").props.accessibilityState.disabled,
    ).toBe(true);
  });

  it("says an exact name will reuse the existing folder, before the tap", async () => {
    const result = await render(sheet());
    await fireEvent.changeText(
      result.getByLabelText("Name for a new folder"),
      "Newsletters",
    );
    expect(
      result.getByText(/already exists — this files the selection into it/),
    ).toBeTruthy();
  });

  it("warns that a case-only variant mints a second, separate folder", async () => {
    const result = await render(sheet());
    await fireEvent.changeText(
      result.getByLabelText("Name for a new folder"),
      "newsletters",
    );
    expect(
      result.getByText(/different casing.*second, separate folder/),
    ).toBeTruthy();
  });

  it("invites the first folder by name in an empty workspace, not a web hand-off", async () => {
    const result = await render(sheet({ folders: [] }));
    expect(result.getByText(/Name the first one below/)).toBeTruthy();
    expect(result.queryByText(/created on the web app/)).toBeNull();
  });
});
