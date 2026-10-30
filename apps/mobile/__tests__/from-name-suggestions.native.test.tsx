/**
 * FromNameSuggestionsRow — the tenant's best-performing sender names as apply
 * chips under the from-name field (desktop parity:
 * composer/FromNameSuggestions.tsx).
 *
 * The parse rules live in src/lib/fromNamePicker.test.ts and the transport in
 * src/api/fromNamePicker.test.ts. What only a render test can hold:
 *
 *   - a chip press APPLIES that exact name (the whole point of the strip);
 *   - the open rate reaches a screen reader, since the chip shows only a name;
 *   - an EMPTY answer renders nothing at all — the server enforces its own
 *     min-campaigns floor, so "no rows" means "not enough history", never
 *     "draw placeholder chips";
 *   - a truthy NON-ARRAY from the wire renders nothing instead of throwing
 *     inside the identity sheet. `?? []` substitutes only for null/undefined
 *     and would hand a paged envelope or an HTML fallback straight to `.map`
 *     (lib/nullishArrayGuard.test.ts).
 *
 * IMPORTED BY RELATIVE PATH ON PURPOSE. jest.routes.config.cjs maps
 * `@/components/campaigns/*` to the null-component stub (the composer is heavy
 * and route suites do not want it), so importing this through the alias would
 * render the stub and assert nothing. The relative specifier bypasses the
 * mapper for this one module without changing what every other suite sees.
 */
import { describe, expect, it, jest, afterEach } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";

import { FromNameSuggestionsRow } from "../src/components/campaigns/FromNameSuggestionsRow";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

function settled(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(),
  };
}

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
});

describe("FromNameSuggestionsRow", () => {
  it("applies the exact name on the chip that was pressed", async () => {
    queryHarness.__setQueryResultForTests(
      settled([
        { fromName: "Jane from Acme", campaignsUsing: 6, openRate: 0.41, rank: 1 },
        { fromName: "Acme Marketing", campaignsUsing: 11, openRate: 0.29, rank: 2 },
      ]),
    );
    const onApply = jest.fn();
    await render(<FromNameSuggestionsRow current="" onApply={onApply} />);

    await fireEvent.press(
      screen.getByLabelText("Acme Marketing, 29% open rate across 11 campaigns"),
    );
    expect(onApply).toHaveBeenCalledWith("Acme Marketing");
  });

  it("speaks the performance the chip only shows as a name", async () => {
    queryHarness.__setQueryResultForTests(
      settled([
        { fromName: "Jane from Acme", campaignsUsing: 1, openRate: 0.415, rank: 1 },
      ]),
    );
    await render(<FromNameSuggestionsRow current="" onApply={jest.fn()} />);
    expect(
      screen.getByLabelText("Jane from Acme, 41.5% open rate across 1 campaign"),
    ).toBeTruthy();
  });

  it("renders nothing at all when the server had nothing above its floor", async () => {
    queryHarness.__setQueryResultForTests(settled([]));
    await render(<FromNameSuggestionsRow current="" onApply={jest.fn()} />);
    expect(
      screen.queryByText("Top performers by historical engagement:"),
    ).toBeNull();
  });

  it("survives a truthy non-array where the list should be", async () => {
    // The shapes that actually arrive: a paged envelope from a handler change,
    // and an HTML page from a proxy answering 200 for an absent upstream. `??`
    // passes both through; `Array.isArray` does not.
    for (const junk of [{ from_names: [] }, "<!doctype html>", 0]) {
      queryHarness.__setQueryResultForTests(settled(junk));
      await render(<FromNameSuggestionsRow current="" onApply={jest.fn()} />);
      expect(
        screen.queryByText("Top performers by historical engagement:"),
      ).toBeNull();
    }
  });
});
