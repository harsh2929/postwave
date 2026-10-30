// SPDX-License-Identifier: AGPL-3.0-only
//
// Canonical domain: moosewave.com. See docs/legal-pages-audit-2026-06-02.md
// (Blocker §1). Cross-referenced from Privacy §9 and Terms §18.1.
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cookie Policy. Moosewave",
  description:
    "What cookies Moosewave uses, why, and how to opt out of optional categories.",
  alternates: { canonical: "https://moosewave.com/legal/cookies" },
};

type CookieRow = {
  name: string;
  category: "Essential" | "Analytics" | "Marketing";
  purpose: string;
  duration: string;
};

const COOKIES: CookieRow[] = [
  {
    name: "pw_session",
    category: "Essential",
    purpose: "Authenticated session token; required for log-in to function",
    duration: "Session",
  },
  {
    name: "moosewave.cookie.consent.v1 (localStorage)",
    category: "Essential",
    purpose: "Stores your cookie preference choice",
    duration: "13 months",
  },
  {
    name: "ph_* (PostHog)",
    category: "Analytics",
    purpose: "Pseudonymous product analytics; off when you opt out",
    duration: "13 months",
  },
];

export default function CookiePolicyPage(): JSX.Element {
  return (
    <article className="max-w-3xl mx-auto px-6 py-16">
      <h1>Cookie Policy</h1>
      <p className="text-pw-muted-on-paper text-sm">
        Last updated: 2026-04-30. Pending counsel review.
      </p>

      <p>
        We use a small number of cookies to keep Moosewave working, secure your
        session and (with your consent) understand how the product is used. We
        do not run third-party advertising trackers and we do not sell data.
      </p>

      <h2>Categories</h2>
      <h3>Essential</h3>
      <p>
        These are required for Moosewave to function. They handle
        authentication, session management, request-origin checks, and storage
        of your cookie preference. We do not ask consent for these because the
        site will not work without them; this matches GDPR / ePrivacy guidance
        for strictly necessary cookies.
      </p>

      <h3>Analytics (optional)</h3>
      <p>
        We use PostHog (EU-hosted, eu.posthog.com) to understand how the product
        is used: which features get adopted, where flows get stuck, what
        onboarding steps drop off. These cookies are pseudonymous and you can
        opt out via the cookie banner at any time. When you opt out we call
        PostHog&rsquo;s <code>opt_out_capturing</code> API and stop recording
        events.
      </p>

      <h3>Marketing (optional)</h3>
      <p>
        Currently disabled by default. If we add attribution / remarketing in
        the future we will list specific cookies here before they are set, and
        the banner will require your active opt-in.
      </p>

      <h2>Cookie register</h2>
      <div
        role="region"
        aria-label="Cookies we set"
        tabIndex={0}
        className="not-prose mt-3 overflow-x-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
      >
        <table className="w-full text-sm">
          <thead className="bg-pw-surface">
            <tr>
              <th scope="col" className="text-left p-3 font-medium">
                Cookie
              </th>
              <th scope="col" className="text-left p-3 font-medium">
                Category
              </th>
              <th scope="col" className="text-left p-3 font-medium">
                Purpose
              </th>
              <th scope="col" className="text-left p-3 font-medium">
                Duration
              </th>
            </tr>
          </thead>
          <tbody>
            {COOKIES.map((c) => (
              <tr key={c.name} className="border-t align-top">
                <td className="p-3 font-mono text-xs">{c.name}</td>
                <td className="p-3 text-pw-muted-on-paper">{c.category}</td>
                <td className="p-3 text-pw-muted-on-paper">{c.purpose}</td>
                <td className="p-3 text-pw-muted-on-paper">{c.duration}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Managing your preferences</h2>
      <p>
        The cookie banner lets you Accept all, Reject optional, or Customize.
        Your choice is stored in a small localStorage entry (
        <code>moosewave.cookie.consent.v1</code>) so we don&rsquo;t re-prompt
        every visit. To change your choice later, click &quot;Cookie
        preferences&quot; in the site footer.
      </p>
      <p>
        You can also block cookies entirely at the browser level. The site will
        still load but logged-in features will fail because they depend on the
        essential session cookie.
      </p>

      <h2>Third-party cookies on emails</h2>
      <p>
        Moosewave injects open-tracking pixels and click-tracking redirects into
        customer-sent emails by default. Whether these constitute
        &quot;cookies&quot; under the ePrivacy Directive depends on jurisdiction
        and consent posture; the controller (the Moosewave customer who sent the
        email) is responsible for their own compliance posture and can disable
        both per campaign or per workspace.
      </p>

      <h2>Updates</h2>
      <p>
        We update this page when we add, remove, or change cookies. Material
        changes are announced via the cookie banner.
      </p>

      <p>
        Questions:{" "}
        <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a>
      </p>
    </article>
  );
}
