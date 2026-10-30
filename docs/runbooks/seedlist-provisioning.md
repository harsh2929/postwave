# Runbook - Seedlist Mailbox Provisioning

Scope: creating or replacing a monitored seedlist mailbox used by Inbox
Reality. This is an operational checklist, not automation. Seed mailboxes
should look like normal, long-lived inboxes; automated mass account creation is
more likely to get the whole seedlist flagged.

## When To Use

- A seed mailbox is banned, locked, or repeatedly missing health probes.
- A provider needs more geographic or ASN diversity.
- A customer segment needs an inbox provider that the current seedlist does not
  cover.

## Preconditions

- Provider and mailbox target approved by the deliverability owner.
- Budget owner approves paid mailbox cost where applicable.
- Password manager or secrets manager path is ready for the new credential.
- A human operator can complete provider signup and any recovery challenge.

## Provisioning Steps

1. Create the mailbox manually from a residential or provider-ordinary network.
   Avoid data-center IPs, VPNs, and scripted signup.
2. Use a provider-normal profile:
   - Realistic display name.
   - Recovery email or phone controlled by Moosewave operations.
   - Locale, timezone, and language matching the intended seed geography.
3. Enable MFA where the provider supports it and store recovery codes in the
   approved password manager.
4. Record the mailbox in the seedlist registry with `status=warming`, provider,
   region, ASN/network notes, and owner.
5. Store IMAP/OAuth credentials in secrets management. Never commit raw
   passwords, app passwords, cookies, or OAuth refresh tokens.
6. Send a low-volume warming schedule for seven days:
   - Day 1-2: one internal health email/day.
   - Day 3-4: two health emails/day from different Moosewave domains.
   - Day 5-7: normal seed cadence, but exclude it from customer-facing
     placement percentages.
7. After seven clean days, move the record to `status=active` and include it in
   aggregation.

## Validation

Run these checks before activation:

- IMAP login succeeds from the deliverability service network.
- The synthetic health email arrives within the provider SLA window.
- Folder classification is parsed correctly: inbox, spam, promotions, or
  missing.
- The account is not prompting for web login, CAPTCHA, recovery challenge, or
  suspicious-activity review.
- The seedlist dashboard shows at least three consecutive successful probes.

## Replacement Rules

- Do not delete the banned mailbox record. Mark it `banned` or `retired` so
  historical reports remain explainable.
- Keep the old mailbox excluded from aggregation immediately after ban
  confirmation.
- Replace within seven days for a single SEV3 account ban.
- Replace within 24 hours for SEV2+ or when provider coverage drops below the
  minimum active inbox threshold.

## Rotation And Review

- Review provider mix monthly.
- Rotate app passwords or OAuth grants after any suspected compromise.
- Rebalance if more than two mailboxes for one provider share the same ASN,
  region, or recovery path.
- Open an ADR if the same provider bans three accounts in 30 days.
