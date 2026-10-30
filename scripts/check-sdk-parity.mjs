#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const tsDir = join(ROOT, "packages/sdk-ts/src/resources");
const pyDir = join(ROOT, "packages/sdk-py/postwave/resources");
const phpResDir = join(ROOT, "packages/sdk-php/src/Resources");
const pyClient = readFileSync(
  join(ROOT, "packages/sdk-py/postwave/client.py"),
  "utf8",
);
const tsClient = readFileSync(
  join(ROOT, "packages/sdk-ts/src/client.ts"),
  "utf8",
);
const phpClient = readFileSync(
  join(ROOT, "packages/sdk-php/src/Client.php"),
  "utf8",
);

const expected = readdirSync(tsDir)
  .filter((name) => name.endsWith(".ts"))
  .filter((name) => !name.startsWith("_"))
  .map((name) => name.replace(/\.ts$/, ""))
  .sort();

let failed = false;
for (const tsName of expected) {
  const pyName = tsName.replaceAll("-", "_");
  const pyFile = join(pyDir, `${pyName}.py`);
  const hasFile = existsSync(pyFile);
  const hasSyncAccessor = pyClient.includes(`self.${pyName} = `);
  const hasAsyncAccessor = pyClient.includes(`self.${pyName} = Async`);
  const status =
    hasFile && hasSyncAccessor && hasAsyncAccessor ? "PASS" : "FAIL";
  console.log(`${status} ${tsName} -> ${pyName}`);
  if (!hasFile)
    console.log(
      `  - missing Python resource file: packages/sdk-py/postwave/resources/${pyName}.py`,
    );
  if (!hasSyncAccessor) console.log(`  - missing Moosewave.${pyName} accessor`);
  if (!hasAsyncAccessor)
    console.log(`  - missing AsyncPostwave.${pyName} accessor`);
  if (status === "FAIL") failed = true;
}

const methodParity = [
  {
    resource: "analytics",
    tsFile: "analytics.ts",
    pyFile: "analytics.py",
    methods: {
      engagementClassificationSummary: "engagement_classification_summary",
      humanEngagedReach: "human_engaged_reach",
      exportHumanEngagedReachEvidence: "export_human_engaged_reach_evidence",
    },
  },
  {
    resource: "assets",
    tsFile: "assets.ts",
    pyFile: "assets.py",
    methods: {
      upload: "upload",
      list: "list",
      get: "get",
      update: "update",
      usage: "usage",
      delete: "delete",
    },
  },
  {
    resource: "lists",
    tsFile: "lists.ts",
    pyFile: "lists.py",
    methods: {
      list: "list",
      create: "create",
      delete: "delete",
      forSubscriber: "for_subscriber",
    },
  },
  {
    resource: "subscribers",
    tsFile: "subscribers.ts",
    pyFile: "subscribers.py",
    methods: {
      list: "list",
      get: "get",
      create: "create",
      update: "update",
      delete: "delete",
      search: "search",
      suppress: "suppress",
      transformRules: "transform_rules",
      upsertTransformRule: "upsert_transform_rule",
      deleteTransformRule: "delete_transform_rule",
    },
  },
  {
    resource: "campaigns",
    tsFile: "campaigns.ts",
    pyFile: "campaigns.py",
    methods: {
      list: "list",
      get: "get",
      create: "create",
      update: "update",
      delete: "delete",
      queue: "queue",
      send: "send",
      pause: "pause",
      resume: "resume",
      cancel: "cancel",
      sendTest: "send_test",
    },
  },
  {
    resource: "campaign-templates",
    tsFile: "campaign-templates.ts",
    pyFile: "campaign_templates.py",
    methods: {
      list: "list",
      search: "search",
      get: "get",
      favorite: "favorite",
      unfavorite: "unfavorite",
      compare: "compare",
      recordView: "record_view",
      recent: "recent",
      clearRecent: "clear_recent",
      listCollections: "list_collections",
      getCollection: "get_collection",
      createCollection: "create_collection",
      updateCollection: "update_collection",
      replaceCollectionItems: "replace_collection_items",
      deleteCollection: "delete_collection",
      listSavedSearches: "list_saved_searches",
      getSavedSearch: "get_saved_search",
      createSavedSearch: "create_saved_search",
      updateSavedSearch: "update_saved_search",
      deleteSavedSearch: "delete_saved_search",
      savedSearchResults: "saved_search_results",
      create: "create",
      update: "update",
      archive: "archive",
      restore: "restore",
      delete: "delete",
      listRevisions: "list_revisions",
      getRevision: "get_revision",
      clone: "clone",
      adapt: "adapt",
      generate: "generate",
      createDesign: "create_design",
      listDesigns: "list_designs",
      getDesign: "get_design",
      listDesignRevisions: "list_design_revisions",
      refineDesign: "refine_design",
      retryDesign: "retry_design",
      saveDesign: "save_design",
      createCampaignFromDesign: "create_campaign_from_design",
      archiveDesign: "archive_design",
      waitForDesign: "wait_for_design",
      createCampaign: "create_campaign",
    },
  },
  {
    resource: "migrations",
    tsFile: "migrations.ts",
    pyFile: "migrations.py",
    methods: {
      uploadStatus: "upload_status",
      start: "start",
      callback: "callback",
      credentials: "credentials",
      discover: "discover",
      dryRun: "dry_run",
      commit: "commit",
      deltaImport: "delta_import",
      shadowCheck: "shadow_check",
      startShadowMonitor: "start_shadow_monitor",
      shadowMonitor: "shadow_monitor",
      stopShadowMonitor: "stop_shadow_monitor",
      startSourceEvents: "start_source_events",
      sourceEvents: "source_events",
      stopSourceEvents: "stop_source_events",
      updateSourceEventReview: "update_source_event_review",
      pilotAcceptance: "pilot_acceptance",
      rollbackRehearsal: "rollback_rehearsal",
      automationRebuilds: "automation_rebuilds",
      updateAutomationRebuild: "update_automation_rebuild",
      rollback: "rollback",
      rollbackStatus: "rollback_status",
      listSources: "list_sources",
    },
  },
  {
    resource: "segments",
    tsFile: "segments.ts",
    pyFile: "segments.py",
    methods: {
      list: "list",
      get: "get",
      create: "create",
      update: "update",
      delete: "delete",
      compileFromNaturalLanguage: "compile_from_natural_language",
    },
  },
  {
    resource: "sms",
    tsFile: "sms.ts",
    pyFile: "sms.py",
    methods: {
      setup: "setup",
      compliance: "compliance",
      pilotReadiness: "pilot_readiness",
      senderPilotCertification: "sender_pilot_certification",
      listLists: "list_lists",
      createList: "create_list",
      listSenders: "list_senders",
      upsertSender: "upsert_sender",
      pauseSender: "pause_sender",
      resumeSender: "resume_sender",
      submitBrandRegistration: "submit_brand_registration",
      submitCampaignRegistration: "submit_campaign_registration",
      pollA2PRegistration: "poll_a2p_registration",
      recordConsent: "record_consent",
      listCampaigns: "list_campaigns",
      getCampaign: "get_campaign",
      createCampaign: "create_campaign",
      campaignReport: "campaign_report",
      exportCampaignReport: "export_campaign_report",
      sendCampaign: "send_campaign",
      scheduleCampaign: "schedule_campaign",
      pauseCampaign: "pause_campaign",
      resumeCampaign: "resume_campaign",
      cancelCampaign: "cancel_campaign",
      sendTest: "send_test",
    },
  },
  {
    resource: "push-suppressions",
    tsFile: "push-suppressions.ts",
    pyFile: "push_suppressions.py",
    methods: {
      list: "list",
      add: "add",
      remove: "remove",
      bulkImport: "bulk_import",
      bulkRemove: "bulk_remove",
    },
  },
];

// Split a Python resource module into its sync-class body and its async-class
// body so we can assert each method exists in BOTH variants. The previous
// check used a single `\bdef <name>(` regex that matched EITHER a sync `def`
// OR an `async def` — so a missing async variant (py async drift) slipped
// through. We now locate `class <Name>Resource(SyncResource)` and
// `class Async<Name>Resource(AsyncResource)` and scope each grep to that body.
function splitSyncAsync(pyText, resource) {
  const pascal = resource
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  const findBody = (classRe) => {
    const m = classRe.exec(pyText);
    if (!m) return null;
    const start = m.index;
    // Body runs until the next top-level `class ` declaration (or EOF).
    const rest = pyText.slice(start + m[0].length);
    const nextClass = /\nclass\s+\w+/.exec(rest);
    const end =
      start + m[0].length + (nextClass ? nextClass.index : rest.length);
    return pyText.slice(start, end);
  };
  const sync = findBody(
    new RegExp(`class\\s+${pascal}Resource\\s*\\(\\s*SyncResource\\s*\\)`),
  );
  const async = findBody(
    new RegExp(
      `class\\s+Async${pascal}Resource\\s*\\(\\s*AsyncResource\\s*\\)`,
    ),
  );
  return { sync, async };
}

for (const group of methodParity) {
  const tsText = readFileSync(join(tsDir, group.tsFile), "utf8");
  const pyText = readFileSync(join(pyDir, group.pyFile), "utf8");
  const { sync: syncBody, async: asyncBody } = splitSyncAsync(
    pyText,
    group.resource,
  );
  if (!syncBody) {
    console.log(
      `FAIL ${group.resource}: missing sync class in ${group.pyFile}`,
    );
    failed = true;
  }
  if (!asyncBody) {
    console.log(
      `FAIL ${group.resource}: missing async class in ${group.pyFile}`,
    );
    failed = true;
  }
  for (const [tsMethod, pyMethod] of Object.entries(group.methods)) {
    const hasTS = new RegExp(`\\b${tsMethod}\\s*\\(`).test(tsText);
    // Sync body must have a plain `def`; async body must have `async def`.
    const hasPySync =
      !!syncBody &&
      new RegExp(`(?<!async )\\bdef\\s+${pyMethod}\\s*\\(`).test(syncBody);
    const hasPyAsync =
      !!asyncBody &&
      new RegExp(`\\basync\\s+def\\s+${pyMethod}\\s*\\(`).test(asyncBody);
    const status = hasTS && hasPySync && hasPyAsync ? "PASS" : "FAIL";
    console.log(`${status} ${group.resource}.${tsMethod} -> ${pyMethod}`);
    if (!hasTS) console.log(`  - missing TypeScript method ${tsMethod}`);
    if (!hasPySync)
      console.log(`  - missing Python sync method def ${pyMethod}`);
    if (!hasPyAsync)
      console.log(`  - missing Python async method def ${pyMethod}`);
    if (status === "FAIL") failed = true;
  }
}

// Release-critical contract additions must also exist in PHP. Full PHP
// resource-file coverage below is intentionally informational, so keep this
// small blocking list for routes that are already advertised in OpenAPI and
// shipped by all first-party SDKs.
const criticalPhpMethods = {
  AnalyticsResource: [
    "engagementClassificationSummary",
    "humanEngagedReach",
    "exportHumanEngagedReachEvidence",
  ],
  AssetsResource: ["upload", "list", "get", "update", "usage", "delete"],
  CampaignTemplatesResource: [
    "list",
    "search",
    "get",
    "favorite",
    "unfavorite",
    "compare",
    "recordView",
    "recent",
    "clearRecent",
    "listCollections",
    "getCollection",
    "createCollection",
    "updateCollection",
    "replaceCollectionItems",
    "deleteCollection",
    "listSavedSearches",
    "getSavedSearch",
    "createSavedSearch",
    "updateSavedSearch",
    "deleteSavedSearch",
    "savedSearchResults",
    "create",
    "update",
    "archive",
    "restore",
    "delete",
    "listRevisions",
    "getRevision",
    "clone",
    "adapt",
    "generate",
    "createDesign",
    "listDesigns",
    "getDesign",
    "listDesignRevisions",
    "refineDesign",
    "retryDesign",
    "saveDesign",
    "createCampaignFromDesign",
    "archiveDesign",
    "createCampaign",
  ],
  ListsResource: ["forSubscriber"],
  SubscribersResource: [
    "transformRules",
    "upsertTransformRule",
    "deleteTransformRule",
  ],
  MigrationsResource: [
    "uploadStatus",
    "startShadowMonitor",
    "shadowMonitor",
    "stopShadowMonitor",
    "startSourceEvents",
    "sourceEvents",
    "stopSourceEvents",
    "updateSourceEventReview",
  ],
  NativeIntegrationFamilyResource: ["oauthAvailability", "oauthStartUrl"],
  PushSuppressionsResource: [
    "list",
    "add",
    "remove",
    "bulkImport",
    "bulkRemove",
  ],
};
for (const [resourceClass, methods] of Object.entries(criticalPhpMethods)) {
  const phpFile = join(phpResDir, `${resourceClass}.php`);
  const phpText = existsSync(phpFile) ? readFileSync(phpFile, "utf8") : "";
  for (const method of methods) {
    const present = new RegExp(`\\bfunction\\s+${method}\\s*\\(`).test(phpText);
    console.log(`${present ? "PASS" : "FAIL"} php ${resourceClass}.${method}`);
    if (!present) failed = true;
  }
}

// A resource file alone is insufficient: advertised full-tier users must be
// able to reach the campaign-template surface from the public PHP client.
const hasPhpCampaignTemplateProperty =
  /\bpublic\s+CampaignTemplatesResource\s+\$campaignTemplates\s*;/.test(
    phpClient,
  );
const hasPhpCampaignTemplateConstruction =
  /\$this->campaignTemplates\s*=\s*new\s+CampaignTemplatesResource\s*\(\s*\$this\s*\)\s*;/.test(
    phpClient,
  );
console.log(
  `${hasPhpCampaignTemplateProperty && hasPhpCampaignTemplateConstruction ? "PASS" : "FAIL"} php Client.campaignTemplates accessor`,
);
if (!hasPhpCampaignTemplateProperty || !hasPhpCampaignTemplateConstruction) {
  failed = true;
}

// Route43 is a release-critical exact-admin surface. The generic TS→Python
// file check and informational PHP coverage below do not prove that users can
// reach the resource from each public client: a file with methods but no
// import/property/construction silently ships as dead code. Keep these exact
// resource/accessor markers blocking in all three full-tier SDKs.
const route43Files = {
  ts: readFileSync(join(tsDir, "push-suppressions.ts"), "utf8"),
  py: readFileSync(join(pyDir, "push_suppressions.py"), "utf8"),
  php: readFileSync(join(phpResDir, "PushSuppressionsResource.php"), "utf8"),
};
const route43AccessChecks = [
  {
    label: "ts PushSuppressionsResource declaration",
    present:
      /\bexport\s+class\s+PushSuppressionsResource\s+extends\s+Resource\b/.test(
        route43Files.ts,
      ),
  },
  {
    label: "ts client import",
    present:
      /import\s*\{\s*PushSuppressionsResource\s*\}\s*from\s*["']\.\/resources\/push-suppressions\.js["']\s*;/.test(
        tsClient,
      ),
  },
  {
    label: "ts client property",
    present:
      /\breadonly\s+pushSuppressions\s*:\s*PushSuppressionsResource\s*;/.test(
        tsClient,
      ),
  },
  {
    label: "ts client construction",
    present:
      /this\.pushSuppressions\s*=\s*new\s+PushSuppressionsResource\s*\(\s*this\s*\)\s*;/.test(
        tsClient,
      ),
  },
  {
    label: "python sync resource declaration",
    present:
      /^class\s+PushSuppressionsResource\s*\(\s*SyncResource\s*\)\s*:/m.test(
        route43Files.py,
      ),
  },
  {
    label: "python async resource declaration",
    present:
      /^class\s+AsyncPushSuppressionsResource\s*\(\s*AsyncResource\s*\)\s*:/m.test(
        route43Files.py,
      ),
  },
  {
    label: "python client import",
    present:
      /from\s+\.resources\.push_suppressions\s+import\s+AsyncPushSuppressionsResource\s*,\s*PushSuppressionsResource/.test(
        pyClient,
      ),
  },
  {
    label: "python sync client construction",
    present:
      /self\.push_suppressions\s*=\s*PushSuppressionsResource\s*\(\s*self\s*\)/.test(
        pyClient,
      ),
  },
  {
    label: "python async client construction",
    present:
      /self\.push_suppressions\s*=\s*AsyncPushSuppressionsResource\s*\(\s*self\s*\)/.test(
        pyClient,
      ),
  },
  {
    label: "php PushSuppressionsResource declaration",
    present:
      /\bfinal\s+class\s+PushSuppressionsResource\s+extends\s+Resource\b/.test(
        route43Files.php,
      ),
  },
  {
    label: "php client import",
    present: /\buse\s+Moosewave\\Resources\\PushSuppressionsResource\s*;/.test(
      phpClient,
    ),
  },
  {
    label: "php client property",
    present:
      /\bpublic\s+PushSuppressionsResource\s+\$pushSuppressions\s*;/.test(
        phpClient,
      ),
  },
  {
    label: "php client construction",
    present:
      /\$this->pushSuppressions\s*=\s*new\s+PushSuppressionsResource\s*\(\s*\$this\s*\)\s*;/.test(
        phpClient,
      ),
  },
];
for (const check of route43AccessChecks) {
  console.log(`${check.present ? "PASS" : "FAIL"} route43 ${check.label}`);
  if (!check.present) failed = true;
}

// ---------------------------------------------------------------------------
// Error-model parity (cross-SDK). The TS SDK (packages/sdk-ts/src/errors.ts)
// is the canonical error taxonomy; Python and PHP must expose the same typed
// errors so callers can branch identically on every SDK. This closes the
// audit's "no error-model parity" gap (and the reason sdk-php drifted).
// ---------------------------------------------------------------------------
const CANONICAL_ERRORS = [
  "PostwaveError",
  "AuthError",
  "ForbiddenError",
  "NotFoundError",
  "ConflictError",
  "ValidationError",
  "RateLimitError",
  "ServerError",
  "NetworkError",
  "TimeoutError",
  "RequestAbortedError",
  "WrongRegionError",
  "ParseError",
];
const pyErrors = readFileSync(
  join(ROOT, "packages/sdk-py/postwave/errors.py"),
  "utf8",
);
const phpErrorsDir = join(ROOT, "packages/sdk-php/src/Errors");
console.log("");
for (const cls of CANONICAL_ERRORS) {
  const inPy = new RegExp(`\\bclass\\s+${cls}\\b`).test(pyErrors);
  // A bare existsSync() check would pass for a renamed/empty/stub file. Read
  // the file and assert it actually declares `class <Name>` — symmetric with
  // the Python `class <Name>` regex above.
  const phpFile = join(phpErrorsDir, `${cls}.php`);
  const inPhp =
    existsSync(phpFile) &&
    new RegExp(`\\bclass\\s+${cls}\\b`).test(readFileSync(phpFile, "utf8"));
  const status = inPy && inPhp ? "PASS" : "FAIL";
  console.log(
    `${status} error ${cls} (py:${inPy ? "y" : "n"} php:${inPhp ? "y" : "n"})`,
  );
  if (!inPy)
    console.log(
      `  - missing Python error class ${cls} in packages/sdk-py/postwave/errors.py`,
    );
  if (!inPhp)
    console.log(
      `  - missing PHP error class packages/sdk-php/src/Errors/${cls}.php`,
    );
  if (status === "FAIL") failed = true;
}

// ---------------------------------------------------------------------------
// PHP resource coverage — INFORMATIONAL (non-blocking). The PHP SDK
// intentionally covers a subset today; this surfaces the remaining gap so
// progress is visible without breaking CI while sdk-php is brought to parity.
// ---------------------------------------------------------------------------
const phpResFiles = existsSync(phpResDir)
  ? readdirSync(phpResDir).filter((f) => f.endsWith("Resource.php"))
  : [];
const toPascal = (s) =>
  s
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
const phpResLower = phpResFiles.map((f) => f.toLowerCase());
const missingPhp = expected.filter(
  (ts) => !phpResLower.includes(`${toPascal(ts)}resource.php`.toLowerCase()),
);
console.log(
  `\nPHP resource coverage: ${expected.length - missingPhp.length}/${expected.length} TS resources have a PHP counterpart.`,
);
if (missingPhp.length) {
  console.log(
    `  (informational) PHP SDK lacks resources: ${missingPhp.join(", ")}`,
  );
}

if (failed) {
  console.error(
    "\nSDK parity audit failed. Keep Python + PHP resource/accessor/error coverage aligned with the TS SDK.",
  );
  process.exit(1);
}

console.log("\nSDK parity audit passed.");
