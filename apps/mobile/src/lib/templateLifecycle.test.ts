/**
 * The archive / restore rules, pinned in node. Two readers (the hook and the
 * sheet's action row) depend on these agreeing, so the assertions are about
 * the CONTRACT — which verb, whether it is offered, what is confirmed — not
 * about any one rendering of it.
 */
import { describe, expect, it } from "vitest";

import {
  isStrongTemplateEtag,
  templateArchiveConfirm,
  templateLifecycleButtonLabel,
  templateLifecycleFailureFallback,
  templateLifecycleOffered,
  templateLifecycleSuccessMessage,
  templateLifecycleVerb,
  TEMPLATE_LIFECYCLE_A11Y,
} from "./templateLifecycle";

const ACTIVE = { etag: '"v7"', archivedAt: null };
const ARCHIVED = { etag: '"v8"', archivedAt: "2026-08-01T10:00:00Z" };

describe("templateLifecycleVerb", () => {
  it("reads the verb off archived_at alone — null means archive, a timestamp means restore", () => {
    expect(templateLifecycleVerb(ACTIVE)).toBe("archive");
    expect(templateLifecycleVerb(ARCHIVED)).toBe("restore");
  });
});

describe("isStrongTemplateEtag", () => {
  it("accepts exactly what requireTemplateIfMatch accepts", () => {
    expect(isStrongTemplateEtag('"v7"')).toBe(true);
    expect(isStrongTemplateEtag('"campaign-template:abc:3"')).toBe(true);
  });

  it("refuses weak, unquoted, empty and truncated tags — each a guaranteed 412/428", () => {
    expect(isStrongTemplateEtag('W/"v7"')).toBe(false);
    expect(isStrongTemplateEtag("v7")).toBe(false);
    expect(isStrongTemplateEtag("")).toBe(false);
    expect(isStrongTemplateEtag('"')).toBe(false);
    expect(isStrongTemplateEtag("*")).toBe(false);
  });
});

describe("templateLifecycleOffered", () => {
  it("offers the verb only to an online editor holding a strong tag", () => {
    expect(
      templateLifecycleOffered({ template: ACTIVE, canWrite: true, online: true }),
    ).toBe(true);
  });

  it("withholds it on any one missing gate", () => {
    expect(
      templateLifecycleOffered({ template: null, canWrite: true, online: true }),
    ).toBe(false);
    expect(
      templateLifecycleOffered({ template: ACTIVE, canWrite: false, online: true }),
    ).toBe(false);
    expect(
      templateLifecycleOffered({ template: ACTIVE, canWrite: true, online: false }),
    ).toBe(false);
    // The catalogue projection: no tag at all.
    expect(
      templateLifecycleOffered({
        template: { etag: "", archivedAt: null },
        canWrite: true,
        online: true,
      }),
    ).toBe(false);
  });
});

describe("templateArchiveConfirm", () => {
  it("names the design, confirms with the verb, and is DESTRUCTIVE", () => {
    const confirm = templateArchiveConfirm("Spring launch");
    expect(confirm.title).toBe("Archive “Spring launch”?");
    expect(confirm.confirmLabel).toBe("Archive");
    expect(confirm.cancelLabel).toBe("Cancel");
    expect(confirm.destructive).toBe(true);
    // The sentence that makes this a reversible act, not a delete.
    expect(confirm.message).toMatch(/Nothing is deleted/);
    expect(confirm.message).toMatch(/Archived shelf/);
  });
});

describe("labels and copy", () => {
  it("keeps the accessible name stable across the busy state", () => {
    expect(TEMPLATE_LIFECYCLE_A11Y.archive.label).toBe("Archive this design");
    expect(TEMPLATE_LIFECYCLE_A11Y.restore.label).toBe(
      "Restore this design to the library",
    );
    expect(templateLifecycleButtonLabel("archive", false)).toBe(
      "Archive this design",
    );
    expect(templateLifecycleButtonLabel("archive", true)).toBe("Archiving…");
    expect(templateLifecycleButtonLabel("restore", false)).toBe(
      "Restore to the library",
    );
    expect(templateLifecycleButtonLabel("restore", true)).toBe("Restoring…");
  });

  it("says where a design went, and how to get it back", () => {
    expect(templateLifecycleSuccessMessage("archive", "Spring launch")).toBe(
      "Archived Spring launch. Restore it any time from the Archived shelf.",
    );
    expect(templateLifecycleSuccessMessage("restore", "Spring launch")).toBe(
      "Restored Spring launch to the library.",
    );
    expect(templateLifecycleFailureFallback("archive")).toBe(
      "Couldn't archive that design.",
    );
    expect(templateLifecycleFailureFallback("restore")).toBe(
      "Couldn't restore that design.",
    );
  });
});
