import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";

import { SmsCampaignControls } from "@/components/sms/SmsCampaignControls";

describe("mobile SMS campaign controls release hold", () => {
  it("renders a content-light hold with no live dispatch affordance", async () => {
    const view = await render(<SmsCampaignControls />);
    expect(view.getByText(/Campaign dispatch is release-held/u)).toBeTruthy();
    expect(view.getByText(/No campaign request is made/u)).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
  });

  it("explains the hold without quoting the server's gate code", async () => {
    // The sentence used to end "…from this inbox
    // (sms_broadcast_dispatch_release_held)." That identifier is for us, not
    // for the operator reading the card; it belongs somewhere diagnostic.
    const view = await render(<SmsCampaignControls />);
    expect(
      view.queryByText(/sms_broadcast_dispatch_release_held/u),
    ).toBeNull();
    expect(
      view.getByTestId("sms-campaign-hold-sms_broadcast_dispatch_release_held"),
    ).toBeTruthy();
  });
});
