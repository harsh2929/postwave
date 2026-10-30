import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PricingSuccessPage from "@/app/(marketing)/pricing/success/page";

describe("pricing checkout return", () => {
  it("never treats a browser redirect as payment evidence", () => {
    const html = renderToStaticMarkup(<PricingSuccessPage />);

    expect(html).toContain("We can&#x27;t verify a payment from this page");
    expect(html).toContain("signed payment webhook");
    expect(html).not.toContain("Payment received");
    expect(html).not.toContain("provisioning your workspace");
  });
});
