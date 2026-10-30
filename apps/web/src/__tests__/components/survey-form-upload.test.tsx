// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SurveyForm } from "@/components/SurveyForm";
import type { Form } from "@/lib/forms-types";

vi.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) => {
      if (key === "upload_complete") return "Upload complete";
      if (key === "uploaded") return "Uploaded.";
      if (key === "upload_progress") {
        return `Uploading… ${values?.progress ?? 0}%`;
      }
      return key;
    },
}));

type MockXhrProgressHandler = (event: ProgressEvent) => void;

class MockXMLHttpRequest {
  static lastInstance: MockXMLHttpRequest | null = null;

  upload: { onprogress: MockXhrProgressHandler | null } = {
    onprogress: null,
  };
  status = 200;
  timeout = 0;
  withCredentials = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  constructor() {
    MockXMLHttpRequest.lastInstance = this;
  }

  open = vi.fn();
  setRequestHeader = vi.fn();

  send = vi.fn(() => {
    this.upload.onprogress?.(
      new ProgressEvent("progress", {
        lengthComputable: true,
        loaded: 512,
        total: 1024,
      }),
    );
    this.onload?.();
  });
}

const originalFetch = globalThis.fetch;
const originalXMLHttpRequest = globalThis.XMLHttpRequest;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXMLHttpRequest;
  vi.restoreAllMocks();
});

function render(ui: ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

const uploadForm: Form = {
  id: "form_1",
  tenantId: "tenant_1",
  slug: "brief",
  name: "Brief intake",
  optInMode: "single",
  status: "published",
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T00:00:00.000Z",
  settings: {
    successMessage: "Thanks",
  },
  structure: {
    fields: [
      {
        id: "asset",
        kind: "file_upload",
        label: "Creative brief",
        required: true,
        customKey: "brief",
        acceptMime: ["text/plain"],
        maxBytes: 1024 * 1024,
      },
      {
        id: "submit",
        kind: "submit",
        label: "Submit",
        required: false,
      },
    ],
  },
};

describe("SurveyForm file upload accessibility", () => {
  it("labels the file input and announces upload progress/status", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            upload_id: "upload_1",
            put_url: "https://uploads.postwave.test/brief.txt",
            put_headers: {
              "Content-Type": "text/plain",
              "x-amz-server-side-encryption": "aws:kms",
              "x-amz-server-side-encryption-aws-kms-key-id": "arn:aws:kms:test",
            },
            field_value: "upload_1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    globalThis.XMLHttpRequest =
      MockXMLHttpRequest as unknown as typeof XMLHttpRequest;

    const { container, root } = render(
      createElement(SurveyForm, {
        form: uploadForm,
        actionUrl: "/api/public/forms/brief/submit",
      }),
    );

    try {
      const label = container.querySelector("label");
      const input =
        container.querySelector<HTMLInputElement>('input[type="file"]');
      expect(label?.textContent).toContain("Creative brief");
      expect(input).not.toBeNull();
      expect(label?.getAttribute("for")).toBe(input?.id);
      expect(input?.required).toBe(true);

      const file = new File(["hello"], "brief.txt", { type: "text/plain" });
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });

      await act(async () => {
        input?.dispatchEvent(new Event("change", { bubbles: true }));
        await flush();
        await flush();
      });

      const progress = container.querySelector('[role="progressbar"]');
      const status = container.querySelector('[role="status"]');
      const hidden = container.querySelector<HTMLInputElement>(
        'input[type="hidden"][name="cf_brief"]',
      );

      expect(progress?.getAttribute("aria-valuenow")).toBe("100");
      expect(progress?.getAttribute("aria-valuetext")).toBe("Upload complete");
      expect(status?.textContent).toContain("Uploaded.");
      expect(hidden?.value).toBe("upload_1");
      expect(MockXMLHttpRequest.lastInstance?.withCredentials).toBe(false);
      expect(
        MockXMLHttpRequest.lastInstance?.setRequestHeader,
      ).toHaveBeenCalledWith("x-amz-server-side-encryption", "aws:kms");
      expect(
        MockXMLHttpRequest.lastInstance?.setRequestHeader,
      ).toHaveBeenCalledWith(
        "x-amz-server-side-encryption-aws-kms-key-id",
        "arn:aws:kms:test",
      );
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });
});
