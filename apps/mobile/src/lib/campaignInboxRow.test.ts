/**
 * The inbox-row model behind the identity sheet's live preview: from-name
 * wins over address (what clients actually display), and empty preview text
 * states the inbox's REAL fallback instead of rendering a blank.
 */
import { describe, expect, it } from "vitest";

import {
  INBOX_ROW_EMPTY_SNIPPET_NOTE,
  inboxRowModel,
} from "./campaignInboxRow";

describe("inboxRowModel", () => {
  it("from-name wins over the address", () => {
    const row = inboxRowModel({
      fromName: "Acme Weekly",
      fromEmail: "news@acme.com",
      subject: "The launch",
      previewText: "It shipped.",
    });
    expect(row).toEqual({
      sender: "Acme Weekly",
      subject: "The launch",
      snippet: "It shipped.",
    });
  });

  it("falls back to the address, then a placeholder sender", () => {
    expect(
      inboxRowModel({
        fromName: " ",
        fromEmail: "news@acme.com",
        subject: "s",
        previewText: "p",
      }).sender,
    ).toBe("news@acme.com");
    expect(
      inboxRowModel({ fromName: "", fromEmail: "", subject: "s", previewText: "p" })
        .sender,
    ).toBe("you@your-domain.com");
  });

  it("empty preview text yields a null snippet — the component then states the body fallback", () => {
    const row = inboxRowModel({
      fromName: "A",
      fromEmail: "",
      subject: "",
      previewText: "  ",
    });
    expect(row.snippet).toBeNull();
    expect(row.subject).toBe("(no subject)");
    expect(INBOX_ROW_EMPTY_SNIPPET_NOTE).toMatch(/preview text/);
  });
});
