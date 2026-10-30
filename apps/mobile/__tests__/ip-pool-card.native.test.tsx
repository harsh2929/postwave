/**
 * The IP-pool card at the rendered seam.
 *
 * The vitest suite proves the reading; what only a render can prove is that
 * the card never TURNS a reading into a stronger claim than the data supports.
 * Three failures are possible here and all three are silent:
 *
 *   1. A missing projection drawn as the shared pool. "Which IPs do we send
 *      from?" is a deliverability question with a support ticket attached; a
 *      card that answers "Shared" because a field was absent sends the
 *      operator to argue about a lane they may not be on.
 *   2. "Not reported by this server" printed when there was no server. The
 *      sending-settings screen renders its body with `row === undefined`
 *      whenever the read gate is closed (pinned by the first case in
 *      sending-settings.native.test.tsx), so this state is reachable, and it
 *      is a claim about someone else's infrastructure manufactured out of our
 *      own missing read.
 *   3. The dedicated/shared pill disagreeing with the line beside it — the
 *      pill is what an operator glances at and the line is what VoiceOver
 *      reads, so they have to be one decision.
 *
 * Rendered directly rather than through the screen: the screen's own suite
 * covers the wiring, and these are the card's states, including one the screen
 * can only reach through a closed gate.
 */
import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";

import { IpPoolCard } from "../src/components/deliverability/IpPoolCard";

describe("IpPoolCard", () => {
  it("names a dedicated pool and says who provisions it", async () => {
    const screen = await render(
      <IpPoolCard row={{ ip_pool: { name: "pool-eu-1", dedicated: true } }} />,
    );
    expect(screen.getByText("pool-eu-1")).toBeTruthy();
    expect(screen.getByText("Dedicated")).toBeTruthy();
    expect(
      screen.getByText(/provisioned and managed by support/u),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /actual message route and provider lane are not certified here/u,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(/outbound mail routes via this pool/u),
    ).toBeNull();
  });

  it("calls a pool shared only when the server said dedicated=false", async () => {
    const screen = await render(
      <IpPoolCard row={{ ip_pool: { name: "shared", dedicated: false } }} />,
    );
    expect(screen.getByText("shared")).toBeTruthy();
    expect(screen.getByText("Shared")).toBeTruthy();
  });

  it("reads a VERIFIED row with no projection as not-reported, not as shared", async () => {
    const screen = await render(<IpPoolCard row={{}} />);
    expect(
      screen.getByText("Unknown — not reported by this server"),
    ).toBeTruthy();
    expect(
      screen.getByText(/verified settings response did not include/u),
    ).toBeTruthy();
    // No pill at all: a pill is a claim about the lane.
    expect(screen.queryByText("Shared")).toBeNull();
    expect(screen.queryByText("Dedicated")).toBeNull();
  });

  it("blames nobody but itself when no settings row was loaded at all", async () => {
    const screen = await render(<IpPoolCard row={undefined} />);
    expect(
      screen.getByText("Unknown — no settings response has been verified"),
    ).toBeTruthy();
    expect(
      screen.getByText(/has not verified a settings response/u),
    ).toBeTruthy();
    // The distinction this state exists for: it must NOT report on a server
    // that was never called, and it must not offer the support sentence as
    // though an assignment had been read.
    expect(
      screen.queryByText("Unknown — not reported by this server"),
    ).toBeNull();
    expect(screen.queryByText("Shared")).toBeNull();
  });

  it("says the same thing to VoiceOver that it prints on screen", async () => {
    const known = await render(
      <IpPoolCard row={{ ip_pool: { name: "pool-eu-1", dedicated: true } }} />,
    );
    expect(
      known.getByLabelText(
        "Sending IP pool: pool-eu-1 · Dedicated. Dedicated pools are provisioned and managed by support.",
      ),
    ).toBeTruthy();

    const unverified = await render(<IpPoolCard row={undefined} />);
    expect(
      unverified.getByLabelText(
        "Sending IP pool: Unknown — no settings response has been verified.",
      ),
    ).toBeTruthy();
  });
});
