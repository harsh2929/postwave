// SPDX-License-Identifier: AGPL-3.0-only
//
// Accessibility statement — European Accessibility Act (Dir. (EU) 2019/882,
// applicable since 2025-06-28) and EN 301 549.
//
// Written in the same register as /security, and for the same reason: an
// accessibility statement is a CLAIM, and a false accessibility claim is both
// an EAA problem and an FTC Act §5 / UCPD Art. 6 problem. So this page states
// what is actually tested in this repository, names the gaps, and does NOT
// assert unqualified WCAG 2.1 AA conformance — no independent audit has been
// performed. If a section drifts from what the test suite really covers, fix
// the suite or weaken the claim, never the other way.
//
// Deliberately NOT under /legal/*. That route group 404s behind the counsel
// publication gate (see lib/legal-publication.ts), and a conformance statement
// that cannot be reached is exactly the failure the compliance audit recorded
// for the cookie banner.
import type { Metadata } from "next";
import Link from "next/link";

import {
  JsonLd,
  breadcrumbSchema,
  type JsonLdObject,
} from "@/components/seo/json-ld";
import { asRoute } from "@/lib/typed-routes";

const PAGE_URL = "https://moosewave.com/accessibility";
// Visible review date, matching the /security convention. Update when the
// statements below are re-checked against the suite.
const LAST_REVIEWED = "2026-09-05";
const PAGE_DESCRIPTION =
  "Moosewave's accessibility status: what is tested, what is known to be incomplete, and how to report a barrier.";

export const metadata: Metadata = {
  title: "Accessibility | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave accessibility statement",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
  },
};

interface Section {
  id: string;
  heading: string;
  bullets: string[];
}

const SECTIONS: Section[] = [
  {
    id: "standard",
    heading: "The standard we work to",
    bullets: [
      "Moosewave targets WCAG 2.1 Level AA, the standard referenced by EN 301 549 and by the European Accessibility Act (Directive (EU) 2019/882), and the level United States Department of Justice guidance points to for ADA Title III web accessibility.",
      "This is a statement of the target and of the testing actually performed against it. It is not a declaration of full conformance: no independent accessibility audit and no assistive-technology user testing have been carried out, so parts of the product are unverified rather than verified-passing.",
      "Accessibility is treated as a regression surface, not a one-time review. The checks described below run in continuous integration and block a merge when they fail.",
    ],
  },
  {
    id: "tested",
    heading: "What is covered by automated checks",
    bullets: [
      "Keyboard operability across dashboard pages — that every interactive control is reachable and operable without a pointer, that focus order follows meaning, and that focus is visible (WCAG 2.1.1, 2.1.2, 2.4.3, 2.4.7).",
      "Focus containment in dialogs, command palettes, search overlays and menus, including the ability to dismiss with a key rather than only by clicking a close button (WCAG 2.1.2).",
      "Scrollable regions — code samples, tables and JSON panels are focusable, because a scroll region a keyboard user cannot reach is a region they cannot read (WCAG 2.1.1). This check has caught real defects in shipped pages.",
      "ARIA reference integrity — every aria-labelledby, aria-describedby and aria-controls resolves to an element that exists, so assistive technology is not pointed at a missing node.",
      "Consent and onboarding surfaces specifically: the cookie banner, install prompt, product tour and dashboard menus each carry their own accessibility tests, because these are interruptive and appear before a visitor has committed to anything.",
    ],
  },
  {
    id: "email",
    heading: "Accessibility of the email you send",
    bullets: [
      "Moosewave includes a pre-send accessibility checker for campaign content, so an operator sees problems before a message reaches a subscriber rather than after.",
      "It flags missing image alt text (WCAG 1.1.1), a missing document language attribute (3.1.1), text and background colour pairs below the 4.5:1 AA contrast ratio (1.4.3), empty or non-descriptive link text such as “click here” (2.4.4), text below 12px, a missing document title, and image-only emails whose message a screen reader cannot surface at all.",
      "Findings are surfaced with a severity and shown inline next to the element they concern. They are not auto-corrected: whether a given label is adequate depends on context, and silently rewriting a customer's content would be the wrong default.",
    ],
  },
  {
    id: "known-limitations",
    heading: "Known limitations",
    bullets: [
      "No independent third-party accessibility audit has been commissioned, and no conformance has been certified by an external body.",
      "No structured testing with screen readers or other assistive technologies by people who rely on them has been carried out. Automated checks find missing structure; they cannot tell you whether a flow is usable.",
      "Coverage is not uniform. Authentication, settings, consent and the main dashboard surfaces carry the most testing; deeper analytics views, the visual flow builder, and drag-and-drop editing surfaces are the least covered, and drag-based interactions in particular may lack a fully equivalent keyboard path.",
      "Rich content a customer authors — landing pages, hosted forms, and email templates — can be made inaccessible by the customer despite the checks above. The pre-send checker warns; it does not prevent sending.",
      "The marketing site, the documentation site, the desktop application and the mobile application are each tested to different depths. This statement describes the web platform.",
    ],
  },
  {
    id: "feedback",
    heading: "Reporting a barrier",
    bullets: [
      "Email accessibility@moosewave.com describing what you were trying to do, the page or screen, and the assistive technology and browser you were using. A specific barrier report is far more actionable than a general audit result.",
      "Reports about a barrier that prevents you completing a task — signing in, changing consent, exporting your data, cancelling a subscription, or unsubscribing — are treated as defects and prioritised as such.",
      "If a reply does not resolve the problem, EU users may escalate to the national enforcement authority responsible for the European Accessibility Act in their Member State.",
    ],
  },
];

export default function AccessibilityPage(): JSX.Element {
  const breadcrumbs = breadcrumbSchema([
    { name: "Home", url: "https://moosewave.com" },
    { name: "Accessibility", url: PAGE_URL },
  ]);

  const webPageSchema: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Moosewave accessibility statement",
    description: PAGE_DESCRIPTION,
    url: PAGE_URL,
    inLanguage: "en-US",
    isPartOf: {
      "@type": "WebSite",
      name: "Moosewave",
      url: "https://moosewave.com",
    },
  };

  return (
    <div className="bg-pw-paper">
      <JsonLd data={[webPageSchema, breadcrumbs]} id="accessibility-jsonld" />

      <section className="bg-gradient-to-b from-pw-ink to-[#080711] text-white">
        <div className="max-w-4xl mx-auto px-6 pt-16 pb-14 md:pt-20 md:pb-20">
          <div className="text-pw-ember-300 text-xs tracking-widest font-medium uppercase">
            Accessibility
          </div>
          <h1 className="mt-3 text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            What we test.
            <br />
            What we haven&apos;t.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            Moosewave works to WCAG 2.1 Level AA. This page describes the checks
            that actually run against the product, the parts that remain
            unverified, and how to tell us about a barrier.
          </p>
          <p className="mt-6 text-sm text-pw-muted-on-ink">
            Last reviewed {LAST_REVIEWED}
          </p>
        </div>
      </section>

      <section className="max-w-4xl mx-auto px-6 py-14 md:py-20">
        <div className="space-y-12">
          {SECTIONS.map((section) => (
            <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`}>
              <h2
                id={`${section.id}-heading`}
                className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink"
              >
                {section.heading}
              </h2>
              <ul className="mt-4 space-y-3">
                {section.bullets.map((bullet) => (
                  <li key={bullet} className="text-pw-ink2 leading-relaxed">
                    {bullet}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <p className="mt-12 text-sm text-pw-ink2">
          Related:{" "}
          <Link
            href={asRoute("/security")}
            className="underline underline-offset-2 hover:text-pw-ink"
          >
            security and control qualification
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
