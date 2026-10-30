// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import * as React from "react";
import { Button } from "../src/components/Button.js";
import { Column } from "../src/components/Column.js";
import { Divider } from "../src/components/Divider.js";
import { Email } from "../src/components/Email.js";
import { Footer } from "../src/components/Footer.js";
import { Heading } from "../src/components/Heading.js";
import { Image } from "../src/components/Image.js";
import { Link } from "../src/components/Link.js";
import { Section } from "../src/components/Section.js";
import { SocialRow } from "../src/components/SocialRow.js";
import { Spacer } from "../src/components/Spacer.js";
import { Text } from "../src/components/Text.js";
import { renderToHtml } from "../src/render/to-html.js";

describe("integration: full Email composing several primitives", () => {
  it("produces valid email HTML with all primitives", async () => {
    const tree = (
      <Email preview="A preview line" title="An email">
        <Section backgroundColor="#ffffff">
          <Column>
            <Image
              src="https://cdn.example.test/logo.png"
              alt="logo"
              width="120px"
            />
            <Heading level={1} align="center">
              A heading
            </Heading>
            <Text align="center">
              Lead paragraph with a{" "}
              <Link href="https://example.test">link</Link>.
            </Text>
            <Spacer height="16px" />
            <Button href="https://example.test/cta" align="center">
              Primary CTA
            </Button>
            <Spacer height="16px" />
            <Divider />
            <Text>Section copy goes here.</Text>
            <SocialRow
              items={[
                { name: "twitter", href: "https://example.test/t" },
                { name: "linkedin", href: "https://example.test/l" },
              ]}
            />
          </Column>
        </Section>
        <Footer
          senderName="The Sender"
          address="1 Some Street, City, Country"
          unsubscribeUrl="https://example.test/u"
        />
      </Email>
    );

    const { html, mjml, errors } = await renderToHtml(tree);
    expect(errors).toEqual([]);
    expect(mjml).toContain("<mjml>");
    expect(mjml).toContain("</mjml>");
    expect(html.toLowerCase()).toContain("<html");
    expect(html).toContain("Primary CTA");
    expect(html).toContain("A heading");
    expect(html).toContain("Unsubscribe");
  });
});
