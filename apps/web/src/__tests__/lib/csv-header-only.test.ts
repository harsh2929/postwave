// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { csvIsHeaderOnly } from "@/lib/translations-api";

describe("header-only CSV detection", () => {
  it("recognises the live export, which has a header and no rows", () => {
    expect(csvIsHeaderOnly("term,case_sensitive,notes\n")).toBe(true);
  });

  it("is false once a row exists", () => {
    expect(
      csvIsHeaderOnly("term,case_sensitive,notes\nPostwave,true,brand\n"),
    ).toBe(false);
  });

  it("ignores trailing blank lines rather than counting them as rows", () => {
    // A trailing newline is not data, and counting it would report a real
    // glossary as empty or an empty one as full.
    expect(csvIsHeaderOnly("term,case_sensitive,notes\n\n\n")).toBe(true);
  });

  it("treats CRLF the same as LF", () => {
    expect(csvIsHeaderOnly("term,notes\r\nPostwave,brand\r\n")).toBe(false);
  });

  it("treats a completely empty body as header-only", () => {
    expect(csvIsHeaderOnly("")).toBe(true);
  });
});
