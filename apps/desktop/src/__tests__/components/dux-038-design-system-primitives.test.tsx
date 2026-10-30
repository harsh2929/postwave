import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WinnerBanner } from "../../components/abtest/WinnerBanner";
import { Banner } from "../../components/Banner";
import { Card } from "../../components/Card";
import {
  CancelledBanner,
  PartialImportBanner,
  SourceUnavailableBanner,
} from "../../components/migration/MigrationErrorBanners";
import { Notice } from "../../components/Notice";
import { Skeleton } from "../../components/Skeleton";
import { AutoDisabledBanner } from "../../components/webhooks/AutoDisabledBanner";

function source(relative: string): string {
  return readFileSync(resolve(process.cwd(), "src", relative), "utf8");
}

describe("DUX-038 primitive semantics", () => {
  it("reserves assertive announcements for danger unless explicitly requested", () => {
    expect(
      renderToStaticMarkup(<Notice tone="danger">Blocked</Notice>),
    ).toContain('role="alert"');
    expect(
      renderToStaticMarkup(<Notice tone="warning">Degraded</Notice>),
    ).toContain('role="status"');
    expect(
      renderToStaticMarkup(<Notice tone="info">Context</Notice>),
    ).toContain('role="note"');
    expect(
      renderToStaticMarkup(
        <Notice tone="warning" announcement="assertive">
          Act now
        </Notice>,
      ),
    ).toContain('role="alert"');
  });

  it("requires a contextual dismiss name and omits empty action chrome", () => {
    const plain = renderToStaticMarkup(<Banner title="Plain">Body</Banner>);
    expect(plain).not.toContain("<button");

    const dismissible = renderToStaticMarkup(
      <Banner
        title="Domain verified"
        onDismiss={vi.fn()}
        dismissLabel="Dismiss domain verified banner"
      >
        Body
      </Banner>,
    );
    expect(dismissible).toContain(
      'aria-label="Dismiss domain verified banner"',
    );
  });

  it("keeps Card non-interactive and labels an explicit section from its heading", () => {
    const neutral = renderToStaticMarkup(<Card title="Summary">Body</Card>);
    expect(neutral.startsWith("<div")).toBe(true);
    expect(neutral).toContain("<h3");
    expect(neutral).not.toContain('role="button"');

    const section = renderToStaticMarkup(
      <Card as="section" title="Article 50 readiness">
        Body
      </Card>,
    );
    expect(section).toMatch(/<section[^>]+aria-labelledby="[^"]+"/);
    expect(section).toMatch(/<h3 id="[^"]+-title"/);
  });

  it("hides visual skeletons from AT and announces only an explicitly named owner", () => {
    const decorative = renderToStaticMarkup(
      <div>
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>,
    );
    expect(decorative.match(/aria-hidden="true"/g)).toHaveLength(3);
    expect(decorative).not.toContain('role="status"');

    const labelled = renderToStaticMarkup(
      <Skeleton lines={3} aria-label="Loading forms" />,
    );
    expect(labelled.match(/role="status"/g)).toHaveLength(1);
    expect(labelled).toContain('aria-label="Loading forms"');
    expect(labelled.match(/aria-hidden="true"/g)).toHaveLength(3);
  });
});

describe("DUX-038 domain Banner composition", () => {
  it("uses announcement severity that matches each domain state", () => {
    const unavailable = renderToStaticMarkup(
      <SourceUnavailableBanner sourceLabel="Mailchimp" />,
    );
    expect(unavailable).toContain('role="status"');

    const partial = renderToStaticMarkup(
      <PartialImportBanner failures={[]} onRetry={vi.fn()} onSkip={vi.fn()} />,
    );
    expect(partial).toContain('role="alert"');

    const cancelled = renderToStaticMarkup(
      <CancelledBanner
        importedSubscribers={12}
        onView={vi.fn()}
        onRollback={vi.fn()}
      />,
    );
    expect(cancelled).toContain('role="status"');

    const pendingWinner = renderToStaticMarkup(
      <WinnerBanner variantIndex={-1} method="not_decided" confidence={0.6} />,
    );
    expect(pendingWinner).toContain('role="note"');

    const disabledWebhook = renderToStaticMarkup(
      <AutoDisabledBanner webhookId="wh_1" onReEnabled={vi.fn()} />,
    );
    expect(disabledWebhook).toContain('role="alert"');
  });
});

describe("DUX-038 source and platform guardrails", () => {
  it("removes the nested pseudo-button card from Forms", () => {
    const forms = source("pages/Forms.tsx");
    expect(forms).toContain('className="form-tile"');
    expect(forms).toContain('className="link-button form-tile-open"');
    expect(forms).not.toMatch(/className="card form-tile"/);
    expect(forms).not.toMatch(
      /className="form-tile"[\s\S]{0,120}role="button"/,
    );
  });

  it("gives Template cards an explicit open control beside favorite", () => {
    const templatesView = source(
      "components/templates/TemplatesLibraryView.tsx",
    );
    expect(templatesView).toContain('className="tpl-card"');
    expect(templatesView).toContain(
      'className="link-button tpl-name tpl-card-open"',
    );
    expect(templatesView).not.toMatch(/className="card tpl-card"/);
    expect(templatesView).not.toMatch(
      /className="tpl-card"[\s\S]{0,180}role="button"/,
    );
  });

  it("pins forced-colors, reduced-motion, and visual-story coverage", () => {
    const css = source("styles/design-system.css");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain(".pw-notice");
    expect(css).toContain(".pw-card");
    expect(css).toContain(".skel");

    const stories = readFileSync(
      resolve(process.cwd(), "tests/storybook/stories.spec.ts"),
      "utf8",
    );
    for (const id of [
      "primitives-notice--danger",
      "primitives-banner--dismissible",
      "primitives-card--with-header",
      "primitives-skeleton--multi-line",
    ]) {
      expect(stories).toContain(id);
    }
  });
});
