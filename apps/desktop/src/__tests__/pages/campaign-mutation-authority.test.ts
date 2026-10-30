import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bulkTagCampaigns: vi.fn(),
  cloneCampaign: vi.fn(),
  createCampaignFolder: vi.fn(),
  deleteCampaign: vi.fn(),
  moveCampaignToFolder: vi.fn(),
  resendCampaign: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      bulkTagCampaigns: mocks.bulkTagCampaigns,
      createCampaignFolder: mocks.createCampaignFolder,
      deleteCampaign: mocks.deleteCampaign,
      moveCampaignToFolder: mocks.moveCampaignToFolder,
    },
    campaignCloneApi: {
      ...actual.campaignCloneApi,
      clone: mocks.cloneCampaign,
    },
    resendUnopenedApi: {
      ...actual.resendUnopenedApi,
      resend: mocks.resendCampaign,
    },
  };
});

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: vi.fn(),
  },
}));

import type { Campaign } from "../../lib/api-client";
import { useCampaignBulkActions as createCampaignBulkActions } from "../../pages/campaigns/useCampaignBulkActions";
import { createCampaignRowActions } from "../../pages/campaigns/useCampaignRowActions";
import {
  closeUnavailableCampaignMutationOverlays,
  resolveCampaignSnapshotMutationAuthority,
} from "../../pages/campaigns/useCampaignsController";
import type { CampaignsData } from "../../pages/campaigns/useCampaignsData";
import type { CampaignsState } from "../../pages/campaigns/useCampaignsState";
import type { CampaignsViewModel } from "../../pages/campaigns/useCampaignsViewModel";

const row = {
  id: "campaign-1",
  name: "Launch",
  subject: "Launch now",
  status: "sent",
} as Campaign;
const rowTwo = {
  ...row,
  id: "campaign-2",
  name: "Follow-up",
} as Campaign;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("campaign list mutation authority", () => {
  it("fails closed for retained or refresh-unverified snapshots independent of role", () => {
    const current = resolveCampaignSnapshotMutationAuthority({
      canMutate: true,
      canAdminMutate: true,
      roleStatus: "resolved",
      rowsAvailable: true,
      loading: false,
      refreshing: false,
      stale: false,
      error: null,
    });
    expect(current.canMutateCampaignSnapshot).toBe(true);
    expect(current.canAdminMutateCampaignSnapshot).toBe(true);

    const refreshing = resolveCampaignSnapshotMutationAuthority({
      canMutate: true,
      canAdminMutate: true,
      roleStatus: "resolved",
      rowsAvailable: true,
      loading: false,
      refreshing: true,
      stale: false,
      error: null,
    });
    expect(refreshing.canMutateCampaignSnapshot).toBe(false);
    expect(refreshing.canAdminMutateCampaignSnapshot).toBe(false);
    expect(refreshing.campaignMutationUnavailableReason).toContain(
      "refresh to finish",
    );

    const stale = resolveCampaignSnapshotMutationAuthority({
      canMutate: true,
      canAdminMutate: true,
      roleStatus: "resolved",
      rowsAvailable: true,
      loading: false,
      refreshing: false,
      stale: true,
      error: "offline",
    });
    expect(stale.canMutateCampaignSnapshot).toBe(false);
    expect(stale.campaignMutationUnavailableReason).toContain(
      "Refresh campaigns successfully",
    );
  });

  it("distinguishes editor and admin role loss with one recovery reason", () => {
    const viewer = resolveCampaignSnapshotMutationAuthority({
      canMutate: false,
      canAdminMutate: false,
      roleStatus: "resolved",
      rowsAvailable: true,
      loading: false,
      refreshing: false,
      stale: false,
      error: null,
    });
    expect(viewer.canMutateCampaignSnapshot).toBe(false);
    expect(viewer.campaignMutationUnavailableReason).toBe(
      "Ask a workspace editor or admin for edit access.",
    );
    expect(viewer.campaignAdminMutationUnavailableReason).toBe(
      "Ask a workspace admin to clone or resend campaigns.",
    );

    const editor = resolveCampaignSnapshotMutationAuthority({
      canMutate: true,
      canAdminMutate: false,
      roleStatus: "resolved",
      rowsAvailable: true,
      loading: false,
      refreshing: false,
      stale: false,
      error: null,
    });
    expect(editor.canMutateCampaignSnapshot).toBe(true);
    expect(editor.canAdminMutateCampaignSnapshot).toBe(false);
  });

  it("closes every affected overlay as soon as snapshot or role authority is lost", () => {
    const state = {
      setMoveTarget: vi.fn(),
      setBulkMoveOpen: vi.fn(),
      setBulkTagOpen: vi.fn(),
      setPendingBulkDeleteCount: vi.fn(),
      setResendTarget: vi.fn(),
    };
    closeUnavailableCampaignMutationOverlays(state, {
      canMutateCampaignSnapshot: false,
      canAdminMutateCampaignSnapshot: false,
    });
    expect(state.setMoveTarget).toHaveBeenCalledWith(null);
    expect(state.setBulkMoveOpen).toHaveBeenCalledWith(false);
    expect(state.setBulkTagOpen).toHaveBeenCalledWith(false);
    expect(state.setPendingBulkDeleteCount).toHaveBeenCalledWith(null);
    expect(state.setResendTarget).toHaveBeenCalledWith(null);
  });
});

describe("campaign list handler defense in depth", () => {
  it("blocks every previously exposed bulk callback after snapshot authority is lost", async () => {
    const state = {
      rows: [row],
      selectedIds: new Set(["campaign-1"]),
      bulkMovePick: "folder-1",
      bulkTagValue: "launch",
      setPendingBulkDeleteCount: vi.fn(),
      setBulkMoveOpen: vi.fn(),
      setBulkTagOpen: vi.fn(),
      setBulkTagValue: vi.fn(),
      setBulkBusy: vi.fn(),
      setSelectedIds: vi.fn(),
    } as unknown as CampaignsState;
    const data = {
      load: vi.fn(),
    } as unknown as CampaignsData;
    const view = {
      allPageSelected: false,
      pageRows: [row],
    } as unknown as CampaignsViewModel;
    const authority = {
      current: { canMutateCampaignSnapshot: true },
    };
    const actions = createCampaignBulkActions(state, data, view, authority);
    authority.current = { canMutateCampaignSnapshot: false };

    actions.promptBulkDelete();
    actions.promptBulkTag();
    await actions.bulkDelete();
    await actions.bulkMove();
    await actions.bulkTag();

    expect(mocks.deleteCampaign).not.toHaveBeenCalled();
    expect(mocks.moveCampaignToFolder).not.toHaveBeenCalled();
    expect(mocks.bulkTagCampaigns).not.toHaveBeenCalled();
    expect(data.load).not.toHaveBeenCalled();
    expect(state.setPendingBulkDeleteCount).toHaveBeenCalledWith(null);
    expect(state.setBulkMoveOpen).toHaveBeenCalledWith(false);
    expect(state.setBulkTagOpen).toHaveBeenCalledWith(false);
    expect(state.setBulkBusy).not.toHaveBeenCalledWith(true);
  });

  it("stops delete and move before item two when authority is lost mid-flight and preserves the rest", async () => {
    const exercise = async (operation: "delete" | "move"): Promise<void> => {
      const first = deferred<{ data: { ok: boolean; folder_id?: string } }>();
      const request =
        operation === "delete"
          ? mocks.deleteCampaign
          : mocks.moveCampaignToFolder;
      request.mockImplementationOnce(() => first.promise);
      const setSelectedIds = vi.fn();
      const state = {
        rows: [row, rowTwo],
        selectedIds: new Set(["campaign-1", "campaign-2"]),
        bulkMovePick: "folder-1",
        setPendingBulkDeleteCount: vi.fn(),
        setBulkMoveOpen: vi.fn(),
        setBulkBusy: vi.fn(),
        setSelectedIds,
      } as unknown as CampaignsState;
      const data = { load: vi.fn() } as unknown as CampaignsData;
      const authority = {
        current: {
          canMutateCampaignSnapshot: true,
          campaignMutationUnavailableReason: null as string | null,
        },
      };
      const actions = createCampaignBulkActions(
        state,
        data,
        {
          allPageSelected: true,
          pageRows: [row, rowTwo],
        } as CampaignsViewModel,
        authority,
      );

      const pending =
        operation === "delete" ? actions.bulkDelete() : actions.bulkMove();
      expect(request).toHaveBeenCalledTimes(1);
      authority.current = {
        canMutateCampaignSnapshot: false,
        campaignMutationUnavailableReason:
          "Refresh campaigns successfully before retrying.",
      };
      first.resolve({ data: { ok: true, folder_id: "folder-1" } });
      await pending;

      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[0]).toBe("campaign-1");
      const removeConfirmed = setSelectedIds.mock.calls[0]?.[0] as (
        previous: Set<string>,
      ) => Set<string>;
      expect(
        Array.from(removeConfirmed(new Set(["campaign-1", "campaign-2"]))),
      ).toEqual(["campaign-2"]);
      expect(data.load).toHaveBeenCalledTimes(1);
      expect(mocks.toastError).not.toHaveBeenCalled();
      expect(mocks.toastInfo).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message:
            operation === "delete"
              ? "Bulk delete stopped when campaign authority changed"
              : "Bulk move stopped when campaign authority changed",
          detail: expect.stringContaining("1 failed or unprocessed campaign"),
        }),
      );
    };

    await exercise("delete");
    await exercise("move");
  });

  it("blocks previously exposed folder, move, clone, resend, and calendar callbacks after downgrade", async () => {
    const state = {
      newFolderName: "Q3",
      moveTarget: row,
      movePick: "folder-1",
      resendTarget: row,
      resendSubject: "A new subject",
      setNewFolderName: vi.fn(),
      setMoveTarget: vi.fn(),
      setCloningId: vi.fn(),
      setResendTarget: vi.fn(),
      setResendSubject: vi.fn(),
      setResendErr: vi.fn(),
      setResendBusy: vi.fn(),
    } as unknown as CampaignsState;
    const data = {
      load: vi.fn(),
      loadFolders: vi.fn(),
    } as unknown as CampaignsData;
    const authority = {
      current: {
        canMutateCampaignSnapshot: true,
        canAdminMutateCampaignSnapshot: true,
      },
    };
    const actions = createCampaignRowActions(state, data, authority);
    authority.current = {
      canMutateCampaignSnapshot: false,
      canAdminMutateCampaignSnapshot: false,
    };

    await actions.createFolder();
    await actions.moveCampaign();
    await actions.cloneCampaign(row);
    actions.openResend(row);
    await actions.submitResend();
    expect(await actions.rescheduleFromCalendar(row, "2026-07-21")).toBe(false);

    expect(mocks.createCampaignFolder).not.toHaveBeenCalled();
    expect(mocks.moveCampaignToFolder).not.toHaveBeenCalled();
    expect(mocks.cloneCampaign).not.toHaveBeenCalled();
    expect(mocks.resendCampaign).not.toHaveBeenCalled();
    expect(data.load).not.toHaveBeenCalled();
    expect(data.loadFolders).not.toHaveBeenCalled();
    expect(state.setResendTarget).not.toHaveBeenCalled();
  });

  it("does not replace a different open campaign from an external row target", async () => {
    const state = {
      selected: row,
      setSelected: vi.fn(),
    } as unknown as CampaignsState;
    const data = { load: vi.fn() } as unknown as CampaignsData;
    const actions = createCampaignRowActions(state, data, {
      current: {
        canMutateCampaignSnapshot: true,
        canAdminMutateCampaignSnapshot: true,
      },
    });

    await actions.openCampaignById("campaign-2");

    expect(data.load).not.toHaveBeenCalled();
    expect(state.setSelected).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Close the open campaign before opening another one",
      detail:
        "This protects unsaved campaign work. Close the current campaign, then try again.",
    });
  });
});
