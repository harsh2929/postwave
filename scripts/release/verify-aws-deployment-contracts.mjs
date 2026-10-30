#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const json = (relative) => JSON.parse(read(relative));
const failures = [];

function requireContract(condition, message) {
  if (!condition) failures.push(message);
}

function count(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function requireRetainedLogGroup(stack, logicalId, name) {
  const contract = `${logicalId}:
    Type: AWS::Logs::LogGroup
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      LogGroupName: ${name}
      RetentionInDays: 90`;
  requireContract(
    stack.includes(contract),
    `${logicalId} must explicitly retain ${name} for 90 days`,
  );
}

const apiTask = json("infra/aws/ecs-task-definition.json");
const apiContainer = apiTask.containerDefinitions?.[0];
const apiEnv = new Map(
  (apiContainer?.environment ?? []).map(({ name, value }) => [name, value]),
);
const apiSecrets = new Set(
  (apiContainer?.secrets ?? []).map(({ name }) => name),
);
const apiSecretValues = new Map(
  (apiContainer?.secrets ?? []).map(({ name, valueFrom }) => [name, valueFrom]),
);
const productionEnvTemplate = read(".env.production.template");

const assuranceTask = json(
  "infra/aws/ecs-campaign-assurance-task-definition.json",
);
const assuranceContainers = new Map(
  (assuranceTask.containerDefinitions ?? []).map((container) => [
    container.name,
    container,
  ]),
);
const assuranceEnvironment = (name) =>
  new Map(
    (assuranceContainers.get(name)?.environment ?? []).map(
      ({ name, value }) => [name, value],
    ),
  );
const assuranceSecretNames = (name) =>
  new Set(
    (assuranceContainers.get(name)?.secrets ?? []).map(({ name }) => name),
  );
const assuranceTaskRolePolicy = read(
  "infra/aws/iam-policy-campaign-assurance-task-role.json",
);
const executionRolePolicy = read(
  "infra/aws/iam-policy-ecs-task-execution-role.json",
);

const assuranceContainerNames = [
  "assurance-socket-init",
  "assurance-provider-gateway",
  "assurance-model-sandbox",
  "assurance-ocr-sandbox",
  "assurance-content-scanner",
  "assurance-image-broker",
  "assurance-worker",
];
requireContract(
  assuranceContainerNames.every((name) => assuranceContainers.has(name)) &&
    assuranceContainers.size === assuranceContainerNames.length,
  "Campaign Assurance task must contain only the seven reviewed boundary containers",
);
requireContract(
  assuranceTask.family === "postwave-campaign-assurance" &&
    assuranceTask.taskRoleArn?.includes(
      ":role/postwave-campaign-assurance-task-role",
    ) &&
    assuranceTask.taskRoleArn !== apiTask.taskRoleArn,
  "Campaign Assurance must use its dedicated task family and runtime role",
);
requireContract(
  assuranceTask.cpu === "4096" &&
    assuranceTask.memory === "8192" &&
    (assuranceTask.ephemeralStorage?.sizeInGiB ?? 0) >= 30,
  "Campaign Assurance task must retain the reviewed OCR/scanner resource floor",
);
const assuranceImageServiceContainers = new Set([
  "assurance-ocr-sandbox",
  "assurance-content-scanner",
]);
requireContract(
  assuranceContainerNames.every((name) => {
    const expected = assuranceImageServiceContainers.has(name)
      ? ".amazonaws.com/postwave-campaign-assurance-image-services@<image-services-image-digest>"
      : ".amazonaws.com/postwave-campaign-assurance@<core-image-digest>";
    return assuranceContainers.get(name)?.image?.endsWith(expected);
  }),
  "Campaign Assurance must keep OCR/scanner tools in their immutable image-services digest and every other boundary in the minimal core digest",
);
requireContract(
  assuranceContainerNames
    .filter((name) => name !== "assurance-socket-init")
    .every(
      (name) =>
        assuranceContainers.get(name)?.readonlyRootFilesystem === true &&
        assuranceContainers
          .get(name)
          ?.linuxParameters?.capabilities?.drop?.includes("ALL"),
    ),
  "every long-running assurance container must have a read-only root and no Linux capabilities",
);
requireContract(
  JSON.stringify(
    assuranceContainers
      .get("assurance-socket-init")
      ?.linuxParameters?.capabilities?.drop?.slice()
      .sort(),
  ) ===
    JSON.stringify(
      [
        "AUDIT_WRITE",
        "DAC_OVERRIDE",
        "FOWNER",
        "FSETID",
        "KILL",
        "MKNOD",
        "NET_BIND_SERVICE",
        "NET_RAW",
        "SETFCAP",
        "SETGID",
        "SETPCAP",
        "SETUID",
        "SYS_CHROOT",
      ].sort(),
    ) &&
    JSON.stringify(
      assuranceContainers.get("assurance-socket-init")?.linuxParameters
        ?.capabilities?.add,
    ) === JSON.stringify(undefined),
  "socket init may retain only CAP_CHOWN for its one-shot private-volume handoff",
);

const exactSocketPeers = new Map([
  ["model-worker-socket", ["assurance-model-sandbox", "assurance-worker"]],
  [
    "model-provider-socket",
    ["assurance-model-sandbox", "assurance-provider-gateway"],
  ],
  ["image-worker-socket", ["assurance-image-broker", "assurance-worker"]],
  ["image-ocr-socket", ["assurance-image-broker", "assurance-ocr-sandbox"]],
  [
    "image-scanner-socket",
    ["assurance-content-scanner", "assurance-image-broker"],
  ],
]);
for (const [volume, expected] of exactSocketPeers) {
  const mountedBy = assuranceContainerNames
    .filter((name) => name !== "assurance-socket-init")
    .filter((name) =>
      assuranceContainers
        .get(name)
        ?.mountPoints?.some(({ sourceVolume }) => sourceVolume === volume),
    )
    .sort();
  requireContract(
    JSON.stringify(mountedBy) === JSON.stringify([...expected].sort()),
    `${volume} must be visible only to its exact two reviewed peers`,
  );
}

const providerSecrets = assuranceSecretNames("assurance-provider-gateway");
const workerSecrets = assuranceSecretNames("assurance-worker");
const imageBrokerSecrets = assuranceSecretNames("assurance-image-broker");
requireContract(
  providerSecrets.size === 1 &&
    providerSecrets.has("POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY"),
  "only the provider gateway may receive the dedicated Campaign Assurance provider key",
);
requireContract(
  workerSecrets.size === 1 &&
    workerSecrets.has("DATABASE_URL") &&
    !workerSecrets.has("POSTWAVE_SENDING_KEK") &&
    !workerSecrets.has("POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY") &&
    imageBrokerSecrets.size === 1 &&
    imageBrokerSecrets.has("DATABASE_URL"),
  "worker/image broker credential injection must remain KMS-only, narrow, and provider-free",
);
for (const name of [
  "assurance-model-sandbox",
  "assurance-ocr-sandbox",
  "assurance-content-scanner",
]) {
  requireContract(
    assuranceSecretNames(name).size === 0 &&
      (assuranceContainers.get(name)?.command?.join(" ") ?? "").includes(
        "unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      ),
    `${name} must receive no secrets and scrub ECS task-role discovery before exec`,
  );
}
requireContract(
  (
    assuranceContainers.get("assurance-provider-gateway")?.command?.join(" ") ??
    ""
  ).includes("unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"),
  "provider gateway must scrub unrelated ECS task-role discovery before exec",
);
requireContract(
  assuranceEnvironment("assurance-worker").get(
    "POSTWAVE_CAMPAIGN_ASSURANCE_PROVIDER_GATEWAY_SOCKET",
  ) === undefined &&
    assuranceEnvironment("assurance-worker").get(
      "POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_SOCKET",
    ) === "/run/postwave/model-worker/model.sock" &&
    assuranceEnvironment("assurance-worker")
      .get("POSTWAVE_KMS_KEY_ID")
      ?.includes(":key/<app-data-cmk-uuid>") &&
    assuranceEnvironment("assurance-image-broker").get(
      "POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_PREFIX",
    ) === "campaign-assurance/image-evidence/v1",
  "worker and image broker must use only their reviewed indirect boundaries",
);
requireContract(
  assuranceContainerNames.every(
    (name) => (assuranceContainers.get(name)?.portMappings ?? []).length === 0,
  ),
  "Campaign Assurance data-plane containers must expose no network listener",
);
requireContract(
  !/secretsmanager:|ses:|dynamodb:|sqs:/iu.test(assuranceTaskRolePolicy) &&
    assuranceTaskRolePolicy.includes("s3:GetBucketVersioning") &&
    assuranceTaskRolePolicy.includes("s3:GetEncryptionConfiguration") &&
    count(assuranceTaskRolePolicy, /s3:DeleteObjectVersion/gu) === 2 &&
    assuranceTaskRolePolicy.includes("kms:GenerateDataKey"),
  "Campaign Assurance runtime IAM must remain limited to its reviewed S3/KMS data plane",
);
for (const token of [
  "repository/postwave-campaign-assurance",
  "repository/postwave-campaign-assurance-image-services",
  "campaign-assurance-gemini-api-key-*",
  "log-group:/ecs/postwave-campaign-assurance:*",
]) {
  requireContract(
    executionRolePolicy.includes(token),
    `ECS execution role is missing Campaign Assurance startup capability ${token}`,
  );
}

requireContract(
  apiContainer?.image?.endsWith("@<image-digest>"),
  "canonical API task must use an immutable image-digest placeholder",
);
requireContract(
  apiContainer?.readonlyRootFilesystem === true,
  "canonical API task must use a read-only root filesystem",
);
for (const forbidden of [
  "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY",
  "GEMINI_API_KEY",
  "POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_SOCKET",
  "POSTWAVE_CAMPAIGN_ASSURANCE_PROVIDER_GATEWAY_SOCKET",
  "POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_IMAGE_BROKER",
]) {
  requireContract(
    !apiEnv.has(forbidden) && !apiSecrets.has(forbidden),
    `control-plane API task must not receive assurance data-plane capability ${forbidden}`,
  );
}
requireContract(
  apiEnv.get("POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME") === "false" &&
    apiEnv.get("POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_MODELED") === "false" &&
    apiEnv.get("POSTWAVE_CAMPAIGN_ASSURANCE_GATE_ROLLOUT") === "off",
  "canonical API bootstrap must keep assurance runtime/model/gate disabled until the data plane is stable",
);
requireContract(
  apiTask.volumes?.some(({ name }) => name === "postwave-api-tmp") &&
    apiContainer?.mountPoints?.some(
      ({ sourceVolume, containerPath, readOnly }) =>
        sourceVolume === "postwave-api-tmp" &&
        containerPath === "/tmp" &&
        readOnly === false,
    ),
  "canonical API task must mount an isolated writable /tmp volume",
);
for (const name of [
  "POSTWAVE_PUBLIC_BASE_URL",
  "POSTWAVE_SMS_PROVIDER_CALLBACK_BASE_URL",
  "POSTWAVE_PORTAL_ORIGIN",
  "POSTWAVE_UPLOADS_BUCKET",
  "POSTWAVE_ASSETS_BUCKET",
  "POSTWAVE_EXPORTS_BUCKET",
  "POSTWAVE_S3_KMS_KEY_ID",
  "POSTWAVE_KMS_KEY_ID",
  "POSTWAVE_WEB_VITALS_ALLOWED_ORIGINS",
  "POSTWAVE_TRUST_FORWARDED_IP_HEADERS",
  "POSTWAVE_TRUSTED_PROXY_CIDRS",
]) {
  requireContract(apiEnv.has(name), `canonical API task is missing ${name}`);
}
requireContract(
  apiEnv.get("POSTWAVE_UPLOADS_BUCKET") ===
    apiEnv.get("POSTWAVE_ASSETS_BUCKET"),
  "uploads and assets must share the canonical private S3 bucket",
);
requireContract(
  apiEnv.get("POSTWAVE_EXPORTS_BUCKET") !==
    apiEnv.get("POSTWAVE_ASSETS_BUCKET") &&
    productionEnvTemplate.includes("POSTWAVE_EXPORTS_BUCKET=REPLACE_ME"),
  "tenant exports must use a separately documented private S3 bucket",
);
requireContract(
  apiEnv.get("CORS_ALLOWED_ORIGINS") ===
    "https://app.moosewave.com,https://moosewave.com",
  "canonical API CORS must allow the dashboard and the exact marketing consent-producer origin",
);
requireContract(
  apiEnv.get("POSTWAVE_WEB_VITALS_ALLOWED_ORIGINS") ===
    apiEnv.get("CORS_ALLOWED_ORIGINS"),
  "anonymous web-vitals CORS must exactly match API-wide CORS so preflight and ingest enforce the same origins",
);
for (const name of [
  "DATABASE_URL",
  "REDIS_URL",
  "POSTWAVE_CONSENT_CURSOR_SIGNING_KEY",
  "POSTWAVE_SMS_INBOX_CURSOR_KEY",
  "POSTWAVE_HELPDESK_CURSOR_KEY",
  "POSTWAVE_PORTAL_JWT_SECRET",
  "ANTHROPIC_API_KEY",
  "METRICS_TOKEN",
  "OPS_DATABASE_URL",
  "OPS_SLACK_WEBHOOK_URL",
  "DODO_PAYMENTS_API_KEY",
  "DODO_PAYMENTS_WEBHOOK_KEY",
  "DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY",
  "DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY",
  "DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY",
]) {
  requireContract(
    apiSecrets.has(name),
    `canonical API task is missing ${name}`,
  );
}
const dodoProductSecretValues = [
  apiSecretValues.get("DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY"),
  apiSecretValues.get("DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY"),
  apiSecretValues.get("DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY"),
];
requireContract(
  dodoProductSecretValues.every(Boolean) &&
    new Set(dodoProductSecretValues).size === dodoProductSecretValues.length,
  "canonical API task must map each Dodo Payments plan to a distinct Secrets Manager entry",
);
requireContract(
  apiEnv.get("BILLING_PROVIDER") === "dodo" &&
    apiEnv.get("DODO_PAYMENTS_ENVIRONMENT") === "live_mode" &&
    apiEnv.get("MOOSEWAVE_BILLING_LAUNCH_APPROVAL") ===
      "<approved-release-record>",
  "canonical API task must select live Dodo Payments and require the release-record placeholder to be resolved",
);
requireContract(
  apiSecretValues
    .get("POSTWAVE_CONSENT_CURSOR_SIGNING_KEY")
    ?.includes(":secret:postwave/prod/consent-cursor-signing-key-XXXXXX"),
  "canonical API task must map POSTWAVE_CONSENT_CURSOR_SIGNING_KEY to its dedicated Secrets Manager entry",
);
requireContract(
  !apiEnv.has("POSTWAVE_CONSENT_CURSOR_SIGNING_KEY") &&
    productionEnvTemplate.includes(
      "POSTWAVE_CONSENT_CURSOR_SIGNING_KEY=REPLACE_ME",
    ),
  "consent cursor signing material must be secret-injected and documented as a boot-gating production input",
);
requireContract(
  apiEnv.get("POSTWAVE_SMS_PROVIDER_CALLBACK_BASE_URL") ===
    "https://api.moosewave.com",
  "SMS provider callbacks must use the direct public API origin",
);
for (const [name, secret] of [
  ["POSTWAVE_SMS_INBOX_CURSOR_KEY", "sms-inbox-cursor-key"],
  ["POSTWAVE_HELPDESK_CURSOR_KEY", "helpdesk-cursor-key"],
]) {
  requireContract(
    apiSecretValues
      .get(name)
      ?.includes(`:secret:postwave/prod/${secret}-XXXXXX`),
    `canonical API task must map ${name} to its dedicated Secrets Manager entry`,
  );
  requireContract(
    !apiEnv.has(name) && productionEnvTemplate.includes(`${name}=REPLACE_ME`),
    `${name} must be secret-injected and documented in the production template`,
  );
}
requireContract(
  !apiSecrets.has("POSTWAVE_SMS_INBOX_CURSOR_PREVIOUS_KEY") &&
    !apiEnv.has("POSTWAVE_SMS_INBOX_CURSOR_PREVIOUS_KEY") &&
    productionEnvTemplate.includes("# POSTWAVE_SMS_INBOX_CURSOR_PREVIOUS_KEY="),
  "canonical tasks must omit the active previous cursor key outside an explicit <=15 minute rotation deployment",
);
// Route40 dispatch and callback readiness remain source-held. The current SMS
// adapters consume process-global credentials while sender profiles are
// tenant-scoped; injecting one provider account here would falsely advertise a
// multi-tenant BYO-provider vault. Canonical deployment must stay unconfigured
// until tenant-bound credential lookup/rotation is deployed and verified.
for (const name of [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WEBHOOK_AUTH_TOKEN",
  "TELNYX_API_KEY",
  "TELNYX_PUBLIC_KEY",
  "BANDWIDTH_ACCOUNT_ID",
  "BANDWIDTH_API_USERNAME",
  "BANDWIDTH_API_PASSWORD",
  "BANDWIDTH_WEBHOOK_TOKEN",
  "BANDWIDTH_WEBHOOK_USERNAME",
  "BANDWIDTH_WEBHOOK_PASSWORD",
]) {
  requireContract(
    !apiSecrets.has(name) && !apiEnv.has(name),
    `canonical multi-tenant API must not inject process-global ${name} before the tenant provider-vault release gate is complete`,
  );
}
for (const [name, secret] of [
  ["DODO_PAYMENTS_API_KEY", "dodo-payments-api-key"],
  ["DODO_PAYMENTS_WEBHOOK_KEY", "dodo-payments-webhook-key"],
  ["DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY", "dodo-payments-product-launch-monthly"],
  ["DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY", "dodo-payments-product-growth-monthly"],
  ["DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY", "dodo-payments-product-scale-monthly"],
]) {
  const secretPrefix = secret.startsWith("dodo-payments-product-")
    ? "moosewave/prod"
    : "postwave/prod";
  requireContract(
    apiSecretValues
      .get(name)
      ?.includes(`:secret:${secretPrefix}/${secret}-XXXXXX`),
    `canonical API task must map ${name} to ${secret}`,
  );
}
for (const name of [
  "POSTWAVE_MIGRATION_SESSION_KEK",
  "MAILCHIMP_CLIENT_ID",
  "MAILCHIMP_CLIENT_SECRET",
  "CONVERTKIT_CLIENT_ID",
  "CONVERTKIT_CLIENT_SECRET",
  "POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_LTD",
  "STRIPE_PRICE_SENDING",
  "STRIPE_PRICE_PRO",
  "STRIPE_CHECKOUT_URL_STUDIO_LTD",
  "STRIPE_CHECKOUT_URL_STUDIO_LTD_CLOUD",
  "STRIPE_CHECKOUT_URL_STUDIO_LTD_PLUS",
  "STRIPE_CUSTOMER_PORTAL_URL",
]) {
  requireContract(
    !apiEnv.has(name) && !apiSecrets.has(name),
    `canonical API task must not receive sidecar-local or static billing setting ${name}`,
  );
}
requireContract(
  ![...apiEnv.keys()].some((name) => name.startsWith("POSTWAVE_DEV_")),
  "canonical API task must not carry development bypass variables",
);
requireContract(
  apiContainer?.healthCheck?.command?.includes(
    "wget -qO- http://localhost:8080/api/ready || exit 1",
  ),
  "canonical API container must use dependency/configuration readiness",
);

const migratorTask = json("infra/aws/ecs-migrator-task-definition.json");
const migratorContainer = migratorTask.containerDefinitions?.[0];
requireContract(
  migratorContainer?.image?.endsWith("@<image-digest>"),
  "migrator task must use an immutable image-digest placeholder",
);
requireContract(
  migratorContainer?.readonlyRootFilesystem === true,
  "migrator task must use a read-only root filesystem",
);
requireContract(
  JSON.stringify((migratorContainer?.secrets ?? []).map(({ name }) => name)) ===
    JSON.stringify(["DATABASE_URL"]),
  "migrator task must receive only its privileged DATABASE_URL secret",
);
requireContract(
  !JSON.stringify(apiTask).includes("POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE") &&
    !JSON.stringify(migratorTask).includes("POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE"),
  "canonical production tasks must never carry the privileged DB-role bypass",
);

const mainStack = read("infra/aws/cloudformation/postwave-stack.yaml");
for (const keyParameter of [
  "SecretsManagerKmsKeyArn",
  "RdsKmsKeyArn",
  "S3KmsKeyArn",
]) {
  const marker = `  ${keyParameter}:\n`;
  const start = mainStack.indexOf(marker);
  const remainder = start >= 0 ? mainStack.slice(start + marker.length) : "";
  const nextParameter = remainder.search(/^  [A-Za-z][A-Za-z0-9]*:/mu);
  const parameterBlock =
    nextParameter >= 0 ? remainder.slice(0, nextParameter) : remainder;
  requireContract(
    start >= 0 && /AllowedPattern: "[^"]*:key\//u.test(parameterBlock),
    `${keyParameter} must reject aliases and require a customer-managed KMS key ARN`,
  );
}
for (const token of [
  "DeployApplicationServices:",
  'Default: "false"',
  "ApplicationRolloutRequiresCanonicalTask:",
  "Condition: ApplicationServicesEnabled",
  "TaskDefinition: !Ref ApiTaskDefinitionArn",
  "DesiredCount: 2",
  "UploadsBucket:",
  "ExportsBucketName:",
  "ExportsBucket:",
  "ExportsBucketPolicy:",
  "Prefix: tenant-exports/",
  "SSEAlgorithm: aws:kms",
  "BucketOwnerEnforced",
  "AbortIncompleteMultipartUpload:",
  "DenyInsecureTransport",
  "DenyWrongKmsKey",
  "https://forms.${DomainName}",
  "ServiceDiscoveryNamespace:",
  "ServiceRegistries:",
  "access_logs.s3.enabled",
  "routing.http.drop_invalid_header_fields.enabled",
  "PerformanceInsightsKMSKeyId: !Ref RdsKmsKeyArn",
  "AlbHostedZoneId:",
  "HealthCheckPath: /api/ready",
  "DeployCampaignAssuranceService:",
  "CampaignAssuranceRolloutRequiresCertifiedInputs:",
  "CampaignAssuranceTaskDefinitionArn:",
  "CampaignAssuranceTaskRoleArn:",
  "CampaignAssuranceTaskSecurityGroup:",
  "CampaignAssuranceRdsIngress:",
  "CampaignAssuranceImageEvidenceBucket:",
  "CampaignAssuranceImageEvidenceBucketPolicy:",
  "ExpireAbandonedNoncurrentEvidence",
  "NoncurrentDays: 45",
  "CampaignAssuranceLogGroup:",
  "LogGroupName: /ecs/postwave-campaign-assurance",
  "CampaignAssuranceService:",
  "TaskDefinition: !Ref CampaignAssuranceTaskDefinitionArn",
  "EnableExecuteCommand: false",
  "Value: campaign-assurance-data-plane",
]) {
  requireContract(mainStack.includes(token), `main stack is missing ${token}`);
}
const exportsBucketSection = mainStack.slice(
  mainStack.indexOf("  ExportsBucket:"),
  mainStack.indexOf("  ExportsBucketPolicy:"),
);
requireContract(
  exportsBucketSection.length > 0 &&
    exportsBucketSection.includes("BucketOwnerEnforced") &&
    exportsBucketSection.includes("RestrictPublicBuckets: true") &&
    !exportsBucketSection.includes("CorsConfiguration:") &&
    !exportsBucketSection.includes("VersioningConfiguration:") &&
    !exportsBucketSection.includes("campaign-assurance/image-evidence/") &&
    !exportsBucketSection.includes("NoncurrentVersionExpiration:") &&
    !exportsBucketSection.includes("ExpiredObjectDeleteMarker:"),
  "tenant-export bucket must remain private, non-CORS, unversioned, and free of versioned assurance-evidence lifecycle rules",
);
const assuranceEvidenceSection = mainStack.slice(
  mainStack.indexOf("  CampaignAssuranceImageEvidenceBucket:"),
  mainStack.indexOf("  CampaignAssuranceImageEvidenceBucketPolicy:"),
);
requireContract(
  assuranceEvidenceSection.length > 0 &&
    assuranceEvidenceSection.includes("Condition: CampaignAssuranceEnabled") &&
    assuranceEvidenceSection.includes("VersioningConfiguration:") &&
    assuranceEvidenceSection.includes("Status: Enabled") &&
    assuranceEvidenceSection.includes("BucketOwnerEnforced") &&
    assuranceEvidenceSection.includes("RestrictPublicBuckets: true") &&
    assuranceEvidenceSection.includes("ExpireAbandonedNoncurrentEvidence") &&
    assuranceEvidenceSection.includes(
      "Prefix: campaign-assurance/image-evidence/v1/",
    ) &&
    assuranceEvidenceSection.includes("NoncurrentVersionExpiration:") &&
    assuranceEvidenceSection.includes("NoncurrentDays: 45") &&
    assuranceEvidenceSection.includes("ExpiredObjectDeleteMarker: true") &&
    !assuranceEvidenceSection.includes("\n            Expiration:\n") &&
    !assuranceEvidenceSection.includes("CorsConfiguration:"),
  "Campaign Assurance raster evidence must use a conditional private versioned non-CORS bucket with its bounded noncurrent-version lifecycle on that bucket",
);
requireContract(
  !mainStack.includes("ImageTag"),
  "main stack must not accept mutable image tags",
);
requireContract(
  !mainStack.includes("ApiTaskDefinition:") &&
    !mainStack.includes("Add the rest from ecs-task-definition.json"),
  "main stack must consume only the fully rendered canonical task definition, never an incomplete bootstrap duplicate",
);
for (const [logicalId, name] of [
  ["ApiLogGroup", "/ecs/postwave-api"],
  ["DbMigratorLogGroup", "/ecs/postwave-db-migrator"],
]) {
  requireRetainedLogGroup(mainStack, logicalId, name);
}

const sidecars = read("infra/aws/cloudformation/postwave-sidecars.yaml");
requireContract(
  !sidecars.includes("POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE"),
  "sidecar tasks must never carry the privileged DB-role bypass",
);
for (const token of [
  "VoiceImageDigest:",
  "AutomationImageDigest:",
  "DeliverabilityImageDigest:",
  "MigrationImageDigest:",
  "DeploySidecarServices:",
  "GeminiApiKeySecretArn:",
  "OpenAiApiKeySecretArn:",
  "HctiApiKeySecretArn:",
  "SeedlistRegistrySecretArn:",
  "ListmonkAdminPasswordSecretArn:",
  "MigrationStripeSecretKeyArn:",
  "postwave/prod/migration-stripe-secret-key-",
  "MailchimpClientIdSecretArn:",
  "MailchimpClientSecretArn:",
  "ConvertKitClientIdSecretArn:",
  "ConvertKitClientSecretArn:",
  "MigrationOAuthRedirectUri:",
  "ActiveCampaignAllowedAPIHosts:",
  "ListmonkTenantMode:",
  "ListmonkDedicatedTenantId:",
  "DIAGNOSTICIAN_PROMPTS_PATH",
  "DIAGNOSTICIAN_EVAL_CASES_PATH",
  "VOICE_PROMPTS_PATH",
  "VOICE_TEMPLATES_PATH",
  "ServiceDiscoveryNamespaceId:",
  "MetricsTokenSecretArn:",
]) {
  requireContract(
    sidecars.includes(token),
    `sidecar stack is missing ${token}`,
  );
}
const migrationTaskStart = sidecars.indexOf("  MigrationTaskDefinition:");
const migrationServiceStart = sidecars.indexOf(
  "  MigrationService:",
  migrationTaskStart,
);
const migrationTaskSection = sidecars.slice(
  migrationTaskStart,
  migrationServiceStart,
);
for (const [name, parameter] of [
  ["POSTWAVE_MIGRATION_SESSION_KEK", "MigrationSessionKekSecretArn"],
  ["MAILCHIMP_CLIENT_ID", "MailchimpClientIdSecretArn"],
  ["MAILCHIMP_CLIENT_SECRET", "MailchimpClientSecretArn"],
  ["CONVERTKIT_CLIENT_ID", "ConvertKitClientIdSecretArn"],
  ["CONVERTKIT_CLIENT_SECRET", "ConvertKitClientSecretArn"],
  ["STRIPE_SECRET_KEY", "MigrationStripeSecretKeyArn"],
]) {
  requireContract(
    migrationTaskSection.includes(
      `            - Name: ${name}\n              ValueFrom: !Ref ${parameter}`,
    ) && count(sidecars, new RegExp(`- Name: ${name}`, "gu")) === 1,
    `migration task must exclusively bind ${name} from ${parameter}`,
  );
}
for (const name of [
  "DODO_PAYMENTS_API_KEY",
  "DODO_PAYMENTS_WEBHOOK_KEY",
  "DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY",
  "DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY",
  "DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_LTD",
  "STRIPE_PRICE_SENDING",
  "STRIPE_PRICE_PRO",
]) {
  requireContract(
    !migrationTaskSection.includes(`- Name: ${name}`),
    `migration task must not receive API-only billing setting ${name}`,
  );
}
requireContract(
  migrationTaskSection.includes(
    "            - Name: OAUTH_REDIRECT_URI\n              Value: !Ref MigrationOAuthRedirectUri",
  ) &&
    !migrationTaskSection.includes(
      "http://localhost:3000/app/migrations/oauth/callback",
    ),
  "migration task must use the explicit public OAuth callback parameter",
);
requireContract(
  migrationTaskSection.includes(
    "            - Name: ACTIVECAMPAIGN_ALLOWED_API_HOSTS\n              Value: !Ref ActiveCampaignAllowedAPIHosts",
  ),
  "migration task must bind the operator-controlled ActiveCampaign exact-host allowlist",
);
for (const [name, parameter] of [
  ["LISTMONK_TENANT_MODE", "ListmonkTenantMode"],
  ["LISTMONK_DEDICATED_TENANT_ID", "ListmonkDedicatedTenantId"],
]) {
  requireContract(
    migrationTaskSection.includes(
      `            - Name: ${name}\n              Value: !Ref ${parameter}`,
    ),
    `migration task must bind ${name} from ${parameter}`,
  );
}
requireContract(
  !sidecars.includes("ImageTag"),
  "sidecar stack must not accept mutable image tags",
);
requireContract(
  !/^\s{2}StripeSecretKeyArn:/mu.test(sidecars) &&
    !sidecars.includes("ValueFrom: !Ref StripeSecretKeyArn"),
  "migration stack must never accept or inject the API Stripe key",
);
requireContract(
  !sidecars.includes("eu-north-1"),
  "sidecar deployment example must use the canonical production region",
);
requireContract(
  count(sidecars, /DesiredCount: !If \[SidecarServicesEnabled, 1, 0\]/gu) === 4,
  "all four sidecar services must bootstrap at desired count zero",
);
requireContract(
  count(sidecars, /ReadonlyRootFilesystem: true/gu) === 4,
  "all four sidecars must use read-only root filesystems",
);
requireContract(
  count(sidecars, /- Name: METRICS_TOKEN/gu) === 4,
  "all four sidecars must receive the dedicated metrics bearer token",
);
requireContract(
  count(sidecars, /ContainerPath: \/tmp/gu) === 4 &&
    new Set(
      [...sidecars.matchAll(/- Name: (postwave-[a-z-]+-tmp)/gu)].map(
        (match) => match[1],
      ),
    ).size === 4,
  "all four sidecars must have isolated writable /tmp volumes",
);
requireContract(
  count(
    sidecars,
    /amazonaws\.com\/postwave-[a-z-]+@\$\{[A-Za-z]+ImageDigest\}/gu,
  ) === 4,
  "all four sidecar images must interpolate immutable digests after @",
);
for (const [logicalId, name] of [
  ["VoiceLogGroup", "/ecs/postwave-voice"],
  ["AutomationLogGroup", "/ecs/postwave-automation"],
  ["DeliverabilityLogGroup", "/ecs/postwave-deliverability"],
  ["MigrationLogGroup", "/ecs/postwave-migration"],
]) {
  requireRetainedLogGroup(sidecars, logicalId, name);
}

const webStack = read("infra/aws/cloudformation/postwave-web.yaml");
const productionPlatform = json("config/production-platform.json");
requireContract(
  productionPlatform.canonicalTemplates?.includes(
    "infra/aws/cloudformation/postwave-web.yaml",
  ) && productionPlatform.releaseWorkloads?.includes("web"),
  "canonical production platform must inventory the web template and workload",
);
for (const token of [
  "WebImageDigest:",
  "WebArtifactVerified:",
  "PublicReleaseApproval:",
  'AllowedPattern: "^$|^approved:[A-Za-z0-9][A-Za-z0-9._/-]{5,127}$"',
  "EnabledRolloutRequiresVerifiedArtifact:",
  "DeployWebService:",
  'Default: "false"',
  "DesiredCount: !If [WebServiceEnabled, 2, 0]",
  "RepositoryName: postwave-web",
  "ImageTagMutability: IMMUTABLE_WITH_EXCLUSION",
  "ReadonlyRootFilesystem: true",
  'User: "10001:10001"',
  "Drop: [ALL]",
  "ContainerPath: /tmp",
  "ContainerPath: /app/apps/web/.next/cache",
  "WebTaskSecurityGroup:",
  "SourceSecurityGroupId: !Ref AlbSecurityGroupId",
  "FromPort: 3000",
  "CidrIp: 169.254.169.253/32",
  "HealthCheckPath: /healthz",
  "http://127.0.0.1:3000/healthz",
  "Priority: 200",
  "app.${DomainName}",
  "DeploymentCircuitBreaker:",
  "WebCpuScalingPolicy:",
  "WebMemoryScalingPolicy:",
  "CreateDnsRecord:",
  "AWS::Route53::RecordSetGroup",
]) {
  requireContract(webStack.includes(token), `web stack is missing ${token}`);
}
const webDigestParameter = webStack.slice(
  webStack.indexOf("  WebImageDigest:"),
  webStack.indexOf("  WebArtifactVerified:"),
);
requireContract(
  webDigestParameter.length > 0 && !webDigestParameter.includes("Default:"),
  "web digest parameter must not have a mutable or fallback default",
);
requireContract(
  /postwave-web@\$\{WebImageDigest\}/u.test(webStack) &&
    !/^\s{2}WebImageTag:/mu.test(webStack),
  "web stack must interpolate only an immutable image digest after @",
);
for (const name of [
  "NODE_ENV",
  "NEXT_TELEMETRY_DISABLED",
  "POSTWAVE_ENV",
  "POSTWAVE_RELEASE",
  "POSTWAVE_PUBLIC_RELEASE_APPROVAL",
  "HOSTNAME",
  "PORT",
  "API_URL",
  "POSTWAVE_API_URL",
  "POSTWAVE_API_PROXY_TIMEOUT_MS",
  "POSTWAVE_API_STREAM_TIMEOUT_MS",
  "POSTWAVE_API_EXPORT_TIMEOUT_MS",
  "POSTWAVE_API_PROXY_MAX_BODY_BYTES",
  "POSTWAVE_PUBLIC_PAGE_TIMEOUT_MS",
  "POSTWAVE_APPLE_TEAM_ID",
  "POSTWAVE_IOS_BUNDLE_ID",
  "POSTWAVE_ANDROID_PACKAGE_NAME",
  "POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS",
]) {
  requireContract(
    webStack.includes(`- Name: ${name}`),
    `web task runtime contract is missing ${name}`,
  );
}
requireContract(
  !webStack.includes("- Name: NEXT_PUBLIC_") &&
    !/BYPASS\n\s+Value:/u.test(webStack),
  "web task must not pretend build-time public values or bypasses are runtime configuration",
);
requireRetainedLogGroup(webStack, "WebLogGroup", "/ecs/postwave-web");
requireContract(
  !mainStack.includes("awslogs-create-group") &&
    !sidecars.includes("awslogs-create-group") &&
    !JSON.stringify(apiTask).includes("awslogs-create-group") &&
    !JSON.stringify(migratorTask).includes("awslogs-create-group"),
  "task definitions must not lazily create unretained CloudWatch log groups",
);

const executionPolicy = json(
  "infra/aws/iam-policy-ecs-task-execution-role.json",
);
const executionResources = new Set(
  executionPolicy.Statement.flatMap(({ Resource }) =>
    Array.isArray(Resource) ? Resource : [Resource],
  ),
);
for (const suffix of [
  "postwave-api",
  "postwave-voice",
  "postwave-automation",
  "postwave-deliverability",
  "postwave-migration",
  "postwave-db-migrator",
  "postwave-campaign-assurance",
  "postwave-campaign-assurance-image-services",
]) {
  requireContract(
    [...executionResources].some((resource) =>
      String(resource).endsWith(`repository/${suffix}`),
    ),
    `execution role cannot pull ${suffix}`,
  );
}
for (const secret of [
  "redis-url",
  "consent-cursor-signing-key",
  "portal-jwt",
  "gemini-api-key",
  "openai-api-key",
  "hcti-api-key",
  "seedlist-registry-json",
  "seedlist-vendor-api-key",
  "listmonk-admin-password",
  "metrics-token",
  "ops-db-dsn",
  "ops-slack-webhook-url",
  "dodo-payments-api-key",
  "dodo-payments-webhook-key",
  "dodo-payments-product-launch-monthly",
  "dodo-payments-product-growth-monthly",
  "dodo-payments-product-scale-monthly",
  "migration-stripe-secret-key",
  "migration-mailchimp-client-id",
  "migration-mailchimp-client-secret",
  "migration-convertkit-client-id",
  "migration-convertkit-client-secret",
]) {
  const secretPrefix = secret.startsWith("dodo-payments-product-")
    ? "moosewave/prod"
    : "postwave/prod";
  requireContract(
    [...executionResources].some((resource) =>
      String(resource).includes(`${secretPrefix}/${secret}-*`),
    ),
    `execution role cannot inject ${secret}`,
  );
}
const logStatement = executionPolicy.Statement.find(
  ({ Sid }) => Sid === "CloudWatchLogsWriteManagedGroups",
);
const expectedLogActions = ["logs:CreateLogStream", "logs:PutLogEvents"];
requireContract(
  JSON.stringify(logStatement?.Action) === JSON.stringify(expectedLogActions),
  "execution role may only create streams and write events in managed log groups",
);
const expectedLogResources = [
  "postwave-api",
  "postwave-voice",
  "postwave-automation",
  "postwave-deliverability",
  "postwave-migration",
  "postwave-db-migrator",
  "postwave-campaign-assurance",
].map((name) => `arn:aws:logs:us-west-2:<account>:log-group:/ecs/${name}:*`);
requireContract(
  JSON.stringify(logStatement?.Resource) ===
    JSON.stringify(expectedLogResources),
  "execution role log writes must be scoped to the seven managed log groups",
);

const taskPolicy = read("infra/aws/iam-policy-ecs-task-role.json");
requireContract(
  taskPolicy.includes("KMSApplicationEnvelopeCipher") &&
    taskPolicy.includes("<app-data-cmk-uuid>") &&
    taskPolicy.includes("KMSEncryptUploadsAndAssets") &&
    !taskPolicy.includes("postwave-backups"),
  "task role must isolate direct application envelope-KMS access",
);
requireContract(
  taskPolicy.includes("S3PrivateExportsObjectAccess") &&
    taskPolicy.includes('"Resource": "arn:aws:s3:::postwave-exports/*"') &&
    taskPolicy.includes("S3PrivateExportsBucketList") &&
    taskPolicy.includes('"Resource": "arn:aws:s3:::postwave-exports"'),
  "task role must grant only the dedicated tenant-export bucket object/list access",
);

const secretInventory = json("infra/aws/secrets-manager-bootstrap.json");
const inventoryNames = secretInventory.Secrets.map(({ Name }) => Name);
const inventoryEnv = new Map(
  secretInventory.Secrets.map(({ Name, EnvVarName }) => [Name, EnvVarName]),
);
requireContract(
  new Set(inventoryNames).size === inventoryNames.length,
  "Secrets Manager inventory contains duplicate names",
);
for (const name of [
  "postwave/prod/redis-url",
  "postwave/prod/consent-cursor-signing-key",
  "postwave/prod/portal-jwt",
  "postwave/prod/gemini-api-key",
  "postwave/prod/openai-api-key",
  "postwave/prod/hcti-user-id",
  "postwave/prod/hcti-api-key",
  "postwave/prod/seedlist-registry-json",
  "postwave/prod/seedlist-vendor-api-key",
  "postwave/prod/listmonk-admin-password",
  "postwave/prod/metrics-token",
]) {
  requireContract(
    inventoryNames.includes(name),
    `secret inventory is missing ${name}`,
  );
}
for (const [name, env] of [
  [
    "postwave/prod/consent-cursor-signing-key",
    "POSTWAVE_CONSENT_CURSOR_SIGNING_KEY",
  ],
  ["postwave/prod/dodo-payments-api-key", "DODO_PAYMENTS_API_KEY"],
  ["postwave/prod/dodo-payments-webhook-key", "DODO_PAYMENTS_WEBHOOK_KEY"],
  [
    "moosewave/prod/dodo-payments-product-launch-monthly",
    "DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY",
  ],
  [
    "moosewave/prod/dodo-payments-product-growth-monthly",
    "DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY",
  ],
  [
    "moosewave/prod/dodo-payments-product-scale-monthly",
    "DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY",
  ],
  ["postwave/prod/migration-stripe-secret-key", "STRIPE_SECRET_KEY"],
  ["postwave/prod/migration-mailchimp-client-id", "MAILCHIMP_CLIENT_ID"],
  [
    "postwave/prod/migration-mailchimp-client-secret",
    "MAILCHIMP_CLIENT_SECRET",
  ],
  ["postwave/prod/migration-convertkit-client-id", "CONVERTKIT_CLIENT_ID"],
  [
    "postwave/prod/migration-convertkit-client-secret",
    "CONVERTKIT_CLIENT_SECRET",
  ],
]) {
  requireContract(
    inventoryEnv.get(name) === env,
    `secret inventory must map ${name} to ${env}`,
  );
}

const ecrWorkflow = read(".github/workflows/ecr-bridge.yml");
for (const token of [
  "IMMUTABLE_WITH_EXCLUSION",
  'filter: "latest"',
  'filter: "main"',
  "aws ecr describe-repositories",
  "aws ecr describe-images",
  "existing_digest",
  'ECR_REF="${ECR_REPO}@${GHCR_DIGEST}"',
  "observability-collector",
  "campaign-assurance",
  "campaign-assurance-image-services",
  "- web",
  "inputs.service",
  "canonical production promotion requires AWS_REGION=us-west-2",
  '.mutability == "IMMUTABLE"',
]) {
  requireContract(
    ecrWorkflow.includes(token),
    `ECR bridge is missing ${token}`,
  );
}

const observabilityStack = read("infra/aws/observability-stack.yaml");
for (const token of [
  "AWS::APS::Workspace",
  "KmsKeyArn: !GetAtt ObservabilityKey.Arn",
  "AWS::APS::RuleGroupsNamespace",
  "AlertManagerDefinition:",
  "AWS::Grafana::Workspace",
  "AuthenticationProviders: [AWS_SSO]",
  "PermissionType: CUSTOMER_MANAGED",
  "NetworkAccessControl:",
  "AWS::ECR::Repository",
  "RepositoryName: postwave-observability-collector",
  "ImageTagMutability: IMMUTABLE",
  "CollectorImageDigest:",
  "DeployCollector:",
  "DesiredCount: !If [CollectorEnabled, 1, 0]",
  "ReadonlyRootFilesystem: true",
  'User: "10001"',
  "Drop: [ALL]",
  'Command: ["--config=env:AOT_CONFIG_CONTENT"]',
  "ValueFrom: !Ref MetricsTokenSecretArn",
  "AWS::EC2::VPCEndpoint",
  "AWS::ECS::Service",
]) {
  requireContract(
    observabilityStack.includes(token),
    `observability stack is missing ${token}`,
  );
}
const collectorParameter = observabilityStack.slice(
  observabilityStack.indexOf("  CollectorImageDigest:"),
  observabilityStack.indexOf("  DeployCollector:"),
);
requireContract(
  collectorParameter.length > 0 && !collectorParameter.includes("Default:"),
  "collector digest parameter must not have a mutable, stale, or fallback default",
);
requireContract(
  count(observabilityStack, /- job_name: postwave-[a-z]+/gu) === 5 &&
    count(observabilityStack, /credentials: \$\{!env:METRICS_TOKEN\}/gu) === 5,
  "collector must authenticate exactly five governed scrape targets",
);

const cloudWatchAlarms = read("infra/aws/cloudwatch-alarms.yaml");
for (const token of [
  "CampaignAssuranceServiceName:",
  "Default: postwave-campaign-assurance",
  "ExpectedCampaignAssuranceTaskCount:",
  "CampaignAssuranceLogGroupName:",
  "Default: /ecs/postwave-campaign-assurance",
  "CampaignAssuranceCPUHighAlarm:",
  "AlarmName: postwave-campaign-assurance-cpu-high",
  "CampaignAssuranceMemoryHighAlarm:",
  "AlarmName: postwave-campaign-assurance-memory-high",
  "CampaignAssuranceRunningTasksLowAlarm:",
  "Threshold: !Ref ExpectedCampaignAssuranceTaskCount",
  "CampaignAssuranceErrorMetricFilter:",
  "MetricName: CampaignAssuranceErrorLogCount",
  "CampaignAssuranceErrorLogsAlarm:",
  "AlarmName: postwave-campaign-assurance-error-logs",
  "EmailHMACProjectionFailureMetricFilter:",
  "MetricName: EmailHMACProjectionFailureCount",
  "AlarmName: postwave-email-hmac-projection-failed",
  "EmailHMACProjectionStaleMetricFilter:",
  "MetricName: EmailHMACProjectionStaleCount",
  "AlarmName: postwave-email-hmac-projection-stale",
  "Recent Campaign Assurance errors",
]) {
  requireContract(
    cloudWatchAlarms.includes(token),
    `CloudWatch alarm stack is missing Campaign Assurance contract ${token}`,
  );
}
requireContract(
  count(
    cloudWatchAlarms,
    /ServiceName\n\s+Value: !Ref CampaignAssuranceServiceName/gu,
  ) === 3 && count(cloudWatchAlarms, /CampaignAssuranceLogGroupName/gu) >= 3,
  "Campaign Assurance CPU, memory, running-task, log filter, and dashboard dimensions must stay wired",
);

const observabilityRunbook = read("infra/aws/OBSERVABILITY_RUNBOOK.md");
for (const token of [
  "CampaignAssuranceServiceName=postwave-campaign-assurance",
  "ExpectedCampaignAssuranceTaskCount=2",
  "CampaignAssuranceLogGroupName=/ecs/postwave-campaign-assurance",
  "services postwave-api postwave-campaign-assurance",
  "not a sixth scrape target",
  "do not force-deploy it during token rotation",
  "Campaign Assurance CPU, memory, running-task, and structured-error",
  "email-HMAC projection failure and 15-minute staleness",
]) {
  requireContract(
    observabilityRunbook.includes(token),
    `observability runbook is missing Campaign Assurance operation ${token}`,
  );
}
requireContract(
  observabilityRunbook.includes("exactly five `Scrape job added` messages") &&
    observabilityRunbook.includes("all five `up` series"),
  "Campaign Assurance alarms must not change the five authenticated metrics-target contract",
);

const collectorLock = json("infra/aws/observability-image-lock.json");
const collectorDockerfile = read("infra/observability/image/Dockerfile");
const collectorBuilderManifest = read(
  "infra/observability/image/builder-config.yaml",
);
requireContract(
  collectorLock.runtimeBase === "scratch" &&
    collectorDockerfile.includes("FROM scratch") &&
    collectorDockerfile.includes(
      `ARG GO_IMAGE=${collectorLock.builderImage}`,
    ) &&
    collectorDockerfile.includes("COPY collector/ ./collector/") &&
    collectorDockerfile.includes("-mod=readonly") &&
    collectorDockerfile.includes("go mod verify") &&
    !collectorDockerfile.includes("go install "),
  "collector runtime and build toolchain must match the reviewed image lock",
);
requireContract(
  Object.values(collectorLock.components).flat().length === 7 &&
    Object.keys(collectorLock.sourceChecksums).length === 9 &&
    !collectorBuilderManifest.includes("otlpreceiver") &&
    !collectorBuilderManifest.includes("debugexporter"),
  "collector build must remain limited to the seven governed runtime modules",
);

const dockerPushWorkflow = read(".github/workflows/docker-push.yml");
const trivyWorkflow = read(".github/workflows/trivy.yml");
const verifyImagesWorkflow = read(".github/workflows/verify-images.yml");
const testWorkflow = read(".github/workflows/test.yml");
for (const [source, token, message] of [
  [dockerPushWorkflow, "service: web", "web publish matrix entry"],
  [
    dockerPushWorkflow,
    "NEXT_PUBLIC_APP_URL=https://app.moosewave.com",
    "canonical web build arguments",
  ],
  [
    dockerPushWorkflow,
    "NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY=${{ vars.POSTWAVE_WEB_CONSENT_SITE_KEY }}",
    "tenant-bound consent evidence build input",
  ],
  [
    dockerPushWorkflow,
    "NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN=${{ vars.POSTWAVE_WEB_UPLOAD_ORIGIN }}",
    "exact production upload CSP origin",
  ],
  [
    dockerPushWorkflow,
    "NEXT_PUBLIC_POSTWAVE_API_BASE_URL=https://api.moosewave.com",
    "canonical consent evidence API origin",
  ],
  [
    dockerPushWorkflow,
    "verify-web-image.sh",
    "web artifact-content/startup gate",
  ],
  [
    dockerPushWorkflow,
    "docker/setup-qemu-action@",
    "multi-platform runtime emulation",
  ],
  [
    dockerPushWorkflow,
    'POSTWAVE_WEB_IMAGE_PLATFORM="$platform"',
    "both web platform runtime gates",
  ],
  [
    dockerPushWorkflow,
    "service: observability-collector",
    "collector publish matrix entry",
  ],
  [
    dockerPushWorkflow,
    "service: campaign-assurance-image-services",
    "Campaign Assurance image-services publish entry",
  ],
  [
    dockerPushWorkflow,
    "target: campaign-assurance-core",
    "minimal Campaign Assurance core target",
  ],
  [
    dockerPushWorkflow,
    "target: campaign-image-services",
    "isolated Campaign Assurance image-services target",
  ],
  [
    dockerPushWorkflow,
    "verify-campaign-assurance-image.sh",
    "multi-platform Campaign Assurance role/identity verification",
  ],
  [
    dockerPushWorkflow,
    "CLAMAV_DATABASE_VERSION=${{ steps.assurance_image_lock.outputs.clamav_database_revision }}",
    "locked ClamAV daily database revision",
  ],
  [dockerPushWorkflow, "provenance: true", "collector provenance attestation"],
  [dockerPushWorkflow, "sbom: true", "collector SBOM attestation"],
  [trivyWorkflow, "name: web", "web vulnerability scan matrix entry"],
  [
    trivyWorkflow,
    "name: campaign-assurance-image-services",
    "Campaign Assurance image-services vulnerability scan",
  ],
  [
    trivyWorkflow,
    "NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY=pwk_0123456789abcdef0123456789abcdef0123456789abcdef",
    "non-published web scan consent-key fixture",
  ],
  [
    trivyWorkflow,
    "NEXT_PUBLIC_POSTWAVE_API_BASE_URL=https://api.moosewave.com",
    "non-published web scan consent API origin",
  ],
  [
    trivyWorkflow,
    "NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN=https://postwave-uploads-scan.s3.us-west-2.amazonaws.com",
    "non-published web scan upload CSP origin",
  ],
  [trivyWorkflow, "verify-web-image.sh", "web hardened startup scan gate"],
  [
    verifyImagesWorkflow,
    "            web,",
    "nightly web signature verification",
  ],
  [
    verifyImagesWorkflow,
    "            campaign-assurance-image-services,",
    "nightly Campaign Assurance image-services signature verification",
  ],
  [
    testWorkflow,
    "infra/aws/cloudformation/postwave-web.yaml",
    "web CloudFormation CI lint",
  ],
  [
    trivyWorkflow,
    "name: observability-collector",
    "collector vulnerability scan matrix entry",
  ],
  [
    trivyWorkflow,
    "aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25",
    "pinned Trivy action v0.36.0",
  ],
  [trivyWorkflow, "version: v0.74.0", "pinned current Trivy engine"],
]) {
  requireContract(
    source.includes(token),
    `release workflows are missing ${message}`,
  );
}

const auditPortalScanEntry = trivyWorkflow.slice(
  trivyWorkflow.indexOf("          - name: audit-portal"),
  trivyWorkflow.indexOf("          - name: observability-collector"),
);
const blockingTrivyGate = trivyWorkflow.slice(
  trivyWorkflow.indexOf(
    "      - name: Run Trivy (block PR on HIGH/CRITICAL fixable)",
  ),
);
requireContract(
  auditPortalScanEntry.includes("dockerfile: apps/audit-portal/Dockerfile") &&
    blockingTrivyGate.includes('severity: "CRITICAL,HIGH"') &&
    blockingTrivyGate.includes("ignore-unfixed: true") &&
    blockingTrivyGate.includes('exit-code: "1"'),
  "audit portal must remain in the image matrix governed by the zero-fixable-HIGH/CRITICAL Trivy gate",
);

const dockerIgnore = read(".dockerignore");
for (const buildContextExclusion of [
  "**/.next-*",
  "**/.terraform",
  "**/.venv",
  "**/vendor",
  "apps/product-video/out",
  "apps/product-video/**",
  "**/test-results",
  "**/playwright-report",
  "**/audit-screenshots",
  "**/.playwright-mcp",
  "**/*.mp4",
  "**/*.pem",
  "**/*.key",
  "**/*.tfvars",
  "**/*.tfstate",
  "**/*.tfplan",
  "apps/api/api",
  "apps/api/engagement-corpus",
  "**/.cxx",
  "infra/observability/image/collector/collector",
  "infra/observability/image/healthcheck/healthcheck",
  "backups/**",
  "data/**",
  "sites/**",
]) {
  requireContract(
    dockerIgnore.split(/\r?\n/u).includes(buildContextExclusion),
    `.dockerignore must keep ${buildContextExclusion} out of every production image build context`,
  );
}

const webDockerfile = read("apps/web/Dockerfile");
const auditPortalDockerfile = read("apps/audit-portal/Dockerfile");
requireContract(
  auditPortalDockerfile.includes(
    "FROM nginxinc/nginx-unprivileged:1.30.4-alpine3.24@sha256:442753882674b49ae2c1de83ed67896131c0777f56df5005e356e62bc3f7e7ce AS runtime",
  ) &&
    auditPortalDockerfile.includes("COPY apps/audit-portal apps/audit-portal") &&
    !auditPortalDockerfile.includes("COPY . .") &&
    auditPortalDockerfile.includes("USER 101:101"),
  "audit portal image must copy only package-local build inputs and run as the pinned non-root account",
);
const webNextConfig = read("apps/web/next.config.mjs");
const webBuildCheck = read("apps/web/scripts/check-container-build-env.mjs");
const webEnvSchema = read("apps/web/scripts/env-schema.mjs");
const webImageCheck = read("scripts/release/verify-web-image.sh");
const webHealthRoute = read("apps/web/src/app/healthz/route.ts");
const webApiDocRoute = read(
  "apps/web/src/app/(docs)/docs/api/[endpoint]/page.tsx",
);
const webSkillDocRoute = read(
  "apps/web/src/app/(docs)/docs/skills/[skill]/page.tsx",
);
const webSkillLoader = read("apps/web/src/lib/docs/loadSkills.ts");
const webBaseImages = [
  ...webDockerfile.matchAll(
    /FROM node:24\.16\.0-alpine3\.22@(sha256:[0-9a-f]{64})/gu,
  ),
].map((match) => match[1]);
requireContract(
  webDockerfile.startsWith(
    "# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e",
  ) &&
    webNextConfig.includes('output: "standalone"') &&
    webNextConfig.includes("productionBrowserSourceMaps: false") &&
    webNextConfig.includes("experimental: {") &&
    webNextConfig.includes("cpus: 2") &&
    webBaseImages.length === 2 &&
    new Set(webBaseImages).size === 1 &&
    webDockerfile.includes("/app/apps/web/.next/standalone") &&
    webDockerfile.includes('CMD ["node", "server.js"]') &&
    !webDockerfile.includes("/app ./") &&
    !webDockerfile.includes('CMD ["pnpm"') &&
    !webDockerfile.includes("--chown=10001:10001") &&
    !webDockerfile.includes("COPY . .") &&
    webDockerfile.includes("COPY apps/web apps/web") &&
    webDockerfile.includes(
      "COPY packages/notifications/package.json packages/notifications/package.json",
    ) &&
    webDockerfile.includes("pnpm --filter '@postwave/web^...' build") &&
    webDockerfile.includes("mcp-catalog:check") &&
    webDockerfile.includes(".next/standalone/packages/mcp-server") &&
    webDockerfile.includes("chmod -R a-w /app/apps/web/.next/standalone") &&
    webDockerfile.includes("chmod 0700 /app/apps/web/.next/cache"),
  "web runtime must copy and execute only the standalone Next artifact",
);
for (const token of [
  "ARG POSTWAVE_RELEASE",
  "ARG NEXT_PUBLIC_POSTWAVE_RELEASE",
  "ARG NEXT_PUBLIC_SITE_URL",
  "ARG NEXT_PUBLIC_APP_URL",
  "ARG NEXT_PUBLIC_DOCS_URL",
  "ARG NEXT_PUBLIC_FORMS_ORIGIN",
  "ARG NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY",
  "ARG NEXT_PUBLIC_POSTWAVE_API_BASE_URL",
  "check-container-build-env.mjs",
  "apk upgrade --no-cache",
  "USER 10001:10001",
  "http://127.0.0.1:3000/healthz",
]) {
  requireContract(
    webDockerfile.includes(token),
    `web Dockerfile is missing ${token}`,
  );
}
requireContract(
  webBuildCheck.includes("https://moosewave.com") &&
    webBuildCheck.includes("https://app.moosewave.com") &&
    webBuildCheck.includes("https://docs.moosewave.com") &&
    webBuildCheck.includes("https://forms.moosewave.com") &&
    webBuildCheck.includes("NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY") &&
    webBuildCheck.includes("^pwk_[0-9a-f]{48}$") &&
    webBuildCheck.includes("NEXT_PUBLIC_POSTWAVE_API_BASE_URL") &&
    webBuildCheck.includes("^[0-9a-f]{40}$"),
  "web build input gate must pin canonical origins and full release identity",
);
requireContract(
  webEnvSchema.includes(
    "NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY is required for production cookie-consent evidence delivery",
  ) &&
    webEnvSchema.includes(
      "NEXT_PUBLIC_POSTWAVE_API_BASE_URL is required for production cookie-consent evidence delivery",
    ) &&
    webEnvSchema.includes("^pwk_[0-9a-f]{48}$"),
  "general web production environment validation must fail closed without the consent evidence destination",
);
requireContract(
  webImageCheck.includes("--read-only") &&
    webImageCheck.includes("apps/web/src") &&
    webImageCheck.includes("^app/.*\\.map$") &&
    webImageCheck.includes("devDependencies") &&
    webImageCheck.includes("419430400") &&
    webImageCheck.includes("v24.16.0") &&
    webImageCheck.includes("POSTWAVE_WEB_IMAGE_PLATFORM") &&
    webImageCheck.includes("stat -c %u:%g /app/apps/web/server.js") &&
    webImageCheck.includes("apple-app-site-association") &&
    webImageCheck.includes("assetlinks.json") &&
    webImageCheck.includes('require("mjml")') &&
    webImageCheck.includes("id -u"),
  "web image gate must enforce size, source/map/dev-dependency absence, immutable ownership, and multi-platform non-root read-only startup",
);
requireContract(
  webHealthRoute.includes('dynamic = "force-dynamic"') &&
    webHealthRoute.includes('runtime = "nodejs"') &&
    webHealthRoute.includes('"cache-control": "no-store, max-age=0"') &&
    webHealthRoute.includes('{"status":"ok","service":"postwave-web"}') &&
    !webHealthRoute.includes("fetch("),
  "web /healthz must be an uncached local process-liveness route",
);
requireContract(
  [webApiDocRoute, webSkillDocRoute].every(
    (source) =>
      source.includes('dynamic = "force-static"') &&
      source.includes("revalidate = 86_400") &&
      source.includes("generateStaticParams(): []"),
  ) &&
    webSkillLoader.includes("mcp-tool-details.generated.json") &&
    !webSkillLoader.includes('from "node:fs"'),
  "long-tail docs must render on demand from generated data without shipping tool source",
);

const webRunbook = read("infra/aws/WEB_DEPLOY_RUNBOOK.md");
const webBootstrap = webRunbook.indexOf("DeployWebService=false");
const webBridge = webRunbook.indexOf("gh workflow run ecr-bridge.yml");
const webVerified = webRunbook.indexOf(
  "set_web_parameter WebArtifactVerified true",
  webBridge,
);
const webEnabled = webRunbook.indexOf(
  "set_web_parameter DeployWebService true",
  webVerified,
);
requireContract(
  webBootstrap >= 0 &&
    webBridge > webBootstrap &&
    webVerified > webBridge &&
    webEnabled > webVerified,
  "web runbook must preserve desired-zero bootstrap, verified promotion, then enablement order",
);
for (const token of [
  "configured, not certified",
  "cosign verify",
  "@${WEB_IMAGE_DIGEST}",
  "/healthz",
  "ReadonlyRootFilesystem",
  "deployment circuit breaker",
  "set_web_parameter CreateDnsRecord true",
  "PREVIOUS_WEB_IMAGE_DIGEST",
  "-f service=web",
  "describe-subnets",
  "BASH_VERSION",
  "set_web_parameter()",
  "POSTWAVE_WEB_CONSENT_SITE_KEY",
  "^pwk_[0-9a-f]{48}$",
  "Origin: https://moosewave.com",
  '"invalid_visitor_id"',
  "access-control-allow-origin",
  "reject-optional canary",
]) {
  requireContract(
    webRunbook.includes(token),
    `web runbook is missing ${token}`,
  );
}

const dockerfile = read("Dockerfile.go");
const migratorDockerfile = read("infra/migrations/Dockerfile");
const migrationManifestBuilder = read(
  "scripts/release/build-migration-manifest.sh",
);
const opsDockerfile = read("apps/ops/Dockerfile");
const backupDockerfile = read("infra/backup/image/Dockerfile");
const assuranceImageLock = json("infra/aws/campaign-assurance-image-lock.json");
const assuranceImageVerifier = read(
  "scripts/release/verify-campaign-assurance-image.sh",
);
requireContract(
  dockerfile.includes("/out/runtime/proprietary") &&
    dockerfile.includes("/etc/postwave/proprietary") &&
    dockerfile.includes("proprietary/prompts/diagnostician") &&
    dockerfile.includes("proprietary/eval/diagnostician-cases") &&
    dockerfile.includes("proprietary/prompts/voice") &&
    dockerfile.includes("proprietary/templates/voice-templates") &&
    !dockerfile.includes("cp -a proprietary/."),
  "voice/deliverability images must carry only their reviewed runtime packs",
);
requireContract(
  count(dockerfile, /libcrypto3=3\.5\.8-r0/gu) === 2 &&
    count(dockerfile, /libssl3=3\.5\.8-r0/gu) === 2 &&
    migratorDockerfile.includes("libcrypto3=3.5.8-r0") &&
    migratorDockerfile.includes("libssl3=3.5.8-r0") &&
    opsDockerfile.includes("libcrypto3=3.5.8-r0") &&
    opsDockerfile.includes("libssl3=3.5.8-r0"),
  "every Alpine application runtime must pin the reviewed OpenSSL security revision",
);
requireContract(
  migratorDockerfile.includes(
    "COPY --from=build /src/infra/migrations/*.sql /migrations/",
  ) &&
    migratorDockerfile.includes(
      "COPY --from=build /src/infra/migrations/checksum-supersessions.json /migrations/checksum-supersessions.json",
    ) &&
    !migratorDockerfile.includes(
      "COPY --from=build /src/infra/migrations /migrations",
    ),
  "migrator runtime must contain only migration SQL and its governed checksum ledger, not build files or runbooks",
);
requireContract(
  count(
    migrationManifestBuilder,
    /1839:1839_email_verification\.sql:1839_landing_page_variants\.sql/gu,
  ) === 1 &&
    migrationManifestBuilder.includes(
      '*) fail "duplicate numeric migration prefix: ${prefix} (${filename})" ;;',
    ),
  "migrator manifest must allow only the exact already-shipped 1839 pair and fail closed on every other collision",
);
requireContract(
  backupDockerfile.includes(
    'ARG POSTGRES_IMAGE="postgres:16.15-alpine3.23@sha256:421b84e07a72bb8f3715f20501a1fdbe1219aad1fa4af7786a49d9a3f2480296"',
  ) &&
    backupDockerfile.includes('ARG OPENSSL_APK_VERSION="3.5.8-r0"') &&
    backupDockerfile.includes('ARG LIBUUID_APK_VERSION="2.41.6-r1"') &&
    backupDockerfile.includes('"libuuid=${LIBUUID_APK_VERSION}"'),
  "backup runtime must pin the reviewed PostgreSQL, OpenSSL, and libuuid patch boundary",
);
requireContract(
  assuranceImageLock.schemaVersion ===
    "postwave.campaign-assurance-image-lock.v1" &&
    Number.isInteger(assuranceImageLock.clamav?.dailyDatabaseRevision) &&
    assuranceImageLock.clamav.dailyDatabaseRevision > 0 &&
    assuranceImageLock.clamav.engineVersion === "1.4.4-r0" &&
    assuranceImageLock.tesseract?.engineVersion === "5.5.1-r0" &&
    assuranceImageLock.tesseract?.englishDataVersion === "5.5.1-r0",
  "Campaign Assurance tool versions and ClamAV daily database must be review-locked",
);
for (const token of [
  "AS campaign-assurance-core",
  "FROM --platform=$BUILDPLATFORM",
  "AS clamav-database",
  "AS campaign-image-services",
  "ARG CLAMAV_DATABASE_REFRESH",
  "ARG CLAMAV_DATABASE_VERSION",
  "actual_database_version",
  "AS ordinary-service",
  "COPY --from=build /out/bin/postwave-service /usr/local/bin/postwave-service",
]) {
  requireContract(
    dockerfile.includes(token),
    `Dockerfile is missing Campaign Assurance image boundary ${token}`,
  );
}
for (const token of [
  "linux/amd64 linux/arm64",
  "expected_database_revision",
  "eng.sha256",
  "freshclam",
  "postwave.campaign-assurance-image-services-verification.v1",
]) {
  requireContract(
    assuranceImageVerifier.includes(token),
    `Campaign Assurance image verifier is missing ${token}`,
  );
}

const runbook = read("infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md");
const apiMain = read("apps/api/main.go");
const bootstrapMain = runbook.indexOf("DeployApplicationServices=false");
const bootstrapSidecars = runbook.indexOf("DeploySidecarServices=false");
const firstMigration = runbook.indexOf("run_migrator \\");
const verifyMigration = runbook.indexOf("run_migrator\n", firstMigration + 1);
const enableSidecars = runbook.indexOf("DeploySidecarServices=true");
const enableMain = runbook.indexOf("DeployApplicationServices=true");
const enableAssurance = runbook.indexOf("DeployCampaignAssuranceService=true");
const waitForAssurance = runbook.indexOf(
  "postwave-api postwave-campaign-assurance",
  enableAssurance,
);
const enterAssuranceShadow = runbook.indexOf(
  "deploy_api_assurance_rollout shadow",
  waitForAssurance,
);
requireContract(
  bootstrapMain >= 0 &&
    bootstrapSidecars >= 0 &&
    firstMigration > bootstrapMain &&
    firstMigration > bootstrapSidecars &&
    verifyMigration > firstMigration &&
    enableSidecars > verifyMigration &&
    enableMain > enableSidecars,
  "runbook must keep API/sidecars at zero through two successful migrator runs",
);
requireContract(
  enableAssurance > enableMain &&
    waitForAssurance > enableAssurance &&
    enterAssuranceShadow > waitForAssurance,
  "runbook must make the assurance worker healthy before enabling API shadow mode",
);
for (const token of [
  "postwave-campaign-assurance-image-services",
  "CAMPAIGN_ASSURANCE_IMAGE_SERVICES_IMAGE_DIGEST",
  "campaign-assurance-image-services-verification-${GIT_SHA}",
  "postwave.campaign-assurance-image-services-verification.v1",
  'export ASSURANCE_OCR_VERSION="$(jq -r',
  'export ASSURANCE_SCANNER_VERSION="$(jq -r',
  "ecs-campaign-assurance-task-definition.resolved.json",
  "ASSURANCE_TASK_DEFINITION_ARN",
  "CampaignAssuranceTaskDefinitionArn=${ASSURANCE_TASK_DEFINITION_ARN}",
  "CampaignAssuranceImageEvidenceBucketName=${ASSURANCE_IMAGE_EVIDENCE_BUCKET}",
  "register_api_assurance_rollout",
  "deploy_api_assurance_rollout warn",
  "deploy_api_assurance_rollout block",
  "shadow-to-warn.json",
  "warn-to-block.json",
  ".credentialed_capture.reviewed == true",
  ".production_load.reviewed == true",
  ".policy.predicted_score_advisory_only == true",
  "--service postwave-campaign-assurance --desired-count 0",
]) {
  requireContract(
    runbook.includes(token),
    `Campaign Assurance deployment runbook is missing ${token}`,
  );
}
requireContract(
  !runbook.includes("<[^>]+>|XXXXXX|us-west-2|postwave\\.com"),
  "runbook placeholder checks must not reject the canonical production region/domain",
);
requireContract(
  runbook.includes("DB_MIGRATOR_IMAGE_DIGEST") &&
    !runbook.includes("MIGRATOR_DIGEST=$(aws ecr describe-images"),
  "runbook must reuse the once-resolved migrator digest",
);
requireContract(
  !runbook.includes("-f infra/postgres/init.sql"),
  "runbook must never execute the local fixed-password Postgres initializer",
);
requireContract(
  runbook.includes("PrimaryBackupBucketName") &&
    runbook.includes("BackupWriterManagedPolicyArn") &&
    !runbook.includes('ensure_bucket "$BACKUPS_BUCKET"') &&
    !runbook.includes("export BACKUPS_BUCKET="),
  "runbook must delegate portable backups to the standalone backup/DR stack",
);
for (const token of [
  "verify_dodo_product DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY recurring LAUNCH usd 3900 month",
  "verify_dodo_product DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY recurring GROWTH usd 9900 month",
  "verify_dodo_product DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY recurring SCALE usd 34900 month",
  "Dodo Payments plans must use three distinct Product IDs",
  "DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY",
  "DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY",
  "DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY",
  "MOOSEWAVE_BILLING_LAUNCH_APPROVAL must name an approved release record",
  "External go-live blocker: approved commercial input",
  "MIGRATION_STRIPE_SECRET_KEY must be a Stripe live restricted key",
  "Subscriptions: Read",
  "Customers: Read",
  "Never reuse",
  "packages/migrate/stripeconnect",
  ".price.currency == $currency",
  ".price.price == $amount",
  '.price.type == "recurring_price"',
  "--connect-timeout 10 --max-time 30",
  'dodo_curl_config="$(mktemp /tmp/postwave-deploy/dodo-curl.XXXXXX)"',
  'chmod 0600 "$dodo_curl_config"',
  'header = "Authorization: Bearer %s"',
  '--config "$dodo_curl_config"',
  "trap 'rm -f -- \"$dodo_curl_config\"' EXIT HUP INT TERM",
  "trap - EXIT HUP INT TERM",
  "https://live.dodopayments.com/products/${product_id}",
  "https://live.dodopayments.com/webhooks",
  'dodo_webhook_endpoint="https://api.${DOMAIN}/api/public/dodo/webhook"',
  "payment.succeeded",
  "payment.failed",
  "payment.cancelled",
  "subscription.active",
  "subscription.updated",
  "subscription.renewed",
  "subscription.plan_changed",
  "subscription.past_due",
  "subscription.on_hold",
  "subscription.paused",
  "subscription.unpaused",
  "subscription.cancelled",
  "subscription.failed",
  "subscription.expired",
  "refund.succeeded",
  "dunning.started",
  "dunning.recovered",
  "create_secret postwave/prod/dodo-payments-api-key",
  "create_secret postwave/prod/dodo-payments-webhook-key",
  "create_secret moosewave/prod/dodo-payments-product-launch-monthly",
  "create_secret moosewave/prod/dodo-payments-product-growth-monthly",
  "create_secret moosewave/prod/dodo-payments-product-scale-monthly",
  "create_secret postwave/prod/consent-cursor-signing-key",
  "create_secret postwave/prod/migration-stripe-secret-key",
  "create_secret postwave/prod/migration-mailchimp-client-id",
  "create_secret postwave/prod/migration-mailchimp-client-secret",
  "create_secret postwave/prod/migration-convertkit-client-id",
  "create_secret postwave/prod/migration-convertkit-client-secret",
  "MigrationStripeSecretKeyArn=${MIGRATION_STRIPE_SECRET_KEY_ARN}",
  "MailchimpClientIdSecretArn=${MAILCHIMP_CLIENT_ID_SECRET_ARN}",
  "MailchimpClientSecretArn=${MAILCHIMP_CLIENT_SECRET_ARN}",
  "ConvertKitClientIdSecretArn=${CONVERTKIT_CLIENT_ID_SECRET_ARN}",
  "ConvertKitClientSecretArn=${CONVERTKIT_CLIENT_SECRET_ARN}",
  'MigrationOAuthRedirectUri="https://app.${DOMAIN}/app/migrations/oauth/callback?source={source}"',
  'ActiveCampaignAllowedAPIHosts="${ACTIVECAMPAIGN_ALLOWED_API_HOSTS:-}"',
  "https://app.${DOMAIN}/app/migrations/oauth/callback?source=mailchimp",
  "https://app.${DOMAIN}/app/migrations/oauth/callback?source=convertkit",
  "Static Checkout and Customer Portal URLs are not deployment inputs",
]) {
  requireContract(runbook.includes(token), `runbook is missing ${token}`);
}
requireContract(
  !runbook.includes("curl --user") &&
    !runbook.includes('--user "${STRIPE_SECRET_KEY}:"'),
  "runbook must not expose a Stripe key in process arguments",
);
requireContract(
  runbook.includes("`POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE` is unset") &&
    !/POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE\s*=/u.test(runbook),
  "runbook must keep the privileged database-role escape hatch unset",
);
requireContract(
  apiMain.includes(
    'Method(http.MethodPost, "/api/public/dodo/webhook", dodoBillingWebhook)',
  ) &&
    runbook.includes("https://api.${DOMAIN}/api/public/dodo/webhook") &&
    runbook.includes("https://api.moosewave.com/api/public/dodo/webhook") &&
    !runbook.includes("/api/webhooks/dodo"),
  "runbook must configure the actual public Dodo Payments webhook route",
);
for (const event of [
  "payment.succeeded",
  "payment.failed",
  "payment.cancelled",
  "subscription.active",
  "subscription.updated",
  "subscription.renewed",
  "subscription.plan_changed",
  "subscription.past_due",
  "subscription.on_hold",
  "subscription.paused",
  "subscription.unpaused",
  "subscription.cancelled",
  "subscription.failed",
  "subscription.expired",
  "refund.succeeded",
  "dunning.started",
  "dunning.recovered",
]) {
  requireContract(
    read("apps/api/internal/billing/dodo_webhook.go").includes(
      `"${event}"`,
    ) && runbook.includes(event),
    `Dodo Payments endpoint must enable the handled billing event ${event}`,
  );
}
const dodoConfigCreated = runbook.indexOf(
  'dodo_curl_config="$(mktemp /tmp/postwave-deploy/dodo-curl.XXXXXX)"',
);
const dodoConfigTrap = runbook.indexOf(
  "trap 'rm -f -- \"$dodo_curl_config\"' EXIT HUP INT TERM",
  dodoConfigCreated,
);
const firstDodoRequest = runbook.indexOf(
  '--config "$dodo_curl_config"',
  dodoConfigTrap,
);
const dodoConfigCleanup = runbook.indexOf(
  'rm -f -- "$dodo_curl_config"',
  firstDodoRequest,
);
requireContract(
  dodoConfigCreated >= 0 &&
    dodoConfigTrap > dodoConfigCreated &&
    firstDodoRequest > dodoConfigTrap &&
    dodoConfigCleanup > firstDodoRequest,
  "runbook must install cleanup before using the private Dodo Payments curl config",
);

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "PASS AWS deployment contracts are internally consistent\n",
  );
}
