// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { serializeJsonLd } from "@/components/seo/json-ld";

describe("serializeJsonLd", () => {
  it("cannot emit a script-closing sequence from composed content", () => {
    const serialized = serializeJsonLd({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "</script><script>alert(1)</script>",
    });

    expect(serialized).not.toContain("<");
    expect(serialized).not.toContain("</script>");
    expect(JSON.parse(serialized).headline).toBe(
      "</script><script>alert(1)</script>",
    );
  });
});
