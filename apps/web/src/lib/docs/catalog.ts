// SPDX-License-Identifier: AGPL-3.0-only

export const DOCS_MIGRATION_SOURCES = [
  { slug: "mailchimp", name: "Mailchimp" },
  { slug: "activecampaign", name: "ActiveCampaign" },
  { slug: "convertkit", name: "ConvertKit" },
  { slug: "brevo", name: "Brevo" },
  { slug: "hubspot", name: "HubSpot" },
  { slug: "customerio", name: "Customer.io" },
  { slug: "beehiiv", name: "Beehiiv" },
  { slug: "substack", name: "Substack" },
  { slug: "mailerlite", name: "MailerLite" },
  { slug: "sendy", name: "Sendy" },
  { slug: "csv", name: "CSV import" },
] as const;

export const DOCS_INTEGRATIONS = [
  { slug: "customerio", name: "Customer.io" },
  { slug: "slack", name: "Slack" },
  { slug: "stripe", name: "Stripe" },
  { slug: "postmark", name: "Postmark" },
  { slug: "mailgun", name: "Mailgun" },
  { slug: "ses", name: "Amazon SES" },
  { slug: "custom-domains", name: "Custom domains" },
  { slug: "inbound-webhooks", name: "Inbound webhooks" },
] as const;
