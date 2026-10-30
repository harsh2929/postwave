import Link from "next/link";
import type { Metadata } from "next";

// Canonical domain: moosewave.com. See docs/legal-pages-audit-2026-06-02.md
// (Blocker §1). Use moosewave.com for all URLs, canonical, breadcrumbs, and
// support email aliases on every legal page.
export const metadata: Metadata = {
  title: "Account Deletion | Moosewave",
  description:
    "How to delete your Moosewave user account from the web or mobile app, what is removed, and what is retained.",
  alternates: { canonical: "https://moosewave.com/legal/account-deletion" },
};

export default function AccountDeletionPage(): JSX.Element {
  return (
    <article className="max-w-3xl mx-auto px-6 py-16">
      <h1>Account deletion</h1>
      <p className="text-pw-muted-on-paper text-sm">
        Last updated: 2026-07-15. This page explains deletion of an individual
        Moosewave user account and the separate workspace-deletion process.
      </p>

      <h2>Request deletion from the mobile app</h2>
      <p>
        In the Moosewave mobile app, open <strong>Settings</strong>, then use{" "}
        <strong>Delete my account</strong>. Type the exact confirmation phrase,
        reauthenticate with your password or recent identity-provider sign-in,
        and enter an authenticator code when MFA is enabled.
      </p>

      <h2>Request deletion from the web app</h2>
      <p>
        Sign in to Moosewave, then open{" "}
        <Link href="/app/settings/privacy">Settings &rarr; Privacy</Link> and
        choose <strong>Delete my account</strong>. If you cannot sign in, email{" "}
        <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a> from the
        address associated with your Moosewave account.
      </p>

      <h2>What gets deleted</h2>
      <p>
        Personal account deletion removes your Moosewave user profile and login,
        password credential, linked identities, MFA secret, active sessions,
        browser and mobile push registrations, CLI grants, and personal display
        and notification preferences.
      </p>
      <p>
        It does <strong>not</strong> delete workspace-owned campaigns,
        subscribers, automations, shared content, billing resources, or other
        members. Authored shared content remains with direct personal
        attribution removed where feasible. A last or sole workspace owner must
        transfer ownership before deleting their account.
      </p>

      <h2>Deleting a whole workspace</h2>
      <p>
        Workspace deletion has a much larger impact and is a separate owner or
        administrator privacy-review action in Settings. Its confirmation is
        explicitly labelled <strong>Request workspace deletion</strong>; the
        personal account button never starts that workflow.
      </p>

      <h2>Timing and retained records</h2>
      <p>
        The request is normally scheduled after a short security and legal-hold
        review window and no later than the legal deadline shown with the
        request. A legal hold can delay completion. Limited pseudonymized
        security, tax, billing, fraud-prevention, dispute, abuse-prevention, and
        immutable audit records may remain for their required retention period.
        The email-free deletion certificate is retained for up to six years,
        subject to the deployed retention policy.
      </p>
      <p>
        Deleted data can remain in encrypted backups until those backups expire
        under the normal backup lifecycle. It is not restored into normal
        product use. Retained records are restricted to the stated legal and
        security purposes and are not used for product marketing.
      </p>

      <h2>Subscriber data</h2>
      <p>
        If you are a newsletter subscriber of a Moosewave customer, the customer
        is usually the controller of your subscriber data. Contact the sender
        first using the unsubscribe or preference link in their email. Moosewave
        will assist the customer with deletion requests under our{" "}
        <Link href="/legal/dpa">Data Processing Addendum</Link>.
      </p>

      <h2>Questions</h2>
      <p>
        Contact <a href="mailto:privacy@moosewave.com">privacy@moosewave.com</a>{" "}
        for privacy requests, or{" "}
        <a href="mailto:support@moosewave.com">support@moosewave.com</a> for
        account access help.
      </p>
    </article>
  );
}
