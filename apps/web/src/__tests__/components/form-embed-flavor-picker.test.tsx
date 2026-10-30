// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Share tab parity (desktop FormDetailSlideover): every flavor reads
// GET /api/v1/forms/{id}/embed/{flavor} and renders — and copies — the
// server-authored text VERBATIM. Non-admins get the reason and no request; a
// 503 (no public forms host) renders the server's sentence; a response that
// points off the canonical host is refused rather than offered for pasting.
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMBED_ADMIN_REQUIRED_MESSAGE,
  EmbedFlavorPicker,
} from "@/components/forms/embed-flavor-picker";
import type { MeResponse } from "@/lib/auth-api";
import { EMBED_CONTRACT_ERROR } from "@/lib/forms-extras-api";

import {
  button,
  click,
  eventually,
  identity,
  json,
  mount,
  stubFetch,
  unmountAll,
  type RecordedCall,
} from "../helpers/forms-extras-harness";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

const FORM_ID = "form 1/x";
const ENC = encodeURIComponent(FORM_ID);
const HOST = "https://forms.acme.test";
const PUBLIC_URL = `${HOST}/forms/newsletter`;

const SNIPPETS = {
  iframe: {
    snippet: `<iframe src="${PUBLIC_URL}" title="Subscribe form" loading="lazy" style="width:100%;border:0;min-height:520px;"></iframe>`,
    language: "html",
    instructions: "Paste anywhere inside <body>. CSP-safe.",
  },
  script: {
    snippet: `<script async src="${HOST}/embed.js" data-postwave-form="newsletter"></script>`,
    language: "html",
    instructions: "Add data-postwave-mode='popup' to open the form as a modal.",
  },
  react: {
    snippet: `export function PostwaveForm() {\n  return <iframe src="${PUBLIC_URL}" title="Subscribe form" style={{ width: "100%", minHeight: 520, border: 0 }} />;\n}`,
    language: "tsx",
    instructions: "Drop this component into any React/Next.js page.",
  },
} as const;

let calls: RecordedCall[];
let mode: "ok" | "unconfigured" | "offhost";

function embedCalls() {
  return calls.filter((c) => c.path.startsWith(`/api/v1/forms/${ENC}/embed/`));
}

function codeText(): string {
  return (
    document.querySelector<HTMLElement>('pre[role="group"]')?.textContent ?? ""
  );
}

beforeEach(() => {
  mode = "ok";
  ({ calls } = stubFetch((call) => {
    const m = call.path.match(/^\/api\/v1\/forms\/([^/]+)\/embed\/([a-z]+)$/);
    if (!m || call.method !== "GET" || m[1] !== ENC) return undefined;
    if (mode === "unconfigured") {
      return json(
        {
          error: {
            code: "forms_public_host_unconfigured",
            message: "canonical forms public host is not configured",
          },
        },
        { status: 503, headers: { "retry-after": "0" } },
      );
    }
    const flavor = m[2] as keyof typeof SNIPPETS;
    return json({
      flavor,
      ...SNIPPETS[flavor],
      public_host: HOST,
      public_url: mode === "offhost" ? "https://evil.test/forms/newsletter" : PUBLIC_URL,
    });
  }));
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: undefined,
    configurable: true,
    writable: true,
  });
});

function render(me: MeResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return mount(
    createElement(
      QueryClientProvider,
      { client },
      createElement(EmbedFlavorPicker, { formId: FORM_ID, identity: me }),
    ),
  );
}

describe("EmbedFlavorPicker", () => {
  it("reads each flavor from the server and renders + copies it verbatim", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    render(identity());

    // Hosted page = the canonical URL from the iframe contract.
    await eventually(() => expect(codeText()).toBe(PUBLIC_URL));
    expect(embedCalls().map((c) => c.path)).toEqual([
      `/api/v1/forms/${ENC}/embed/iframe`,
    ]);
    expect(document.body.textContent).toContain(`Served by ${HOST}.`);

    await click(button("Script"));
    await eventually(() => expect(codeText()).toBe(SNIPPETS.script.snippet));
    expect(embedCalls().at(-1)?.path).toBe(`/api/v1/forms/${ENC}/embed/script`);
    expect(document.body.textContent).toContain(SNIPPETS.script.instructions);

    await click(button("React"));
    await eventually(() => expect(codeText()).toBe(SNIPPETS.react.snippet));
    expect(embedCalls().at(-1)?.path).toBe(`/api/v1/forms/${ENC}/embed/react`);
    expect(document.body.textContent).toContain("tsx");

    await click(button("Copy code"));
    await eventually(() =>
      expect(writeText).toHaveBeenCalledWith(SNIPPETS.react.snippet),
    );

    await click(button("Iframe"));
    await eventually(() => expect(codeText()).toBe(SNIPPETS.iframe.snippet));
    // Iframe and hosted share one cached response: no second iframe read.
    expect(
      embedCalls().filter((c) => c.path.endsWith("/embed/iframe")),
    ).toHaveLength(1);
  });

  it("withholds the admin-scoped route from an editor, with the reason", async () => {
    render(identity({ role: "editor", effective_role: "editor" }));
    await eventually(() =>
      expect(document.body.textContent).toContain(EMBED_ADMIN_REQUIRED_MESSAGE),
    );
    expect(button("Script").disabled).toBe(true);
    expect(embedCalls()).toHaveLength(0);
  });

  it("renders the server's sentence when the public forms host is unconfigured", async () => {
    mode = "unconfigured";
    render(identity());
    await eventually(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "canonical forms public host is not configured",
      ),
    );
    expect(codeText()).toBe("");
    expect(
      Array.from(document.querySelectorAll("button")).some((b) =>
        /^Copy/.test(b.textContent ?? ""),
      ),
    ).toBe(false);
  });

  it("refuses a response that points off the canonical host", async () => {
    mode = "offhost";
    render(identity());
    await eventually(() =>
      expect(document.body.textContent).toContain(EMBED_CONTRACT_ERROR),
    );
    expect(codeText()).toBe("");
  });
});
