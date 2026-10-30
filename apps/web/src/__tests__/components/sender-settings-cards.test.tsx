// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthenticationHealthCard } from "@/app/(dashboard)/app/settings/sender/authentication-health-card";
import { PauseEmailSendingDialog } from "@/app/(dashboard)/app/settings/sender/pause-email-sending-dialog";
import {
  ComplianceProfileCard,
  EmailSendingSafetyCard,
} from "@/app/(dashboard)/app/settings/sender/sender-settings-cards";
import type { EmailComplianceProfileDraft } from "@/app/(dashboard)/app/settings/sender/sender-settings-helpers";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  // Unmounting the pause dialog is not the end of its work. Radix's FocusScope
  // restores focus from a setTimeout(0) it schedules while unmounting, and the
  // dialog's onCloseAutoFocus chains one more timeout and two animation frames
  // after it. Run that chain here, while the test environment still exists.
  // Every test in this file is otherwise synchronous, so after the last one
  // the chain ran once the file had finished, against a window vitest may
  // already have torn down.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
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

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.includes(text) === true,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function textareaById(id: string): HTMLTextAreaElement {
  const textarea = document.getElementById(id);
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error(`Textarea not found: ${id}`);
  }
  return textarea;
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

function profile(
  overrides: Partial<EmailComplianceProfileDraft> = {},
): EmailComplianceProfileDraft {
  return {
    compliance_contact_email: "ops@example.com",
    default_footer_text: "",
    legal_sender_name: "Acme",
    list_unsubscribe_enabled: true,
    one_click_unsubscribe_enabled: true,
    physical_address_city: "San Francisco",
    physical_address_country: "US",
    physical_address_line1: "1 Market",
    physical_address_line2: "",
    physical_address_postal_code: "94105",
    physical_address_region: "CA",
    verified_sender_domain: false,
    ...overrides,
  };
}

describe("sender settings cards", () => {
  it("keeps domain verification read-only and routes unsubscribe toggles", () => {
    const onProfileChange = vi.fn();
    const onSave = vi.fn();
    const root = render(
      createElement(ComplianceProfileCard, {
        canWrite: true,
        complianceReady: false,
        loading: false,
        onProfileChange,
        onSave,
        profile: profile(),
        profileDirty: false,
        savingProfile: false,
      }),
    );

    try {
      expect(document.body.textContent).toContain("Not verified");
      expect(document.body.textContent).toContain("cannot be self-certified");
      expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(
        2,
      );
      expect(buttonByText("Save compliance profile").disabled).toBe(true);

      const listUnsubscribeCheckbox = document.querySelector(
        'input[type="checkbox"]',
      );
      if (!(listUnsubscribeCheckbox instanceof HTMLInputElement)) {
        throw new Error("List-Unsubscribe checkbox not found");
      }
      act(() => {
        listUnsubscribeCheckbox.click();
      });
      expect(onProfileChange).toHaveBeenCalledWith({
        list_unsubscribe_enabled: false,
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("enables save when the compliance profile is dirty", () => {
    const onSave = vi.fn();
    const root = render(
      createElement(ComplianceProfileCard, {
        canWrite: true,
        complianceReady: true,
        loading: false,
        onProfileChange: vi.fn(),
        onSave,
        profile: profile({ verified_sender_domain: true }),
        profileDirty: true,
        savingProfile: false,
      }),
    );

    try {
      act(() => {
        buttonByText("Save compliance profile").click();
      });
      expect(onSave).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("routes pause dialog edits, cancel, and confirm through callbacks", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const onReasonChange = vi.fn();
    const root = render(
      createElement(PauseEmailSendingDialog, {
        canWrite: true,
        onConfirm,
        onOpenChange,
        onReasonChange,
        open: true,
        reason: "Pilot pause",
        savingControl: false,
      }),
    );

    try {
      act(() => {
        changeTextarea(textareaById("pause-reason"), "Incident response");
      });
      expect(onReasonChange).toHaveBeenCalledWith("Incident response");

      act(() => {
        buttonByText("Cancel").click();
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);

      act(() => {
        buttonByText("Pause sends").click();
      });
      expect(onConfirm).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("restores focus to the safety action after cancelling the pause dialog", async () => {
    function FocusHarness() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return createElement(
        "div",
        null,
        createElement(
          "button",
          {
            ref: triggerRef,
            type: "button",
            onClick: () => setOpen(true),
          },
          "Open pause dialog",
        ),
        createElement(PauseEmailSendingDialog, {
          canWrite: true,
          onConfirm: vi.fn(),
          onOpenChange: setOpen,
          onReasonChange: vi.fn(),
          open,
          reason: "Pilot pause",
          returnFocusRef: triggerRef,
          savingControl: false,
        }),
      );
    }

    const root = render(createElement(FocusHarness));
    try {
      const opener = buttonByText("Open pause dialog");
      act(() => opener.click());
      act(() => buttonByText("Cancel").click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(document.activeElement).toBe(opener);
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders authentication health rows and auth-check errors", () => {
    const root = render(
      createElement("div", null, [
        createElement(AuthenticationHealthCard, {
          checks: [
            {
              bimi: { detail: "Not configured", status: "warn" },
              dkim: { detail: "Selector is valid", status: "ok" },
              dmarc: { detail: "Policy missing", status: "fail" },
              domain: "example.com",
              ptr: { detail: "ok", status: "ok" },
              spf: { detail: "Includes provider", status: "ok" },
            },
          ],
          key: "ok",
          loading: false,
          loadError: null,
        }),
        createElement(AuthenticationHealthCard, {
          checks: [],
          key: "err",
          loading: false,
          loadError: "DNS timeout",
        }),
      ]),
    );

    try {
      expect(document.body.textContent).toContain("example.com");
      expect(document.body.textContent).toContain("Pass");
      expect(document.body.textContent).toContain("Fail");
      expect(document.body.textContent).toContain(
        "Could not load authentication health.",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps every workspace mutation read-only for a viewer", () => {
    const onSave = vi.fn();
    const onConfirm = vi.fn();
    const root = render(
      createElement("div", null, [
        createElement(ComplianceProfileCard, {
          canWrite: false,
          complianceReady: true,
          key: "profile",
          loading: false,
          onProfileChange: vi.fn(),
          onSave,
          profile: profile({ verified_sender_domain: true }),
          profileDirty: true,
          savingProfile: false,
        }),
        createElement(EmailSendingSafetyCard, {
          canWrite: false,
          control: {
            paused: false,
            source: "tenant",
            tenant_id: "t1",
          },
          key: "safety",
          loading: false,
          loadError: null,
          onOpenPause: vi.fn(),
          onResume: vi.fn(),
          readiness: null,
          savingControl: false,
        }),
        createElement(PauseEmailSendingDialog, {
          canWrite: false,
          key: "dialog",
          onConfirm,
          onOpenChange: vi.fn(),
          onReasonChange: vi.fn(),
          open: true,
          reason: "Pilot pause",
          savingControl: false,
        }),
      ]),
    );

    try {
      expect(
        Array.from(document.querySelectorAll("input, textarea")).every(
          (field) => (field as HTMLInputElement).disabled,
        ),
      ).toBe(true);
      expect(buttonByText("Save compliance profile").disabled).toBe(true);
      expect(buttonByText("Pause sends").disabled).toBe(true);
      expect(document.body.textContent).toContain("read-only for your role");
      expect(onSave).not.toHaveBeenCalled();
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("hides unknown compliance values after a failed baseline load", () => {
    const root = render(
      createElement(ComplianceProfileCard, {
        canWrite: true,
        complianceReady: false,
        loading: false,
        onProfileChange: vi.fn(),
        onSave: vi.fn(),
        profile: profile(),
        profileDirty: false,
        savingProfile: false,
        unavailable: true,
      }),
    );
    try {
      expect(document.body.textContent).toContain(
        "unknown values cannot be overwritten",
      );
      expect(document.querySelector("#legal-sender-name")).toBeNull();
      expect(document.querySelector("#default-footer-text")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("wires the stored default footer and blocks invalid dirty profiles", () => {
    const onProfileChange = vi.fn();
    const root = render(
      createElement(ComplianceProfileCard, {
        canWrite: true,
        complianceReady: false,
        loading: false,
        onProfileChange,
        onSave: vi.fn(),
        profile: profile({ legal_sender_name: "", default_footer_text: "Old" }),
        profileDirty: true,
        savingProfile: false,
      }),
    );
    try {
      const footer = textareaById("default-footer-text");
      act(() => changeTextarea(footer, "New legal footer"));
      expect(onProfileChange).toHaveBeenCalledWith({
        default_footer_text: "New legal footer",
      });
      expect(buttonByText("Save compliance profile").disabled).toBe(true);
      expect(
        document
          .querySelector("#legal-sender-name")
          ?.getAttribute("aria-invalid"),
      ).toBe("true");
    } finally {
      act(() => root.unmount());
    }
  });
});
