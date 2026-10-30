# Cloudflare production deploy runbook (WAF in front of ALB)

Optional front-door cutover after the canonical AWS origin is certified.
Cloudflare proxies `moosewave.com`, `www.moosewave.com`, and `api.moosewave.com`
onto the AWS ALB in `us-west-2`. It does not own the application data plane.
[`infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md`](../aws/PRODUCTION_DEPLOY_RUNBOOK.md).
Companion: [`README.md`](./README.md), [`refresh-stripe-ips.sh`](./refresh-stripe-ips.sh).

**Scope:** zone setup, origin SSL, WAF/rate-limit/cache, Bot Fight + Turnstile,
Logpush. **Out of scope:** ALB/ECS/RDS, Sentry/OTel wiring.

---

## 0. Prerequisites

- [ ] Cloudflare account + zone `moosewave.com`. Plan = **Pro** min (rate-limit,
      Bot Fight); **Business** for Turnstile Enterprise + managed rulesets.
- [ ] API token with `Zone:Edit`, `Zone WAF:Edit`, `Zone Cache Rules:Edit`,
      `Account Rule Lists:Edit`, `Logs:Edit`.
- [ ] AWS-side ALB serving 200 on `https://<alb-dns>/api/health` with ACM cert
      covering `*.moosewave.com`.
- [ ] S3 bucket `postwave-cf-logs-prod` in `us-west-2` for Logpush.

Shell vars:

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_ZONE_ID=...
export CLOUDFLARE_API_TOKEN=...
export ALB_DNS=postwave-prod-alb-xxxxxxxx.us-west-2.elb.amazonaws.com
export DOMAIN=moosewave.com
export CF=https://api.cloudflare.com/client/v4
export H="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
```

---

## 1. DNS records (apex + www + api)

Proxied (orange-cloud) CNAMEs. CNAME flattening on apex is on by default
(Pro+); lets us point apex at the ALB hostname.

```bash
for rec in '{"type":"CNAME","name":"'${DOMAIN}'","content":"'${ALB_DNS}'","proxied":true,"ttl":1}' \
           '{"type":"CNAME","name":"www","content":"'${DOMAIN}'","proxied":true,"ttl":1}' \
           '{"type":"CNAME","name":"api","content":"'${ALB_DNS}'","proxied":true,"ttl":1}'; do
  curl -fsSL -X POST "${CF}/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
    -H "$H" -H 'Content-Type: application/json' --data "$rec"
done
```

Verify orange-cloud:

```bash
dig +short ${DOMAIN}                # Cloudflare anycast (104.x / 172.67.x)
dig +short api.${DOMAIN}            # Cloudflare anycast
curl -sSv https://api.${DOMAIN}/api/health   # 200 via Cloudflare cert
```

If `dig` returns the ALB DNS, flip `proxied=true`.

---

## 2. Origin certificate + SSL/TLS mode (Full strict)

Moosewave runs **Full (strict)** — Cloudflare validates the ACM chain.
Never run `flexible` (CF-to-origin plaintext).

```bash
curl -fsSL -X PATCH "${CF}/zones/${CLOUDFLARE_ZONE_ID}/settings/ssl" \
  -H "$H" -H 'Content-Type: application/json' --data '{"value":"strict"}'

curl -fsSL -X PATCH "${CF}/zones/${CLOUDFLARE_ZONE_ID}/settings/always_use_https" \
  -H "$H" -H 'Content-Type: application/json' --data '{"value":"on"}'

curl -fsSL -X PATCH "${CF}/zones/${CLOUDFLARE_ZONE_ID}/settings/min_tls_version" \
  -H "$H" -H 'Content-Type: application/json' --data '{"value":"1.2"}'

curl -fsSL -X PATCH "${CF}/zones/${CLOUDFLARE_ZONE_ID}/settings/security_header" \
  -H "$H" -H 'Content-Type: application/json' \
  --data '{"value":{"strict_transport_security":{"enabled":true,"max_age":31536000,"include_subdomains":true,"preload":true,"nosniff":true}}}'
```

ALB serves the AWS ACM cert (`*.moosewave.com` + apex SAN) — satisfies
Full strict. If you ever switch the ALB to self-signed, generate a
Cloudflare Origin CA cert (15-year, free) and install on the ALB instead.

---

## 3. WAF rules (custom ruleset)

`waf-rules.json` covers form-bot mitigation, JA3 blocklist, geo blocklist,
login rate-limit, and the legacy Stripe compatibility-route IP allowlist. Dodo
Payments authenticates `/api/public/dodo/webhook` with Standard Webhooks
signatures and replay-window enforcement; do not invent an IP allowlist unless
Dodo publishes an authoritative range. Apply:

```bash
curl -fsSL -X PUT \
  "${CF}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_request_firewall_custom/entrypoint" \
  -H "$H" -H 'Content-Type: application/json' --data @infra/cloudflare/waf-rules.json
```

Add the signup rate-limit (login is already in `waf-rules.json`):

```bash
RATE_ID=$(curl -fsSL "${CF}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_ratelimit/entrypoint" \
  -H "$H" | jq -r .result.id)

curl -fsSL -X POST "${CF}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/${RATE_ID}/rules" \
  -H "$H" -H 'Content-Type: application/json' --data '{
    "description": "signup_brute_force: 3 POSTs/min/IP -> 15min challenge",
    "expression": "(http.request.uri.path eq \"/api/v1/auth/signup\") and (http.request.method eq \"POST\")",
    "action": "managed_challenge",
    "ratelimit": {"characteristics":["ip.src"],"period":60,"requests_per_period":3,"mitigation_timeout":900}
  }'
```

Enable the managed OWASP CRS:

```bash
MGD_ID=$(curl -fsSL "${CF}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_request_firewall_managed/entrypoint" \
  -H "$H" | jq -r .result.id)

# Cloudflare Managed Ruleset (4814...) + OWASP CRS (efb7...)
for id in 4814384a9e5d4991b9815dcfc25d2f1f efb7b8c949ac4650a09736fc376e9aee; do
  curl -fsSL -X POST "${CF}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/${MGD_ID}/rules" \
    -H "$H" -H 'Content-Type: application/json' \
    --data "{\"action\":\"execute\",\"expression\":\"true\",\"action_parameters\":{\"id\":\"${id}\"}}"
done
```

### Legacy Stripe webhook IP allowlist

`waf-rules.json` references `$stripe_webhook_ips`, an account-scoped IP list:

```bash
# Create empty list (one-time)
LIST_ID=$(curl -fsSL -X POST "${CF}/accounts/${CLOUDFLARE_ACCOUNT_ID}/rules/lists" \
  -H "$H" -H 'Content-Type: application/json' \
  --data '{"name":"stripe_webhook_ips","kind":"ip","description":"Stripe webhook IPs"}' \
  | jq -r .result.id)
export CLOUDFLARE_STRIPE_WEBHOOK_IP_LIST_ID="$LIST_ID"

# Weekly refresh
./infra/cloudflare/refresh-stripe-ips.sh
```

Cron on the ops host:

```cron
# /etc/cron.d/cloudflare-stripe-ips — Mondays 03:00 UTC
0 3 * * 1 ops /opt/postwave/infra/cloudflare/refresh-stripe-ips.sh >> /var/log/cf-stripe-ips.log 2>&1
```

---

## 4. Cache rules (bypass /api/* and /app/*)

`cache-rules.json` bypasses `/api/v1/*` plus Dodo Payments and compatibility
Stripe billing webhooks. Apply, then
extend to broader `/api/*` and `/app/*`:

```bash
curl -fsSL -X PUT \
  "${CF}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint" \
  -H "$H" -H 'Content-Type: application/json' --data @infra/cloudflare/cache-rules.json

CACHE_ID=$(curl -fsSL "${CF}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint" \
  -H "$H" | jq -r .result.id)

curl -fsSL -X POST "${CF}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/${CACHE_ID}/rules" \
  -H "$H" -H 'Content-Type: application/json' --data '{
    "description": "bypass_all_api_and_app",
    "expression": "(starts_with(http.request.uri.path, \"/api/\")) or (starts_with(http.request.uri.path, \"/app/\"))",
    "action": "set_cache_settings",
    "action_parameters": {"cache": false}
  }'
```

Verify:

```bash
curl -sSI https://api.${DOMAIN}/api/health | grep -i cf-cache-status   # BYPASS
```

### Worker: strip cookies on cacheable form GETs (optional)

Hosted-form HTML at `/api/public/forms/:id` is cached 60s, but Cloudflare
refuses to cache responses with `Set-Cookie`. Deploy a Worker on the
route `api.moosewave.com/api/public/forms/*` that strips `set-cookie`
before the response goes through the cache.

---

## 5. Bot Fight Mode + Turnstile

```bash
curl -fsSL -X PATCH "${CF}/zones/${CLOUDFLARE_ZONE_ID}/bot_management" \
  -H "$H" -H 'Content-Type: application/json' --data '{
    "fight_mode": true,
    "sbfm_definitely_automated": "managed_challenge",
    "sbfm_likely_automated": "managed_challenge",
    "sbfm_verified_bots": "allow",
    "sbfm_static_resource_protection": false,
    "suppress_session_score": false
  }'
```

**Turnstile** for the hosted-form widget + `/auth/signup`:

1. Dashboard -> Turnstile -> Add site -> domain `${DOMAIN}` + `app.${DOMAIN}`.
   Widget type: **Managed**.
2. Capture public site key + secret.
3. Inject the secret into AWS Secrets Manager:

   ```bash
   aws secretsmanager create-secret --name postwave/prod/turnstile-secret \
     --secret-string "$TURNSTILE_SECRET_KEY" --kms-key-id "${SECRETS_KMS_KEY_ARN}"
   ```

4. Add `POSTWAVE_TURNSTILE_SECRET` (from Secrets Manager) and
   `POSTWAVE_TURNSTILE_SITE_KEY` (env, public) to
   `infra/aws/ecs-task-definition.json` and roll the service.

The form renderer adds the `<div class="cf-turnstile" data-sitekey="...">`
element; the API verifies `cf-turnstile-response` against
`https://challenges.cloudflare.com/turnstile/v0/siteverify`.

---

## 6. Origin lock-down (so attackers cannot bypass Cloudflare)

If the ALB is reachable on the open internet, anyone who learns the ALB
DNS skips every rule above. Two layers:

**1. ALB security group — only allow 443 from Cloudflare ranges:**

```bash
for cidr in $(curl -fsSL https://www.cloudflare.com/ips-v4); do
  aws ec2 authorize-security-group-ingress --group-id ${ALB_SG_ID} \
    --protocol tcp --port 443 --cidr "$cidr"
done
# Repeat for ips-v6 with --ip-permissions ... Ipv6Ranges=...
```

Refresh monthly via a `refresh-cloudflare-ips.sh` (same pattern as
`refresh-stripe-ips.sh`).

**2. Authenticated Origin Pulls — Cloudflare presents a client cert
the ALB validates:**

```bash
curl -fsSL -X PATCH "${CF}/zones/${CLOUDFLARE_ZONE_ID}/settings/tls_client_auth" \
  -H "$H" --data '{"value":"on"}'
```

Configure ALB mTLS with the CA bundle from
<https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem>.

---

## 7. Transform rules (response headers)

`transform-rules.json` adds CSP, X-Frame-Options, Referrer-Policy:

```bash
curl -fsSL -X PUT \
  "${CF}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_response_headers_transform/entrypoint" \
  -H "$H" -H 'Content-Type: application/json' --data @infra/cloudflare/transform-rules.json

curl -sSI https://${DOMAIN} | grep -iE 'strict-transport|content-security|x-frame'
```

---

## 7b. Request transform rules (edge-measured client facts)

`request-transform-rules.json` publishes the connecting client's ASN to the
origin as `X-Postwave-Client-ASN` (PRD Foundations 2.1).

A DIFFERENT PHASE from §7, and the difference is load-bearing. This is a
REQUEST-header rewrite; sending it to `http_response_headers_transform` is
accepted and then never reaches the origin, so `network_asn` would stay NULL
while the deploy looked successful.

```bash
curl -fsSL -X PUT \
  "${CF}/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_request_late_transform/entrypoint" \
  -H "$H" -H 'Content-Type: application/json' --data @infra/cloudflare/request-transform-rules.json
```

THE ORIGIN MUST ALSO BE CONFIGURED, or this rule does nothing. The header is
honoured only when the TCP peer is inside `POSTWAVE_TRUSTED_PROXY_CIDRS` and
`POSTWAVE_TRUST_FORWARDED_IP_HEADERS=1` — an ASN believed from an untrusted peer
is attacker-chosen, and the machine-source registry matches on it, so a sender
could select its own human/machine classification.

Verify end to end rather than trusting the PUT: after a real beacon request,

```sql
SELECT network_asn_source, count(*)
  FROM subscriber_event_observations
 WHERE subscriber_event_at > now() - interval '1 hour'
 GROUP BY 1;
```

`edge_measured` means the whole path works. `edge_unconfigured` means the origin
half is missing. The two are distinguished precisely so "the signal is switched
off" cannot be misread as "no machine traffic this week".

---

## 8. Logpush to S3 (compliance)

HTTP request logs -> S3 -> Athena. Required for SOC 2 + forensics.

```bash
# 1. Create bucket (one-time)
aws s3api create-bucket --bucket postwave-cf-logs-prod \
  --create-bucket-configuration LocationConstraint=us-west-2
aws s3api put-public-access-block --bucket postwave-cf-logs-prod \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket postwave-cf-logs-prod \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# 2. Lifecycle: Glacier 90d, delete 7y
aws s3api put-bucket-lifecycle-configuration --bucket postwave-cf-logs-prod \
  --lifecycle-configuration '{"Rules":[{"Id":"archive","Status":"Enabled","Filter":{"Prefix":""},"Transitions":[{"Days":90,"StorageClass":"GLACIER"}],"Expiration":{"Days":2555}}]}'

# 3. Bucket policy for Cloudflare's logpush principal
aws s3api put-bucket-policy --bucket postwave-cf-logs-prod --policy '{
  "Version":"2012-10-17","Statement":[{
    "Sid":"CloudflareLogpush","Effect":"Allow",
    "Principal":{"AWS":"arn:aws:iam::000000000000:root"},
    "Action":["s3:PutObject","s3:GetBucketLocation"],
    "Resource":["arn:aws:s3:::postwave-cf-logs-prod","arn:aws:s3:::postwave-cf-logs-prod/*"]
  }]}'

# 4. Create the Logpush job
curl -fsSL -X POST "${CF}/zones/${CLOUDFLARE_ZONE_ID}/logpush/jobs" \
  -H "$H" -H 'Content-Type: application/json' --data '{
    "name": "postwave-http-requests",
    "destination_conf": "s3://postwave-cf-logs-prod/http_requests?region=us-west-2",
    "dataset": "http_requests",
    "enabled": true,
    "output_options": {
      "field_names": ["RayID","EdgeStartTimestamp","ClientIP","ClientCountry","ClientRequestHost","ClientRequestMethod","ClientRequestURI","EdgeResponseStatus","WAFAction","WAFRuleID","BotScore","ClientRequestUserAgent"],
      "timestamp_format": "rfc3339"
    }
  }'
```

Subscribe a second job for the `firewall_events` dataset — that is what
you grep when triaging a WAF block report.

---

## 9. Smoke tests + rollback

```bash
# Through Cloudflare
curl -sSv https://api.${DOMAIN}/api/health | grep -i HTTP/2

# Login rate-limit fires
for i in $(seq 1 10); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.${DOMAIN}/api/v1/auth/login \
    -H 'Content-Type: application/json' --data '{}'
done
# Expect: ~5x 401 then 429/403

# Dodo rejects an unsigned webhook at the application boundary
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.${DOMAIN}/api/public/dodo/webhook
# Expect: 400 (invalid signature)

# Legacy Stripe compatibility webhook remains IP-restricted while it is mounted
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.${DOMAIN}/api/public/stripe/webhook
# Expect: 403

# Cache bypass on /api/v1/*
curl -sSI https://api.${DOMAIN}/api/v1/me | grep -i cf-cache-status   # BYPASS or DYNAMIC

# Logpush wrote to S3 within ~5 min
aws s3 ls s3://postwave-cf-logs-prod/http_requests/ --recursive | head
```

| What | Symptom | Rollback |
|---|---|---|
| DNS | `dig` shows ALB IP | re-PATCH record with `"proxied":true` |
| SSL/TLS | `ERR_SSL_PROTOCOL_ERROR` | flip to `full` (not strict) temporarily; fix ACM chain; flip back |
| WAF rule | legit traffic blocked | `PATCH .../rules/{id} {"enabled":false}`; fix expression; re-enable |
| Rate-limit | real users 429ing | bump `requests_per_period` or `period`; never set `action:"log"` (silently disables) |
| Cache | stale form HTML | `POST /zones/${ZONE}/purge_cache {"purge_everything":true}` then narrow |
| Dodo webhook | signed events return 400 | verify the raw body is unchanged and `DODO_PAYMENTS_WEBHOOK_SECRET` matches the endpoint |
| Legacy Stripe allowlist | compatibility webhooks 403'ing | re-run `refresh-stripe-ips.sh`; if blocking, disable rule |
| Origin lock-down | direct ALB 403s after AOP on | toggle `tls_client_auth` off; remove ALB mTLS; investigate cert presentation |
| Logpush | no S3 objects after 30 min | `GET /logpush/jobs/{id}` for state; common cause = bucket policy missing CF principal |

Full-zone bypass (emergency — disables ALL Cloudflare protection):

```bash
for rec in $(curl -fsSL "${CF}/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=CNAME" \
  -H "$H" | jq -r '.result[].id'); do
  curl -fsSL -X PATCH "${CF}/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${rec}" \
    -H "$H" --data '{"proxied":false}'
done
```

---

## 10. Steady-state ops

- **Weekly:** `refresh-stripe-ips.sh` cron (step 3).
- **Monthly:** refresh Cloudflare-origin SG allowlist.
- **On incident:** Athena query against `s3://postwave-cf-logs-prod/`
  filtered by `RayID` from the user report (`cf-ray` response header).
- **Cert renewal:** ACM auto-renews; Cloudflare Origin CA does not — set
  a calendar reminder if you adopted it.

## Reference

- `README.md` — payload catalog + Terraform path.
- `waf-rules.json`, `cache-rules.json`, `transform-rules.json` — ruleset payloads.
- `refresh-stripe-ips.sh` — weekly Stripe IP sync.
- `../aws/PRODUCTION_DEPLOY_RUNBOOK.md` — origin-side ECS/ALB deploy.
- `../aws/OBSERVABILITY_RUNBOOK.md` — Sentry/PostHog/OTel/CloudWatch.
