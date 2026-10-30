# alb-listener-rules.md

ALB listener rules for the `postwave-prod-alb` Application Load Balancer.
This file documents the intended state; the actual rules live in CloudFormation
(`cloudformation/postwave-stack.yaml`) once deployed. Keep both in sync.

## Topology

The ALB sits in the public subnets, fronts two target groups in private
subnets, and terminates TLS using an ACM certificate covering
`*.moosewave.com`. Hostnames resolve via Route 53 ALIAS records to the ALB DNS
name. There is exactly one ALB; routing is by Host header, not by listener.

```
                 internet
                    |
                    v
           postwave-prod-alb (public)
              |              |
   :443 (HTTPS)             :80 (HTTP)
       |                        |
       |                        +-- redirect to HTTPS (301)
       |
       +-- Host: api.moosewave.com  -> tg-postwave-api  (Fargate, port 8080)
       +-- Host: app.moosewave.com  -> tg-postwave-web  (Fargate, port 3000)
       +-- (default)               -> tg-postwave-api  (catch-all -> API)
```

## Listener rules

### HTTP :80 -- redirect to HTTPS

Single default rule, no conditions. Redirect action:

- `Protocol: HTTPS`
- `Port: 443`
- `StatusCode: HTTP_301`
- `Host: #{host}` (preserve)
- `Path: /#{path}` (preserve)
- `Query: #{query}` (preserve)

Never serve real traffic over plain HTTP. Cookies are `Secure` in production,
so an unredirected HTTP visit would arrive cookieless and immediately fail
auth, but defending the auth flow on TLS termination alone is fragile -- the
redirect is the belt to the cookie's suspenders.

### HTTPS :443 -- routing rules

Rules are evaluated in priority order, lowest number wins. Defaults:

- TLS policy: `ELBSecurityPolicy-TLS13-1-2-2021-06` (TLS 1.2+, prefers 1.3).
- Certificate: ACM cert for `*.moosewave.com` + `moosewave.com` (SAN).

| Priority | Conditions                              | Action                             |
|---------:|-----------------------------------------|------------------------------------|
| 100      | Host header `api.moosewave.com`          | Forward -> `tg-postwave-api`       |
| 200      | Host header `app.moosewave.com`          | Forward -> `tg-postwave-web`       |
| 300      | Host header `forms.moosewave.com`        | Forward -> `tg-postwave-api`       |
| (def.)   | (no match)                              | Fixed-response 404 + JSON body     |

The default fixed-response keeps unrecognised Host headers (scanner traffic,
misconfigured DNS) from quietly hitting the API. Body:

```json
{"error":"unknown_host","host":"%{http_host}"}
```

## Target groups

### tg-postwave-api

- Protocol: `HTTP`
- Port: `8080`
- Target type: `ip` (Fargate awsvpc requires this)
- Health check path: `/api/ready`
- Health check protocol: `HTTP`
- Healthy threshold: `2`
- Unhealthy threshold: `3`
- Interval: `30s`
- Timeout: `5s`
- Matcher: HTTP `200`
- Deregistration delay: `30s` (matches `stopTimeout` in the task definition)

### tg-postwave-web

- Protocol: `HTTP`
- Port: `3000`
- Target type: `ip`
- Health check path: `/healthz` (local Next.js liveness; post-cutover checks
  separately prove the same-origin API readiness proxy)
- Same thresholds and intervals as `tg-postwave-api`.

## Stickiness

**Not enabled.** Sessions are DB-backed (`auth_sessions` table, opaque cookie
maps to a row), so any task can serve any request. Enabling stickiness would
mask a real bug (a task with stale in-memory state) and wedge the load
balancer to a hot Fargate task.

## Cross-zone load balancing

Enabled. ALB cost model includes cross-zone in the LCU price; turning it off
gains nothing and risks one-AZ overload during a redeploy.

## Access logs

Logs to `s3://postwave-alb-logs-prod/` with a 90-day lifecycle policy. The
bucket lives in the same region as the ALB (us-west-2). Log analysis lives
out-of-band; this is the audit trail, not the primary observability surface.

## WAF

`AWS::WAFv2::WebACL` `postwave-prod-waf` is associated with the listener (not
listed in the table above; it sits in front of all rules). Managed rule
groups:

- `AWSManagedRulesCommonRuleSet`
- `AWSManagedRulesKnownBadInputsRuleSet`
- `AWSManagedRulesAmazonIpReputationList`

Plus a custom rate-based rule capping unauthenticated `/api/auth/login` and
`/api/auth/signup` POSTs at 30 per 5 minutes per source IP. Auth-side
in-process rate limiting is not a substitute -- the goal is to keep brute
force from reaching the API at all.

## Operational notes

- A failed API deploy that breaks `/api/ready`, or a web deploy that breaks
  `/healthz`, will not cut traffic over. Target-group health gates
  registration. ECS deployment circuit
  breaker (configured in the service definition) rolls the deploy back if
  the new task set never reaches steady state. See `auth-aws.md` for the
  rollback procedure.
- Never put an `application/x-www-form-urlencoded` POST limit on the WAF
  default rules below 1 MB; magic-link verification + multipart upload paths
  push close to that.
- The ALB is the only ingress. There is no public-facing IP on Fargate
  tasks; tasks live in private subnets and reach the internet (SES, S3,
  Stripe webhooks outbound) via NAT. See `auth-aws.md` for the VPC
  prerequisites.
