/**
 * ArchiveDomainCard — the render contract (register: archive custom domain,
 * settings).
 *
 * The wire/validation/copy policy is pinned in src/lib/archiveDomain.test.ts;
 * this file pins the card on the Custom domains screen:
 *
 *  - an unconfigured tenant gets the empty form and no lifecycle;
 *  - a saved domain publishes a copyable CNAME (host and target separately)
 *    and states the CNAME + SSL positions in the server's own words;
 *  - Save is dead until the field changes, refuses a bad hostname locally with
 *    the sentence the server would have used, and sends the canonical value;
 *  - Verify writes the returned row into the cache and reports the outcome;
 *  - Remove verification is confirmed first and is a DIFFERENT verb from
 *    clearing the domain;
 *  - below admin the card renders nothing at all — the READ is admin too;
 *  - loading / offline / an unknown enum in the cache are silence, not a throw;
 *  - the card is MOUNTED on app/(tabs)/custom-domains.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";
import * as AuthStore from "@/store/auth";

const mockSaveCalls: string[] = [];
const mockVerifyCalls: number[] = [];
const mockDeleteCalls: number[] = [];
let mockSaveAnswer: { data: unknown; error: unknown } = {
  data: { archiveDomain: "news.example.com" },
  error: null,
};
let mockVerifyAnswer: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};
let mockDeleteAnswer: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};
jest.mock("@/api/archiveDomain", () => ({
  getArchiveDomainStatus: jest.fn(async () => ({ data: null, error: null })),
  saveArchiveDomain: async (domain: string) => {
    mockSaveCalls.push(domain);
    return mockSaveAnswer;
  },
  verifyArchiveDomain: async () => {
    mockVerifyCalls.push(1);
    return mockVerifyAnswer;
  },
  deleteArchiveDomainVerification: async () => {
    mockDeleteCalls.push(1);
    return mockDeleteAnswer;
  },
}));

const mockConfirmCalls: Record<string, unknown>[] = [];
let mockConfirmAnswer = true;
jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => async (options: Record<string, unknown>) => {
    mockConfirmCalls.push(options);
    return mockConfirmAnswer;
  },
}));

const mockToasts: { kind: string; message: string }[] = [];
jest.mock("@/components/Toast", () => ({
  useToast: () => ({
    toast: (entry: { kind: string; message: string }) => {
      mockToasts.push(entry);
    },
    dismiss: () => undefined,
  }),
}));

// eslint-disable-next-line import/first -- must follow the api/confirm/toast mocks.
import { ArchiveDomainCard } from "@/components/settings/ArchiveDomainCard";
// eslint-disable-next-line import/first
import CustomDomains from "../app/(tabs)/custom-domains";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
  __getQueryClientForTests: () => { setQueryData: jest.Mock };
};
const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};
const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

const refetch = jest.fn(async () => ({}));

function result(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
    isFetching: false,
    isSuccess: true,
    refetch,
    ...over,
  };
}

/** A configured but unverified host, as lib/archiveDomain normalizes it. */
const PENDING = {
  domain: "news.example.com",
  cnameTarget: "custom-domains.moosewave.com",
  verificationToken: "abc123",
  status: "pending",
  sslStatus: "pending",
  lastCheckedAt: "2026-09-03T10:00:00Z",
  verifiedAt: "",
  lastError: "",
  sslLastError: "",
};

const UNCONFIGURED = {
  ...PENDING,
  domain: "",
  verificationToken: "",
};

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

const FIELD = "Custom domain";
const SAVE = "Save archive domain";
const VERIFY = "Verify the archive domain";
const REMOVE = "Remove the archive domain verification";

function asAdmin() {
  gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
  authHarness.__setAuthStateForTests({
    mode: "session",
    session: { role: "admin", effectiveRole: "admin", tenantId: "t1" },
  });
}

afterEach(() => {
  mockSaveCalls.length = 0;
  mockVerifyCalls.length = 0;
  mockDeleteCalls.length = 0;
  mockConfirmCalls.length = 0;
  mockToasts.length = 0;
  mockConfirmAnswer = true;
  mockSaveAnswer = {
    data: { archiveDomain: "news.example.com" },
    error: null,
  };
  mockVerifyAnswer = { data: null, error: null };
  mockDeleteAnswer = { data: null, error: null };
  refetch.mockClear();
  queryHarness.__getQueryClientForTests().setQueryData.mockClear();
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  authHarness.__resetAuthStateForTests();
});

describe("ArchiveDomainCard", () => {
  it("offers the empty form, and no lifecycle, before a domain exists", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(result({ data: UNCONFIGURED }));
    await render(<ArchiveDomainCard />);
    expect(screen.getByLabelText(FIELD).props.value).toBe("");
    expect(
      screen.getByText(
        "No custom domain configured yet. Add one above to start verification.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText(VERIFY)).toBeNull();
    expect(screen.queryByLabelText(REMOVE)).toBeNull();
    expect(screen.getByLabelText(SAVE).props.accessibilityState.disabled).toBe(
      true,
    );
  });

  it("publishes the CNAME and states both positions in the server's words", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(result({ data: PENDING }));
    await render(<ArchiveDomainCard />);
    expect(screen.getByLabelText(FIELD).props.value).toBe("news.example.com");
    expect(screen.getByText("CNAME status: pending")).toBeTruthy();
    expect(
      screen.getByText(
        "Waiting for DNS propagation — tap Verify once the CNAME below exists.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("SSL certificate: pending")).toBeTruthy();
    expect(
      screen.getByText("SSL provisioning starts after CNAME verification succeeds."),
    ).toBeTruthy();
    // Host and target are separately copyable, as a registrar form expects.
    expect(
      screen.getByLabelText("Copy the CNAME host for news.example.com"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Copy the CNAME record value for news.example.com"),
    ).toBeTruthy();
    expect(screen.getByText("custom-domains.moosewave.com")).toBeTruthy();
    // The TXT alternative is offered because the server issued a token.
    expect(screen.getByText("_postwave-verify.news.example.com")).toBeTruthy();
  });

  it("refuses a bad hostname locally, in the sentence the server would have used", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(result({ data: PENDING }));
    await render(<ArchiveDomainCard />);
    await fireEvent.changeText(screen.getByLabelText(FIELD), "not a host");
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockSaveCalls).toEqual([]);
    expect(screen.getByRole("alert").props.children).toBe(
      "archive: domain must be a lowercase hostname (e.g. archive.example.com)",
    );
  });

  it("refuses a Moosewave edge host the tenant cannot claim", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(result({ data: PENDING }));
    await render(<ArchiveDomainCard />);
    await fireEvent.changeText(screen.getByLabelText(FIELD), "archive.moosewave.com");
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockSaveCalls).toEqual([]);
    expect(screen.getByRole("alert").props.children).toBe(
      "archive: that domain is reserved for Moosewave's own infrastructure",
    );
  });

  it("saves the canonical host and says what to do next", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(result({ data: PENDING }));
    await render(<ArchiveDomainCard />);
    await fireEvent.changeText(screen.getByLabelText(FIELD), "letters.example.com");
    expect(screen.getByLabelText(SAVE).props.accessibilityState.disabled).toBe(
      false,
    );
    await fireEvent.press(screen.getByLabelText(SAVE));
    await act(async () => {});
    expect(mockSaveCalls).toEqual(["letters.example.com"]);
    expect(mockToasts).toEqual([
      {
        kind: "success",
        message: "Archive domain saved. Publish the CNAME below, then Verify.",
      },
    ]);
    expect(refetch).toHaveBeenCalled();
  });

  it("caches the row a verify returns and reports the outcome", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(result({ data: PENDING }));
    const verified = { ...PENDING, status: "verified", sslStatus: "issuing" };
    mockVerifyAnswer = { data: verified, error: null };
    await render(<ArchiveDomainCard />);
    await fireEvent.press(screen.getByLabelText(VERIFY));
    await act(async () => {});
    expect(mockVerifyCalls).toHaveLength(1);
    const client = queryHarness.__getQueryClientForTests();
    expect(client.setQueryData).toHaveBeenCalledTimes(1);
    expect(client.setQueryData.mock.calls[0]?.[1]).toEqual(verified);
    expect(mockToasts).toEqual([
      { kind: "success", message: "Domain verified! SSL is being provisioned." },
    ]);
  });

  it("quotes the server when a verify fails", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(result({ data: PENDING }));
    mockVerifyAnswer = {
      data: null,
      error: {
        status: 400,
        code: "no_domain",
        message: "no custom archive domain configured; set archive_domain first",
      },
    };
    await render(<ArchiveDomainCard />);
    await fireEvent.press(screen.getByLabelText(VERIFY));
    await act(async () => {});
    expect(screen.getByRole("alert").props.children).toBe(
      "no custom archive domain configured; set archive_domain first",
    );
    expect(
      queryHarness.__getQueryClientForTests().setQueryData,
    ).not.toHaveBeenCalled();
  });

  it("shows the issued-cert reading once the edge is done", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(
      result({
        data: { ...PENDING, status: "verified", sslStatus: "issued" },
      }),
    );
    await render(<ArchiveDomainCard />);
    expect(screen.getByText("Let's Encrypt cert is live — HTTPS works.")).toBeTruthy();
    expect(screen.getByText("https://news.example.com")).toBeTruthy();
    expect(screen.getByLabelText(VERIFY).props.children).toBeDefined();
  });

  it("confirms before removing the verification, and calls only that verb", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(result({ data: PENDING }));
    await render(<ArchiveDomainCard />);
    await fireEvent.press(screen.getByLabelText(REMOVE));
    await act(async () => {});
    expect(mockConfirmCalls).toHaveLength(1);
    expect(mockConfirmCalls[0]?.title).toBe(
      "Remove custom-domain verification?",
    );
    expect(mockDeleteCalls).toHaveLength(1);
    // Removing the verification is NOT clearing the column.
    expect(mockSaveCalls).toEqual([]);
    expect(mockToasts).toEqual([
      { kind: "success", message: "Verification cleared." },
    ]);
  });

  it("does not remove anything when the confirm is declined", async () => {
    asAdmin();
    mockConfirmAnswer = false;
    queryHarness.__setQueryResultForTests(result({ data: PENDING }));
    await render(<ArchiveDomainCard />);
    await fireEvent.press(screen.getByLabelText(REMOVE));
    await act(async () => {});
    expect(mockConfirmCalls).toHaveLength(1);
    expect(mockDeleteCalls).toEqual([]);
  });

  it("renders NOTHING below admin — the read is admin too", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    queryHarness.__setQueryResultForTests(result({ data: PENDING }));
    await render(<ArchiveDomainCard />);
    expect(screen.queryByText("Archive domain")).toBeNull();
    expect(screen.queryByLabelText(FIELD)).toBeNull();
  });

  it("shows a skeleton on first load", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(
      result({ isLoading: true, isPending: true, isSuccess: false }),
    );
    await render(<ArchiveDomainCard />);
    expect(screen.getByLabelText("Loading archive domain")).toBeTruthy();
  });

  it("shows the offline notice with the gate closed and nothing cached", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin", enabled: false });
    queryHarness.__setQueryResultForTests(result({ data: undefined }));
    await render(<ArchiveDomainCard />);
    expect(screen.getByText("Reconnect to load the archive domain.")).toBeTruthy();
  });

  it("renders the empty state, not a throw, for an unknown enum in the cache", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(
      result({ data: { ...PENDING, status: "provisioning" } }),
    );
    await render(<ArchiveDomainCard />);
    expect(screen.getByText("No archive-domain settings")).toBeTruthy();
    expect(screen.queryByText(/undefined/u)).toBeNull();
  });

  it("is MOUNTED on the Custom domains screen", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(
      result({ isLoading: true, isPending: true, isSuccess: false }),
    );
    await render(<CustomDomains />, { wrapper });
    expect(screen.getByLabelText("Loading archive domain")).toBeTruthy();
  });
});
