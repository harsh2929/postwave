import Link from "next/link";
// SPDX-License-Identifier: AGPL-3.0-only
//
// Canonical domain: moosewave.com. See docs/legal-pages-audit-2026-06-02.md
// (Blocker §1). Cross-referenced from Terms §10.
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Refund policy. Moosewave",
  description:
    "The review draft of Moosewave's refund policy for first subscriptions, renewals, duplicate charges, and payment disputes.",
  alternates: { canonical: "https://moosewave.com/legal/refund" },
};

export default function RefundPolicyPage(): JSX.Element {
  return (
    <article className="max-w-3xl mx-auto px-6 py-16">
      <h1>Refund Policy</h1>
      <p className="text-pw-muted-on-paper text-sm">
        Last updated: 2026-09-22. Review draft — Coming soon and pending
        counsel approval. Paid checkout is not open.
      </p>

      <h2>1. The short version</h2>
      <p>
        The intended launch policy gives a full refund within 14 calendar days
        of a customer&rsquo;s first paid Moosewave subscription. It may be used
        once per customer and workspace. Renewal charges are non-refundable
        except where required by law or where the charge is duplicate,
        unauthorized, or follows a material service failure attributable to
        Moosewave.
      </p>

      <h2>2. First-subscription window</h2>
      <ul>
        <li>
          The request must reach us within 14 calendar days after the first
          successful subscription payment.
        </li>
        <li>
          An approved refund returns the subscription charge to the original
          payment method. Taxes are handled according to the payment provider
          and applicable law.
        </li>
        <li>
          After a refund, the workspace returns to Sandbox at the end of any
          access period we confirm in the refund response. Production sending
          is then disabled.
        </li>
      </ul>

      <h2>3. Cancellation and renewals</h2>
      <p>
        Launch, Growth, and Scale renew monthly. Cancellation takes effect at
        the end of the paid period; access continues until then and no partial
        month is automatically refunded. Annual billing is Coming soon and is
        not part of this launch policy. Moosewave does not sell paid overages or
        rollover allowances.
      </p>

      <h2>4. How to request a refund</h2>
      {/*
   This list used to lead with a dashboard control that does not exist:
   there is no "Request refund" affordance anywhere in the app, and
   Billing is a top-level section (/app/billing), not a child of
   Settings. A refund policy is a binding commitment, so the documented
   primary route must be one a customer can actually complete — email is
   the mechanism that is really wired up. Guarded by
   __tests__/refund-policy-routes.test.ts.
 */}
      <ol>
        <li>
          <strong>Email:</strong>{" "}
          <a href="mailto:refunds@moosewave.com">refunds@moosewave.com</a> with
          your account email and (if relevant) the reason. We respond within two
          business days. This is the route for any direct Moosewave purchase.
        </li>
        <li>
          <strong>Billing history:</strong> open <strong>Billing</strong> in the
          app to find the invoice and charge you want refunded, and quote it in
          your email so we can match it straight away.
        </li>
      </ol>
      <p>
        Once approved, timing depends on Dodo Payments, the card network, and
        your financial institution. We will provide the provider refund
        reference when it is available.
      </p>

      <h2>5. Edge cases</h2>
      <h3>5.1 Chargebacks</h3>
      <p>
        Please email us first if a charge looks wrong so we can investigate it.
        A payment dispute may limit the affected paid entitlement while the
        payment provider reviews the case, but it does not waive rights that
        applicable law gives you.
      </p>

      <h3>5.2 Disputed transactions</h3>
      <p>
        If you don&rsquo;t recognize a charge from Moosewave, email{" "}
        <a href="mailto:billing@moosewave.com">billing@moosewave.com</a> with the
        last four digits of the card and the date of the charge. We will
        identify the account and either issue a refund if the charge was
        unauthorized or send you the receipt and plan details if the account is
        yours.
      </p>

      <h3>5.3 Refund-and-rebuy abuse</h3>
      <p>
        The 14-day first-subscription refund is available once per customer and
        workspace. This does not limit remedies required by applicable law.
      </p>

      <h3>5.4 Account terminations for AUP violations</h3>
      <p>
        Accounts terminated for material violations of our{" "}
        <Link href="/legal/aup">Acceptable Use Policy</Link> (cold outreach,
        purchased lists, malware, phishing, etc.) are not eligible for refund.
        We may decline a discretionary refund where the relevant subscription
        was terminated for material abuse, except where applicable law requires
        otherwise.
      </p>

      <h2>6. Contact</h2>
      <p>
        Refunds: <a href="mailto:refunds@moosewave.com">refunds@moosewave.com</a>
        <br />
        Billing: <a href="mailto:billing@moosewave.com">billing@moosewave.com</a>
        <br />
        Support: <a href="mailto:support@moosewave.com">support@moosewave.com</a>
      </p>
    </article>
  );
}
