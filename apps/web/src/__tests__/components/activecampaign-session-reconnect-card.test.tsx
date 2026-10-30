// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveCampaignSessionReconnectCard } from "@/components/migration/activecampaign-session-reconnect-card";
import type { MigrationJob } from "@/lib/types";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  refreshSourceSessionWithApiKey: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const AUTHORITY_PROPS = {
  authorityKey: "tnt_1:usr_admin:admin:member",
  beforeWrite: async () => undefined,
} as const;

vi.mock("@/lib/migration-api", () => ({
  refreshSourceSessionWithApiKey: mocks.refreshSourceSessionWithApiKey,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function inputByID(id: string): HTMLInputElement {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${id}`);
  }
  return input;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((node) =>
    node.textContent?.includes(text),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

function changeInput(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input) as typeof HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function refreshedJob(overrides: Partial<MigrationJob> = {}): MigrationJob {
  return {
    id: "job_ac",
    tenant_id: "tnt_1",
    source: "activecampaign",
    status: "completed",
    progress: {
      subscribers_total: 0,
      subscribers_done: 0,
      segments_total: 0,
      segments_done: 0,
      automations_total: 0,
      automations_done: 0,
      paid_subs_total: 0,
      paid_subs_done: 0,
      archive_total: 0,
      archive_done: 0,
    },
    cursor: {},
    started_at: "2026-07-07T00:00:00.000Z",
    completed_at: "2026-07-07T00:01:00.000Z",
    rollback_until: null,
    source_session_expires_at: "2099-01-01T00:00:00.000Z",
    verification_report: null,
    error: null,
    ...overrides,
  };
}

describe("ActiveCampaignSessionReconnectCard", () => {
  it("locks reconnect attempts and scrubs credentials when authority changes", async () => {
    let resolveRefresh!: (job: MigrationJob) => void;
    const refresh = new Promise<MigrationJob>((resolve) => {
      resolveRefresh = resolve;
    });
    mocks.refreshSourceSessionWithApiKey.mockReturnValue(refresh);
    const onReconnected = vi.fn();
    const beforeWrite = vi.fn(async () => undefined);
    const root = render(
      createElement(ActiveCampaignSessionReconnectCard, {
        ...AUTHORITY_PROPS,
        beforeWrite,
        jobId: "job_ac",
        sessionStatus: {
          kind: "expired",
          message: "Reconnect before final delta.",
        },
        onReconnected,
      }),
    );

    try {
      await act(async () => {
        changeInput(
          inputByID("activecampaign-refresh-api-url-job_ac"),
          "https://acme.api-us1.com/api/3",
        );
        changeInput(
          inputByID("activecampaign-refresh-api-token-job_ac"),
          "old-secret",
        );
        await flush();
      });
      await act(async () => {
        document.querySelector("form")?.requestSubmit();
        document.querySelector("form")?.requestSubmit();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(beforeWrite).toHaveBeenCalledTimes(1);
      expect(mocks.refreshSourceSessionWithApiKey).toHaveBeenCalledTimes(1);
      const signal = mocks.refreshSourceSessionWithApiKey.mock.calls[0]?.[5] as
        | AbortSignal
        | undefined;

      act(() => {
        root.render(
          createElement(ActiveCampaignSessionReconnectCard, {
            ...AUTHORITY_PROPS,
            authorityKey: "tnt_2:usr_admin_b:admin:member",
            beforeWrite,
            jobId: "job_ac",
            sessionStatus: {
              kind: "expired",
              message: "Reconnect before final delta.",
            },
            onReconnected,
          }),
        );
      });
      expect(signal?.aborted).toBe(true);
      expect(inputByID("activecampaign-refresh-api-url-job_ac").value).toBe("");
      expect(inputByID("activecampaign-refresh-api-token-job_ac").value).toBe(
        "",
      );

      await act(async () => {
        resolveRefresh(refreshedJob());
        await refresh;
        await Promise.resolve();
      });
      expect(onReconnected).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("blocks unsafe API URLs before refreshing a source session", async () => {
    const root = render(
      createElement(ActiveCampaignSessionReconnectCard, {
        ...AUTHORITY_PROPS,
        jobId: "job_ac",
        sessionStatus: {
          kind: "expired",
          message: "Reconnect before final delta.",
        },
        onReconnected: vi.fn(),
      }),
    );

    try {
      await act(async () => {
        changeInput(
          inputByID("activecampaign-refresh-api-url-job_ac"),
          "http://acme.api-us1.com/api/3",
        );
        changeInput(
          inputByID("activecampaign-refresh-api-token-job_ac"),
          "new_token",
        );
        await flush();
      });

      expect(document.body.textContent).toContain(
        "Use an HTTPS ActiveCampaign API URL.",
      );
      expect(buttonByText("Refresh source session").disabled).toBe(true);
      expect(mocks.refreshSourceSessionWithApiKey).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("blocks browser-normalized legacy loopback URLs before refresh", async () => {
    const root = render(
      createElement(ActiveCampaignSessionReconnectCard, {
        ...AUTHORITY_PROPS,
        jobId: "job_ac",
        sessionStatus: {
          kind: "expired",
          message: "Reconnect before final delta.",
        },
        onReconnected: vi.fn(),
      }),
    );

    try {
      await act(async () => {
        changeInput(
          inputByID("activecampaign-refresh-api-url-job_ac"),
          "http://127.1:8080/api/3",
        );
        changeInput(
          inputByID("activecampaign-refresh-api-token-job_ac"),
          "new_token",
        );
        await flush();
      });

      expect(document.body.textContent).toContain(
        "Use an HTTPS ActiveCampaign API URL.",
      );
      expect(buttonByText("Refresh source session").disabled).toBe(true);
      expect(mocks.refreshSourceSessionWithApiKey).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("refreshes the existing ActiveCampaign job with a safe custom provider URL", async () => {
    const onReconnected = vi.fn();
    mocks.refreshSourceSessionWithApiKey.mockResolvedValue(refreshedJob());
    const root = render(
      createElement(ActiveCampaignSessionReconnectCard, {
        ...AUTHORITY_PROPS,
        jobId: "job_ac",
        sessionStatus: {
          kind: "near",
          message: "Reconnect before final delta.",
        },
        onReconnected,
      }),
    );

    try {
      expect(document.body.textContent).toContain(
        "same ActiveCampaign account already bound to this job",
      );
      expect(document.body.textContent).toContain(
        "custom provider-issued host must be authorized",
      );
      await act(async () => {
        changeInput(
          inputByID("activecampaign-refresh-api-url-job_ac"),
          " https://tenant.eu.provider.example/api/3 ",
        );
        changeInput(
          inputByID("activecampaign-refresh-api-token-job_ac"),
          " new_token ",
        );
        await flush();
      });

      await act(async () => {
        buttonByText("Refresh source session").click();
        await flush();
      });

      expect(mocks.refreshSourceSessionWithApiKey).toHaveBeenCalledWith(
        "job_ac",
        "activecampaign",
        "new_token",
        "https://tenant.eu.provider.example/api/3",
        undefined,
        expect.anything(),
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "ActiveCampaign source session refreshed",
      );
      expect(onReconnected).toHaveBeenCalledWith(refreshedJob());
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("refreshes a HubSpot bridge job with a private app token", async () => {
    const onReconnected = vi.fn();
    const nextJob = refreshedJob({ id: "job_hs", source: "hubspot" });
    mocks.refreshSourceSessionWithApiKey.mockResolvedValue(nextJob);
    const root = render(
      createElement(ActiveCampaignSessionReconnectCard, {
        ...AUTHORITY_PROPS,
        source: "hubspot",
        jobId: "job_hs",
        sessionStatus: {
          kind: "expired",
          message: "Reconnect before bridge acceptance.",
        },
        onReconnected,
      }),
    );

    try {
      expect(document.body.textContent).toContain("Reconnect HubSpot");
      expect(document.body.textContent).toContain("Hub ID (optional)");
      await act(async () => {
        changeInput(inputByID("hubspot-refresh-account-id-job_hs"), " 12345 ");
        changeInput(
          inputByID("hubspot-refresh-api-token-job_hs"),
          " hs_private_token ",
        );
        await flush();
      });

      await act(async () => {
        buttonByText("Refresh source session").click();
        await flush();
      });

      expect(mocks.refreshSourceSessionWithApiKey).toHaveBeenCalledWith(
        "job_hs",
        "hubspot",
        "hs_private_token",
        "12345",
        undefined,
        expect.anything(),
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "HubSpot source session refreshed",
      );
      expect(onReconnected).toHaveBeenCalledWith(nextJob);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("refreshes the existing Beehiiv job and preserves publication binding", async () => {
    const onReconnected = vi.fn();
    const nextJob = refreshedJob({ id: "job_bh", source: "beehiiv" });
    mocks.refreshSourceSessionWithApiKey.mockResolvedValue(nextJob);
    const root = render(
      createElement(ActiveCampaignSessionReconnectCard, {
        ...AUTHORITY_PROPS,
        source: "beehiiv",
        jobId: "job_bh",
        sessionStatus: {
          kind: "expired",
          message: "Reconnect before publication cutover.",
        },
        onReconnected,
      }),
    );

    try {
      expect(document.body.textContent).toContain("Reconnect Beehiiv");
      expect(document.body.textContent).toContain("Publication ID (optional)");
      expect(document.body.textContent).toContain(
        "server reuses the publication already bound to this job",
      );
      expect(document.body.textContent).toContain(
        "reconnect never auto-selects another workspace publication",
      );
      await act(async () => {
        changeInput(
          inputByID("beehiiv-refresh-account-id-job_bh"),
          " pub_publication_1 ",
        );
        changeInput(
          inputByID("beehiiv-refresh-api-token-job_bh"),
          " beehiiv_api_key ",
        );
        await flush();
      });

      await act(async () => {
        buttonByText("Refresh source session").click();
        await flush();
      });

      expect(mocks.refreshSourceSessionWithApiKey).toHaveBeenCalledWith(
        "job_bh",
        "beehiiv",
        "beehiiv_api_key",
        "pub_publication_1",
        undefined,
        expect.anything(),
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Beehiiv source session refreshed",
      );
      expect(onReconnected).toHaveBeenCalledWith(nextJob);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("refreshes the existing Klaviyo job without changing account binding", async () => {
    const onReconnected = vi.fn();
    const nextJob = refreshedJob({ id: "job_kl", source: "klaviyo" });
    mocks.refreshSourceSessionWithApiKey.mockResolvedValue(nextJob);
    const root = render(
      createElement(ActiveCampaignSessionReconnectCard, {
        ...AUTHORITY_PROPS,
        source: "klaviyo",
        jobId: "job_kl",
        sessionStatus: {
          kind: "expired",
          message: "Reconnect before Klaviyo cutover.",
        },
        onReconnected,
      }),
    );

    try {
      expect(document.body.textContent).toContain("Reconnect Klaviyo");
      expect(document.body.textContent).toContain("Account ID (optional)");
      expect(document.body.textContent).toContain("Private API key");
      expect(document.body.textContent).toContain(
        "reconnect never switches the job to another account",
      );
      await act(async () => {
        changeInput(
          inputByID("klaviyo-refresh-account-id-job_kl"),
          " account_123 ",
        );
        changeInput(
          inputByID("klaviyo-refresh-api-token-job_kl"),
          " private_key ",
        );
        await flush();
      });

      await act(async () => {
        buttonByText("Refresh source session").click();
        await flush();
      });

      expect(mocks.refreshSourceSessionWithApiKey).toHaveBeenCalledWith(
        "job_kl",
        "klaviyo",
        "private_key",
        "account_123",
        undefined,
        expect.anything(),
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Klaviyo source session refreshed",
      );
      expect(onReconnected).toHaveBeenCalledWith(nextJob);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("refreshes the exact Customer.io workspace and regional App API session", async () => {
    const onReconnected = vi.fn();
    const nextJob = refreshedJob({ id: "job_cio", source: "customerio" });
    mocks.refreshSourceSessionWithApiKey.mockResolvedValue(nextJob);
    const root = render(
      createElement(ActiveCampaignSessionReconnectCard, {
        ...AUTHORITY_PROPS,
        source: "customerio",
        jobId: "job_cio",
        sessionStatus: {
          kind: "near",
          message: "Reconnect before Customer.io final delta.",
        },
        onReconnected,
      }),
    );

    try {
      expect(document.body.textContent).toContain("Reconnect Customer.io");
      expect(document.body.textContent).toContain("Workspace ID (optional)");
      expect(document.body.textContent).toContain("App API key");
      expect(document.body.textContent).toContain(
        "reconnect never switches workspace or region",
      );
      const region = document.getElementById(
        "customerio-refresh-region-job_cio",
      );
      expect(region).toBeInstanceOf(HTMLSelectElement);
      await act(async () => {
        changeInput(
          inputByID("customerio-refresh-account-id-job_cio"),
          " 9001 ",
        );
        changeInput(
          inputByID("customerio-refresh-api-token-job_cio"),
          " cio_app_key ",
        );
        (region as HTMLSelectElement).value = "eu";
        region?.dispatchEvent(new Event("change", { bubbles: true }));
        await flush();
      });

      await act(async () => {
        buttonByText("Refresh source session").click();
        await flush();
      });

      expect(mocks.refreshSourceSessionWithApiKey).toHaveBeenCalledWith(
        "job_cio",
        "customerio",
        "cio_app_key",
        "9001",
        { region: "eu" },
        expect.anything(),
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Customer.io source session refreshed",
      );
      expect(onReconnected).toHaveBeenCalledWith(nextJob);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
