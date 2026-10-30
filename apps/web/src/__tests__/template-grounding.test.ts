// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { reviewGeneratedTemplateGrounding } from "@/lib/template-grounding";

describe("reviewGeneratedTemplateGrounding", () => {
  it("flags links and monetary claims that were not supplied as approved", () => {
    const warnings = reviewGeneratedTemplateGrounding(
      '<a href="https://other.example/offer">Save $79</a><img src="https://other.example/hero.png" alt="Hero"><style>.box{width:50%}</style>',
      "Launch offer",
      { approved_facts: ["The early-bird price is $49."], approved_urls: ["https://approved.example/offer"] },
    );
    expect(warnings.join(" ")).toContain("https://other.example/offer");
    expect(warnings.join(" ")).toContain("$79");
    expect(warnings.join(" ")).toContain("image URL");
    expect(warnings.join(" ")).not.toContain("50%");
  });

  it("does not flag numerical claims verbatim in operator-supplied facts", () => {
    const warnings = reviewGeneratedTemplateGrounding("<p>Save $49</p>", "", {
      approved_facts: ["The price is $49."],
    });
    expect(warnings.join(" ")).not.toContain("not found verbatim");
  });
});
