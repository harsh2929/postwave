// SPDX-License-Identifier: AGPL-3.0-only
//
// Which stored note-attachment keys the web remove route can address, and the
// path tail it sends for them (the route is {file_key:.+}).

import { describe, expect, it } from "vitest";

import {
  noteAttachmentKeyAddressable,
  noteAttachmentKeyPath,
} from "@/lib/subscriber-profile-api";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("noteAttachmentKeyAddressable", () => {
  it("accepts a flat key and the tenants/… storage layout", () => {
    expect(noteAttachmentKeyAddressable("invoice.pdf")).toBe(true);
    expect(
      noteAttachmentKeyAddressable(`tenants/${TENANT}/notes/n1/invoice.pdf`),
    ).toBe(true);
  });

  it("refuses segments the browser would collapse or the API would compare encoded", () => {
    expect(noteAttachmentKeyAddressable(`tenants/${TENANT}/../x.pdf`)).toBe(
      false,
    );
    expect(noteAttachmentKeyAddressable(`tenants/./x.pdf`)).toBe(false);
    expect(noteAttachmentKeyAddressable(`tenants//x.pdf`)).toBe(false);
    expect(noteAttachmentKeyAddressable(`/tenants/x.pdf`)).toBe(false);
    expect(noteAttachmentKeyAddressable(`tenants/x.pdf/`)).toBe(false);
    expect(noteAttachmentKeyAddressable(`tenants/report Q3.pdf`)).toBe(false);
    expect(noteAttachmentKeyAddressable(`tenants/a%2Fb.pdf`)).toBe(false);
    expect(noteAttachmentKeyAddressable("")).toBe(false);
    expect(noteAttachmentKeyAddressable("a".repeat(1025))).toBe(false);
  });
});

describe("noteAttachmentKeyPath", () => {
  it("keeps the separators and encodes each part, as desktop does", () => {
    expect(noteAttachmentKeyPath(`tenants/${TENANT}/notes/invoice.pdf`)).toBe(
      `tenants/${TENANT}/notes/invoice.pdf`,
    );
    expect(noteAttachmentKeyPath("tenant files/report Q3.pdf")).toBe(
      "tenant%20files/report%20Q3.pdf",
    );
  });
});
