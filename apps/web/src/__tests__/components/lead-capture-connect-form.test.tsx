// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// LeadCaptureConnectForm: GET /api/v1/lead-integrations/providers drives the
// fields; "Save configuration" POSTs /api/v1/lead-integrations with the
// provider, desktop's derived name, the credential reference and the
// remaining settings. Missing required fields and non-admin roles send
// nothing; the server's refusal sentence is rendered verbatim.

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONN,
  buttonNamed,
  click,
  identity,
  installFetchRouter,
  mount,
  text,
  type,
  unmountAll,
  waitFor,
  type FetchRouter,
} from "../helpers/integrations-lifecycle-harness";
import { LeadCaptureConnectForm } from "@/components/integrations/lead-capture-connect-form";
import { ADMIN_REQUIRED_REASON } from "@/components/integrations/use-integration-lifecycle-authority";

const auth = vi.hoisted(() => ({ me: null as unknown }));

vi.mock("@/lib/auth-api", () => ({
  whoami: async () => auth.me,
  whoamiFresh: async () => auth.me,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));

let router: FetchRouter;

function input(label: string): HTMLInputElement {
  const labelEl = [...document.querySelectorAll("label")].find((candidate) =>
    candidate.textContent?.startsWith(label),
  );
  const id = labelEl?.getAttribute("for");
  const found = id ? document.getElementById(id) : null;
  if (!(found instanceof HTMLInputElement)) {
    throw new Error(`no input labelled ${label}`);
  }
  return found;
}

beforeEach(() => {
  auth.me = identity("admin");
  router = installFetchRouter({
    "GET /api/v1/lead-integrations/providers": {
      body: {
        items: [
          {
            provider: "typeform",
            name: "Typeform",
            category: "lead_capture",
            auth_mode: "api_token_ref",
            managed: true,
            runtime_status: "available",
            sync_model: "postwave_lead_pull",
            sync_objects: ["responses"],
            required_settings: [
              { key: "form_id", label: "Form ID", required: true },
              {
                key: "credentials_ref",
                label: "Credential reference",
                required: true,
                help: "Vault reference containing the Typeform token",
              },
            ],
            optional_settings: [
              { key: "list_id", label: "Moosewave list" },
              { key: "api_token", label: "API token", secret: true },
            ],
          },
        ],
      },
    },
    "POST /api/v1/lead-integrations": {
      status: 201,
      body: {
        id: CONN,
        provider: "typeform",
        name: "Typeform abc123",
        status: "active",
      },
    },
  });
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe("LeadCaptureConnectForm", () => {
  it("Save configuration POSTs the lead integration with a credential reference", async () => {
    const onConnected = vi.fn();
    mount(
      createElement(LeadCaptureConnectForm, {
        provider: "typeform",
        providerName: "Typeform",
        onConnected,
      }),
    );
    await waitFor(() => expect(text()).toContain("Imports responses"));
    // A secret field is never rendered as an input; it is named as something
    // the vault reference must cover.
    expect(text()).toContain("The reference must cover: API token.");

    await type(input("Form ID"), "abc123");
    await type(input("Credential reference"), "vault://lead/typeform");
    await type(input("Moosewave list"), "list-7");
    await click(buttonNamed("Save configuration"));

    await waitFor(() => expect(text()).toContain("Typeform abc123 saved"));
    expect(text()).toContain(`Connection ${CONN}`);
    expect(router.writes()).toEqual([
      {
        method: "POST",
        path: "/api/v1/lead-integrations",
        search: "",
        body: {
          provider: "typeform",
          name: "Typeform abc123",
          credentials_ref: "vault://lead/typeform",
          settings: { form_id: "abc123", list_id: "list-7" },
        },
      },
    ]);
    expect(onConnected).toHaveBeenCalledWith(
      expect.objectContaining({ id: CONN, provider: "typeform" }),
    );
  });

  it("names the missing required field and sends nothing", async () => {
    mount(
      createElement(LeadCaptureConnectForm, {
        provider: "typeform",
        providerName: "Typeform",
      }),
    );
    await waitFor(() => expect(buttonNamed("Save configuration")).toBeDefined());
    await type(input("Form ID"), "abc123");
    await click(buttonNamed("Save configuration"));
    await waitFor(() =>
      expect(text()).toContain("Credential reference is required."),
    );
    expect(router.writes()).toEqual([]);
  });

  it("renders the server's raw-credential refusal verbatim", async () => {
    router.route("POST /api/v1/lead-integrations", {
      status: 422,
      body: {
        error: {
          code: "raw_credentials_rejected",
          message:
            "raw credentials are not accepted in settings; store them in the credential vault and pass credentials_ref",
        },
      },
    });
    mount(
      createElement(LeadCaptureConnectForm, {
        provider: "typeform",
        providerName: "Typeform",
      }),
    );
    await waitFor(() => expect(buttonNamed("Save configuration")).toBeDefined());
    await type(input("Form ID"), "abc123");
    await type(input("Credential reference"), "tfp_live_secret");
    await click(buttonNamed("Save configuration"));
    await waitFor(() =>
      expect(text()).toContain(
        "raw credentials are not accepted in settings; store them in the credential vault and pass credentials_ref",
      ),
    );
    expect(text()).not.toContain("saved");
  });

  it("an editor gets the reason and no provider-registry request", async () => {
    auth.me = identity("editor");
    mount(
      createElement(LeadCaptureConnectForm, {
        provider: "typeform",
        providerName: "Typeform",
      }),
    );
    await waitFor(() => expect(text()).toContain(ADMIN_REQUIRED_REASON));
    expect(router.requests).toEqual([]);
    expect(buttonNamed("Save configuration")).toBeUndefined();
  });
});
