# Security Policy

## Supported Versions

The latest minor release on the `main` branch is the only supported version. Older releases receive no patches.

## Reporting a Vulnerability

If you find a security issue in this Go module, please email **security@moosewave.com**. Do not open a public GitHub issue.

We will acknowledge receipt within 72 hours, share an initial assessment within 7 days, and aim to ship a fix within 90 days. We will credit you in the release notes unless you ask us not to.

## Scope

This policy covers only the open-source `github.com/postwave/migrate` Go module: the canonical schema, the adapter framework, the six bundled adapters, and the bundled examples.

Service-side issues (Moosewave Cloud, the dashboard, the API gateway, the AI services) are out of scope here. Report those at `https://moosewave.com/legal/security`.

## Out of Scope

- Findings in third-party services (Mailchimp, Substack, Beehiiv, ConvertKit, MailerLite) accessed by an adapter — please report to the respective vendor.
- Misuse of the library by a downstream consumer outside of documented patterns.
- Attacks requiring control of the developer's machine or network.

## Coordinated Disclosure

We follow a 90-day coordinated-disclosure window from initial private report to public advisory. We may extend this in coordination with affected vendors when a vulnerability touches their service.
