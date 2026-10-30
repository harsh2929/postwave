# Cloudflare configuration

Three JSON documents describing the Cloudflare-side of the production stack.
They are layered on top of (not duplicated by) the WAF managed rules
provisioned via Terraform.

| File                      | Phase                             |
|---------------------------|-----------------------------------|
| `waf-rules.json`          | `http_request_firewall_custom`    |
| `transform-rules.json`    | `http_response_headers_transform` |
| `request-transform-rules.json` | `http_request_late_transform` |
| `cache-rules.json`        | `http_request_cache_settings`     |

## Apply via the Cloudflare API

```
ZONE=$CLOUDFLARE_ZONE_ID
TOKEN=$CLOUDFLARE_API_TOKEN

curl -X PUT \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data @waf-rules.json \
  "https://api.cloudflare.com/client/v4/zones/${ZONE}/rulesets/phases/http_request_firewall_custom/entrypoint"
```

Repeat with the matching phase name for each file.

## Apply via Terraform

The Terraform provider supports the `cloudflare_ruleset` resource. The
`cloudflare.tf` file in `infra/terraform/` already provisions the managed
ruleset + rate-limit + DDoS phases; the three JSON files in this directory
are loaded into custom ruleset resources with `jsondecode(file(...))`. See
`infra/terraform/README.md` for the workspace promotion flow.

## Stripe IP allowlist

`waf-rules.json` references a `$stripe_webhook_ips` IP list. Refresh it
weekly with Stripe's published webhook IP ranges:

```
./refresh-stripe-ips.sh --dry-run --output /tmp/stripe-webhook-items.json

CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
CLOUDFLARE_STRIPE_WEBHOOK_IP_LIST_ID=... \
./refresh-stripe-ips.sh
```

The script downloads <https://stripe.com/files/ips/ips_webhooks.txt>,
builds the Rules Lists payload, and replaces the Cloudflare IP list via
`PUT /accounts/:account_id/rules/lists/:list_id/items`. The live API call
returns a Cloudflare bulk-operation id; keep that id with the change ticket.
