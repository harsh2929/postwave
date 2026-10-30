// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SecurityPolicySettingsCard } from "@/app/(dashboard)/app/settings/security/security-policy-settings-card";
import type { SecuritySettings } from "@/lib/security-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

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

const settings: SecuritySettings = {
  require_2fa_for_admins: true,
  require_2fa_for_all: false,
  sso_provider: "saml-custom",
  sso_metadata_url: "https://idp.example.com/saml.xml",
  session_max_minutes: 60,
};

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.includes(text) === true,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("SecurityPolicySettingsCard", () => {
  it("routes policy form changes and save through props", () => {
    const onPatch = vi.fn();
    const onSave = vi.fn();
    const root = render(
      createElement(SecurityPolicySettingsCard, {
        loading: false,
        dirty: true,
        onPatch,
        onSave,
        saving: false,
        settings,
      }),
    );

    try {
      const checkboxes = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      );

      act(() => {
        checkboxes[0]?.click();
        checkboxes[1]?.click();
        buttonByText("Save security settings").click();
      });

      expect(onPatch).toHaveBeenCalledWith({
        require_2fa_for_admins: false,
      });
      expect(onPatch).toHaveBeenCalledWith({
        require_2fa_for_all: true,
      });
      // SETC-038 / SETC-039: legacy SSO values remain visible/preserved while
      // the enforced session setting stays editable.
      expect(document.body.textContent).toContain("Single sign-on");
      expect(document.body.textContent).toContain("Session timeout");
      const providerInput =
        document.querySelector<HTMLInputElement>("#sso-provider");
      expect(providerInput?.value).toBe("saml-custom");
      expect(providerInput?.readOnly).toBe(true);
      expect(onSave).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("disables save when the form is pristine", () => {
    const onSave = vi.fn();
    const root = render(
      createElement(SecurityPolicySettingsCard, {
        loading: false,
        dirty: false,
        onPatch: vi.fn(),
        onSave,
        saving: false,
        settings,
      }),
    );

    try {
      const save = buttonByText("Save security settings");
      expect(save.disabled).toBe(true);
      act(() => save.click());
      expect(onSave).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("disables inputs and save while loading", () => {
    const root = render(
      createElement(SecurityPolicySettingsCard, {
        loading: true,
        dirty: true,
        onPatch: vi.fn(),
        onSave: vi.fn(),
        saving: false,
        settings,
      }),
    );

    try {
      expect(
        Array.from(document.querySelectorAll("input, select")).every(
          (element) =>
            element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement
              ? element.disabled
              : false,
        ),
      ).toBe(true);
      expect(buttonByText("Save security settings").disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("SecurityPolicySettingsCard SSO honesty", () => {
  // The card renders legacy "SSO provider" state beside two settings the
  // server genuinely enforces (2FA policy via middleware/mfa_gate.go, session
  // timeout via auth/session.go). Nothing consumes sso_provider —
  // scim.SAMLJITProvision has zero callers and there is no ACS route — so the
  // card must state that before the operator types into it, not only when the
  // save is refused.
  it("discloses that SSO is not enforced, beside the SSO inputs", () => {
    const root = render(
      createElement(SecurityPolicySettingsCard, {
        loading: false,
        dirty: false,
        onPatch: vi.fn(),
        onSave: vi.fn(),
        saving: false,
        settings,
      }),
    );
    const note = document.querySelector('[role="note"]');
    expect(note).not.toBeNull();
    const text = note?.textContent ?? "";
    expect(text).toContain("SSO is not enforced");
    expect(text).toContain("not delegated");
    act(() => root.unmount());
  });

  it("does not describe the fields as working SSO configuration", () => {
    const root = render(
      createElement(SecurityPolicySettingsCard, {
        loading: false,
        dirty: false,
        onPatch: vi.fn(),
        onSave: vi.fn(),
        saving: false,
        settings,
      }),
    );
    // The old copy read "SAML/SSO provider configuration and how long an
    // authenticated session may last" — an unqualified promise that the fields
    // configure something.
    expect(document.body.textContent).not.toContain(
      "SAML/SSO provider configuration",
    );
    act(() => root.unmount());
  });

  it("makes legacy values read-only and wires the only supported clear transition", () => {
    const onPatch = vi.fn();
    const root = render(
      createElement(SecurityPolicySettingsCard, {
        loading: false,
        dirty: false,
        onPatch,
        onSave: vi.fn(),
        saving: false,
        settings,
      }),
    );

    try {
      const provider =
        document.querySelector<HTMLInputElement>("#sso-provider");
      const metadata =
        document.querySelector<HTMLInputElement>("#sso-metadata");
      expect(provider?.readOnly).toBe(true);
      expect(metadata?.readOnly).toBe(true);

      act(() => buttonByText("Clear stored SSO values").click());

      expect(onPatch).toHaveBeenCalledWith({
        sso_provider: "",
        sso_metadata_url: "",
      });
      expect(document.body.textContent).toContain(
        "Save security settings to persist the change",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not expose provider setup controls when no legacy value exists", () => {
    const onPatch = vi.fn();
    const root = render(
      createElement(SecurityPolicySettingsCard, {
        loading: false,
        dirty: false,
        onPatch,
        onSave: vi.fn(),
        saving: false,
        settings: {
          ...settings,
          sso_provider: "",
          sso_metadata_url: "",
        },
      }),
    );

    try {
      expect(
        document.querySelector<HTMLInputElement>("#sso-provider")?.readOnly,
      ).toBe(true);
      expect(
        document.querySelector<HTMLInputElement>("#sso-metadata")?.readOnly,
      ).toBe(true);
      expect(document.body.textContent).toContain(
        "Provider setup remains unavailable",
      );
      expect(
        Array.from(document.querySelectorAll("button")).some((button) =>
          button.textContent?.includes("Clear stored SSO values"),
        ),
      ).toBe(false);
      expect(onPatch).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("names Moosewave's own TOTP as what enforces the 2FA policy, not an IdP", () => {
    const root = render(
      createElement(SecurityPolicySettingsCard, {
        loading: false,
        dirty: false,
        onPatch: vi.fn(),
        onSave: vi.fn(),
        saving: false,
        settings,
      }),
    );
    const text = document.body.textContent ?? "";

    // The card used to say "Moosewave delegates login to your IdP" and that these
    // switches make Moosewave "reject sessions whose IdP assertion does not
    // include an MFA claim". Both were false — there is no SAML sign-in path in
    // the product, and internal/middleware/mfa_gate.go checks
    // hasConfirmedTOTPForUser. Telling an operator on the SECURITY page that a
    // different system enforces their 2FA requirement is the kind of wrong that
    // changes what they do next, so it is pinned rather than left to copy edits.
    expect(text).not.toContain("delegates login to your IdP");
    expect(text).not.toContain("IdP assertion");
    expect(text).not.toContain("MFA at the IdP");

    // Asserted positively too: a card that rendered nothing would satisfy the
    // negatives above, which is how a "not.toContain" test passes over an empty
    // component and proves nothing.
    expect(text).toContain("TOTP");
    expect(text).toContain("not");
    expect(text).toContain("delegated");
    act(() => root.unmount());
  });
});
