// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  activeCampaignApiUrlError,
  apiKeyConnectCanSubmit,
  ConnectStep,
  hubSpotHubIDError,
} from "@/app/(dashboard)/app/migrations/new/[source]/connect-step";
import type { MeResponse } from "@/lib/auth-api";

const ADMIN_IDENTITY: MeResponse = {
  user_id: "usr_admin",
  tenant_id: "tnt_1",
  email: "admin@example.com",
  role: "admin",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

const AUTHORITY_PROPS = {
  identity: ADMIN_IDENTITY,
  authorityKey: "tnt_1:usr_admin:admin:member",
  beforeWrite: async () => undefined,
} as const;

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
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

describe("migration connect step", () => {
  it("labels the initial ActiveCampaign credential field as an API token", () => {
    const root = render(
      createElement(ConnectStep, {
        source: "activecampaign",
        authMethod: "api_key",
        onConnected: () => {},
        ...AUTHORITY_PROPS,
      }),
    );

    try {
      const label = document.querySelector('label[for="api-key"]');
      expect(label?.textContent).toBe("API token");
      expect(document.body.textContent).toContain("API URL and token");
      expect(document.body.textContent).toContain(
        "validated provider account is bound to this job",
      );
      expect(document.body.textContent).toContain("validates the API token");
      expect(document.body.textContent).toContain(
        "other provider-issued hosts must be authorized",
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("requires ActiveCampaign API URL as well as API token", () => {
    expect(apiKeyConnectCanSubmit("activecampaign", "token", "")).toBe(false);
    expect(
      apiKeyConnectCanSubmit(
        "activecampaign",
        "token",
        "https://acme.api-us1.com/api/3",
      ),
    ).toBe(true);
  });

  it("labels HubSpot credentials as a private app token", () => {
    const root = render(
      createElement(ConnectStep, {
        source: "hubspot",
        authMethod: "api_key",
        onConnected: () => {},
        ...AUTHORITY_PROPS,
      }),
    );

    try {
      const label = document.querySelector('label[for="api-key"]');
      expect(label?.textContent).toBe("HubSpot private app access token");
      expect(document.body.textContent).toContain(
        "HubSpot private app access token",
      );
      expect(document.body.textContent).toContain("crm.objects.contacts.read");
      expect(document.body.textContent).toContain(
        "subscriptions-definition-read",
      );
      expect(document.body.textContent).toContain("subscriptions-status-read");
      expect(document.body.textContent).toContain(
        "Enterprise batch subscription scopes are not required",
      );
      expect(document.body.textContent).toContain(
        "validates the HubSpot private app access token",
      );
      expect(document.body.textContent).toContain(
        "conservative current-primary-email eligibility",
      );
      expect(document.body.textContent).toContain(
        "This is not exact HubSpot sendability parity",
      );
      const hubID = document.getElementById("account-id");
      expect(hubID).toBeInstanceOf(HTMLInputElement);
      expect((hubID as HTMLInputElement).inputMode).toBe("numeric");
      expect((hubID as HTMLInputElement).maxLength).toBe(64);
      expect(hubID?.getAttribute("aria-describedby")).toBe(
        "hubspot-hub-id-help",
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("accepts an omitted or numeric HubSpot Hub ID and rejects malformed selectors", () => {
    expect(apiKeyConnectCanSubmit("hubspot", "private-token", "")).toBe(true);
    expect(
      apiKeyConnectCanSubmit("hubspot", "private-token", " 12345678 "),
    ).toBe(true);
    expect(apiKeyConnectCanSubmit("hubspot", "private-token", "12a34")).toBe(
      false,
    );
    expect(
      apiKeyConnectCanSubmit("hubspot", "private-token", "1".repeat(65)),
    ).toBe(false);
    expect(hubSpotHubIDError("")).toBeNull();
    expect(hubSpotHubIDError("9".repeat(64))).toBeNull();
    expect(hubSpotHubIDError("12a34")).toBe(
      "Hub ID must contain 1 to 64 digits.",
    );
  });

  it("uses a private API key and optional account binding for Klaviyo", () => {
    const root = render(
      createElement(ConnectStep, {
        source: "klaviyo",
        authMethod: "api_key",
        onConnected: () => {},
        ...AUTHORITY_PROPS,
      }),
    );

    try {
      const label = document.querySelector('label[for="api-key"]');
      const accountLabel = document.querySelector('label[for="account-id"]');
      expect(label?.textContent).toBe("Klaviyo private API key");
      expect(accountLabel?.textContent).toBe("Account ID (optional)");
      expect(document.body.textContent).toContain("accounts, profiles, lists");
      expect(document.body.textContent).toContain(
        "Klaviyo flows are preserved for rebuild review",
      );
      expect(document.body.textContent).toContain(
        "reconnect and cutover remain bound to the same account",
      );
      expect(apiKeyConnectCanSubmit("klaviyo", "private-key", "")).toBe(true);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("uses a workspace-bound regional App API key for Customer.io", () => {
    const root = render(
      createElement(ConnectStep, {
        source: "customerio",
        authMethod: "api_key",
        onConnected: () => {},
        ...AUTHORITY_PROPS,
      }),
    );

    try {
      expect(document.querySelector('label[for="api-key"]')?.textContent).toBe(
        "Customer.io App API key",
      );
      expect(
        document.querySelector('label[for="account-id"]')?.textContent,
      ).toContain("Workspace ID");
      const region = document.getElementById("customerio-region");
      expect(region).toBeInstanceOf(HTMLSelectElement);
      expect((region as HTMLSelectElement).value).toBe("us");
      expect(document.body.textContent).toContain("not a Track API site key");
      expect(document.body.textContent).toContain("immutable cio_id");
      expect(document.body.textContent).toContain("multiple workspaces");
      expect(document.body.textContent).toContain(
        "cannot switch an existing migration between US and EU",
      );
      expect(apiKeyConnectCanSubmit("customerio", "app-key", "")).toBe(true);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("accepts ActiveCampaign bare account hosts that the backend normalizes", () => {
    expect(
      apiKeyConnectCanSubmit("activecampaign", "token", "acme.api-us1.com"),
    ).toBe(true);
    expect(activeCampaignApiUrlError("acme.api-us1.com")).toBeNull();
    expect(
      activeCampaignApiUrlError("https://acme.api-us1.com/api/3/contacts"),
    ).toBeNull();
  });

  it("accepts a safe provider-issued custom hostname for backend authorization", () => {
    expect(
      apiKeyConnectCanSubmit(
        "activecampaign",
        "token",
        "https://tenant.eu.provider.example/api/3",
      ),
    ).toBe(true);
    expect(activeCampaignApiUrlError("tenant.eu.provider.example")).toBeNull();
  });

  it("rejects unsafe ActiveCampaign API URLs before submit", () => {
    expect(
      apiKeyConnectCanSubmit(
        "activecampaign",
        "token",
        "ftp://acme.api-us1.com/api/3",
      ),
    ).toBe(false);
    expect(
      activeCampaignApiUrlError("http://acme.api-us1.com/api/3"),
    ).toContain("HTTPS");
    expect(
      activeCampaignApiUrlError("https://user:secret@acme.api-us1.com/api/3"),
    ).toContain("Remove usernames");
    expect(
      activeCampaignApiUrlError("https://acme.api-us1.com/api/3?token=secret"),
    ).toContain("Remove usernames");
    expect(
      activeCampaignApiUrlError(
        "https://acme.activehosted.com/app/settings/developer",
      ),
    ).toContain("account API root");
    expect(
      activeCampaignApiUrlError("https://acme.api-us1.com:8443/api/3"),
    ).toContain("port (443)");
  });

  it("rejects local and alternate HTTP ActiveCampaign destinations", () => {
    expect(activeCampaignApiUrlError("http://localhost:8080/api/3")).toContain(
      "HTTPS",
    );
    expect(activeCampaignApiUrlError("http://127.0.0.1:8080/api/3")).toContain(
      "HTTPS",
    );
    expect(activeCampaignApiUrlError("http://127.example.com/api/3")).toContain(
      "HTTPS",
    );
    expect(activeCampaignApiUrlError("http://127.1:8080/api/3")).toContain(
      "HTTPS",
    );
    expect(
      activeCampaignApiUrlError("http://127.001.000.001:8080/api/3"),
    ).toContain("HTTPS");
    expect(activeCampaignApiUrlError("http://2130706433:8080/api/3")).toContain(
      "HTTPS",
    );
    expect(activeCampaignApiUrlError("https://localhost/api/3")).toContain(
      "localhost",
    );
    expect(activeCampaignApiUrlError("https://127.0.0.1/api/3")).toContain(
      "IP",
    );
    expect(activeCampaignApiUrlError("https://api.localhost/api/3")).toContain(
      "localhost",
    );
    expect(activeCampaignApiUrlError("https://intranet/api/3")).toContain(
      "single-label",
    );
    expect(activeCampaignApiUrlError("https://[::1]/api/3")).toContain("IP");
  });

  it("does not require account id for generic API-key sources", () => {
    expect(apiKeyConnectCanSubmit("convertkit", "secret", "")).toBe(true);
  });
});
