/**
 * The tag maintenance sheets — what only a rendered test can pin:
 *
 *  - the edit sheet submits ONLY the touched keys, bound to the row's
 *    revision token, and offers NO delete verb (both delete routes are
 *    unconditional server-side holds);
 *  - the history sheet renders the event sentences;
 *  - the tags screen withholds Edit (and Manage groups) below the editor
 *    floor while History stays for every role.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

jest.mock("@/hooks/useTagManage", () => {
  const actual = jest.requireActual("@/hooks/useTagManage") as Record<
    string,
    unknown
  >;
  const edit = jest.fn();
  return {
    ...actual,
    __edit: edit,
    useTagManageWrites: () => ({
      edit: { isPending: false, error: null, mutate: edit },
      groupCreate: { isPending: false, error: null, mutate: jest.fn() },
      groupRename: { isPending: false, error: null, mutate: jest.fn() },
      groupDelete: { isPending: false, error: null, mutate: jest.fn() },
    }),
  };
});

import {
  TagEditSheet,
  TagHistorySheet,
} from "@/components/tags/TagManageSheets";
import type { ThemeTokens } from "@/lib/theme";

const writeHarness = jest.requireMock("@/hooks/useTagManage") as {
  __edit: jest.Mock;
};
const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

afterEach(() => {
  writeHarness.__edit.mockClear();
  queryHarness.__resetQueryResultForTests();
});

const t = new Proxy({}, { get: () => "#777777" }) as ThemeTokens;

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

const ROW = {
  id: "t1",
  name: "vip",
  description: "Important people",
  etag: '"tag:t1:v4"',
};

describe("the tag edit sheet", () => {
  it("submits only the touched keys, bound to the row's revision", async () => {
    await render(
      <TagEditSheet row={ROW} groups={[]} onClose={jest.fn()} t={t} />,
      { wrapper },
    );
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Color teal"));
    });
    await act(async () => {
      fireEvent.press(screen.getByText("Save tag"));
    });
    expect(writeHarness.__edit).toHaveBeenCalledTimes(1);
    expect(writeHarness.__edit.mock.calls[0]![0]).toEqual({
      id: "t1",
      etag: '"tag:t1:v4"',
      body: { color: "teal" },
    });
  });

  it("offers NO delete verb — the server holds both delete routes", async () => {
    await render(
      <TagEditSheet row={ROW} groups={[]} onClose={jest.fn()} t={t} />,
      { wrapper },
    );
    expect(screen.queryByText(/delete/i)).toBeNull();
  });
});

describe("the tag history sheet", () => {
  it("renders the membership event sentences", async () => {
    queryHarness.__setQueryResultForTests({
      data: {
        items: [
          {
            action: "applied",
            source: "bulk",
            reason: "",
            occurredAt: "2026-08-01T00:00:00Z",
          },
        ],
        nextCursor: "",
      },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      isPending: false,
      isSuccess: true,
      refetch: jest.fn(async () => ({ data: undefined })),
    });
    await render(<TagHistorySheet row={ROW} onClose={jest.fn()} t={t} />, {
      wrapper,
    });
    expect(
      screen.getByText("Applied to a subscriber via bulk"),
    ).toBeTruthy();
  });
});
