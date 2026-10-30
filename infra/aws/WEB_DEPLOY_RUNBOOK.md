# Moosewave web production deployment runbook

This is the canonical procedure for the Next.js workload at
`https://app.moosewave.com` on AWS ECS Fargate in `us-west-2`. The reviewed IaC
is [`cloudformation/postwave-web.yaml`](./cloudformation/postwave-web.yaml).
It consumes the VPC, private subnets, ECS cluster, ALB security group, ALB,
certificate, and HTTPS listener created by
[`cloudformation/postwave-stack.yaml`](./cloudformation/postwave-stack.yaml).

Repository configuration is not evidence of a live deployment. Do not mark the
web workload production-ready until the account-specific evidence checklist at
the end of this runbook is complete on the exact promoted digest.

## Safety contract

- Region and domain are fixed to `us-west-2` and `moosewave.com`.
- ECS references `postwave-web@sha256:...`; CloudFormation rejects tags.
- The service starts at desired count zero. Enabling it requires the explicit
  `WebArtifactVerified=true` assertion after cryptographic verification.
- Public indexing fails closed independently of service deployment. An empty
  `PublicReleaseApproval` disallows crawlers, omits the sitemap, adds an
  `X-Robots-Tag`, and leaves draft legal/comparison routes unavailable.
- GitHub Actions builds one `linux/amd64,linux/arm64` manifest, emits SLSA
  provenance and an SPDX SBOM, signs it in GHCR, verifies it, mirrors the same
  digest into ECR, then signs and verifies the ECR reference. The publish gate
  starts and inspects both architecture-specific runtime images.
- The web target group and container probe `/healthz`, which proves only the
  Next.js process. It never calls the API. API readiness is a separate rollout
  precondition, so an API incident cannot churn otherwise healthy web tasks.
- Tasks run as UID/GID `10001`, use `ReadonlyRootFilesystem=true`, drop every
  Linux capability, and receive writable mounts only at `/tmp` and
  `/app/apps/web/.next/cache`.
- Build and runtime stages use an exact digest-pinned Node.js 24 LTS image;
  the artifact gate rejects an EOL runtime line.
- ECS deployment circuit-breaker rollback is enabled, and target-tracking
  policies keep two to six tasks based on CPU and memory.
- `/ecs/postwave-web` is retained across stack deletion/replacement for 90
  days. Never delete it during application rollback.

## 1. Prerequisites

Do not start unless all items pass:

- [ ] The main stack `postwave-prod` is deployed from the reviewed template in
      `us-west-2`; its API service is stable with two healthy targets.
- [ ] `https://api.moosewave.com/api/ready` returns exactly `status: ready`; from
      an approved operator IP, the TOTP-authenticated
      `/api/internal/ops/readiness` report has top-level `status: ok` and no
      failed required check.
- [ ] The ALB HTTPS listener uses the reviewed ACM certificate covering
      `app.moosewave.com`; WAF and retained access logs are enabled.
- [ ] Private subnets span at least two availability zones and have controlled
      outbound HTTPS access for server-side calls to `api.moosewave.com`.
- [ ] GitHub environment variables `AWS_REGION=us-west-2` and
      `AWS_ECR_PUSH_ROLE_ARN` are configured for the ECR bridge.
- [ ] Repository variable `POSTWAVE_WEB_CONSENT_SITE_KEY` contains a live,
      unrevoked public `pwk_` key bound to the reviewed Moosewave marketing
      tenant. Record the tenant/key-prefix review in the release evidence; the
      key is public write-routing material, not a dashboard/read credential.
- [ ] The exact Apple Team ID, iOS bundle ID, Android package name, and SHA-256
      certificate fingerprints for the release signing identities are known.
- [ ] `cosign`, `docker buildx`, `jq`, `aws` v2, `gh`, `curl`, and `dig` are
      installed in the controlled operator environment.
- [ ] A dedicated Bash session is open. Execute every shell block below in
      that same Bash session; do not paste the indexed-array procedure into
      zsh or another shell with different array semantics.
- [ ] The Route 53 hosted zone is known, or the approved external-DNS operator
      is available for the final cutover. DNS is not changed during bootstrap.

Use a private operator directory and full commit SHA:

```bash
if [ -z "${BASH_VERSION:-}" ]; then
  echo 'Run this procedure in a dedicated Bash session.' >&2
  exit 2
fi
set -euo pipefail
umask 077
install -d -m 0700 /tmp/postwave-web-deploy

export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
export DOMAIN=moosewave.com
export MAIN_STACK=postwave-prod
export WEB_STACK=postwave-web-prod
export GIT_SHA="$(git rev-parse HEAD)"
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export OWNER_LC="$(gh repo view --json owner --jq '.owner.login' | tr '[:upper:]' '[:lower:]')"
export REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
export SOURCE_URL="https://github.com/${REPOSITORY}"
export CONSENT_SITE_KEY="$(gh variable get POSTWAVE_WEB_CONSENT_SITE_KEY --repo "$REPOSITORY")"

test "$AWS_REGION" = us-west-2
test "$DOMAIN" = moosewave.com
printf '%s' "$GIT_SHA" | grep -Eq '^[0-9a-f]{40}$'
printf '%s' "$CONSENT_SITE_KEY" | grep -Eq '^pwk_[0-9a-f]{48}$'
```

Capture parent resources without retyping IDs:

```bash
export VPC_ID="$(aws cloudformation describe-stacks \
  --stack-name "$MAIN_STACK" \
  --query 'Stacks[0].Parameters[?ParameterKey==`VpcId`].ParameterValue' --output text)"

export ECS_CLUSTER_NAME="$(aws cloudformation describe-stacks \
  --stack-name "$MAIN_STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`EcsClusterName`].OutputValue' --output text)"
export ALB_SG="$(aws cloudformation describe-stack-resource \
  --stack-name "$MAIN_STACK" --logical-resource-id AlbSecurityGroup \
  --query 'StackResourceDetail.PhysicalResourceId' --output text)"
export ALB_DNS="$(aws cloudformation describe-stacks \
  --stack-name "$MAIN_STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`AlbDnsName`].OutputValue' --output text)"
export ALB_ZONE_ID="$(aws cloudformation describe-stacks \
  --stack-name "$MAIN_STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`AlbHostedZoneId`].OutputValue' --output text)"
export HTTPS_LISTENER_ARN="$(aws cloudformation describe-stack-resource \
  --stack-name "$MAIN_STACK" --logical-resource-id HttpsListener \
  --query 'StackResourceDetail.PhysicalResourceId' --output text)"

test "$ECS_CLUSTER_NAME" = postwave-prod
printf '%s' "$VPC_ID" | grep -Eq '^vpc-[0-9a-f]+$'
printf '%s' "$ALB_SG" | grep -Eq '^sg-[0-9a-f]+$'
printf '%s' "$HTTPS_LISTENER_ARN" | grep -Eq '^arn:.*:elasticloadbalancing:us-west-2:'
```

Set the private subnets and mobile association values from reviewed evidence:

```bash
export PRIVATE_SUBNETS=subnet-aaaa,subnet-bbbb
export APPLE_TEAM_ID=ABCDE12345
export IOS_BUNDLE_ID=com.moosewave.app
export ANDROID_PACKAGE_NAME=com.moosewave.app
export ANDROID_SHA256_CERT_FINGERPRINTS='AA:BB:...:FF'
export SENTRY_DSN_WEB='' # optional; empty intentionally disables server Sentry
export PUBLIC_RELEASE_APPROVAL='' # keep empty until a release record approves publication

aws ec2 describe-subnets \
  --cli-input-json "$(jq -cn --arg subnets "$PRIVATE_SUBNETS" \
    '{SubnetIds: ($subnets | split(",") | map(select(length > 0)))}')" \
  --query 'Subnets[].{id:SubnetId,az:AvailabilityZone,public:MapPublicIpOnLaunch}' \
  --output json > /tmp/postwave-web-deploy/subnets.json
jq -e '
  length >= 2 and
  ([.[].az] | unique | length) >= 2 and
  all(.[]; .public == false)
' /tmp/postwave-web-deploy/subnets.json
```

## 2. Build and signed publication

The only production publisher is `.github/workflows/docker-push.yml` on the
reviewed `main` commit. Its web matrix entry supplies and validates these
browser-bundle values before `next build`:

| Build input                                         | Canonical value                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| `POSTWAVE_RELEASE` / `NEXT_PUBLIC_POSTWAVE_RELEASE` | full 40-character `GIT_SHA`                                                 |
| `NEXT_PUBLIC_SITE_URL`                              | `https://moosewave.com`                                                      |
| `NEXT_PUBLIC_APP_URL`                               | `https://app.moosewave.com`                                                  |
| `NEXT_PUBLIC_DOCS_URL`                              | `https://docs.moosewave.com`                                                 |
| `NEXT_PUBLIC_FORMS_ORIGIN`                          | `https://forms.moosewave.com`                                                |
| `NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL`              | reviewed `POSTWAVE_WEB_ASSETS_BASE_URL`; must match the API asset CDN base  |
| `NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN`                 | reviewed `POSTWAVE_WEB_UPLOAD_ORIGIN`; exact presigned-upload bucket origin |
| `NEXT_PUBLIC_WEB_VITALS_ENDPOINT`                   | `https://api.moosewave.com/api/internal/web-vitals`                          |
| `NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY`             | reviewed live `POSTWAVE_WEB_CONSENT_SITE_KEY` bound to the marketing tenant |
| `NEXT_PUBLIC_POSTWAVE_API_BASE_URL`                 | `https://api.moosewave.com`                                                  |
| `NEXT_PUBLIC_API_URL`                               | unset; browser API traffic remains same-origin                              |
| mock/demo/tenant/auth bypass values                 | unset or `0`                                                                |
| PostHog, browser Sentry, VAPID values               | optional reviewed GitHub public variables; empty disables each integration  |

The endpoint above is cross-origin from both canonical web hosts. The API task
must therefore retain
`POSTWAVE_WEB_VITALS_ALLOWED_ORIGINS=https://app.moosewave.com,https://moosewave.com`,
exactly matching `CORS_ALLOWED_ORIGINS` because API-wide middleware answers the
preflight before the endpoint runs. The deployment contract rejects a missing
value, a mismatch, an omitted canonical origin, or a wildcard; otherwise
browsers silently discard the anonymous ingest response even though the API
accepted the request.

`apps/web/scripts/check-container-build-env.mjs` rejects origin drift, a
missing/mismatched release, a missing/malformed consent site key, direct
browser API routing, and production bypasses.
`apps/web/Dockerfile` copies only Next's standalone trace, static assets, and
`public/` into runtime. It does not contain repository source, tests, the pnpm
store, workspace tooling, build-only development dependencies, or source maps.
`scripts/release/verify-web-image.sh` enforces a 400 MiB image ceiling, exact
Node runtime, root-owned immutable application files, package-manager/build
dependency absence, and read-only/non-root startup on both published
architectures. Long-tail API and MCP docs are generated on first request from
bundled, drift-checked catalogs instead of duplicating thousands of pages or
shipping MCP TypeScript sources.

Do not manually tag or push a replacement image. Confirm the Docker Push run
for this commit succeeded, including its web signing and artifact checks:

```bash
gh run list --workflow docker-push.yml --commit "$GIT_SHA" --limit 5
```

Resolve the signed GHCR reference by immutable SHA tag, then immediately switch
to the digest:

```bash
gh auth token | docker login ghcr.io \
  --username "$(gh api user --jq .login)" --password-stdin
export GHCR_TAG="ghcr.io/${OWNER_LC}/postwave-web:sha-${GIT_SHA}"
export WEB_IMAGE_DIGEST="$(docker buildx imagetools inspect "$GHCR_TAG" \
  --format '{{json .Manifest.Digest}}' | tr -d '"')"
printf '%s' "$WEB_IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'
export GHCR_REF="ghcr.io/${OWNER_LC}/postwave-web@${WEB_IMAGE_DIGEST}"

cosign verify \
  --certificate-identity "https://github.com/${REPOSITORY}/.github/workflows/docker-push.yml@refs/heads/main" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$GHCR_REF" > /tmp/postwave-web-deploy/ghcr-signature.json

docker buildx imagetools inspect "$GHCR_REF" \
  --format '{{ json .Image }}' \
  | jq -e --arg revision "$GIT_SHA" --arg source "$SOURCE_URL" '
      (keys | sort) == ["linux/amd64","linux/arm64"] and
      all(.[];
        .config.Labels["org.opencontainers.image.revision"] == $revision and
        .config.Labels["org.opencontainers.image.source"] == $source
      )
    '
docker buildx imagetools inspect "$GHCR_REF" --format '{{ json .Provenance }}' \
  | jq -e '.. | objects | select(has("SLSA")) | .SLSA | length > 0'
docker buildx imagetools inspect "$GHCR_REF" --format '{{ json .SBOM }}' \
  | jq -e '.. | objects | select(has("SPDX")) | .SPDX | .SPDXID == "SPDXRef-DOCUMENT"'
```

## 3. Desired-zero CloudFormation bootstrap

The first deployment creates the ECR repository with the exact immutability
policy expected by the bridge. It also creates the task/service, target group,
host listener rule, roles, and retained logs, but starts no tasks. Supplying a
digest here does not claim that digest is already present in ECR.

```bash
web_parameters=(
  WebImageDigest="$WEB_IMAGE_DIGEST"
  WebArtifactVerified=false
  DeployWebService=false
  ReleaseId="$GIT_SHA"
  PublicReleaseApproval="$PUBLIC_RELEASE_APPROVAL"
  DomainName="$DOMAIN"
  VpcId="$VPC_ID"
  PrivateSubnetIds="$PRIVATE_SUBNETS"
  EcsClusterName="$ECS_CLUSTER_NAME"
  AlbSecurityGroupId="$ALB_SG"
  HttpsListenerArn="$HTTPS_LISTENER_ARN"
  AlbDnsName="$ALB_DNS"
  AlbHostedZoneId="$ALB_ZONE_ID"
  CreateDnsRecord=false
  AppleTeamId="$APPLE_TEAM_ID"
  IosBundleId="$IOS_BUNDLE_ID"
  AndroidPackageName="$ANDROID_PACKAGE_NAME"
  AndroidSha256CertFingerprints="$ANDROID_SHA256_CERT_FINGERPRINTS"
  SentryDsnWeb="$SENTRY_DSN_WEB"
)

set_web_parameter() {
  local key="$1" value="$2" index
  for index in "${!web_parameters[@]}"; do
    if [[ "${web_parameters[$index]}" == "${key}="* ]]; then
      web_parameters[$index]="${key}=${value}"
      return 0
    fi
  done
  web_parameters+=("${key}=${value}")
}

aws cloudformation deploy \
  --template-file infra/aws/cloudformation/postwave-web.yaml \
  --stack-name "$WEB_STACK" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides "${web_parameters[@]}" \
  --region "$AWS_REGION"

test "$(aws ecs describe-services --cluster "$ECS_CLUSTER_NAME" \
  --services postwave-web --query 'services[0].desiredCount' --output text)" = 0
```

If `postwave-web` was previously created outside CloudFormation, stop. Import
it into the stack through a reviewed resource-import change set; never delete a
repository containing the only rollback artifact.

## 4. Verified ECR promotion

Run the canonical bridge for the same commit after the bootstrap repository
exists. The job verifies the GHCR signature, labels, platforms, provenance and
SBOM, copies the complete manifest without changing its digest, then signs and
verifies the ECR digest.

```bash
gh workflow run ecr-bridge.yml --ref main \
  -f git_sha="$GIT_SHA" -f service=web
# Watch the created run and continue only when the web promotion succeeds.
gh run list --workflow ecr-bridge.yml --event workflow_dispatch --limit 5
```

Resolve and verify the ECR artifact independently:

```bash
export ECR_REPO="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/postwave-web"
export ECR_REF="${ECR_REPO}@${WEB_IMAGE_DIGEST}"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin \
      "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

test "$(aws ecr describe-images --repository-name postwave-web \
  --image-ids imageTag="sha-${GIT_SHA}" \
  --query 'imageDetails[0].imageDigest' --output text)" = "$WEB_IMAGE_DIGEST"

cosign verify \
  --certificate-identity "https://github.com/${REPOSITORY}/.github/workflows/ecr-bridge.yml@refs/heads/main" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$ECR_REF" > /tmp/postwave-web-deploy/ecr-signature.json

docker buildx imagetools inspect "$ECR_REF" --format '{{ json .Provenance }}' \
  | jq -e '.. | objects | select(has("SLSA")) | .SLSA | length > 0'
docker buildx imagetools inspect "$ECR_REF" --format '{{ json .SBOM }}' \
  | jq -e '.. | objects | select(has("SPDX")) | .SPDX | .SPDXID == "SPDXRef-DOCUMENT"'
```

Record the digest and verification output in the release evidence bundle. Now
update only the artifact assertion; keep desired count zero:

```bash
set_web_parameter WebArtifactVerified true
aws cloudformation deploy \
  --template-file infra/aws/cloudformation/postwave-web.yaml \
  --stack-name "$WEB_STACK" --capabilities CAPABILITY_IAM \
  --parameter-overrides "${web_parameters[@]}" \
  --region "$AWS_REGION"
```

## 5. Runtime contract and desired-zero exercise

CloudFormation injects exactly these server runtime values; all client-visible
`NEXT_PUBLIC_*` values were fixed during the signed build:

| Runtime variable                     | Value/source                                       |
| ------------------------------------ | -------------------------------------------------- |
| `NODE_ENV`, `POSTWAVE_ENV`           | `production`                                       |
| `NEXT_TELEMETRY_DISABLED`            | `1`                                                |
| `POSTWAVE_RELEASE`                   | full `ReleaseId` Git SHA                           |
| `POSTWAVE_PUBLIC_RELEASE_APPROVAL`   | empty unless a release record approves publication |
| `HOSTNAME`, `PORT`                   | `0.0.0.0`, `3000`                                  |
| `API_URL`, `POSTWAVE_API_URL`        | `https://api.moosewave.com`                         |
| `POSTWAVE_API_PROXY_TIMEOUT_MS`      | `15000`                                            |
| `POSTWAVE_API_STREAM_TIMEOUT_MS`     | `310000`                                           |
| `POSTWAVE_API_EXPORT_TIMEOUT_MS`     | `1800000`                                          |
| `POSTWAVE_API_PROXY_MAX_BODY_BYTES`  | `26214400`                                         |
| `POSTWAVE_PUBLIC_PAGE_TIMEOUT_MS`    | `8000`                                             |
| Apple/iOS/Android association values | reviewed release identity parameters               |
| `SENTRY_DSN_WEB`                     | optional parameter; omitted when empty             |

No auth bypass, tenant override, mock/demo flag, direct browser API URL,
provider secret, API key, or AWS credential belongs in the web task.

Verify the registered shape before any task starts:

```bash
export WEB_TASK_DEF="$(aws cloudformation describe-stacks --stack-name "$WEB_STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`WebTaskDefinitionArn`].OutputValue' --output text)"
export WEB_TASK_SG="$(aws cloudformation describe-stacks --stack-name "$WEB_STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`WebTaskSecurityGroupId`].OutputValue' --output text)"

aws ecs describe-task-definition --task-definition "$WEB_TASK_DEF" \
  --query 'taskDefinition.containerDefinitions[0].{image:image,user:user,readonly:readonlyRootFilesystem,drop:linuxParameters.capabilities.drop,mounts:mountPoints,health:healthCheck.command,env:environment}' \
  > /tmp/postwave-web-deploy/task-contract.json

jq -e --arg digest "$WEB_IMAGE_DIGEST" '
  (.image | endswith("@" + $digest)) and
  .user == "10001:10001" and .readonly == true and .drop == ["ALL"] and
  ([.mounts[].containerPath] | sort) == ["/app/apps/web/.next/cache","/tmp"] and
  (.health | join(" ") | contains("/healthz")) and
  ([.env[] | select(.name == "POSTWAVE_PUBLIC_RELEASE_APPROVAL")][0].value == "") and
  ([.env[].name] | any(startswith("NEXT_PUBLIC_")) | not) and
  ([.env[].name] | any(test("BYPASS|TENANT_SLUG|USE_MOCKS")) | not)
' /tmp/postwave-web-deploy/task-contract.json
```

Exercise the exact task once while the service remains at zero. ECS must mark
the container healthy under the same read-only/non-root task definition:

```bash
TASK_ARN="$(aws ecs run-task \
  --cluster "$ECS_CLUSTER_NAME" --launch-type FARGATE \
  --platform-version 1.4.0 --task-definition "$WEB_TASK_DEF" \
  --network-configuration "awsvpcConfiguration={subnets=[${PRIVATE_SUBNETS}],securityGroups=[${WEB_TASK_SG}],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)"
test -n "$TASK_ARN" && test "$TASK_ARN" != None
aws ecs wait tasks-running --cluster "$ECS_CLUSTER_NAME" --tasks "$TASK_ARN"

for attempt in $(seq 1 30); do
  health="$(aws ecs describe-tasks --cluster "$ECS_CLUSTER_NAME" --tasks "$TASK_ARN" \
    --query 'tasks[0].containers[0].healthStatus' --output text)"
  [ "$health" = HEALTHY ] && break
  [ "$health" = UNHEALTHY ] && { echo 'web canary became unhealthy' >&2; exit 1; }
  sleep 5
done
test "$health" = HEALTHY
aws ecs stop-task --cluster "$ECS_CLUSTER_NAME" --task "$TASK_ARN" \
  --reason 'desired-zero web artifact qualification complete' >/dev/null
```

Check API readiness separately immediately before rollout:

```bash
curl --fail --silent --show-error https://api.moosewave.com/api/ready >/dev/null
```

## 6. Enable service and pre-DNS verification

Enable through CloudFormation, not an out-of-band `update-service`, so desired
state remains auditable:

```bash
set_web_parameter DeployWebService true
aws cloudformation deploy \
  --template-file infra/aws/cloudformation/postwave-web.yaml \
  --stack-name "$WEB_STACK" --capabilities CAPABILITY_IAM \
  --parameter-overrides "${web_parameters[@]}" \
  --region "$AWS_REGION"

aws ecs wait services-stable --cluster "$ECS_CLUSTER_NAME" --services postwave-web
aws ecs describe-services --cluster "$ECS_CLUSTER_NAME" --services postwave-web \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,task:taskDefinition,rollout:deployments[0].rolloutState}'
```

Require desired/running `2`, pending `0`, and rollout `COMPLETED`. Then validate
every target and the host rule before creating DNS:

```bash
export WEB_TG_ARN="$(aws cloudformation describe-stacks --stack-name "$WEB_STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`WebTargetGroupArn`].OutputValue' --output text)"
aws elbv2 describe-target-health --target-group-arn "$WEB_TG_ARN" \
  --query 'TargetHealthDescriptions[].TargetHealth.State' --output json \
  | jq -e 'length >= 2 and all(.[]; . == "healthy")'

ALB_IP="$(dig +short "$ALB_DNS" A | head -1)"
test -n "$ALB_IP"
curl --fail --silent --show-error \
  --resolve "app.${DOMAIN}:443:${ALB_IP}" \
  "https://app.${DOMAIN}/healthz" \
  | jq -e '.status == "ok" and .service == "postwave-web"'
curl --fail --silent --show-error \
  --resolve "app.${DOMAIN}:443:${ALB_IP}" \
  "https://app.${DOMAIN}/api/ready" \
  | jq -e '.status == "ready"'
```

The first request proves local Next.js liveness. The second proves the deployed
same-origin proxy can reach the API; it is intentionally not an ALB health
check.

While `PublicReleaseApproval` remains empty, verify the publication gate before
DNS cutover. This is the expected pre-approval state, not a launch failure:

```bash
curl --fail --silent --show-error \
  --resolve "app.${DOMAIN}:443:${ALB_IP}" \
  "https://app.${DOMAIN}/robots.txt" \
  | grep -Fx 'Disallow: /'
curl --fail --silent --show-error --head \
  --resolve "app.${DOMAIN}:443:${ALB_IP}" \
  "https://app.${DOMAIN}/" \
  | tr -d '\r' | grep -Eix 'x-robots-tag: noindex, nofollow, noarchive'
```

Do not open public indexing merely because the service is healthy. Only after
the launch decision register records counsel-approved legal text, reviewed
public claims/pricing, provider readiness, incident ownership, and the exact
release candidate may an operator set a traceable reference and redeploy:

```bash
export PUBLIC_RELEASE_APPROVAL=approved:REPLACE_WITH_RELEASE_RECORD
printf '%s' "$PUBLIC_RELEASE_APPROVAL" \
  | grep -Eq '^approved:[A-Za-z0-9][A-Za-z0-9._/-]{5,127}$'
set_web_parameter PublicReleaseApproval "$PUBLIC_RELEASE_APPROVAL"
aws cloudformation deploy \
  --template-file infra/aws/cloudformation/postwave-web.yaml \
  --stack-name "$WEB_STACK" --capabilities CAPABILITY_IAM \
  --parameter-overrides "${web_parameters[@]}" \
  --region "$AWS_REGION"
```

After that change, archive the parameter value and change-set approval, require
`robots.txt` to contain the sitemap, and require the root document to omit the
fail-closed `X-Robots-Tag`. Draft `/legal/*` and `/vs/*` routes remain closed
until separately reviewed code removes their route-level gates.

## 7. DNS cutover

For Route 53 managed DNS, set the hosted zone and let CloudFormation create the
A-alias only after pre-DNS checks pass:

```bash
export ROUTE53_ZONE_ID="$(aws route53 list-hosted-zones-by-name \
  --dns-name "${DOMAIN}." \
  --query 'HostedZones[?Name==`moosewave.com.`].Id | [0]' --output text | cut -d/ -f3)"
test -n "$ROUTE53_ZONE_ID" && test "$ROUTE53_ZONE_ID" != None

set_web_parameter CreateDnsRecord true
set_web_parameter Route53HostedZoneId "$ROUTE53_ZONE_ID"
aws cloudformation deploy \
  --template-file infra/aws/cloudformation/postwave-web.yaml \
  --stack-name "$WEB_STACK" --capabilities CAPABILITY_IAM \
  --parameter-overrides "${web_parameters[@]}" \
  --region "$AWS_REGION"
```

If DNS is externally managed, keep `CreateDnsRecord=false` and create an
approved proxied/ALIAS record using the stack outputs `WebDnsName`,
`WebDnsAliasTarget`, and `WebDnsAliasHostedZoneId`. Preserve Host and SNI, do not cache
authenticated HTML or `/api/*`, and do not expose a bypass path around WAF.

## 8. Post-cutover qualification

Run on the exact digest and archive timestamped output:

```bash
curl --fail --silent --show-error https://app.moosewave.com/healthz \
  | jq -e '.status == "ok" and .service == "postwave-web"'
curl --fail --silent --show-error https://app.moosewave.com/api/ready \
  | jq -e '.status == "ready"'
curl --fail --silent --show-error https://app.moosewave.com/.well-known/apple-app-site-association \
  | jq -e --arg app_id "${APPLE_TEAM_ID}.${IOS_BUNDLE_ID}" \
      '.applinks.details[0].appID == $app_id'
curl --fail --silent --show-error https://app.moosewave.com/.well-known/assetlinks.json \
  | jq -e --arg package "$ANDROID_PACKAGE_NAME" \
      '.[0].target.package_name == $package and (.[0].target.sha256_cert_fingerprints | length > 0)'
curl --fail --silent --show-error --head https://app.moosewave.com/login

consent_probe_headers="$(mktemp /tmp/postwave-web-deploy/consent-headers.XXXXXX)"
consent_probe_body="$(mktemp /tmp/postwave-web-deploy/consent-body.XXXXXX)"
consent_probe_status="$(curl --silent --show-error \
  --request POST https://api.moosewave.com/api/public/consent \
  --header 'Origin: https://moosewave.com' \
  --header 'Content-Type: application/json' \
  --header "X-Postwave-Site-Key: ${CONSENT_SITE_KEY}" \
  --data '{"visitor_id":"invalid","choice":"reject","prefs":{"essential":true,"analytics":false,"marketing":false}}' \
  --dump-header "$consent_probe_headers" \
  --output "$consent_probe_body" \
  --write-out '%{http_code}')"
test "$consent_probe_status" = 400
grep -Eqi '^access-control-allow-origin: https://postwave\.com\r?$' "$consent_probe_headers"
grep -Eqi '^cache-control: .*no-store' "$consent_probe_headers"
grep -Eq '"code"[[:space:]]*:[[:space:]]*"invalid_visitor_id"' "$consent_probe_body"
rm -f -- "$consent_probe_headers" "$consent_probe_body"

aws ecs describe-services --cluster postwave-prod --services postwave-web \
  --query 'services[0].{desired:desiredCount,running:runningCount,events:events[0:5]}'
aws logs tail /ecs/postwave-web --since 15m
```

The invalid-visitor probe is intentionally non-mutating: reaching
`invalid_visitor_id` proves the public key resolved before input validation,
while the exact canonical marketing origin, CORS, and no-store assertions prove
the shipped banner can safely observe the result. Also complete an
authenticated browser E2E from `https://moosewave.com` that records one reviewed
reject-optional canary and verifies its three correlated category rows in the
consent ledger, plus CSP/axe/Lighthouse gates, service-worker update/rollback,
upload/proxy limits, SSE, mobile universal/app-link opening on signed devices,
load at the reviewed target, and an alarm/pager exercise. A 200 from `/healthz`
alone is never release certification.

## 9. Rollback

The deployment circuit breaker automatically returns to the last stable task
definition if new tasks fail container or target-group health. Confirm rather
than assuming:

```bash
aws ecs describe-services --cluster postwave-prod --services postwave-web \
  --query 'services[0].{deployments:deployments,events:events[0:10]}'
```

For an application regression that still passes health, roll back through
CloudFormation to a previously recorded, independently verified digest and its
matching full commit SHA. Never use `latest`, `main`, an image tag, or an
architecture-specific child digest:

```bash
export PREVIOUS_WEB_IMAGE_DIGEST=sha256:REPLACE_WITH_RECORDED_64_HEX_DIGEST
export PREVIOUS_GIT_SHA=REPLACE_WITH_RECORDED_40_HEX_SHA
printf '%s' "$PREVIOUS_WEB_IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'
printf '%s' "$PREVIOUS_GIT_SHA" | grep -Eq '^[0-9a-f]{40}$'

cosign verify \
  --certificate-identity "https://github.com/${REPOSITORY}/.github/workflows/ecr-bridge.yml@refs/heads/main" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "${ECR_REPO}@${PREVIOUS_WEB_IMAGE_DIGEST}" >/dev/null

set_web_parameter WebImageDigest "$PREVIOUS_WEB_IMAGE_DIGEST"
set_web_parameter ReleaseId "$PREVIOUS_GIT_SHA"
aws cloudformation deploy \
  --template-file infra/aws/cloudformation/postwave-web.yaml \
  --stack-name "$WEB_STACK" --capabilities CAPABILITY_IAM \
  --parameter-overrides "${web_parameters[@]}" \
  --region "$AWS_REGION"
aws ecs wait services-stable --cluster postwave-prod --services postwave-web
```

For emergency containment, set `DeployWebService=false` through CloudFormation.
This forces desired count zero while retaining logs, ECR artifacts, the target
group, and listener priority for a controlled fix-forward. If the incident is
edge/DNS-specific, restore the previously recorded DNS target as a separate,
approved change. Do not delete the service, log group, repository, or stack as
an application rollback.

## 10. Required external evidence

Repository-side remediation is complete only when its static/unit/image/IaC
checks pass. Live qualification remains external and must include:

- CloudFormation change set, stack events, parameters, outputs, and drift
  detection showing no unreviewed resources;
- Docker Push and ECR Bridge run URLs for the exact full Git SHA;
- GHCR and ECR signature verification JSON, provenance, SBOM, immutable digest,
  platform/label check, vulnerability scan, and minimal-image inventory;
- desired-zero canary health, ECS stable-service state, target health, circuit
  breaker event, autoscaling registration, and retained-log evidence;
- DNS ownership, ACM chain/SAN, WAF association, ALB access logs, and public
  `/healthz` plus same-origin API proxy evidence;
- signed-device universal/app-link checks using the exact release identities;
- authenticated E2E, accessibility, performance, load, rollback rehearsal,
  alert delivery, human acknowledgement, and incident-exercise results.

Until those artifacts exist for a production-like candidate and the promoted
production digest, report the web deployment as **configured, not certified**.
