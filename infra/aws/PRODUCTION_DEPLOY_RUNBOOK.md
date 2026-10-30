# Moosewave production deploy runbook (AWS)

Canonical production cutover for region `us-west-2` and apex
`moosewave.com`. Account IDs are always resolved from the active AWS identity;
the runbook never relies on a checked-in account number.

Companion to [`docs/runbooks/auth-aws.md`](../../docs/runbooks/auth-aws.md)
(steady-state auth ops: rotation, rollback, bootstrap). This file is the
first-deploy cutover sequence.

**Scope:** Go API, four HTTP sidecars, and the isolated Campaign Assurance
data plane on ECS Fargate, ALB, RDS Postgres, Secrets Manager, SES, S3, the
private metrics plane, and infrastructure alarms. **Out of scope:** section 6.

---

## 1. Prerequisites checklist

Verify each before step 1. Not created by the runbook.

- [ ] The intended production AWS account is accessible; CLI default region
      is `us-west-2` with bootstrap permissions.
- [ ] VPC, >=3 AZs in `us-west-2`. Public subnets per AZ (ALB + NAT),
      private subnets per AZ (ECS + RDS). `/22` per subnet minimum.
- [ ] NAT gateway per AZ (single-NAT is a regional SPOF).
- [ ] Route 53 public hosted zone for `moosewave.com`.
- [ ] ACM cert in `us-west-2` covering `*.moosewave.com` + apex (SAN),
      DNS-validated, status `ISSUED`.
- [ ] Five KMS CMKs (rotation enabled):
      `alias/postwave-secrets-prod`, `alias/postwave-rds-prod`,
      `alias/postwave-s3-prod`, `alias/postwave-app-data-prod`, and
      `alias/postwave-campaign-assurance-evidence-prod`. Capture UUIDs.
      Their key policies must delegate the corresponding IAM/service use:
      Secrets Manager + task execution role; RDS; S3-mediated access by the API
      task role; direct application-envelope access by both the API and
      dedicated Campaign Assurance task roles; and S3-mediated evidence access
      by only the dedicated Campaign Assurance task role, respectively.
- [ ] Campaign Assurance release inputs are reviewed and loaded as non-secret
      operator variables: exact Gemini model ID/version and pricing-table
      version/rates and an explicit image-CDN host allowlist. Step 1 derives
      the canonical Tesseract/traineddata and ClamAV/signature identities from
      the exact signed image artifact; operators must not type or guess them.
- [ ] A production Redis endpoint reachable from the private subnets, with
      TLS and authentication. Capture its `rediss://` URL without committing it.
- [ ] A production Listmonk service reachable from the private subnets at a
      stable private URL or internal load balancer, with the default password
      rotated. If another stack later registers `listmonk.postwave.internal`,
      use that name only after the parent Cloud Map namespace exists.
- [ ] A normalized HTTPS seed-list vendor/proxy endpoint and an active mailbox
      registry JSON. The registry must contain real active inbox metadata, not
      the checked-in example addresses.
- [ ] SES `moosewave.com` identity verified, DKIM SUCCESS, SPF + DMARC
      records resolving (MVP did this).
- [ ] SES production access granted (out-of-sandbox). Confirm in SES
      console; if not, file the support case now -- prod cannot send to
      unverified recipients in sandbox.
- [ ] SES configuration set `postwave-prod` and the split SNS topics
      `postwave-prod-ses-bounce` / `postwave-prod-ses-complaint` exist.
- [ ] The Google OAuth client contains the final callback URI from step 9,
      and its client ID is loaded as an operator variable.
- [ ] Dodo Payments is verified for live mode. Load the live
      `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`, and the approved
      `DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY`,
      `DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY`, and
      `DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY` IDs. All three must be recurring
      monthly USD products at $39, $99, and $349 respectively. Confirm tax
      treatment in Dodo. Set `MOOSEWAVE_BILLING_LAUNCH_APPROVAL=approved:<release-record>`
      only after the signed staging webhook and end-to-end payment rehearsal
      have passed; step 10 repeats the evidence check against live mode.
- [ ] Create a separate live restricted key as
      `MIGRATION_STRIPE_SECRET_KEY`. In Stripe Workbench its only permissions
      are connected-account `Subscriptions: Read` and `Customers: Read`;
      every write, Checkout, Billing Portal, refund, payment-method, Price,
      and Product permission is disabled. Retain a screenshot/export of the
      permission configuration in the release evidence. Never reuse
      `STRIPE_SECRET_KEY` for this task.
- [ ] Mailchimp and Kit (ConvertKit) OAuth applications contain their final
      migration callback URIs: Mailchimp uses
      `https://app.moosewave.com/app/migrations/oauth/callback?source=mailchimp`
      and Kit uses
      `https://app.moosewave.com/app/migrations/oauth/callback?source=convertkit`.
      All four client ID/secret values are loaded into the operator environment.
- [ ] Provider credentials loaded into the operator environment: OAuth,
      Dodo Payments, the restricted migration Stripe key, Anthropic, Gemini (`GEMINI_API_KEY` for the deliverability
      sidecar and a separate dedicated `ASSURANCE_GEMINI_API_KEY` for the
      Campaign Assurance provider gateway), OpenAI, HCTI, seed-list vendor,
      the ops console Slack incoming-webhook URL (`OPS_SLACK_WEBHOOK_URL`), and
      feedback-webhook secrets. Do not paste them into this file or shell history.
- [ ] Local: Bash 4+, `aws` v2, authenticated `gh`, `cosign` v3, `jq`, `rg`,
      `psql` v16, `openssl`, `redis-cli`, and `curl`.
- [ ] Git checkout at the SHA to deploy:
      `GIT_SHA=$(git rev-parse HEAD)`. Only a full 40-character SHA is valid.
- [ ] `POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE` is unset. It is a local-only escape
      hatch; staging and production tasks must always use their scoped database
      roles and must never carry this environment variable or secret.

Shell vars used throughout:

```bash
set -euo pipefail
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export DOMAIN=moosewave.com
export GIT_SHA=$(git rev-parse HEAD)
export IMAGE_TAG=sha-${GIT_SHA}
export GITHUB_REPOSITORY=<owner>/<repository>
export SECRETS_KMS_KEY_ARN=arn:aws:kms:${AWS_REGION}:${ACCOUNT_ID}:key/<secrets-cmk-uuid>
export RDS_KMS_KEY_ARN=arn:aws:kms:${AWS_REGION}:${ACCOUNT_ID}:key/<rds-cmk-uuid>
export S3_KMS_KEY_ARN=arn:aws:kms:${AWS_REGION}:${ACCOUNT_ID}:key/<s3-cmk-uuid>
export APP_DATA_KMS_KEY_ARN=arn:aws:kms:${AWS_REGION}:${ACCOUNT_ID}:key/<app-data-cmk-uuid>
export ASSURANCE_EVIDENCE_KMS_KEY_ARN=arn:aws:kms:${AWS_REGION}:${ACCOUNT_ID}:key/<assurance-evidence-cmk-uuid>
export VPC_ID=vpc-xxxxxxxx
export PUBLIC_SUBNETS="subnet-aaaa,subnet-bbbb,subnet-cccc"
export PRIVATE_SUBNETS="subnet-dddd,subnet-eeee,subnet-ffff"
export ACM_CERT_ARN=arn:aws:acm:${AWS_REGION}:${ACCOUNT_ID}:certificate/<uuid>
export UPLOADS_BUCKET=postwave-uploads-prod-${ACCOUNT_ID}
export EXPORTS_BUCKET=postwave-exports-prod-${ACCOUNT_ID}
export ASSURANCE_IMAGE_EVIDENCE_BUCKET=postwave-assurance-image-evidence-prod-${ACCOUNT_ID}
# Replace only after the HTTPS CDN distribution, private-bucket OAC, DNS, and
# external unauthenticated fetch probe are qualified.
export ASSETS_PUBLIC_BASE_URL='https://<qualified-assets-cdn-host>'
export ASSETS_CLOUDFRONT_DISTRIBUTION_ID='<cloudfront-distribution-id>'
export ALB_LOGS_BUCKET=postwave-alb-logs-prod-${ACCOUNT_ID}
export LISTMONK_INTERNAL_URL=http://<existing-private-listmonk-host>:9000
export LISTMONK_ADMIN_USER=<rotated-api-user>
export SEEDLIST_VENDOR_API_URL=https://<vendor-or-proxy-host>/v1/messages
export OPS_ALERT_EMAIL=ops@${DOMAIN}
export SES_TOPIC_ARNS="arn:aws:sns:${AWS_REGION}:${ACCOUNT_ID}:postwave-prod-ses-bounce,arn:aws:sns:${AWS_REGION}:${ACCOUNT_ID}:postwave-prod-ses-complaint"
export ASSURANCE_GEMINI_MODEL_ID='<reviewed-model-id>'
export ASSURANCE_GEMINI_MODEL_VERSION='<reviewed-provider-returned-model-version>'
export ASSURANCE_GEMINI_PRICING_VERSION='<reviewed-pricing-version>'
export ASSURANCE_GEMINI_INPUT_MICROUSD_PER_MILLION_TOKENS='<positive-integer>'
export ASSURANCE_GEMINI_OUTPUT_MICROUSD_PER_MILLION_TOKENS='<positive-integer>'
export ASSURANCE_IMAGE_ALLOWED_HOSTS='<comma-separated-exact-lowercase-hosts>'
# Populated from the exact Docker Push verification artifact in step 1.
export ASSURANCE_OCR_VERSION=''
export ASSURANCE_SCANNER_VERSION=''
```

Keep `REDIS_URL`, provider secrets, `LISTMONK_ADMIN_PASSWORD`, and
`SEEDLIST_REGISTRY_JSON` in a secure operator environment. The commands below
fail before creating infrastructure if a required value is empty.

---

## 2. Step-by-step deploy

Use a private working directory. Task definitions are rendered structurally
only after their immutable image digests and full secret ARNs are known:

```bash
install -d -m 0700 /tmp/postwave-deploy
if ! printf '%s' "$GIT_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "GIT_SHA must be a full 40-character commit SHA" >&2
  exit 1
fi
```

### Step 1 -- signed ECR release artifacts

```bash
ecr_exclusions=(
  filterType=WILDCARD,filter=latest
  filterType=WILDCARD,filter=main
)

for repo in postwave-api postwave-voice postwave-automation \
            postwave-deliverability postwave-migration postwave-db-migrator \
            postwave-campaign-assurance \
            postwave-campaign-assurance-image-services; do
  if ! aws ecr describe-repositories --repository-names "$repo" >/dev/null 2>&1; then
    aws ecr create-repository --repository-name "$repo" \
      --image-scanning-configuration scanOnPush=true \
      --encryption-configuration encryptionType=AES256 \
      --image-tag-mutability IMMUTABLE_WITH_EXCLUSION \
      --image-tag-mutability-exclusion-filters "${ecr_exclusions[@]}"
  fi
  aws ecr put-image-tag-mutability --repository-name "$repo" \
    --image-tag-mutability IMMUTABLE_WITH_EXCLUSION \
    --image-tag-mutability-exclusion-filters "${ecr_exclusions[@]}" >/dev/null

  aws ecr describe-repositories --repository-names "$repo" \
    --query 'repositories[0].{mutability:imageTagMutability,filters:imageTagMutabilityExclusionFilters}' \
    --output json | jq -e '
      .mutability == "IMMUTABLE_WITH_EXCLUSION" and
      ((.filters // []) | map({filterType, filter}) | sort_by(.filter)) ==
        ([{filterType:"WILDCARD",filter:"latest"},{filterType:"WILDCARD",filter:"main"}] | sort_by(.filter))
    ' >/dev/null
done

aws ecr get-login-password | docker login --username AWS --password-stdin \
  ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

for image in api voice automation deliverability migration db-migrator \
             campaign-assurance campaign-assurance-image-services; do
  repository="postwave-${image}"
  registry="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${repository}"
  digest="$(aws ecr describe-images --repository-name "$repository" \
    --image-ids imageTag="${IMAGE_TAG}" \
    --query 'imageDetails[0].imageDigest' --output text)"
  if ! printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
    echo "Invalid ECR digest for ${repository}:${IMAGE_TAG}: ${digest}" >&2
    exit 1
  fi
  cosign verify \
    --certificate-identity "https://github.com/${GITHUB_REPOSITORY}/.github/workflows/ecr-bridge.yml@refs/heads/main" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "${registry}@${digest}" >/dev/null

  variable="$(printf '%s_IMAGE_DIGEST' "$image" | tr '[:lower:]-' '[:upper:]_')"
  printf -v "$variable" '%s' "$digest"
  export "$variable"
done

env | LC_ALL=C sort | grep -E '^(API|VOICE|AUTOMATION|DELIVERABILITY|MIGRATION|DB_MIGRATOR|CAMPAIGN_ASSURANCE|CAMPAIGN_ASSURANCE_IMAGE_SERVICES)_IMAGE_DIGEST=' \
  > /tmp/postwave-deploy/release-digests.env
test "$(wc -l < /tmp/postwave-deploy/release-digests.env | tr -d ' ')" = 8

# The publisher executes both target architectures and archives identities
# derived from the exact tools and immutable English traineddata. Read only the
# successful Docker Push run for this commit and bind the artifact back to the
# already verified manifest digest.
DOCKER_PUSH_RUN_ID="$(gh run list --repo "$GITHUB_REPOSITORY" \
  --workflow docker-push.yml --commit "$GIT_SHA" \
  --json databaseId,conclusion,headSha \
  --jq '[.[] | select(.conclusion == "success" and .headSha == "'"$GIT_SHA"'")] | sort_by(.databaseId) | last | .databaseId')"
test -n "$DOCKER_PUSH_RUN_ID"
ASSURANCE_IDENTITY_DIR="$(mktemp -d /tmp/postwave-assurance-identities.XXXXXX)"
gh run download "$DOCKER_PUSH_RUN_ID" --repo "$GITHUB_REPOSITORY" \
  --name "campaign-assurance-image-services-verification-${GIT_SHA}" \
  --dir "$ASSURANCE_IDENTITY_DIR"
ASSURANCE_IDENTITY_FILE="${ASSURANCE_IDENTITY_DIR}/campaign-assurance-image-services-verification.json"
jq -e --arg digest "$CAMPAIGN_ASSURANCE_IMAGE_SERVICES_IMAGE_DIGEST" '
  .schema_version == "postwave.campaign-assurance-image-services-verification.v1" and
  (.image | endswith("@" + $digest)) and
  (.platforms | map(.platform) | sort) == ["linux/amd64","linux/arm64"] and
  (.platforms | map(.ocr_version) | unique | length) == 1 and
  (.platforms | map(.scanner_version) | unique | length) == 1 and
  (.ocr_version | test("^[0-9]+([.][0-9]+){1,3}([.-][a-z0-9]+)*-eng[.]sha256[.][0-9a-f]{64}$")) and
  (.scanner_version | test("^[0-9]+([.][0-9]+){1,3}([.-][a-z0-9]+)*-db[.][0-9]{1,12}$"))
' "$ASSURANCE_IDENTITY_FILE" >/dev/null
export ASSURANCE_OCR_VERSION="$(jq -r '.ocr_version' "$ASSURANCE_IDENTITY_FILE")"
export ASSURANCE_SCANNER_VERSION="$(jq -r '.scanner_version' "$ASSURANCE_IDENTITY_FILE")"
test -n "$ASSURANCE_OCR_VERSION" && test -n "$ASSURANCE_SCANNER_VERSION"
```

The `Docker Push` workflow builds a signed amd64/arm64 index with SLSA
provenance and an SPDX SBOM. `ECR Bridge` verifies the source identity,
copies the exact digest, signs the destination, and fails if any evidence is
missing. Do not replace this with a local `docker build`/push: it bypasses the
release identity and makes later provenance checks unverifiable.

From this point forward, deployment commands use only the eight exported
`*_IMAGE_DIGEST` values. Never re-resolve a tag midway through the rollout.

### Step 2 -- S3 buckets

`postwave-stack.yaml` owns both the uploads/assets bucket and the separate
private tenant-export bucket, including KMS encryption, lifecycle,
public-access blocks, and bucket policies; CORS applies only to uploads/assets.
RDS owns
its native automated backups and point-in-time recovery. The standalone
`infra/backup/aws-backup-dr.yaml` stack owns any self-managed portable backup
buckets and grants them only to its dedicated writer identity; the API task
role must not receive backup-bucket access. Create only the ALB-log bucket
here:

```bash
ensure_bucket() {
  if ! aws s3api head-bucket --bucket "$1" >/dev/null 2>&1; then
    if [ "$AWS_REGION" = "us-east-1" ]; then
      aws s3api create-bucket --bucket "$1"
    else
      aws s3api create-bucket --bucket "$1" \
        --create-bucket-configuration "LocationConstraint=${AWS_REGION}"
    fi
  fi
  aws s3api put-public-access-block --bucket "$1" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
}

# ALB log delivery supports SSE-S3. Do not apply the application S3 CMK here.
ensure_bucket "$ALB_LOGS_BUCKET"
aws s3api put-bucket-encryption --bucket "$ALB_LOGS_BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-lifecycle-configuration --bucket "$ALB_LOGS_BUCKET" \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-alb-access-logs","Status":"Enabled","Filter":{"Prefix":"alb/"},"Expiration":{"Days":90},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'
aws s3api put-bucket-policy --bucket "$ALB_LOGS_BUCKET" --policy "$(jq -nc \
  --arg bucket "$ALB_LOGS_BUCKET" --arg account "$ACCOUNT_ID" '
  {
    Version:"2012-10-17",
    Statement:[
      {
        Sid:"AllowALBLogDelivery",
        Effect:"Allow",
        Principal:{Service:"logdelivery.elasticloadbalancing.amazonaws.com"},
        Action:"s3:PutObject",
        Resource:("arn:aws:s3:::"+$bucket+"/alb/AWSLogs/"+$account+"/*")
      },
      {
        Sid:"DenyInsecureTransport",
        Effect:"Deny",
        Principal:"*",
        Action:"s3:*",
        Resource:[("arn:aws:s3:::"+$bucket),("arn:aws:s3:::"+$bucket+"/*")],
        Condition:{Bool:{"aws:SecureTransport":"false"}}
      }
    ]
  }')"
```

### Step 3 -- Secrets Manager

Source of truth: `infra/aws/secrets-manager-bootstrap.json`. Loop body:

```bash
required_secret_vars=(
  REDIS_URL GOOGLE_CLIENT_SECRET POSTMARK_HMAC SENDGRID_HMAC
  DODO_PAYMENTS_API_KEY DODO_PAYMENTS_WEBHOOK_KEY
  DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY
  DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY
  DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY MIGRATION_STRIPE_SECRET_KEY
  MAILCHIMP_CLIENT_ID MAILCHIMP_CLIENT_SECRET
  CONVERTKIT_CLIENT_ID CONVERTKIT_CLIENT_SECRET
  ANTHROPIC_API_KEY GEMINI_API_KEY ASSURANCE_GEMINI_API_KEY OPENAI_API_KEY
  HCTI_USER_ID HCTI_API_KEY SEEDLIST_REGISTRY_JSON SEEDLIST_VENDOR_API_KEY
  LISTMONK_ADMIN_PASSWORD OPS_SLACK_WEBHOOK_URL
)
for variable in "${required_secret_vars[@]}"; do
  if [ -z "${!variable:-}" ]; then
    echo "Required secret input ${variable} is empty" >&2
    exit 1
  fi
done
required_commercial_vars=(MOOSEWAVE_BILLING_LAUNCH_APPROVAL)
for variable in "${required_commercial_vars[@]}"; do
  if [ -z "${!variable:-}" ]; then
    echo "External go-live blocker: approved commercial input ${variable} is empty" >&2
    exit 1
  fi
done
printf '%s' "$MOOSEWAVE_BILLING_LAUNCH_APPROVAL" \
  | grep -Eq '^approved:[A-Za-z0-9][A-Za-z0-9._/-]{5,}$' || {
  echo "MOOSEWAVE_BILLING_LAUNCH_APPROVAL must name an approved release record" >&2
  exit 1
}
printf '%s' "$REDIS_URL" | grep -Eq '^rediss://' || {
  echo "REDIS_URL must use TLS (rediss://)" >&2; exit 1;
}
printf '%s' "$DODO_PAYMENTS_WEBHOOK_KEY" | grep -Eq '^whsec_' || {
  echo "DODO_PAYMENTS_WEBHOOK_KEY must be a Dodo Payments webhook signing key" >&2; exit 1;
}
printf '%s' "$MIGRATION_STRIPE_SECRET_KEY" | grep -Eq '^rk_live_[A-Za-z0-9]+$' || {
  echo "MIGRATION_STRIPE_SECRET_KEY must be a Stripe live restricted key (rk_live_...)" >&2; exit 1;
}
for variable in DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY; do
  printf '%s' "${!variable}" | grep -Eq '^pdt_[A-Za-z0-9]+$' || {
    echo "${variable} must be a Dodo Payments Product ID" >&2; exit 1;
  }
done
if [ "$(printf '%s\n' "$DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY" \
    "$DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY" "$DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY" \
    | LC_ALL=C sort -u | wc -l | tr -d ' ')" != 3 ]; then
  echo "Dodo Payments plans must use three distinct Product IDs" >&2
  exit 1
fi

dodo_curl_config="$(mktemp /tmp/postwave-deploy/dodo-curl.XXXXXX)"
trap 'rm -f -- "$dodo_curl_config"' EXIT HUP INT TERM
chmod 0600 "$dodo_curl_config"
printf 'header = "Authorization: Bearer %s"\n' "$DODO_PAYMENTS_API_KEY" \
  > "$dodo_curl_config"

verify_dodo_product() {
  local variable="$1" expected_type="$2" plan="$3" expected_currency="$4" expected_amount="$5" expected_interval="$6" response
  local product_id="${!variable}"
  response="$(curl --fail --silent --show-error \
    --connect-timeout 10 --max-time 30 \
    --config "$dodo_curl_config" \
    "https://live.dodopayments.com/products/${product_id}")"
  printf '%s' "$response" | jq -e \
    --arg id "$product_id" --arg type "$expected_type" \
    --arg currency "$expected_currency" --argjson amount "$expected_amount" \
    --arg interval "$expected_interval" '
    .product_id == $id and .price.currency == $currency and
    .price.price == $amount and
    (if $type == "recurring" then
       .is_recurring == true and .price.type == "recurring_price" and
       .price.payment_frequency_interval == $interval
     else
       .is_recurring == false and .price.type == "one_time_price"
     end)
  ' >/dev/null || {
    echo "${variable} does not match the approved live Dodo Payments commercial contract" >&2
    exit 1
  }
  printf '%s' "$response" | jq -c \
    '{product_id,name,is_recurring,tax_category,price}'
}
verify_dodo_product DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY recurring LAUNCH usd 3900 month
verify_dodo_product DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY recurring GROWTH usd 9900 month
verify_dodo_product DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY recurring SCALE usd 34900 month

dodo_webhook_endpoint="https://api.${DOMAIN}/api/public/dodo/webhook"
dodo_webhook_response="$(curl --fail --silent --show-error \
  --connect-timeout 10 --max-time 30 \
  --config "$dodo_curl_config" \
  'https://live.dodopayments.com/webhooks')"
printf '%s' "$dodo_webhook_response" | jq -e --arg endpoint "$dodo_webhook_endpoint" '
  ["payment.succeeded", "payment.failed", "payment.cancelled",
   "subscription.active", "subscription.updated", "subscription.renewed",
   "subscription.plan_changed", "subscription.past_due", "subscription.on_hold",
   "subscription.paused", "subscription.unpaused", "subscription.cancelled",
   "subscription.failed", "subscription.expired", "refund.succeeded",
   "dunning.started", "dunning.recovered"] as $required |
  any(.data[];
    .url == $endpoint and .disabled == false and
    (((.filter_types // []) | length == 0) or
     (($required - (.filter_types // [])) | length == 0)))
' >/dev/null || {
  echo "Dodo Payments live webhook is missing, disabled, or lacks a required event" >&2
  exit 1
}
rm -f -- "$dodo_curl_config"
trap - EXIT HUP INT TERM

[ "$LISTMONK_ADMIN_PASSWORD" != "listmonk" ] || {
  echo "Refusing the checked-in Listmonk default password" >&2; exit 1;
}
printf '%s' "$SEEDLIST_REGISTRY_JSON" | jq -e \
  '.inboxes | type == "array" and length > 0 and all(.[]; .status == "active")' >/dev/null
[ "$ASSURANCE_GEMINI_API_KEY" != "$GEMINI_API_KEY" ] || {
  echo "ASSURANCE_GEMINI_API_KEY must be a dedicated key, not the deliverability GEMINI_API_KEY" >&2; exit 1;
}
printf '%s' "$OPS_SLACK_WEBHOOK_URL" | grep -Eq '^https://hooks\.slack\.com/' || {
  echo "OPS_SLACK_WEBHOOK_URL must be a Slack incoming-webhook URL" >&2; exit 1;
}

create_secret() {
  local name="$1" value="$2" description="$3" secret_file
  if aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
    echo "exists; preserving current value: $name"
    return
  fi
  secret_file="$(mktemp /tmp/postwave-deploy/secret.XXXXXX)"
  chmod 0600 "$secret_file"
  printf '%s' "$value" > "$secret_file"
  if ! aws secretsmanager create-secret --name "$name" --description "$description" \
      --kms-key-id "${SECRETS_KMS_KEY_ARN}" \
      --secret-string "file://${secret_file}" >/dev/null; then
    rm -f "$secret_file"
    return 1
  fi
  rm -f "$secret_file"
}

create_secret postwave/prod/auth-hmac-pepper       "$(openssl rand -base64 64)" "POSTWAVE_AUTH_HMAC_PEPPER"
create_secret postwave/prod/auth-kek               "$(openssl rand -base64 32)" "POSTWAVE_AUTH_KEK"
create_secret postwave/prod/api-key-pepper         "$(openssl rand -base64 32)" "POSTWAVE_API_KEY_PEPPER"
create_secret postwave/prod/consent-cursor-signing-key "$(openssl rand -base64 32)" "Dedicated POSTWAVE_CONSENT_CURSOR_SIGNING_KEY; never reuse another pepper or key"
create_secret postwave/prod/sms-inbox-cursor-key    "$(openssl rand -base64 32)" "Dedicated POSTWAVE_SMS_INBOX_CURSOR_KEY; never reuse another pepper or key"
create_secret postwave/prod/helpdesk-cursor-key     "$(openssl rand -base64 32)" "Dedicated POSTWAVE_HELPDESK_CURSOR_KEY; never reuse another pepper or key"
create_secret postwave/prod/pii-fingerprint-pepper "$(openssl rand -base64 32)" "Dedicated POSTWAVE_PII_FINGERPRINT_PEPPER"
create_secret postwave/prod/subscriber-import-fingerprint-key "$(openssl rand -base64 32)" "Dedicated POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEY (version v1); never reuse another pepper or key"
create_secret postwave/prod/sending-kek            "$(openssl rand -base64 32)" "POSTWAVE_SENDING_KEK"
create_secret postwave/prod/migration-session-kek  "$(openssl rand -base64 32)" "POSTWAVE_MIGRATION_SESSION_KEK"
create_secret postwave/prod/internal-api-token     "$(openssl rand -hex 32)"    "POSTWAVE_INTERNAL_API_TOKEN"
create_secret postwave/prod/metrics-token          "$(openssl rand -hex 48)"    "Dedicated METRICS_TOKEN"
create_secret postwave/prod/cookie-signing         "$(openssl rand -base64 32)" "Reserved"
create_secret postwave/prod/redis-url               "$REDIS_URL"                 "REDIS_URL"
create_secret postwave/prod/portal-jwt              "$(openssl rand -base64 48)" "POSTWAVE_PORTAL_JWT_SECRET"
create_secret postwave/prod/listmonk-webhook       "$(openssl rand -hex 32)"    "LISTMONK_WEBHOOK_SECRET"
create_secret postwave/prod/arf-hmac               "$(openssl rand -hex 32)"    "POSTWAVE_ARF_HMAC_SECRET"
create_secret postwave/prod/listmonk-admin-password "$LISTMONK_ADMIN_PASSWORD"   "LISTMONK_ADMIN_PASSWORD"
# Provider-issued values loaded into the secure operator environment:
create_secret postwave/prod/oauth/google           "$GOOGLE_CLIENT_SECRET"      "POSTWAVE_OAUTH_GOOGLE_CLIENT_SECRET"
create_secret postwave/prod/postmark-hmac          "$POSTMARK_HMAC"             "POSTWAVE_POSTMARK_HMAC_SECRET"
create_secret postwave/prod/sendgrid-hmac          "$SENDGRID_HMAC"             "POSTWAVE_SENDGRID_HMAC_SECRET"
create_secret postwave/prod/dodo-payments-api-key  "$DODO_PAYMENTS_API_KEY"      "DODO_PAYMENTS_API_KEY"
create_secret postwave/prod/dodo-payments-webhook-key "$DODO_PAYMENTS_WEBHOOK_KEY" "DODO_PAYMENTS_WEBHOOK_KEY"
create_secret moosewave/prod/dodo-payments-product-launch-monthly "$DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY" "DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY"
create_secret moosewave/prod/dodo-payments-product-growth-monthly "$DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY" "DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY"
create_secret moosewave/prod/dodo-payments-product-scale-monthly "$DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY" "DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY"
create_secret postwave/prod/migration-stripe-secret-key "$MIGRATION_STRIPE_SECRET_KEY" "Migration-only restricted STRIPE_SECRET_KEY"
create_secret postwave/prod/migration-mailchimp-client-id "$MAILCHIMP_CLIENT_ID" "MAILCHIMP_CLIENT_ID"
create_secret postwave/prod/migration-mailchimp-client-secret "$MAILCHIMP_CLIENT_SECRET" "MAILCHIMP_CLIENT_SECRET"
create_secret postwave/prod/migration-convertkit-client-id "$CONVERTKIT_CLIENT_ID" "CONVERTKIT_CLIENT_ID"
create_secret postwave/prod/migration-convertkit-client-secret "$CONVERTKIT_CLIENT_SECRET" "CONVERTKIT_CLIENT_SECRET"
create_secret postwave/prod/anthropic-api-key      "$ANTHROPIC_API_KEY"          "ANTHROPIC_API_KEY"
create_secret postwave/prod/gemini-api-key         "$GEMINI_API_KEY"             "GEMINI_API_KEY"
create_secret postwave/prod/campaign-assurance-gemini-api-key "$ASSURANCE_GEMINI_API_KEY" "Dedicated POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY; provider-gateway container only"
create_secret postwave/prod/openai-api-key         "$OPENAI_API_KEY"             "OPENAI_API_KEY"
create_secret postwave/prod/hcti-user-id           "$HCTI_USER_ID"               "HCTI_USER_ID"
create_secret postwave/prod/hcti-api-key           "$HCTI_API_KEY"               "HCTI_API_KEY"
create_secret postwave/prod/seedlist-registry-json "$SEEDLIST_REGISTRY_JSON"      "POSTWAVE_SEEDLIST_IMAP_JSON"
create_secret postwave/prod/seedlist-vendor-api-key "$SEEDLIST_VENDOR_API_KEY"    "SEEDLIST_VENDOR_API_KEY"
create_secret postwave/prod/ops-slack-webhook-url  "$OPS_SLACK_WEBHOOK_URL"      "OPS_SLACK_WEBHOOK_URL"
create_secret postwave/prod/db-dsn                 'pending-rds-bootstrap'        "DATABASE_URL"
create_secret postwave/prod/migration-db-dsn       'pending-rds-bootstrap'        "One-shot migrator DATABASE_URL"
create_secret postwave/prod/ops-db-dsn             'pending-rds-bootstrap'        "OPS_DATABASE_URL (postwave_ops role; filled in step 6)"
```

Capture full ARNs (Secrets Manager appends `-XXXXXX`):

```bash
for s in db-dsn migration-db-dsn ops-db-dsn auth-hmac-pepper auth-kek api-key-pepper \
         consent-cursor-signing-key sms-inbox-cursor-key helpdesk-cursor-key \
         pii-fingerprint-pepper subscriber-import-fingerprint-key sending-kek \
         migration-session-kek internal-api-token metrics-token cookie-signing redis-url portal-jwt \
         listmonk-webhook arf-hmac oauth/google ops-slack-webhook-url \
         postmark-hmac sendgrid-hmac dodo-payments-api-key dodo-payments-webhook-key \
         dodo-payments-product-launch-monthly dodo-payments-product-growth-monthly dodo-payments-product-scale-monthly \
         migration-stripe-secret-key \
         migration-mailchimp-client-id migration-mailchimp-client-secret \
         migration-convertkit-client-id migration-convertkit-client-secret \
         anthropic-api-key \
         gemini-api-key campaign-assurance-gemini-api-key openai-api-key hcti-user-id hcti-api-key \
         seedlist-registry-json seedlist-vendor-api-key listmonk-admin-password; do
  secret_prefix=postwave/prod
  case "$s" in dodo-payments-product-*) secret_prefix=moosewave/prod ;; esac
  arn="$(aws secretsmanager describe-secret --secret-id "$secret_prefix/$s" \
    --query ARN --output text)"
  printf '%s\t%s\n' "$secret_prefix/$s" "$arn"
done > /tmp/postwave-deploy/secret-arns.tsv

secret_arn() {
  aws secretsmanager describe-secret --secret-id "$1" --query ARN --output text
}
export DB_DSN_SECRET_ARN="$(secret_arn postwave/prod/db-dsn)"
export MIGRATION_DSN_SECRET_ARN="$(secret_arn postwave/prod/migration-db-dsn)"
export OPS_DB_DSN_SECRET_ARN="$(secret_arn postwave/prod/ops-db-dsn)"
export OPS_SLACK_WEBHOOK_URL_SECRET_ARN="$(secret_arn postwave/prod/ops-slack-webhook-url)"
export SMS_INBOX_CURSOR_KEY_SECRET_ARN="$(secret_arn postwave/prod/sms-inbox-cursor-key)"
export HELPDESK_CURSOR_KEY_SECRET_ARN="$(secret_arn postwave/prod/helpdesk-cursor-key)"
export AUTH_HMAC_SECRET_ARN="$(secret_arn postwave/prod/auth-hmac-pepper)"
export AUTH_KEK_SECRET_ARN="$(secret_arn postwave/prod/auth-kek)"
export CONSENT_CURSOR_SIGNING_KEY_SECRET_ARN="$(secret_arn postwave/prod/consent-cursor-signing-key)"
export REDIS_URL_SECRET_ARN="$(secret_arn postwave/prod/redis-url)"
export INTERNAL_API_TOKEN_SECRET_ARN="$(secret_arn postwave/prod/internal-api-token)"
export METRICS_TOKEN_SECRET_ARN="$(secret_arn postwave/prod/metrics-token)"
export GEMINI_API_KEY_SECRET_ARN="$(secret_arn postwave/prod/gemini-api-key)"
export ASSURANCE_GEMINI_API_KEY_SECRET_ARN="$(secret_arn postwave/prod/campaign-assurance-gemini-api-key)"
export OPENAI_API_KEY_SECRET_ARN="$(secret_arn postwave/prod/openai-api-key)"
export HCTI_USER_ID_SECRET_ARN="$(secret_arn postwave/prod/hcti-user-id)"
export HCTI_API_KEY_SECRET_ARN="$(secret_arn postwave/prod/hcti-api-key)"
export SEEDLIST_REGISTRY_SECRET_ARN="$(secret_arn postwave/prod/seedlist-registry-json)"
export SEEDLIST_VENDOR_API_KEY_SECRET_ARN="$(secret_arn postwave/prod/seedlist-vendor-api-key)"
export LISTMONK_ADMIN_PASSWORD_SECRET_ARN="$(secret_arn postwave/prod/listmonk-admin-password)"
export MIGRATION_SESSION_KEK_SECRET_ARN="$(secret_arn postwave/prod/migration-session-kek)"
export MIGRATION_STRIPE_SECRET_KEY_ARN="$(secret_arn postwave/prod/migration-stripe-secret-key)"
export MAILCHIMP_CLIENT_ID_SECRET_ARN="$(secret_arn postwave/prod/migration-mailchimp-client-id)"
export MAILCHIMP_CLIENT_SECRET_ARN="$(secret_arn postwave/prod/migration-mailchimp-client-secret)"
export CONVERTKIT_CLIENT_ID_SECRET_ARN="$(secret_arn postwave/prod/migration-convertkit-client-id)"
export CONVERTKIT_CLIENT_SECRET_ARN="$(secret_arn postwave/prod/migration-convertkit-client-secret)"
```

Do not edit ARN suffixes manually. Steps 6 and 7 resolve every task secret by
name and fail if any placeholder remains. The migrator receives only
`migration-db-dsn`; API and sidecar definitions never receive that privileged
DSN. The API task additionally requires `ops-db-dsn` (`OPS_DATABASE_URL`, the
independently revocable `postwave_ops` credential filled in step 6) and
`ops-slack-webhook-url`; the Campaign Assurance provider gateway requires
`campaign-assurance-gemini-api-key`, which must never be injected into the API
task. The migration OAuth credentials and migration session KEK are injected
only into the migration task. The API receives only the Dodo Payments live
key, webhook key, and three approved product IDs for Moosewave billing. Stripe
is absent from the API task; `migration-stripe-secret-key` is a separate
read-only connected-account key injected only into the migration task.

This restriction matches `packages/migrate/stripeconnect`: it lists connected
account subscriptions and expands `data.customer` to read the customer ID and
email. Any future Stripe endpoint or write operation requires a separate
security review before broadening the restricted key.

The safe Dodo Payments product summaries printed above require explicit
product-owner sign-off for product identity, amount, currency, recurring
interval, and tax behavior. The repository can enforce live mode, distinct IDs,
and one-time versus recurring type, but it cannot infer the intended commercial
terms. Missing written approval of those fields is an external go-live blocker.

The API task reads `listmonk-admin-password` as `LISTMONK_PASSWORD`, with
`LISTMONK_USER` set to `${LISTMONK_ADMIN_USER}` in step 7, so it signs in to
Listmonk as the same rotated API user as the sidecars. It reads
`subscriber-import-fingerprint-key` as
`POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEY` (key version `v1`); without it,
every CSV import preview returns 503. Every secret that a task references must
also be granted in `iam-policy-ecs-task-execution-role.json`. A missing grant
stops the task at start with `ResourceInitializationError`.

### Step 4 -- IAM roles

```bash
secrets_kms_uuid="${SECRETS_KMS_KEY_ARN##*/}"
s3_kms_uuid="${S3_KMS_KEY_ARN##*/}"
app_data_kms_uuid="${APP_DATA_KMS_KEY_ARN##*/}"
assurance_evidence_kms_uuid="${ASSURANCE_EVIDENCE_KMS_KEY_ARN##*/}"
for policy in iam-policy-ecs-task-role.json iam-policy-ecs-task-execution-role.json \
              iam-policy-campaign-assurance-task-role.json; do
  sed -e "s|<account>|${ACCOUNT_ID}|g" \
      -e "s|us-west-2|${AWS_REGION}|g" \
      -e "s|moosewave.com|${DOMAIN}|g" \
      -e "s|arn:aws:s3:::postwave-uploads|arn:aws:s3:::${UPLOADS_BUCKET}|g" \
      -e "s|arn:aws:s3:::postwave-exports|arn:aws:s3:::${EXPORTS_BUCKET}|g" \
      -e "s|<secrets-manager-cmk-uuid>|${secrets_kms_uuid}|g" \
      -e "s|<s3-uploads-cmk-uuid>|${s3_kms_uuid}|g" \
      -e "s|<app-data-cmk-uuid>|${app_data_kms_uuid}|g" \
      -e "s|<campaign-assurance-evidence-cmk-uuid>|${assurance_evidence_kms_uuid}|g" \
      -e "s|<uploads-bucket-name>|${UPLOADS_BUCKET}|g" \
      -e "s|<campaign-assurance-image-evidence-bucket-name>|${ASSURANCE_IMAGE_EVIDENCE_BUCKET}|g" \
      "infra/aws/${policy}" \
    | jq 'walk(if type == "object" then with_entries(select(.key | startswith("_") | not)) else . end)' \
    > "/tmp/postwave-deploy/${policy}"
  if rg -n '<[^>]+>' \
      "/tmp/postwave-deploy/${policy}"; then
    echo "Unresolved IAM policy placeholder: ${policy}" >&2
    exit 1
  fi
done

TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam get-role --role-name postwave-ecs-task-role >/dev/null 2>&1 || \
  aws iam create-role --role-name postwave-ecs-task-role \
    --assume-role-policy-document "$TRUST" >/dev/null
aws iam put-role-policy --role-name postwave-ecs-task-role \
  --policy-name postwave-task-permissions \
  --policy-document file:///tmp/postwave-deploy/iam-policy-ecs-task-role.json

aws iam get-role --role-name postwave-ecs-task-execution-role >/dev/null 2>&1 || \
  aws iam create-role --role-name postwave-ecs-task-execution-role \
    --assume-role-policy-document "$TRUST" >/dev/null
aws iam put-role-policy --role-name postwave-ecs-task-execution-role \
  --policy-name postwave-execution-permissions \
  --policy-document file:///tmp/postwave-deploy/iam-policy-ecs-task-execution-role.json

aws iam get-role --role-name postwave-campaign-assurance-task-role >/dev/null 2>&1 || \
  aws iam create-role --role-name postwave-campaign-assurance-task-role \
    --assume-role-policy-document "$TRUST" >/dev/null
aws iam put-role-policy --role-name postwave-campaign-assurance-task-role \
  --policy-name postwave-campaign-assurance-permissions \
  --policy-document file:///tmp/postwave-deploy/iam-policy-campaign-assurance-task-role.json

export TASK_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/postwave-ecs-task-role"
export TASK_EXECUTION_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/postwave-ecs-task-execution-role"
export ASSURANCE_TASK_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/postwave-campaign-assurance-task-role"
```

### Step 5 -- CloudFormation stack (RDS + ECS + ALB scaffolding)

The first deployment creates the durable platform foundation and omits the API
service entirely. There is no partial bootstrap task definition: the service
is created only after the database migrator succeeds and the fully rendered,
digest-pinned canonical task definition has been registered.

```bash
IFS=',' read -r -a public_subnet_ids <<< "$PUBLIC_SUBNETS"
TRUSTED_PROXY_CIDRS="$(aws ec2 describe-subnets \
  --subnet-ids "${public_subnet_ids[@]}" \
  --query 'Subnets[].CidrBlock' --output text | tr '\t' ',')"
test -n "$TRUSTED_PROXY_CIDRS"
export TRUSTED_PROXY_CIDRS

POSTGRES_ENGINE_VERSION="$(aws rds describe-db-engine-versions --engine postgres \
  --query 'DBEngineVersions[].EngineVersion' --output text \
  | tr '\t' '\n' | grep -E '^16\.[0-9]+$' | sort -V | tail -1)"
test -n "$POSTGRES_ENGINE_VERSION"
export POSTGRES_ENGINE_VERSION

aws cloudformation deploy \
  --template-file infra/aws/cloudformation/postwave-stack.yaml \
  --stack-name postwave-prod \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    DeployApplicationServices=false \
    DomainName=${DOMAIN} VpcId=${VPC_ID} \
    PublicSubnetIds=${PUBLIC_SUBNETS} PrivateSubnetIds=${PRIVATE_SUBNETS} \
    CertificateArn=${ACM_CERT_ARN} \
    SecretsManagerKmsKeyArn=${SECRETS_KMS_KEY_ARN} \
    RdsKmsKeyArn=${RDS_KMS_KEY_ARN} \
    S3KmsKeyArn=${S3_KMS_KEY_ARN} \
    UploadsBucketName=${UPLOADS_BUCKET} ExportsBucketName=${EXPORTS_BUCKET} \
    AlbAccessLogsBucketName=${ALB_LOGS_BUCKET} \
    TaskRoleArn=${TASK_ROLE_ARN} \
    PostgresEngineVersion=${POSTGRES_ENGINE_VERSION} \
  --no-fail-on-empty-changeset
```

First deploy provisions RDS Multi-AZ -- 15-25 min. Capture outputs:

```bash
aws cloudformation describe-stacks --stack-name postwave-prod \
  --query 'Stacks[0].Outputs'

stack_output() {
  aws cloudformation describe-stacks --stack-name postwave-prod \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
export ECS_CLUSTER_NAME="$(stack_output EcsClusterName)"
export ECS_API_SG="$(stack_output EcsTaskSecurityGroupId)"
export RDS_SG="$(stack_output RdsSecurityGroupId)"
export SERVICE_DISCOVERY_NAMESPACE_ID="$(stack_output ServiceDiscoveryNamespaceId)"

aws cloudformation deploy \
  --template-file infra/aws/cloudformation/postwave-sidecars.yaml \
  --stack-name postwave-sidecars-prod \
  --parameter-overrides \
    VoiceImageDigest=${VOICE_IMAGE_DIGEST} \
    AutomationImageDigest=${AUTOMATION_IMAGE_DIGEST} \
    DeliverabilityImageDigest=${DELIVERABILITY_IMAGE_DIGEST} \
    MigrationImageDigest=${MIGRATION_IMAGE_DIGEST} \
    DeploySidecarServices=false \
    VpcId=${VPC_ID} PrivateSubnetIds=${PRIVATE_SUBNETS} \
    EcsClusterName=${ECS_CLUSTER_NAME} EcsApiSecurityGroupId=${ECS_API_SG} \
    RdsSecurityGroupId=${RDS_SG} \
    ServiceDiscoveryNamespaceId=${SERVICE_DISCOVERY_NAMESPACE_ID} \
    TaskRoleArn=${TASK_ROLE_ARN} TaskExecutionRoleArn=${TASK_EXECUTION_ROLE_ARN} \
    DbDsnSecretArn=${DB_DSN_SECRET_ARN} \
    RedisUrlSecretArn=${REDIS_URL_SECRET_ARN} \
    InternalApiTokenSecretArn=${INTERNAL_API_TOKEN_SECRET_ARN} \
    MetricsTokenSecretArn=${METRICS_TOKEN_SECRET_ARN} \
    GeminiApiKeySecretArn=${GEMINI_API_KEY_SECRET_ARN} \
    OpenAiApiKeySecretArn=${OPENAI_API_KEY_SECRET_ARN} \
    HctiUserIdSecretArn=${HCTI_USER_ID_SECRET_ARN} \
    HctiApiKeySecretArn=${HCTI_API_KEY_SECRET_ARN} \
    SeedlistRegistrySecretArn=${SEEDLIST_REGISTRY_SECRET_ARN} \
    SeedlistVendorApiKeySecretArn=${SEEDLIST_VENDOR_API_KEY_SECRET_ARN} \
    ListmonkAdminPasswordSecretArn=${LISTMONK_ADMIN_PASSWORD_SECRET_ARN} \
    MigrationSessionKekSecretArn=${MIGRATION_SESSION_KEK_SECRET_ARN} \
    MigrationStripeSecretKeyArn=${MIGRATION_STRIPE_SECRET_KEY_ARN} \
    MailchimpClientIdSecretArn=${MAILCHIMP_CLIENT_ID_SECRET_ARN} \
    MailchimpClientSecretArn=${MAILCHIMP_CLIENT_SECRET_ARN} \
    ConvertKitClientIdSecretArn=${CONVERTKIT_CLIENT_ID_SECRET_ARN} \
    ConvertKitClientSecretArn=${CONVERTKIT_CLIENT_SECRET_ARN} \
    MigrationOAuthRedirectUri="https://app.${DOMAIN}/app/migrations/oauth/callback?source={source}" \
    ActiveCampaignAllowedAPIHosts="${ACTIVECAMPAIGN_ALLOWED_API_HOSTS:-}" \
    ListmonkInternalUrl=${LISTMONK_INTERNAL_URL} \
    ListmonkAdminUser=${LISTMONK_ADMIN_USER} \
    ListmonkTenantMode=shared \
    SeedlistVendorApiUrl=${SEEDLIST_VENDOR_API_URL} \
  --no-fail-on-empty-changeset

test "$(aws ecs describe-services --cluster "$ECS_CLUSTER_NAME" \
  --services postwave-api --query 'services[0].desiredCount' --output text)" = 0
for service in postwave-voice postwave-automation postwave-deliverability postwave-migration; do
  test "$(aws ecs describe-services --cluster "$ECS_CLUSTER_NAME" \
    --services "$service" --query 'services[0].desiredCount' --output text)" = 0
done
```

`ListmonkTenantMode=shared` is deliberately fail-closed for subscriber-writing
Mailchimp commits. For a controlled certification tenant, provision a separate
Listmonk instance/database, point `ListmonkInternalUrl` at that instance, set
`ListmonkTenantMode=dedicated`, and pass `ListmonkDedicatedTenantId=<exact
Moosewave tenant UUID>`. The static shared sidecar topology is not a self-serve
per-tenant Listmonk router and must not be labeled as one.

### Step 6 -- DB init

```bash
RDS_ENDPOINT=$(aws cloudformation describe-stacks --stack-name postwave-prod \
  --query "Stacks[0].Outputs[?OutputKey=='RdsEndpoint'].OutputValue" --output text)

MASTER_SECRET_ARN=$(aws rds describe-db-instances \
  --db-instance-identifier postwave-prod \
  --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
MASTER_SECRET=$(aws secretsmanager get-secret-value --secret-id "$MASTER_SECRET_ARN" \
  --query SecretString --output text)
PG_USER=$(printf '%s' "$MASTER_SECRET" | jq -r .username)
PG_PASS=$(printf '%s' "$MASTER_SECRET" | jq -r .password)
unset MASTER_SECRET

# Run from a host with private-subnet reach (bastion or an approved SSM host).
# The checked-in infra/postgres/init.sql is local-development-only and must
# never be run against RDS because it contains fixed development passwords.
if ! PGPASSWORD="$PG_PASS" psql -h "$RDS_ENDPOINT" -U "$PG_USER" -d postwave \
    -tAc "SELECT 1 FROM pg_roles WHERE rolname='postwave_app'" | grep -qx 1; then
  PGPASSWORD="$PG_PASS" psql -h "$RDS_ENDPOINT" -U "$PG_USER" -d postwave \
    -v ON_ERROR_STOP=1 -c "CREATE ROLE postwave_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;"
fi

APP_PASS=$(openssl rand -hex 32)
PGPASSWORD="$PG_PASS" psql -h "$RDS_ENDPOINT" -U "$PG_USER" -d postwave \
  -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE postwave_app WITH PASSWORD '${APP_PASS}'; GRANT CONNECT ON DATABASE postwave TO postwave_app;"

put_secret_value() {
  local secret_id="$1" value="$2" secret_file
  secret_file="$(mktemp /tmp/postwave-deploy/secret.XXXXXX)"
  chmod 0600 "$secret_file"
  printf '%s' "$value" > "$secret_file"
  if ! aws secretsmanager put-secret-value --secret-id "$secret_id" \
      --secret-string "file://${secret_file}" >/dev/null; then
    rm -f "$secret_file"
    return 1
  fi
  rm -f "$secret_file"
}

APP_DSN="postgres://postwave_app:${APP_PASS}@${RDS_ENDPOINT}:5432/postwave?sslmode=require"
put_secret_value postwave/prod/db-dsn "$APP_DSN"

# The migrator needs the schema owner/master credential; the API must never
# receive it. URL-encode the RDS-generated password before assembling the DSN.
PG_PASS_URLENCODED=$(printf '%s' "$PG_PASS" | python3 -c \
  'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=""))')
MIGRATION_DSN="postgres://${PG_USER}:${PG_PASS_URLENCODED}@${RDS_ENDPOINT}:5432/postwave?sslmode=require"
put_secret_value postwave/prod/migration-db-dsn "$MIGRATION_DSN"

existing_migration_table="$(PGPASSWORD="$PG_PASS" psql -h "$RDS_ENDPOINT" \
  -U "$PG_USER" -d postwave -tAc "SELECT COALESCE(to_regclass('public.schema_migrations')::text, '')")"
if [ -n "$existing_migration_table" ]; then
  echo "schema_migrations already exists; stop and use the routine-release migration path without the bootstrap unsafe override" >&2
  exit 1
fi
unset APP_PASS APP_DSN PG_PASS PG_PASS_URLENCODED MIGRATION_DSN
```

Register and run the exact signed migrator digest captured in step 1. The
privileged DSN is injected only from Secrets Manager; it is never passed in a
CLI environment override or logged:

```bash
MIGRATOR_IMAGE="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/postwave-db-migrator@${DB_MIGRATOR_IMAGE_DIGEST}"

jq --arg arn "$MIGRATION_DSN_SECRET_ARN" \
   --arg image "$MIGRATOR_IMAGE" \
   --arg executionRole "$TASK_EXECUTION_ROLE_ARN" \
   --arg region "$AWS_REGION" '
    walk(if type == "object" then with_entries(select(.key | startswith("_") | not)) else . end)
    | .executionRoleArn = $executionRole
    | (.containerDefinitions[] | select(.name == "postwave-db-migrator").image) = $image
    | (.containerDefinitions[] | select(.name == "postwave-db-migrator")
        | .secrets[] | select(.name == "DATABASE_URL").valueFrom) = $arn
    | (.containerDefinitions[].logConfiguration.options["awslogs-region"]) = $region
  ' \
  infra/aws/ecs-migrator-task-definition.json \
  >/tmp/postwave-deploy/ecs-migrator-task-definition.resolved.json

if rg -n '<[^>]+>|XXXXXX|:[A-Za-z0-9._-]+$' \
    /tmp/postwave-deploy/ecs-migrator-task-definition.resolved.json; then
  echo "Unresolved migrator task placeholder or mutable image tag" >&2
  exit 1
fi
jq -e --arg image "$MIGRATOR_IMAGE" '
  .containerDefinitions == [(.containerDefinitions[0])] and
  .containerDefinitions[0].image == $image and
  .containerDefinitions[0].readonlyRootFilesystem == true and
  (.containerDefinitions[0].secrets | map(.name)) == ["DATABASE_URL"]
' /tmp/postwave-deploy/ecs-migrator-task-definition.resolved.json >/dev/null

MIGRATOR_TASK_DEFINITION_ARN="$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/postwave-deploy/ecs-migrator-task-definition.resolved.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)"
test -n "$MIGRATOR_TASK_DEFINITION_ARN"

run_migrator() {
  local overrides="${1:-}" task_arn exit_code
  local run_args=(
    --cluster "$ECS_CLUSTER_NAME"
    --launch-type FARGATE
    --task-definition "$MIGRATOR_TASK_DEFINITION_ARN"
    --network-configuration \
      "awsvpcConfiguration={subnets=[${PRIVATE_SUBNETS}],securityGroups=[${ECS_API_SG}],assignPublicIp=DISABLED}"
  )
  if [ -n "$overrides" ]; then
    run_args+=(--overrides "$overrides")
  fi
  task_arn="$(aws ecs run-task "${run_args[@]}" \
    --query 'tasks[0].taskArn' --output text)"
  test -n "$task_arn" && test "$task_arn" != "None"
  aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER_NAME" --tasks "$task_arn"
  exit_code="$(aws ecs describe-tasks --cluster "$ECS_CLUSTER_NAME" --tasks "$task_arn" \
    --query 'tasks[0].containers[?name==`postwave-db-migrator`].exitCode | [0]' \
    --output text)"
  if [ "$exit_code" != "0" ]; then
    aws ecs describe-tasks --cluster "$ECS_CLUSTER_NAME" --tasks "$task_arn" \
      --query 'tasks[0].{stopCode:stopCode,stoppedReason:stoppedReason,containers:containers[*].reason}'
    aws logs tail /ecs/postwave-db-migrator --since 30m
    return 1
  fi
}

# This section is the first empty-schema bootstrap. It must replay historical
# migration 0339's reviewed partition cutover, so this first run alone carries
# the explicit safety override. Never copy this override into a routine release.
run_migrator \
  '{"containerOverrides":[{"name":"postwave-db-migrator","environment":[{"name":"POSTWAVE_MIGRATOR_ALLOW_UNSAFE","value":"1"}]}]}'

# A second run without the unsafe override must be a clean idempotent no-op and
# re-verify both the baked migration manifest and the read-only consent-evidence
# legacy-data preflight against the resulting database.
run_migrator
aws logs tail /ecs/postwave-db-migrator --since 30m
```

Migration 1700 creates the `postwave_ops` role `NOLOGIN` with no base-table
access. Grant it login out of band and fill the `ops-db-dsn` secret the API
task resolves as `OPS_DATABASE_URL` (the API refuses to start in production
without it). Run from the same private-network host as the DB init above:

```bash
MASTER_SECRET=$(aws secretsmanager get-secret-value --secret-id "$MASTER_SECRET_ARN" \
  --query SecretString --output text)
PG_USER=$(printf '%s' "$MASTER_SECRET" | jq -r .username)
PG_PASS=$(printf '%s' "$MASTER_SECRET" | jq -r .password)
unset MASTER_SECRET
PGPASSWORD="$PG_PASS" psql -h "$RDS_ENDPOINT" -U "$PG_USER" -d postwave \
  -tAc "SELECT 1 FROM pg_roles WHERE rolname='postwave_ops'" | grep -qx 1
OPS_PASS=$(openssl rand -base64 32)
PGPASSWORD="$PG_PASS" psql -h "$RDS_ENDPOINT" -U "$PG_USER" -d postwave \
  -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE postwave_ops LOGIN PASSWORD '${OPS_PASS}';"
OPS_PASS_URLENCODED=$(printf '%s' "$OPS_PASS" | python3 -c \
  'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=""))')
put_secret_value postwave/prod/ops-db-dsn \
  "postgres://postwave_ops:${OPS_PASS_URLENCODED}@${RDS_ENDPOINT}:5432/postwave?sslmode=require"
unset OPS_PASS OPS_PASS_URLENCODED PG_PASS
```

Exit zero proves the database contains exactly the image's baked migration
count and latest version and that every `schema_migrations.checksum` matches.
It also proves that every existing row in `consent_events`,
`consent_receipts`, and `consent_records` satisfies the bounded v1 evidence
read contract. Migration 1979 intentionally installs those CHECK constraints
as `NOT VALID` to avoid a blocking table scan; the migrator's bounded,
read-only verifier performs the release gate instead and reports only counts
plus at most 20 non-PII row IDs per source plane. A timeout or any invalid row
blocks step 7. Remediate the identified legacy rows under an approved data
change, rerun the verifier, and validate each constraint only in a separately
reviewed maintenance window. Any missing, extra, legacy-empty or altered
checksum also fails before step 7.

### Step 7 -- Task definition + service roll

Render the canonical API task structurally. Secret names are derived from the
checked-in placeholders and resolved to their full `-XXXXXX` ARNs; no manual
suffix editing is permitted.

```bash
for variable in GOOGLE_CLIENT_ID OPS_ALERT_EMAIL ASSETS_PUBLIC_BASE_URL \
  LISTMONK_INTERNAL_URL LISTMONK_ADMIN_USER \
  ASSETS_CLOUDFRONT_DISTRIBUTION_ID ASSURANCE_GEMINI_MODEL_ID \
  ASSURANCE_GEMINI_MODEL_VERSION ASSURANCE_GEMINI_PRICING_VERSION \
  ASSURANCE_GEMINI_INPUT_MICROUSD_PER_MILLION_TOKENS \
  ASSURANCE_GEMINI_OUTPUT_MICROUSD_PER_MILLION_TOKENS \
  ASSURANCE_IMAGE_ALLOWED_HOSTS ASSURANCE_OCR_VERSION ASSURANCE_SCANNER_VERSION; do
  if [ -z "${!variable:-}" ]; then
    echo "Required non-secret deployment input ${variable} is empty" >&2
    exit 1
  fi
done
for variable in ASSURANCE_GEMINI_INPUT_MICROUSD_PER_MILLION_TOKENS \
                ASSURANCE_GEMINI_OUTPUT_MICROUSD_PER_MILLION_TOKENS; do
  if ! printf '%s' "${!variable}" | grep -Eq '^[1-9][0-9]*$'; then
    echo "${variable} must be a positive canonical integer" >&2
    exit 1
  fi
done

secret_arn() {
  aws secretsmanager describe-secret --secret-id "$1" --query ARN --output text
}

secret_arn_map='{}'
while IFS=$'\t' read -r env_name placeholder; do
  secret_id="${placeholder#*:secret:}"
  secret_id="${secret_id%-XXXXXX}"
  if [ "$secret_id" = "$placeholder" ] || [ -z "$secret_id" ]; then
    echo "Cannot derive secret name for ${env_name}: ${placeholder}" >&2
    exit 1
  fi
  resolved_arn="$(secret_arn "$secret_id")"
  secret_arn_map="$(jq -cn --argjson current "$secret_arn_map" \
    --arg name "$env_name" --arg arn "$resolved_arn" '$current + {($name):$arn}')"
done < <(jq -r '.containerDefinitions[].secrets[] | [.name,.valueFrom] | @tsv' \
  infra/aws/ecs-task-definition.json)

API_IMAGE="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/postwave-api@${API_IMAGE_DIGEST}"
jq --arg image "$API_IMAGE" \
   --arg account "$ACCOUNT_ID" \
   --arg region "$AWS_REGION" \
   --arg domain "$DOMAIN" \
   --arg executionRole "$TASK_EXECUTION_ROLE_ARN" \
   --arg taskRole "$TASK_ROLE_ARN" \
   --arg uploadsBucket "$UPLOADS_BUCKET" \
   --arg exportsBucket "$EXPORTS_BUCKET" \
   --arg assetsPublicBase "$ASSETS_PUBLIC_BASE_URL" \
   --arg s3Kms "$S3_KMS_KEY_ARN" \
   --arg appDataKms "$APP_DATA_KMS_KEY_ARN" \
   --arg trustedProxies "$TRUSTED_PROXY_CIDRS" \
   --arg googleClientId "$GOOGLE_CLIENT_ID" \
   --arg sesTopics "$SES_TOPIC_ARNS" \
   --arg listmonkUrl "$LISTMONK_INTERNAL_URL" \
   --arg listmonkUser "$LISTMONK_ADMIN_USER" \
   --arg opsAlertEmail "$OPS_ALERT_EMAIL" \
   --arg billingLaunchApproval "$MOOSEWAVE_BILLING_LAUNCH_APPROVAL" \
   --arg assuranceModelId "$ASSURANCE_GEMINI_MODEL_ID" \
   --arg assuranceModelVersion "$ASSURANCE_GEMINI_MODEL_VERSION" \
   --arg assurancePricingVersion "$ASSURANCE_GEMINI_PRICING_VERSION" \
   --arg assuranceInputPrice "$ASSURANCE_GEMINI_INPUT_MICROUSD_PER_MILLION_TOKENS" \
   --arg assuranceOutputPrice "$ASSURANCE_GEMINI_OUTPUT_MICROUSD_PER_MILLION_TOKENS" \
   --argjson secretArns "$secret_arn_map" '
    walk(if type == "object" then with_entries(select(.key | startswith("_") | not)) else . end)
    | walk(if type == "string" then gsub("moosewave.com"; $domain) | gsub("us-west-2"; $region) else . end)
    | .executionRoleArn = $executionRole
    | .taskRoleArn = $taskRole
    | (.containerDefinitions[] | select(.name == "postwave-api").image) = $image
    | (.containerDefinitions[].environment[] | select(.name == "AWS_REGION").value) = $region
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_DEPLOYMENT_REGION").value) = $region
    | (.containerDefinitions[].environment[] | select(.name == "AWS_SES_REGION").value) = $region
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_UPLOADS_BUCKET").value) = $uploadsBucket
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_ASSETS_BUCKET").value) = $uploadsBucket
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_EXPORTS_BUCKET").value) = $exportsBucket
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_ASSETS_PUBLIC_BASE_URL").value) = $assetsPublicBase
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_S3_KMS_KEY_ID").value) = $s3Kms
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_KMS_KEY_ID").value) = $appDataKms
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_TRUSTED_PROXY_CIDRS").value) = $trustedProxies
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_OAUTH_GOOGLE_CLIENT_ID").value) = $googleClientId
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_SES_TOPIC_ARNS").value) = $sesTopics
    | (.containerDefinitions[].environment[] | select(.name == "LISTMONK_URL").value) = $listmonkUrl
    | (.containerDefinitions[].environment[] | select(.name == "LISTMONK_USER").value) = $listmonkUser
    | (.containerDefinitions[].environment[] | select(.name == "STRIPE_DLQ_ALERT_EMAIL").value) = $opsAlertEmail
    | (.containerDefinitions[].environment[] | select(.name == "MOOSEWAVE_BILLING_LAUNCH_APPROVAL").value) = $billingLaunchApproval
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_MODEL_ID").value) = $assuranceModelId
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_MODEL_VERSION").value) = $assuranceModelVersion
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_PRICING_VERSION").value) = $assurancePricingVersion
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_INPUT_MICROUSD_PER_MILLION_TOKENS").value) = $assuranceInputPrice
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_OUTPUT_MICROUSD_PER_MILLION_TOKENS").value) = $assuranceOutputPrice
    | .containerDefinitions[].secrets |= map(
        .valueFrom = ($secretArns[.name] // error("unresolved task secret: " + .name))
      )
  ' infra/aws/ecs-task-definition.json \
  > /tmp/postwave-deploy/ecs-task-definition.resolved.json

# A placeholder is any <token> without an "@". The API task's display-name
# From addresses, such as "Moosewave <noreply@...>", are resolved values.
if rg -n '<[^>@\s]+>|XXXXXX' \
    /tmp/postwave-deploy/ecs-task-definition.resolved.json; then
  echo "Unresolved API task placeholder" >&2
  exit 1
fi
jq -e --arg image "$API_IMAGE" --arg bucket "$UPLOADS_BUCKET" --arg exportsBucket "$EXPORTS_BUCKET" --arg assetsPublicBase "$ASSETS_PUBLIC_BASE_URL" '
  .containerDefinitions | length == 1 and
  .[0].image == $image and
  .[0].readonlyRootFilesystem == true and
  any(.[0].mountPoints[]; .containerPath == "/tmp" and .readOnly == false) and
  ((.[0].secrets | map(.name)) as $secretNames |
    (["DODO_PAYMENTS_API_KEY","DODO_PAYMENTS_WEBHOOK_KEY",
      "DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY","DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY",
      "DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY","LISTMONK_PASSWORD",
      "POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEY"] - $secretNames | length == 0) and
    ($secretNames | index("STRIPE_SECRET_KEY") == null) and
    ($secretNames | index("STRIPE_WEBHOOK_SECRET") == null) and
    ($secretNames | index("POSTWAVE_MIGRATION_SESSION_KEK") == null) and
    ($secretNames | index("MAILCHIMP_CLIENT_ID") == null) and
    ($secretNames | index("CONVERTKIT_CLIENT_ID") == null)) and
  ((.[0].environment | map({key:.name,value:.value}) | from_entries) as $env |
    $env.POSTWAVE_ENV == "production" and
    $env.BILLING_PROVIDER == "dodo" and
    $env.DODO_PAYMENTS_ENVIRONMENT == "live_mode" and
    ($env.MOOSEWAVE_BILLING_LAUNCH_APPROVAL | startswith("approved:")) and
    $env.POSTWAVE_UPLOADS_BUCKET == $bucket and
    $env.POSTWAVE_ASSETS_BUCKET == $bucket and
    $env.POSTWAVE_EXPORTS_BUCKET == $exportsBucket and
    $env.POSTWAVE_EXPORTS_BUCKET != $env.POSTWAVE_ASSETS_BUCKET and
    $env.POSTWAVE_ASSETS_PUBLIC_BASE_URL == $assetsPublicBase and
    ($env.POSTWAVE_ASSETS_PUBLIC_BASE_URL | startswith("https://")) and
    ($env.POSTWAVE_S3_KMS_KEY_ID | startswith("arn:aws:kms:")) and
    ($env.POSTWAVE_KMS_KEY_ID | startswith("arn:aws:kms:")) and
    $env.POSTWAVE_WEB_VITALS_ALLOWED_ORIGINS == $env.CORS_ALLOWED_ORIGINS and
    all(["LISTMONK_USER","POSTWAVE_REPORT_FROM_EMAIL","POSTWAVE_SEND_COMPLETE_FROM"][];
      . as $name | ($env[$name] // "") | length > 0) and
    (($env.POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEY_VERSION // "") |
      test("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")) and
    ($env.POSTWAVE_TRUSTED_PROXY_CIDRS | length > 0)) and
  all(.[0].secrets[]; .valueFrom | startswith("arn:aws:secretsmanager:")) and
  all(.[0].environment[]; (.name | startswith("POSTWAVE_DEV_")) | not)
' /tmp/postwave-deploy/ecs-task-definition.resolved.json >/dev/null

aws ecs register-task-definition \
  --generate-cli-skeleton output \
  --cli-input-json file:///tmp/postwave-deploy/ecs-task-definition.resolved.json >/dev/null

API_TASK_DEFINITION_ARN="$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/postwave-deploy/ecs-task-definition.resolved.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)"
test -n "$API_TASK_DEFINITION_ARN"

# Resolve the Campaign Assurance secrets independently. This prevents the
# provider-only key from being added to the API task or to any other assurance
# container by a hand-edited ARN substitution.
assurance_secret_arn_map='{}'
while IFS=$'\t' read -r env_name placeholder; do
  secret_id="${placeholder#*:secret:}"
  secret_id="${secret_id%-XXXXXX}"
  if [ "$secret_id" = "$placeholder" ] || [ -z "$secret_id" ]; then
    echo "Cannot derive assurance secret name for ${env_name}: ${placeholder}" >&2
    exit 1
  fi
  resolved_arn="$(secret_arn "$secret_id")"
  assurance_secret_arn_map="$(jq -cn --argjson current "$assurance_secret_arn_map" \
    --arg name "$env_name" --arg arn "$resolved_arn" '$current + {($name):$arn}')"
done < <(jq -r '.containerDefinitions[] | (.secrets // [])[] | [.name,.valueFrom] | @tsv' \
  infra/aws/ecs-campaign-assurance-task-definition.json)

ASSURANCE_CORE_IMAGE="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/postwave-campaign-assurance@${CAMPAIGN_ASSURANCE_IMAGE_DIGEST}"
ASSURANCE_IMAGE_SERVICES_IMAGE="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/postwave-campaign-assurance-image-services@${CAMPAIGN_ASSURANCE_IMAGE_SERVICES_IMAGE_DIGEST}"
jq --arg coreImage "$ASSURANCE_CORE_IMAGE" \
   --arg imageServicesImage "$ASSURANCE_IMAGE_SERVICES_IMAGE" \
   --arg account "$ACCOUNT_ID" \
   --arg region "$AWS_REGION" \
   --arg executionRole "$TASK_EXECUTION_ROLE_ARN" \
   --arg taskRole "$ASSURANCE_TASK_ROLE_ARN" \
   --arg uploadsBucket "$UPLOADS_BUCKET" \
   --arg s3Kms "$S3_KMS_KEY_ARN" \
   --arg appDataKms "$APP_DATA_KMS_KEY_ARN" \
   --arg imageEvidenceBucket "$ASSURANCE_IMAGE_EVIDENCE_BUCKET" \
   --arg imageEvidenceKms "$ASSURANCE_EVIDENCE_KMS_KEY_ARN" \
   --arg allowedImageHosts "$ASSURANCE_IMAGE_ALLOWED_HOSTS" \
   --arg ocrVersion "$ASSURANCE_OCR_VERSION" \
   --arg scannerVersion "$ASSURANCE_SCANNER_VERSION" \
   --arg pricingVersion "$ASSURANCE_GEMINI_PRICING_VERSION" \
   --arg inputPrice "$ASSURANCE_GEMINI_INPUT_MICROUSD_PER_MILLION_TOKENS" \
   --arg outputPrice "$ASSURANCE_GEMINI_OUTPUT_MICROUSD_PER_MILLION_TOKENS" \
   --argjson secretArns "$assurance_secret_arn_map" '
    walk(if type == "object" then with_entries(select(.key | startswith("_") | not)) else . end)
    | walk(if type == "string" then gsub("<account>"; $account) | gsub("us-west-2"; $region) else . end)
    | .executionRoleArn = $executionRole
    | .taskRoleArn = $taskRole
    | .containerDefinitions |= map(
        if .name == "assurance-ocr-sandbox" or .name == "assurance-content-scanner"
        then .image = $imageServicesImage
        else .image = $coreImage
        end
      )
    | .containerDefinitions |= map(
        .environment = (.environment // []) | .secrets = (.secrets // [])
      )
    | (.containerDefinitions[].environment[] | select(.name == "AWS_REGION").value) = $region
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_UPLOADS_BUCKET").value) = $uploadsBucket
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_S3_KMS_KEY_ID").value) = $s3Kms
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_KMS_KEY_ID").value) = $appDataKms
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_BUCKET").value) = $imageEvidenceBucket
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_KMS_KEY_ID").value) = $imageEvidenceKms
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_CAMPAIGN_IMAGE_ALLOWED_HOSTS").value) = $allowedImageHosts
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_CAMPAIGN_IMAGE_OCR_VERSION").value) = $ocrVersion
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_CAMPAIGN_IMAGE_SCANNER_VERSION").value) = $scannerVersion
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_PRICING_VERSION").value) = $pricingVersion
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_INPUT_MICROUSD_PER_MILLION_TOKENS").value) = $inputPrice
    | (.containerDefinitions[].environment[] | select(.name == "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_OUTPUT_MICROUSD_PER_MILLION_TOKENS").value) = $outputPrice
    | .containerDefinitions[].secrets |= ((. // []) | map(
        .valueFrom = ($secretArns[.name] // error("unresolved assurance task secret: " + .name))
      ))
  ' infra/aws/ecs-campaign-assurance-task-definition.json \
  > /tmp/postwave-deploy/ecs-campaign-assurance-task-definition.resolved.json

if rg -n '<[^>]+>|XXXXXX' \
    /tmp/postwave-deploy/ecs-campaign-assurance-task-definition.resolved.json; then
  echo "Unresolved Campaign Assurance task placeholder" >&2
  exit 1
fi
jq -e --arg coreImage "$ASSURANCE_CORE_IMAGE" \
  --arg imageServicesImage "$ASSURANCE_IMAGE_SERVICES_IMAGE" \
  --arg taskRole "$ASSURANCE_TASK_ROLE_ARN" \
  --arg uploadsBucket "$UPLOADS_BUCKET" \
  --arg evidenceBucket "$ASSURANCE_IMAGE_EVIDENCE_BUCKET" '
  .taskRoleArn == $taskRole and
  (.containerDefinitions | length == 7) and
  (all(.containerDefinitions[];
    if (.name == "assurance-ocr-sandbox" or .name == "assurance-content-scanner")
    then .image == $imageServicesImage else .image == $coreImage end)) and
  ((.containerDefinitions | map({key:.name,value:.} ) | from_entries) as $containers |
    (($containers["assurance-provider-gateway"].secrets | map(.name)) ==
      ["POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY"]) and
    (($containers["assurance-image-broker"].secrets | map(.name)) == ["DATABASE_URL"]) and
    (($containers["assurance-worker"].secrets | map(.name)) == ["DATABASE_URL"]) and
    all(["assurance-model-sandbox","assurance-ocr-sandbox","assurance-content-scanner"][];
      . as $name | ((($containers[$name].secrets // []) | length) == 0)) and
    (($containers["assurance-worker"].environment | map({key:.name,value:.value}) | from_entries) as $worker |
      $worker.POSTWAVE_ENV == "production" and
      $worker.POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME == "true" and
      $worker.POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_MODELED == "true" and
      $worker.POSTWAVE_UPLOADS_BUCKET == $uploadsBucket and
      ($worker.POSTWAVE_KMS_KEY_ID | startswith("arn:aws:kms:"))) and
    (($containers["assurance-image-broker"].environment | map({key:.name,value:.value}) | from_entries) as $broker |
      $broker.POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_BUCKET == $evidenceBucket and
      ($broker.POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_KMS_KEY_ID | startswith("arn:aws:kms:")))) and
  all(.containerDefinitions[].secrets[]; .valueFrom | startswith("arn:aws:secretsmanager:")) and
  all(.containerDefinitions[]; (.portMappings // [] | length) == 0)
' /tmp/postwave-deploy/ecs-campaign-assurance-task-definition.resolved.json >/dev/null

aws ecs register-task-definition \
  --generate-cli-skeleton output \
  --cli-input-json file:///tmp/postwave-deploy/ecs-campaign-assurance-task-definition.resolved.json >/dev/null

ASSURANCE_TASK_DEFINITION_ARN="$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/postwave-deploy/ecs-campaign-assurance-task-definition.resolved.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)"
test -n "$ASSURANCE_TASK_DEFINITION_ARN"

# Provider resources referenced by the task must exist before desired count
# changes. HTTPS subscriptions may remain PendingConfirmation until DNS cutover.
aws sesv2 get-configuration-set --configuration-set-name postwave-prod >/dev/null
for topic in postwave-prod-ses-bounce postwave-prod-ses-complaint; do
  aws sns get-topic-attributes \
    --topic-arn "arn:aws:sns:${AWS_REGION}:${ACCOUNT_ID}:${topic}" >/dev/null
done

# Run these from the same private-network host used for the DB bootstrap.
test "$(redis-cli -u "$REDIS_URL" --no-auth-warning PING)" = PONG
curl -fsS "${LISTMONK_INTERNAL_URL%/}/api/health" >/dev/null

# Sidecars start first. If any production dependency or baked runtime pack is
# missing, their circuit breakers fail while the public API remains at zero.
aws cloudformation deploy \
  --template-file infra/aws/cloudformation/postwave-sidecars.yaml \
  --stack-name postwave-sidecars-prod \
  --parameter-overrides DeploySidecarServices=true \
  --no-fail-on-empty-changeset

aws ecs wait services-stable --cluster "$ECS_CLUSTER_NAME" --services \
  postwave-voice postwave-automation postwave-deliverability postwave-migration

# The successful migrator and stable sidecars are hard prerequisites for the
# CloudFormation-owned API and assurance services. The API task registered
# above is deliberately `runtime=false`, `modeled=false`, and gate `off`; this
# first update makes the isolated worker healthy without allowing the control
# plane to enqueue assurance work.
aws cloudformation deploy \
  --template-file infra/aws/cloudformation/postwave-stack.yaml \
  --stack-name postwave-prod \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    DeployApplicationServices=true \
    ApiTaskDefinitionArn=${API_TASK_DEFINITION_ARN} \
    DeployCampaignAssuranceService=true \
    CampaignAssuranceTaskDefinitionArn=${ASSURANCE_TASK_DEFINITION_ARN} \
    CampaignAssuranceTaskRoleArn=${ASSURANCE_TASK_ROLE_ARN} \
    CampaignAssuranceImageEvidenceBucketName=${ASSURANCE_IMAGE_EVIDENCE_BUCKET} \
    CampaignAssuranceEvidenceKmsKeyArn=${ASSURANCE_EVIDENCE_KMS_KEY_ARN} \
  --no-fail-on-empty-changeset

aws ecs wait services-stable --cluster "$ECS_CLUSTER_NAME" --services \
  postwave-api postwave-campaign-assurance
test "$(aws ecs describe-services --cluster "$ECS_CLUSTER_NAME" \
  --services postwave-api --query 'services[0].desiredCount' --output text)" = 2
test "$(aws ecs describe-services --cluster "$ECS_CLUSTER_NAME" \
  --services postwave-campaign-assurance \
  --query 'services[0].desiredCount' --output text)" = 2

# Every API rollout is derived from the already resolved safe task. Do not
# re-render from the checked-in template between stages: that could change an
# unrelated secret or image while operators believe only the gate changed.
register_api_assurance_rollout() {
  local rollout_mode="$1"
  local output
  case "$rollout_mode" in
    shadow|warn|block) ;;
    *) echo "rollout mode must be shadow, warn, or block" >&2; return 1 ;;
  esac
  output="/tmp/postwave-deploy/ecs-task-definition.${rollout_mode}.json"
  jq --arg mode "$rollout_mode" '
    (.containerDefinitions[0].environment[] |
      select(.name == "POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME").value) = "true"
    | (.containerDefinitions[0].environment[] |
      select(.name == "POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_MODELED").value) = "true"
    | (.containerDefinitions[0].environment[] |
      select(.name == "POSTWAVE_CAMPAIGN_ASSURANCE_GATE_ROLLOUT").value) = $mode
  ' /tmp/postwave-deploy/ecs-task-definition.resolved.json > "$output"
  jq -e --arg mode "$rollout_mode" '
    (.containerDefinitions | length == 1) and
    ((.containerDefinitions[0].environment | map({key:.name,value:.value}) | from_entries) as $env |
      $env.POSTWAVE_ENV == "production" and
      $env.POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME == "true" and
      $env.POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_MODELED == "true" and
      $env.POSTWAVE_CAMPAIGN_ASSURANCE_GATE_ROLLOUT == $mode and
      ($env.POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_SEND_GATE // "") == "")
  ' "$output" >/dev/null
  aws ecs register-task-definition --generate-cli-skeleton output \
    --cli-input-json "file://${output}" >/dev/null
  aws ecs register-task-definition --cli-input-json "file://${output}" \
    --query 'taskDefinition.taskDefinitionArn' --output text
}

deploy_api_assurance_rollout() {
  local rollout_mode="$1"
  local rollout_task_arn
  local active_task_arn
  rollout_task_arn="$(register_api_assurance_rollout "$rollout_mode")"
  test -n "$rollout_task_arn"
  aws cloudformation deploy \
    --template-file infra/aws/cloudformation/postwave-stack.yaml \
    --stack-name postwave-prod \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      DeployApplicationServices=true \
      ApiTaskDefinitionArn=${rollout_task_arn} \
      DeployCampaignAssuranceService=true \
      CampaignAssuranceTaskDefinitionArn=${ASSURANCE_TASK_DEFINITION_ARN} \
      CampaignAssuranceTaskRoleArn=${ASSURANCE_TASK_ROLE_ARN} \
      CampaignAssuranceImageEvidenceBucketName=${ASSURANCE_IMAGE_EVIDENCE_BUCKET} \
      CampaignAssuranceEvidenceKmsKeyArn=${ASSURANCE_EVIDENCE_KMS_KEY_ARN} \
    --no-fail-on-empty-changeset
  aws ecs wait services-stable --cluster "$ECS_CLUSTER_NAME" --services \
    postwave-api postwave-campaign-assurance
  active_task_arn="$(aws ecs describe-services --cluster "$ECS_CLUSTER_NAME" \
    --services postwave-api --query 'services[0].taskDefinition' --output text)"
  test "$active_task_arn" = "$rollout_task_arn"
  DEPLOYED_API_TASK_DEFINITION_ARN="$rollout_task_arn"
}

# Enter advisory shadow only after both worker replicas and every UDS
# dependency are healthy. This enables control-plane run creation while queue
# and dispatch remain non-blocking.
deploy_api_assurance_rollout shadow
SHADOW_API_TASK_DEFINITION_ARN="$DEPLOYED_API_TASK_DEFINITION_ARN"
test -n "$SHADOW_API_TASK_DEFINITION_ARN"
```

#### Step 7.1 -- measured shadow, warning, and block promotions

A stable ECS service proves process health, not policy safety. Hold `shadow`
until the reviewed evidence below covers the exact task/image digests. Store
the signed review outside the repository and export its directory; the JSON is
an operator attestation over archived dashboards, traces, restricted test
results, and raw capture/load artifacts, not a replacement for those artifacts.

```bash
test -n "${ASSURANCE_ROLLOUT_EVIDENCE_DIR:-}"
test -f "${ASSURANCE_ROLLOUT_EVIDENCE_DIR}/shadow-to-warn.json"
jq -e --arg gitSha "$GIT_SHA" \
      --arg coreDigest "$CAMPAIGN_ASSURANCE_IMAGE_DIGEST" \
      --arg imageServicesDigest "$CAMPAIGN_ASSURANCE_IMAGE_SERVICES_IMAGE_DIGEST" \
      --arg taskArn "$SHADOW_API_TASK_DEFINITION_ARN" '
  .schema_version == "postwave.campaign-assurance-rollout-review.v1" and
  .from == "shadow" and .to == "warn" and .decision == "approve" and
  .git_sha == $gitSha and .api_task_definition_arn == $taskArn and
  .core_image_digest == $coreDigest and
  .image_services_image_digest == $imageServicesDigest and
  .reviewer.user_id != null and .reviewer.reviewed_at != null and
  .window.started_at != null and .window.ended_at != null and
  .measurements.required_revision_coverage_ratio >= .thresholds.minimum_required_revision_coverage_ratio and
  .measurements.dependency_error_ratio <= .thresholds.maximum_dependency_error_ratio and
  .measurements.stale_or_pending_ratio <= .thresholds.maximum_stale_or_pending_ratio and
  .measurements.queue_evaluation_p95_ms <= 5000 and
  .measurements.full_profile_p95_ms <= 90000 and
  .measurements.required_component_false_green_count == 0 and
  .measurements.stale_or_mismatched_queue_decision_count == 0
' "${ASSURANCE_ROLLOUT_EVIDENCE_DIR}/shadow-to-warn.json" >/dev/null

deploy_api_assurance_rollout warn
WARN_API_TASK_DEFINITION_ARN="$DEPLOYED_API_TASK_DEFINITION_ARN"
test -n "$WARN_API_TASK_DEFINITION_ARN"
```

`warn` remains non-binding, but every client must visibly present the same
freshness, blocker, source-class, and incomplete/unavailable truth before this
stage is considered successful. Exercise a synthetic, non-deliverable canary
through web, desktop, mobile, direct API, CLI, MCP, scheduled automation, and
approval continuation; archive the resulting exact-revision receipts and
closed-label telemetry. Do not use a customer campaign as the canary.

Block promotion has a stricter evidence contract. In particular, ordinary CI
cannot set either `credentialed_capture.reviewed` or
`production_load.reviewed`: both require retained raw evidence and a human
review. Predicted scores remain advisory; `block` authorizes only the reviewed
deterministic gate and current finding-scoped waivers.

```bash
test -f "${ASSURANCE_ROLLOUT_EVIDENCE_DIR}/warn-to-block.json"
jq -e --arg gitSha "$GIT_SHA" \
      --arg coreDigest "$CAMPAIGN_ASSURANCE_IMAGE_DIGEST" \
      --arg imageServicesDigest "$CAMPAIGN_ASSURANCE_IMAGE_SERVICES_IMAGE_DIGEST" \
      --arg taskArn "$WARN_API_TASK_DEFINITION_ARN" '
  .schema_version == "postwave.campaign-assurance-rollout-review.v1" and
  .from == "warn" and .to == "block" and .decision == "approve" and
  .git_sha == $gitSha and .api_task_definition_arn == $taskArn and
  .core_image_digest == $coreDigest and
  .image_services_image_digest == $imageServicesDigest and
  .reviewer.user_id != null and .reviewer.reviewed_at != null and
  .migration_and_rls.restricted_suite_passed == true and
  .migration_and_rls.fresh_chain_passed == true and
  .security_review.image_isolation_passed == true and
  .security_review.model_isolation_passed == true and
  .security_review.action_gate_passed == true and
  .credentialed_capture.reviewed == true and
  .credentialed_capture.multipart_preserved == true and
  .credentialed_capture.semantic_hash_preserved == true and
  .credentialed_capture.remote_assets_not_loaded == true and
  .production_load.reviewed == true and
  .production_load.queue_evaluation_p95_ms <= 5000 and
  .production_load.full_profile_p95_ms <= 90000 and
  .production_load.full_profile_terminal_within_5m_ratio >= 0.99 and
  .production_load.stale_or_mismatched_queue_decision_count == 0 and
  .production_load.required_component_false_green_count == 0 and
  .client_canary.web == "pass" and .client_canary.desktop == "pass" and
  .client_canary.mobile == "pass" and .client_canary.api == "pass" and
  .client_canary.cli == "pass" and .client_canary.mcp == "pass" and
  .policy.predicted_score_advisory_only == true and
  .policy.deterministic_blockers_only == true
' "${ASSURANCE_ROLLOUT_EVIDENCE_DIR}/warn-to-block.json" >/dev/null

deploy_api_assurance_rollout block
BLOCK_API_TASK_DEFINITION_ARN="$DEPLOYED_API_TASK_DEFINITION_ARN"
test -n "$BLOCK_API_TASK_DEFINITION_ARN"
```

After every promotion, verify the private operator report, Campaign Assurance
SLO dashboard, and alerts before starting the next observation window. A
failed threshold or missing evidence means remain at the current stage; it is
not an operator-waivable shell check.

For an upgrade from the legacy public-asset export writer, migration 2025 marks
every prior `download_url` row expired but cannot evict already cached CDN
bytes. After the private-export task is healthy, remove only the reviewed legacy
prefix and wait for a matching CloudFront invalidation. Do not widen either
target: normal library assets live beside this prefix.

```bash
test -n "$UPLOADS_BUCKET"
test -n "$ASSETS_CLOUDFRONT_DISTRIBUTION_ID"
aws s3api list-objects-v2 \
  --bucket "$UPLOADS_BUCKET" \
  --prefix 'assets/exports/' \
  --query '{count:KeyCount,keys:Contents[].Key}'

# Destructive by design, and intentionally scoped to the exact legacy prefix.
aws s3 rm "s3://${UPLOADS_BUCKET}/assets/exports/" --recursive
INVALIDATION_ID="$(aws cloudfront create-invalidation \
  --distribution-id "$ASSETS_CLOUDFRONT_DISTRIBUTION_ID" \
  --paths '/assets/exports/*' \
  --query 'Invalidation.Id' --output text)"
aws cloudfront wait invalidation-completed \
  --distribution-id "$ASSETS_CLOUDFRONT_DISTRIBUTION_ID" \
  --id "$INVALIDATION_ID"
test "$(aws s3api list-objects-v2 --bucket "$UPLOADS_BUCKET" \
  --prefix 'assets/exports/' --query 'KeyCount' --output text)" = 0
```

Non-zero exit from either wait means the deployment circuit breaker rolled
back. Do not bypass CloudFormation with `aws ecs update-service`; keep the
failed service at zero and tail its logs:

```bash
aws logs tail /ecs/postwave-api --since 10m --follow
# In a second terminal when the assurance service is implicated:
aws logs tail /ecs/postwave-campaign-assurance --since 10m --follow
```

### Step 7a -- private observability plane and infrastructure alarms

Observability is a launch requirement, not an adjacent future task. Follow
[`OBSERVABILITY_RUNBOOK.md`](./OBSERVABILITY_RUNBOOK.md) now, using the exact
main/sidecar stack outputs and `METRICS_TOKEN_SECRET_ARN` created above. Its
ordered procedure:

1. builds and scans the minimal scratch collector;
2. verifies the signed multi-architecture GHCR digest and attestations;
3. bootstraps `observability-stack.yaml` with `DeployCollector=false`;
4. promotes the identical digest into the stack-owned immutable ECR repo;
5. enables the collector only after all five services are healthy;
6. configures private Grafana/AMP and deploys `cloudwatch-alarms.yaml`;
7. proves all five `up` series and both on-call alert routes.

At minimum, these local contracts must pass before continuing:

```bash
pnpm audit:observability
pnpm audit:observability:collector:release
node scripts/release/verify-aws-deployment-contracts.mjs
```

Do not expose prospective clients to the environment while the collector is at
desired count zero, any governed target is absent, an alert receiver is
unconfirmed, or the Grafana release dashboard lacks current data.

### Step 8 -- SES config set + SNS event destination

Verify the prerequisite work from `ses-domain-setup.md` sections 5 + 6
(already in `us-west-2`).
Config set name (`postwave-prod`) is hard-wired into the task def as
`POSTWAVE_SES_CONFIGURATION_SET`. Use the two fresh SPLIT SNS topics
(`postwave-prod-ses-bounce` + `postwave-prod-ses-complaint`) so MVP
events do not pollute prod tables. Their ARNs are already wired into
`POSTWAVE_SES_TOPIC_ARNS` in the task def; the topic names you create
must match those ARNs exactly — the webhook handler rejects any other
topic (fail-closed) and no suppression rows get written.

After step 11 (DNS live):

```bash
for topic in postwave-prod-ses-bounce postwave-prod-ses-complaint; do
  aws sns subscribe \
    --topic-arn arn:aws:sns:${AWS_REGION}:${ACCOUNT_ID}:${topic} \
    --protocol https \
    --notification-endpoint https://api.${DOMAIN}/api/internal/webhooks/deliverability/ses
done
```

Handler logs the `SubscriptionConfirmation` URL but does not auto-fetch
it; `curl` it manually from logs.

### Step 9 -- OAuth redirect URI registration

Before first sign-in:

- Google Cloud Console -> Credentials -> OAuth client. Add:
  `https://api.${DOMAIN}/api/v1/auth/oauth/google/callback`
- Mailchimp OAuth app -> redirect URI:
  `https://app.${DOMAIN}/app/migrations/oauth/callback?source=mailchimp`
- Kit OAuth app -> redirect URI:
  `https://app.${DOMAIN}/app/migrations/oauth/callback?source=convertkit`

### Step 10 -- Dodo Payments live billing and webhook

Static Checkout and Customer Portal URLs are not deployment inputs. The API
creates both session types through Dodo Payments using the live API key and
selects one of the three verified product IDs. Keep `BILLING_PROVIDER=dodo` and
`DODO_PAYMENTS_ENVIRONMENT=live_mode`; production readiness fails closed for
test mode or incomplete product mappings.

Before go-live, attach the step 3 product summaries and written
commercial-term approval to the release record. Exercise Checkout for LTD,
Sending, and Pro, confirm the resulting tenant and entitlement state, open the
Customer Portal for an existing Dodo customer, and verify cancel and failed-
payment behavior. Do not charge a real card until the amount, currency, tax,
refund, and cancellation review is complete.

In the Dodo Payments live dashboard create the endpoint
`https://api.${DOMAIN}/api/public/dodo/webhook`. Enable `payment.succeeded`,
`payment.failed`, `payment.cancelled`, `subscription.active`,
`subscription.updated`, `subscription.renewed`, `subscription.plan_changed`,
`subscription.past_due`, `subscription.on_hold`, `subscription.paused`,
`subscription.unpaused`, `subscription.cancelled`, `subscription.failed`,
`subscription.expired`, and `refund.succeeded` (or leave the event filter empty
to deliver all events). Also enable `dunning.started` and `dunning.recovered`.
The step 3 preflight fails if the live endpoint is
disabled, points to another route, or omits a required event.

Send a signed test delivery and retain the successful HTTP 200 delivery plus
the matching Moosewave audit/event record as release evidence. If Dodo rotates
the Standard Webhooks key after rollout, update Secrets Manager and restart the
service so ECS reinjects the new version:

```bash
dodo_secret_file="$(mktemp /tmp/postwave-deploy/secret.XXXXXX)"
chmod 0600 "$dodo_secret_file"
printf '%s' "$DODO_PAYMENTS_WEBHOOK_KEY" > "$dodo_secret_file"
if ! aws secretsmanager put-secret-value \
    --secret-id postwave/prod/dodo-payments-webhook-key \
    --secret-string "file://${dodo_secret_file}" >/dev/null; then
  rm -f "$dodo_secret_file"
  exit 1
fi
rm -f "$dodo_secret_file"
aws ecs update-service --cluster postwave-prod --service postwave-api \
  --force-new-deployment >/dev/null
aws ecs wait services-stable --cluster postwave-prod --services postwave-api
```

Rotating `dodo-payments-api-key` or any Dodo product secret requires new API
tasks. Re-run all three `verify_dodo_product` checks and repeat commercial-term
approval before changing a product mapping. Rotating
`migration-stripe-secret-key` requires only a new migration task and cannot
affect Checkout.

### Step 11 -- DNS cutover (Route 53)

```bash
ALB_DNS=$(aws cloudformation describe-stacks --stack-name postwave-prod \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" --output text)
ALB_ZONE=$(aws cloudformation describe-stacks --stack-name postwave-prod \
  --query "Stacks[0].Outputs[?OutputKey=='AlbHostedZoneId'].OutputValue" --output text)
HZ=$(aws route53 list-hosted-zones-by-name --dns-name ${DOMAIN}. \
  --query 'HostedZones[0].Id' --output text | cut -d/ -f3)

for sub in api forms archive; do
  for type in A AAAA; do
    aws route53 change-resource-record-sets --hosted-zone-id ${HZ} \
      --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"${sub}.${DOMAIN}\",\"Type\":\"${type}\",\"AliasTarget\":{\"HostedZoneId\":\"${ALB_ZONE}\",\"DNSName\":\"${ALB_DNS}\",\"EvaluateTargetHealth\":true}}}]}"
  done
done

# Do not create app.${DOMAIN} here. The parent stack has no Next.js target
# group/listener rule; pointing it at this ALB now would route browser traffic
# into the API target group. Add that ALIAS only through WEB_DEPLOY_RUNBOOK.md.

curl -sSv https://api.${DOMAIN}/api/health    # 200
```

### Step 12 -- Production readiness gate

```bash
test "$(curl --fail --silent --show-error https://api.${DOMAIN}/api/ready | jq -r .status)" = ready
```

This public response is intentionally detail-free and is the same bounded
database/runtime-config probe used by ECS and the ALB. From an approved
operator IP, sign in with the allowlisted platform-operator account, complete
TOTP, and open `https://api.${DOMAIN}/api/internal/ops/readiness` in that same
browser session. Its top-level `status` must be `ok` and every required check
must be `pass`; it is expected to return 503 while any provider or launch-wide
qualification is incomplete. Never copy the session cookie into a command,
ticket, or evidence artifact.

---

## 3. Cutover plan (MVP -> prod)

The MVP runs on a developer laptop against the same AWS account.
"Cutover" here = moving customer-facing URLs and provider callbacks
from `localhost`/MVP to the production ALB.

| What                       | From (MVP)                | To (prod)                                                              | When                     |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------- | ------------------------ |
| DNS `api.moosewave.com`     | unset                     | ALB ALIAS                                                              | step 11                  |
| DNS `app.moosewave.com`     | unset                     | ALB ALIAS (web TG -- adjacent runbook)                                 | step 11                  |
| DNS `forms.moosewave.com`   | unset                     | ALB ALIAS (API target)                                                 | step 11                  |
| DNS `archive.moosewave.com` | unset                     | ALB ALIAS (API target)                                                 | step 11                  |
| Google OAuth redirect      | n/a                       | `https://api.moosewave.com/...`                                         | step 9                   |
| Mailchimp migration OAuth  | n/a                       | `https://app.moosewave.com/app/migrations/oauth/callback?source=mailchimp` | before step 7            |
| Kit migration OAuth        | n/a                       | `https://app.moosewave.com/app/migrations/oauth/callback?source=convertkit` | before step 7            |
| Dodo Checkout + Portal     | test mode / unset         | live API sessions with three approved product contracts                | steps 3 and 10           |
| Dodo webhook URL           | n/a                       | `https://api.moosewave.com/api/public/dodo/webhook`                     | step 10                  |
| SES SNS subscription       | MVP `postwave-ses-events` | `postwave-prod-ses-bounce` + `postwave-prod-ses-complaint` -> prod ALB | step 8 (after 11)        |
| SES config set             | none (raw SES)            | `postwave-prod`                                                        | step 8                   |
| SES from-addresses         | `noreply@` only           | `noreply@`, `support@`, `billing@`, `approvals@` (per IAM allow-list)  | verify each in SES first |

Order: DNS (11) must be live before SES SNS subscribe (8) and before
any browser-driven OAuth/Dodo test. OAuth provider consoles (9)
**before** launching auth or first sign-in returns
`redirect_uri_mismatch`.

Tear down MVP only after prod is smoke-tested. The MVP compose file and
`cleanup-aws.sh` were removed from the tree; `infra/mvp/` now holds only
`README.md` (retired, must not be reconstructed) and `.env.mvp`. Perform the
account-side MVP cleanup manually by following the incident actions listed in
`infra/mvp/README.md`: revoke and delete the retired MVP IAM user's access keys,
review CloudTrail/SES activity, and remove the obsolete MVP bucket
(`postwave-mvp-uploads-<account-id>`), topics, identities and callbacks once
retention and legal-hold requirements are confirmed. None of them is referenced
by the prod task def. Do not start before step 12 passes.

---

## 4. Rollback

| Step | Symptom                                   | Rollback                                                                                                                                                                                       |
| ---- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | bad arch / push fails                     | rebuild `--platform linux/arm64`; no AWS state                                                                                                                                                 |
| 3    | wrong secret value                        | `put-secret-value` again; `AWSPREVIOUS` retained                                                                                                                                               |
| 4    | policy fails to attach (placeholder left) | `delete-role-policy`, re-edit, reapply                                                                                                                                                         |
| 5    | CFN `CREATE_FAILED`                       | `describe-stack-events` to find offender; fix; `delete-stack` (RDS and uploads bucket are retained; secrets are external) and redeploy. **Do not `delete-stack` with healthy RDS under load.** |
| 6    | migration mid-fail                        | restore from latest automated RDS snapshot (`restore-db-instance-from-db-snapshot`); re-run init                                                                                               |
| 7    | API or assurance task never steady        | circuit breaker / stack update rolls back; inspect both log groups. If operator intervention is required, redeploy the previous canonical API and assurance task-definition ARNs through CloudFormation. Never leave the API active with the assurance service at zero. |
| 7.1  | gate-stage errors or false blocks         | disable live dispatch for immediate containment, then deploy a new API task revision moving `block` → `warn` → `shadow`; keep the same assurance worker/task digest and immutable receipts. Do not weaken already-bound rows or delete evidence.            |
| 8    | SNS sub stuck `PendingConfirmation`       | check API logs for confirmation URL; if rejected, fix `POSTWAVE_SES_TOPIC_ARNS` and retry. Non-blocking for send, blocking for suppression                                                     |
| 9    | `redirect_uri_mismatch`                   | add URI in provider console; no AWS rollback                                                                                                                                                   |
| 10   | Dodo webhook 400/401                      | re-copy the live `whsec_` Standard Webhooks key, update Secrets Manager, then `force-new-deployment`                                                                                          |
| 11   | wrong ALIAS target                        | `change-resource-record-sets` DELETE then UPSERT correct; ALIAS TTL fixed 60s                                                                                                                  |
| 12   | `/api/ready` or operator report fails     | inspect the authenticated operator report from an approved IP, fix its named config/provider check, and redeploy. The public probe deliberately exposes no detail. Do not announce launch until both are clean.                                                  |

Full rollback (CFN broken beyond repair):

```bash
aws ecs update-service --cluster postwave-prod --service postwave-api \
  --desired-count 0
aws ecs update-service --cluster postwave-prod \
  --service postwave-campaign-assurance --desired-count 0
for service in postwave-voice postwave-automation postwave-deliverability postwave-migration; do
  aws ecs update-service --cluster postwave-prod --service "$service" \
    --desired-count 0
done
aws rds create-db-snapshot --db-instance-identifier postwave-prod \
  --db-snapshot-identifier postwave-prod-pre-rollback-$(date +%Y%m%d%H%M)
aws rds modify-db-instance --db-instance-identifier postwave-prod \
  --no-deletion-protection --apply-immediately
aws cloudformation delete-stack --stack-name postwave-prod
```

RDS deletion-protected + `DeletionPolicy: Retain` -- DB survives stack
delete; reattach to a fresh stack by identifier. Secrets are externally owned
by the bootstrap and are not deleted with either stack. ALB + ECS services are
destroyed; redo from step 5.

---

## 5. MVP-only config that must flip for prod

The MVP `docker-compose.mvp.yml` + `.env.mvp` carry dev toggles the
prod startup gate (`readiness.go`) refuses when `POSTWAVE_ENV=production`.
Confirm none appear in the rendered task def
(`ecs-task-definition.json` already omits them -- verify they did not
creep in during merge):

| Env var                                       | MVP value                                | Prod requirement                                                                                 |
| --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POSTWAVE_ENV`                                | unset / `dev`                            | `production` (in task def)                                                                       |
| `POSTWAVE_DEV_TENANT_SLUG_HEADER`             | `1`                                      | **unset** -- probe `no_dev_tenant_header` fails otherwise                                        |
| `POSTWAVE_DEV_ADMIN_ROLE_HEADER`              | `1`                                      | **unset** -- `no_dev_admin_header`                                                               |
| `POSTWAVE_DEV_SHOPIFY_WEBHOOK_BYPASS`         | `1` (in `docker-compose.full.yml`)       | **unset** -- `no_unsigned_shopify`                                                               |
| `POSTWAVE_DEV_LISTMONK_WEBHOOK_BYPASS`        | `1` (in `docker-compose.full.yml`)       | **unset** -- `no_unsigned_listmonk`                                                              |
| `POSTWAVE_DEV_TRANSACTIONAL_SINK`             | `1` (in `docker-compose.full.yml`)       | **unset**                                                                                        |
| `DATABASE_URL`                                | `...sslmode=disable`                     | `...sslmode=require` (RDS requires TLS)                                                          |
| `POSTWAVE_PUBLIC_BASE_URL`                    | `http://localhost:3002`                  | `https://app.moosewave.com`                                                                       |
| `FORMS_PUBLIC_HOST`                           | `http://localhost:3002`                  | `https://forms.moosewave.com`                                                                     |
| `CORS_ALLOWED_ORIGINS`                        | `http://localhost:3002`                  | `https://app.moosewave.com,https://moosewave.com` (dashboard plus canonical marketing producer)     |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | retired static MVP IAM user              | **unset** -- ECS task role provides credentials via IMDS                                         |
| `POSTWAVE_DATA_DIR`                           | `/tmp/postwave-data` (local FS fallback) | **unset** -- forces S3 via `POSTWAVE_UPLOADS_BUCKET`                                             |
| `POSTWAVE_UPLOADS_BUCKET`                     | optional                                 | private CloudFormation-owned bucket; required                                                    |
| `POSTWAVE_ASSETS_BUCKET`                      | optional / local filesystem              | same private S3 bucket as uploads; required                                                      |
| `POSTWAVE_ASSETS_PUBLIC_BASE_URL`             | unset / authenticated local blob route   | qualified HTTPS CDN/CloudFront base with private-bucket OAC; required                            |
| `POSTWAVE_EXPORTS_BUCKET`                     | mode-0600 local private store             | separate private CloudFormation-owned bucket with no CDN/CORS; required unless exports disabled  |
| `POSTWAVE_S3_KMS_KEY_ID`                      | optional                                 | dedicated uploads/assets/tenant-export CMK ARN; required                                         |
| `POSTWAVE_FORM_UPLOAD_CLAMAV_ADDR`             | optional / uploads stay quarantined      | private clamd endpoint reachable from every API task; required and startup-probed                  |
| `POSTWAVE_FORM_UPLOAD_TENANT_QUOTA_BYTES`      | `1073741824`                              | reviewed per-tenant quarantine + clean-object byte budget                                         |
| `POSTWAVE_FORM_UPLOAD_PENDING_LIMIT`           | `100`                                     | reviewed per-tenant pending/quarantined reservation ceiling                                       |
| `POSTWAVE_KMS_KEY_ID`                         | optional static-key fallback             | dedicated application-data envelope CMK ARN; required                                            |
| `REDIS_URL`                                   | `redis://localhost:6379`                 | authenticated `rediss://` endpoint reachable from every API/sidecar task                         |
| `POSTWAVE_AUTH_FROM_ADDRESS`                  | `noreply@moosewave.com`                   | `Moosewave <noreply@moosewave.com>` (display name)                                                 |
| `POSTWAVE_TRUST_FORWARDED_IP_HEADERS`         | unset                                    | `1` (ALB adds `X-Forwarded-For`)                                                                 |
| `POSTWAVE_TRUSTED_PROXY_CIDRS`                | unset                                    | exact ALB public-subnet CIDRs; never `0.0.0.0/0`                                                 |
| `POSTWAVE_WEB_VITALS_ALLOWED_ORIGINS`         | unset                                    | exactly matches production `CORS_ALLOWED_ORIGINS`; no wildcard                                   |
| `POSTGRES_PASSWORD=public-local-demo-only`              | hardcoded                                | replaced by RDS-managed master + per-app role w/ random pw                                       |
| Listmonk admin (`listmonk`/`listmonk`)        | hardcoded weak                           | rotate before exposure; keep Listmonk internal-only                                              |
| `LISTMONK_URL=http://listmonk:9000`           | docker DNS                               | `http://listmonk.postwave.internal:9000` or private ALB                                          |
| `POSTWAVE_SES_TOPIC_ARNS`                     | MVP topic                                | BOTH prod split topics (`postwave-prod-ses-bounce,postwave-prod-ses-complaint`), comma-separated |
| `POSTWAVE_LISTMONK_DEFAULT_TEMPLATE_ID`       | `3` (MVP)                                | not rendered in `ecs-task-definition.json` (code default applies); re-provision the template in prod Listmonk and add the env var to the task def only if a non-default id is required |

`envBool` returns false on missing keys, so the safest posture is to
omit every `POSTWAVE_DEV_*` from the prod task def -- which
`ecs-task-definition.json` already does. Audit the rendered file:

```bash
jq '.containerDefinitions[0].environment[] | select(.name|startswith("POSTWAVE_DEV_"))' \
  /tmp/postwave-deploy/ecs-task-definition.resolved.json
# Expected: nothing.
```

---

## 6. NOT in this runbook (adjacent runbooks needed)

- **Next.js web app deploy.** The reviewed adjacent module
  `cloudformation/postwave-web.yaml` owns the standalone digest-pinned task,
  target group, listener rule at priority 200, autoscaling, and optional
  `app.moosewave.com` ALIAS. Execute `WEB_DEPLOY_RUNBOOK.md` only after this
  stack's API/ALB prerequisites are stable. The operator must still supply the
  exact signed web digest and release SHA, private subnets, mobile-association
  identities, DNS-zone choice, and the account-specific promotion, canary,
  browser/device, rollback, and alert evidence required by that runbook.
- **Optional CDN / edge layer.** The ALB already has an AWS WAF association.
  A Cloudflare front-door (`infra/cloudflare/` transform/cache rules and
  provider-specific controls) is a separate architecture choice. If enabled,
  make Cloudflare the public DNS authority and restrict the origin SG to its
  published egress ranges.
- **Archived Hetzner Terraform prototype.** `infra/terraform/` is retained as
  historical design material only. It does not install or operate Moosewave and
  is neither an alternate Moosewave Cloud target nor a layer of this AWS stack.
  Do not apply it to client or production data.
- **Backup + DR.** For this RDS deployment, native encrypted automated backups
  and point-in-time recovery (`BackupRetentionPeriod: 14`) are canonical; prove
  the account-specific recovery objective with an isolated RDS restore drill.
  The self-managed PostgreSQL portable path is independently owned by
  `infra/backup/aws-backup-dr.yaml` and the manifests in `infra/backup/`.
  Consume that stack's `PrimaryBackupBucketName`,
  `ReplicaBackupBucketName`, and `BackupWriterManagedPolicyArn` outputs only
  from its dedicated workload identity; never attach its writer policy to the
  API task role and never dual-write RDS WAL into that filesystem-oriented
  path. See `infra/backup/README.md` and
  `docs/runbooks/disaster-recovery.md`.
- **Redis and Listmonk provisioning.** They are explicit private-network
  prerequisites. This runbook validates them and injects their credentials,
  but does not create their clusters/databases. The four Moosewave sidecars and
  their `*.postwave.internal` Cloud Map records are owned by
  `cloudformation/postwave-sidecars.yaml` and roll only after migrations.
- **Secret rotation.** `docs/runbooks/auth-aws.md` "Secret rotation
  procedures". Not first-deploy.
- **KMS key creation + policy.** Section 1 assumes keys exist. One-time
  security task.
- **VPC / subnet / NAT.** Foundation layer; out of every app-stack
  runbook.
- **Pre-launch gating.** `docs/runbooks/pre-production-launch-readiness.md`; run after step 12.

## Reference

CFN: `cloudformation/postwave-stack.yaml`. Task def: `ecs-task-definition.json`.
IAM: `iam-policy-ecs-task-role.json`, `iam-policy-ecs-task-execution-role.json`.
Secrets: `secrets-manager-bootstrap.json`. ALB: `alb-listener-rules.md`.
SES: `ses-domain-setup.md`. Auth ops: `../../docs/runbooks/auth-aws.md`.
Observability: `OBSERVABILITY_RUNBOOK.md`, `observability-stack.yaml`, and
`cloudwatch-alarms.yaml`.
MVP (retired): `../mvp/README.md`, `../mvp/.env.mvp`.
