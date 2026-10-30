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
import { renderMjmlToHtml, renderToHtml } from "../src/render/to-html.js";
import { renderToMjml } from "../src/render/to-mjml.js";

async function compile(el: React.ReactElement) {
  const mjml = renderToMjml(el);
  const { html, errors } = await renderToHtml(el);
  return { mjml, html, errors };
}

describe("primitives → MJML", () => {
  it("rejects mj-include before invoking the MJML compiler", async () => {
    await expect(
      renderMjmlToHtml(
        '<mjml><mj-body><mj-include path="../../etc/passwd" /></mj-body></mjml>',
      ),
    ).rejects.toThrow("mj-include is not supported");
  });

  it("Email root emits <mjml>, <mj-body>, and a preview", async () => {
    const { mjml, html } = await compile(
      <Email preview="hello there" title="t">
        <Section>
          <Column>
            <Text>body</Text>
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).toContain("<mjml>");
    expect(mjml).toContain("<mj-body");
    expect(mjml).toContain("<mj-preview>hello there</mj-preview>");
    expect(html).toContain("<!doctype html>");
  });

  it("Section + Column emit mj-section and mj-column", async () => {
    const { mjml } = await compile(
      <Email>
        <Section backgroundColor="#fafafa">
          <Column width="50%">
            <Text>hi</Text>
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).toContain("<mj-section");
    expect(mjml).toContain('background-color="#fafafa"');
    expect(mjml).toContain("<mj-column");
    expect(mjml).toContain('width="50%"');
  });

  it("Text passes through styling attrs", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <Text color="#222" fontSize="14px" align="center">
              hi
            </Text>
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).toContain('color="#222"');
    expect(mjml).toContain('font-size="14px"');
    expect(mjml).toContain('align="center"');
  });

  it("Heading uses larger font size and bold weight", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <Heading level={1}>Welcome</Heading>
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).toContain('font-size="28px"');
    expect(mjml).toContain('font-weight="700"');
    expect(mjml).toContain("Welcome");
  });

  it("Button emits mj-button with href", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <Button href="https://example.test/cta">Go</Button>
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).toContain("<mj-button");
    expect(mjml).toContain('href="https://example.test/cta"');
    expect(mjml).toContain(">Go</mj-button>");
  });

  it("Image emits mj-image", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <Image src="https://cdn.example/x.png" alt="x" width="200px" />
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).toContain("<mj-image");
    expect(mjml).toContain('src="https://cdn.example/x.png"');
    expect(mjml).toContain('alt="x"');
  });

  it("Divider emits mj-divider with border", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <Divider borderColor="#000" />
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).toContain("<mj-divider");
    expect(mjml).toContain('border-color="#000"');
  });

  it("Spacer emits mj-spacer with height", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <Spacer height="32px" />
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).toContain("<mj-spacer");
    expect(mjml).toContain('height="32px"');
  });

  it("Link renders as inline <a> inside text", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <Text>
              See <Link href="https://example.test">here</Link>.
            </Text>
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).toContain('<a href="https://example.test/"');
    expect(mjml).toContain(">here</a>");
  });

  it("Link rejects script and credentialed URLs", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <Text>
              <Link href="javascript:alert(1)">bad</Link>
              <Link href="https://u:p@example.test">creds</Link>
            </Text>
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).not.toContain("javascript:");
    expect(mjml).not.toContain("u:p@");
    expect((mjml.match(/href="#"/g) ?? []).length).toBe(2);
  });

  it("Link rejects protocol-relative URLs but preserves template tokens", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <Text>
              <Link href="//evil.example/path">bad</Link>
              <Link href="{{unsubscribe_url}}">unsubscribe</Link>
            </Text>
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).not.toContain("//evil.example");
    expect(mjml).toContain('href="#"');
    expect(mjml).toContain('href="{{unsubscribe_url}}"');
  });

  it("Link rejects local, private, and encoded-control URLs", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <Text>
              <Link href="https://localhost/unsubscribe">local</Link>
              <Link href="http://169.254.169.254/latest">metadata</Link>
              <Link href="https://example.test/%0aevil">encoded</Link>
              <Link href={"https://example.test/path\nbad"}>control</Link>
            </Text>
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).not.toContain("localhost");
    expect(mjml).not.toContain("169.254.169.254");
    expect(mjml).not.toContain("%0a");
    expect((mjml.match(/href="#"/g) ?? []).length).toBe(4);
  });

  it("Button and Image sanitize unsafe URLs", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <Button href="javascript:alert(1)">Go</Button>
            <Image src="file:///tmp/a.png" href="https://u:p@example.test" />
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).not.toContain("javascript:");
    expect(mjml).not.toContain("file://");
    expect(mjml).not.toContain("u:p@");
    expect(mjml).toContain('href="#"');
  });

  it("Image rejects private hosts and encoded-control sources", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <Image src="https://127.0.0.1/pixel.png" />
            <Image src="https://cdn.example.test/%0dtracker.png" />
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).not.toContain("127.0.0.1");
    expect(mjml).not.toContain("%0d");
    expect((mjml.match(/src=""/g) ?? []).length).toBe(2);
  });

  it("Image rejects protocol-relative and template-token sources", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <Image src="//cdn.evil.example/pixel.png" />
            <Image src="{{logo_url}}" href="{{homepage_url}}" />
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).not.toContain("//cdn.evil.example");
    expect(mjml).toContain('src=""');
    expect(mjml).toContain('src="{{logo_url}}"');
    expect(mjml).toContain('href="{{homepage_url}}"');
  });

  it("SocialRow emits mj-social and per-item elements", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <SocialRow
              items={[
                { name: "twitter", href: "https://example.test/t" },
                { name: "github", href: "https://example.test/g" },
              ]}
            />
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).toContain("<mj-social");
    expect((mjml.match(/<mj-social-element/g) ?? []).length).toBe(2);
    expect(mjml).toContain('name="twitter"');
    expect(mjml).toContain('name="github"');
  });

  it("SocialRow sanitizes unsafe item URLs", async () => {
    const { mjml } = await compile(
      <Email>
        <Section>
          <Column>
            <SocialRow items={[{ name: "web", href: "javascript:alert(1)" }]} />
          </Column>
        </Section>
      </Email>,
    );
    expect(mjml).not.toContain("javascript:");
    expect(mjml).toContain('href="#"');
  });

  it("Footer renders an unsubscribe section", async () => {
    const { mjml, html } = await compile(
      <Email>
        <Footer
          senderName="The Sender"
          address="123 Some Street, City"
          unsubscribeUrl="https://example.test/u"
        />
      </Email>,
    );
    expect(mjml).toContain("Unsubscribe");
    expect(mjml).toContain('href="https://example.test/u"');
    expect(html).toContain("Unsubscribe");
  });

  it("compiles to HTML with no errors for a minimal Email", async () => {
    const { html, errors } = await compile(
      <Email>
        <Section>
          <Column>
            <Text>ok</Text>
          </Column>
        </Section>
      </Email>,
    );
    expect(errors).toEqual([]);
    expect(html.toLowerCase()).toContain("<html");
    expect(html.toLowerCase()).toContain("</html>");
  });
});
