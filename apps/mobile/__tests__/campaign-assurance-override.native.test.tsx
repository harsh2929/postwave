import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type {
  CampaignAssuranceFinding,
  CampaignAssuranceOverride,
} from "@postwave/sdk";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  CampaignAssuranceFindingGovernance,
  CampaignAssuranceOverrideSheet,
} from "@/components/campaigns/CampaignAssuranceOverrideControl";

const finding = {
  id: "finding-1",
  code: "FACT_CONTRADICTION",
  overridable: true,
} as CampaignAssuranceFinding;
const override = {
  id: "override-1",
  finding_id: finding.id,
  decision: "allow_send",
  reason: "Approved for this exact frozen send.",
  created_at: "2026-08-30T12:00:00Z",
} as CampaignAssuranceOverride;

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

afterEach(() => {
  jest.clearAllMocks();
});

describe("mobile Campaign Assurance finding governance", () => {
  it("offers the governed action to an online admin when policy permits", async () => {
    const onOpen = jest.fn();
    await render(
      <CampaignAssuranceFindingGovernance
        finding={finding}
        existingOverride={undefined}
        effectiveRole="admin"
        online
        onOpen={onOpen}
      />,
      { wrapper },
    );
    await act(async () => {
      fireEvent.press(
        screen.getByLabelText(
          "Record governed decision for FACT_CONTRADICTION",
        ),
      );
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders honest role and policy handoffs instead of a doomed action", async () => {
    const roleView = await render(
      <CampaignAssuranceFindingGovernance
        finding={finding}
        existingOverride={undefined}
        effectiveRole="editor"
        online
        onOpen={jest.fn()}
      />,
      { wrapper },
    );
    expect(roleView.getByText(/Only a workspace owner or admin/u)).toBeTruthy();
    expect(roleView.queryByText("Record governed decision")).toBeNull();
    await act(async () => roleView.unmount());

    const policyView = await render(
      <CampaignAssuranceFindingGovernance
        finding={{ ...finding, overridable: false }}
        existingOverride={undefined}
        effectiveRole="owner"
        online
        onOpen={jest.fn()}
      />,
      { wrapper },
    );
    expect(
      policyView.getByText(/Policy marks this finding non-overridable/u),
    ).toBeTruthy();
    expect(policyView.queryByText("Record governed decision")).toBeNull();
  });

  it("shows an existing immutable receipt instead of a duplicate action", async () => {
    const view = await render(
      <CampaignAssuranceFindingGovernance
        finding={finding}
        existingOverride={override}
        effectiveRole="owner"
        online
        onOpen={jest.fn()}
      />,
      { wrapper },
    );
    expect(view.getByText(/Governed waiver/u)).toBeTruthy();
    expect(view.queryByText("Record governed decision")).toBeNull();
  });

  it("blocks an empty reason, submits a normalized reason, and surfaces API errors", async () => {
    const onSubmit = jest.fn();
    const onClose = jest.fn();
    const view = await render(
      <CampaignAssuranceOverrideSheet
        finding={finding}
        busy={false}
        submitError={null}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
      { wrapper },
    );
    await act(async () => {
      fireEvent.press(view.getByText("Record immutable decision"));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(view.getByText(/10 to 2000 characters/u)).toBeTruthy();

    await act(async () => {
      fireEvent.changeText(
        view.getByLabelText("Governed decision rationale"),
        "  Specific governed rationale.  ",
      );
    });
    await act(async () => {
      fireEvent.press(view.getByText("Record immutable decision"));
    });
    expect(onSubmit).toHaveBeenCalledWith({
      decision: "allow_send",
      reason: "Specific governed rationale.",
    });

    await act(async () => {
      view.rerender(
        <CampaignAssuranceOverrideSheet
          finding={finding}
          busy={false}
          submitError="The server rejected this governed decision."
          onClose={onClose}
          onSubmit={onSubmit}
        />,
      );
    });
    expect(
      view.getByText("The server rejected this governed decision."),
    ).toBeTruthy();
  });
});
