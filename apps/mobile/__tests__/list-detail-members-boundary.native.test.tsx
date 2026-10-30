import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";

import ListDetail from "../app/(tabs)/lists/[id]";

const {
  __getQueryOptionsForTests,
  __resetQueryResultForTests,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./mocks/reactQuery.cjs");
const {
  request,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./mocks/apiRuntime.cjs");

afterEach(() => {
  __resetQueryResultForTests();
  request.mockReset();
});

describe("mobile list member privacy boundary", () => {
  it("keeps the generic subscriber roster disabled on the default Overview tab", async () => {
    const rendered = await render(<ListDetail />);
    const membersQuery = __getQueryOptionsForTests().find(
      (entry: { kind: string; options: { queryKey?: readonly unknown[] } }) =>
        entry.kind === "infinite" &&
        entry.options.queryKey?.includes("members"),
    );

    expect(membersQuery?.options.enabled).toBe(false);
    expect(
      request.mock.calls.some((call: unknown[]) =>
        String(call[1] ?? "").includes("/subscribers"),
      ),
    ).toBe(false);

    await rendered.unmount();
  });
});
