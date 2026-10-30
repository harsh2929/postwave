// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { clearAllTemplateEditorRecovery } from "@/lib/campaign-template-session-cleanup";
import {
  readTemplateRecovery,
  templateRecoveryKey,
  writeTemplateRecovery,
} from "@/lib/template-editor-recovery";

const draft = {
  name: "News",
  subject: "Hello",
  previewText: "",
  description: "",
  category: "",
  goal: "newsletter",
  tagsInput: "",
  bodyHtml: "<p>Hello</p>",
  bodyMjml: "",
  variables: "[]",
};

describe("template editor recovery", () => {
  it("is isolated by actor, workspace, template, and server version", () => {
    const base = {
      tenantId: "tenant-a",
      userId: "user-a",
      templateId: "template-a",
      etag: '"v1"',
    };
    const key = templateRecoveryKey(base);
    expect(key).not.toBe(
      templateRecoveryKey({ ...base, tenantId: "tenant-b" }),
    );
    expect(key).not.toBe(templateRecoveryKey({ ...base, userId: "user-b" }));
    expect(key).not.toBe(
      templateRecoveryKey({ ...base, templateId: "template-b" }),
    );
    expect(key).not.toBe(templateRecoveryKey({ ...base, etag: '"v2"' }));
  });

  it("round-trips bounded drafts and rejects stale or malformed data", () => {
    const key = "draft";
    expect(writeTemplateRecovery(sessionStorage, key, draft)).toBe(true);
    expect(readTemplateRecovery(sessionStorage, key)).toEqual(draft);
    sessionStorage.setItem(
      key,
      JSON.stringify({
        ...draft,
        savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      }),
    );
    expect(readTemplateRecovery(sessionStorage, key)).toBeNull();
    sessionStorage.setItem(key, "{oops");
    expect(readTemplateRecovery(sessionStorage, key)).toBeNull();
    expect(
      writeTemplateRecovery(sessionStorage, key, {
        ...draft,
        bodyHtml: "x".repeat(1_600_001),
      }),
    ).toBe(false);
  });

  it("clears only template browser drafts at logout", () => {
    const key = templateRecoveryKey({
      tenantId: "tenant",
      userId: "actor",
      templateId: "draft",
    });
    sessionStorage.setItem(key, "private draft");
    sessionStorage.setItem("unrelated", "keep");
    clearAllTemplateEditorRecovery();
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("keep");
    sessionStorage.removeItem("unrelated");
  });
});
