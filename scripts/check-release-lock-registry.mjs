#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Compile-time release locks withhold shipped surface, and nothing notices
// when one lifts unless each lock is explicitly recorded here.
//
// A release lock here is a `const ... = false` that gates a feature's routes,
// workers or writes — `referrals.OperationalRuntimeAvailable`,
// `campaigndispatch.SchedulingQualified`, and nine others. Each is deliberate,
// and each creates the same latent problem in two directions:
//
// THE MANIFEST OVERSTATES THE API. `internal/routeauth/manifest.json` declares
// 2475 routes with their authorization policy, and 15 of them are referral
// routes that nothing mounts while that lock is engaged. The manifest is
// generated from route contracts, which describe what a route's policy WOULD be,
// not whether anything serves it. So the file that answers "what does this API
// expose?" answers it wrong, and `openapi.json` inherits the same overstatement.
//
// Note the direction. Mounted-but-undeclared is the dangerous one, and it is
// already caught — `routeauth.Middleware` fails closed with
// `route_authorization_unclassified` and `ValidateRouterExact` refuses to boot.
// Declared-but-unmounted is not a hole; it is a lie in the documentation, and it
// is invisible precisely because nothing 404s in a way anyone sees.
//
// AND NOTHING FORCES A RE-CHECK WHEN A LOCK LIFTS. That is the worse half. The
// day someone flips `OperationalRuntimeAvailable` to true, fifteen routes become
// live at once, carrying policies nobody has re-read since they were withheld —
// including at least one that silently changed scope while gated
// (`GET /api/v1/subscribers/{id}/referral` moved from `read:reports` to `admin`
// when it was relocated into the gated block). A flip is a large, quiet release.
//
// THIS GUARD DOES NOT AUDIT THE SURFACE, and saying so plainly matters more than
// implying otherwise. Deciding which manifest paths each lock withholds requires
// mounting every router with the lock engaged and diffing, which is real work per
// package. What this does is make the SET of locks reviewed rather than ambient:
// every lock must be recorded with its current value, so a new lock cannot appear
// unnoticed and — the point — a lock cannot change value without failing this
// check and sending someone to the notes below.
//
// ENUMERATED, NOT COUNTED, like the rest of this repo's guards: a stored total
// absorbs the next one silently, a named list fails on it.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["apps", "services", "packages"];

// A lock is any PACKAGE-LEVEL boolean const or var bound to a literal.
//
// THE FIRST VERSION MATCHED ON NAMING — `<Name>Available` or `<Name>Qualified`
// — and that was wrong in the way this guard exists to prevent. It reported
// "11 release lock(s) recorded" and sounded exhaustive while missing two,
// including the most consequential one in the repo:
//
//   apps/api/internal/privacy/erasure.go:85
//       erasureHistoryCoverageComplete = false
//
// which makes `eraseSubscriberData` return ErrErasureCoverageIncomplete before
// its first write — i.e. GDPR erasure does not run. A guard that enumerates
// release locks and cannot see the one disabling Article 17 erasure is worse
// than no guard, because its confident count invites you to stop looking.
//
// Naming is a convention and conventions are exactly what a new lock will not
// follow. Structure is not: a compile-time lock has to be a package-level
// boolean to be usable as one. So this now walks top-level `const (`/`var (`
// blocks and single-line top-level declarations, and ignores everything inside
// a function body — where `allowed = false` and `prevDash = false` live in
// their hundreds and mean nothing.
function isBlockOpen(line) {
  return /^(?:const|var)\s*\($/.test(line);
}
function isBlockClose(line) {
  return /^\)/.test(line);
}
const SINGLE_LINE_DECL =
  /^(?:const|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|\s+bool\s*=)\s*(true|false)\s*$/;
const BLOCK_MEMBER_DECL =
  /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|\s+bool\s*=)\s*(true|false)\s*$/;

// Every lock, its recorded value, and what a reviewer needs to know before
// flipping it. `expected` is the value in the tree today; a mismatch is the
// signal, not a failure to be edited away without reading the note.
const REGISTRY = [
  {
    file: "apps/api/internal/referrals/referrals.go",
    name: "OperationalRuntimeAvailable",
    expected: "false",
    note:
      "Withholds 15 manifest routes (/api/public/r/{code}, /api/public/r/{code}/widget.js, " +
      "/api/v1/referral-programs*, /api/v1/referrals/*, /api/v1/subscribers/{id}/referral*). " +
      "AUDITED. Before flipping: (a) GET /api/v1/subscribers/{id}/referral changed from " +
      "RequireScope(read:reports) to RequireScope(admin) while gated — that is a behavioural " +
      "change bundled with the lock and needs its own decision; (b) CongratsSender is wired in " +
      "main.go and consumes the per-conversion congrats_sent_at idempotency marker while " +
      "emailing nobody, so flipping it without fixing that makes the congrats email permanently " +
      "unsendable for every historical conversion; (c) widget.go's own release note says the " +
      "snippet still lacks the dialog keyboard/focus contract.",
  },
  {
    file: "apps/api/internal/privacy/erasure.go",
    name: "erasureHistoryCoverageComplete",
    expected: "false",
    note:
      "GDPR ARTICLE 17 ERASURE DOES NOT RUN. eraseSubscriberData (erasure.go:169) returns " +
      "ErrErasureCoverageIncomplete before its first write, so every production erasure caller " +
      "fails closed. The constant's own comment says why: retained SMS proof/content, Mailchimp " +
      "reporting/raw commerce payloads and other append-only stores still lack an approved " +
      "retention policy and least-privilege mutation grants, and it must only flip in the same " +
      "release that lands that inventory plus its absence proof. Failing closed is the RIGHT " +
      "behaviour — recording a false Art. 17 success would be worse. Two things to know before " +
      "flipping: the DB tests exercise the inner eraseSubscriberDataWithEntropy and therefore " +
      "pass while the gate is shut, so green tests are not evidence the path runs; and migration " +
      "1913's subscriber_pii_findings_erase definer function is a prerequisite that is already " +
      "in place, not a reason to flip.",
  },
  {
    file: "apps/api/internal/control_group/control_group.go",
    name: "enforcedAtSendTime",
    expected: "true",
    note:
      "The one lock in this registry that is OPEN, recorded so it cannot silently close. " +
      "Control-group members are genuinely dropped from the audience before the A/B split " +
      "(campaigns/handlers_queue.go calls PartitionControl), and report and send path both hash " +
      "the subscriber EMAIL so their partitions agree. That is what makes the published lift a " +
      "real held-out-vs-sent measurement. If this ever returns to false, Report keeps publishing " +
      "a lift number that has become noise — a wrong answer, not a missing one.",
  },
  {
    file: "packages/runtime/campaigndispatch/qualification.go",
    name: "SchedulingQualified",
    expected: "false",
    note:
      "Stops Scheduler.Run from dispatching. campaigns/handlers_schedule.go branches on it and " +
      "keeps the schedule endpoint advisory. Manifest impact NOT audited.",
  },
  {
    file: "apps/api/internal/flowbuilder/flowbuilder.go",
    name: "flowRuntimeQualified",
    expected: "false",
    note:
      "Gates flow versions/promote/publish/activate/runs and the legacy flow_runs drainer " +
      "(9 gated branches in-package). Manifest impact NOT audited.",
  },
  {
    file: "apps/api/internal/omnichannel/omnichannel.go",
    name: "omnichannelRuntimeQualified",
    expected: "false",
    note: "3 gated branches in-package. Manifest impact NOT audited.",
  },
  {
    file: "apps/api/internal/onsite_growth/onsite_growth.go",
    name: "CouponRewardDeliveryAvailable",
    expected: "false",
    note: "2 gated branches in-package. Manifest impact NOT audited.",
  },
  {
    file: "apps/api/internal/discounts/coupon_pools.go",
    name: "CouponAllocationAvailable",
    expected: "false",
    note:
      "Paired with the identically-named lock in services/automation — flipping one without the " +
      "other splits coupon allocation across the two runtimes. Manifest impact NOT audited.",
  },
  {
    file: "services/automation/internal/runtime/coupon.go",
    name: "CouponAllocationAvailable",
    expected: "false",
    note: "The services/automation half of the coupon-allocation pair above. Flip together.",
  },
  {
    file: "apps/api/internal/affiliates/availability.go",
    name: "AdminOperationsAvailable",
    expected: "false",
    note: "One of four affiliate locks (6 gated branches in-package). Manifest impact NOT audited.",
  },
  {
    file: "apps/api/internal/affiliates/availability.go",
    name: "PublicOfferAvailable",
    expected: "false",
    note: "Affiliate public offer surface. Manifest impact NOT audited.",
  },
  {
    file: "apps/api/internal/affiliates/availability.go",
    name: "NewAttributionAvailable",
    expected: "false",
    note: "Affiliate attribution writes. Manifest impact NOT audited.",
  },
  {
    file: "apps/api/internal/affiliates/availability.go",
    name: "PayoutOperationsAvailable",
    expected: "false",
    note: "Affiliate payout operations — money movement. Manifest impact NOT audited.",
  },
  {
    file: "apps/api/internal/offers/handlers.go",
    name: "PublicResolutionAvailable",
    expected: "false",
    note:
      "Withholds the unauthenticated canonical-offer resolver until a production writer proves " +
      "recipient/subscription/tier eligibility, the public projection has an approved field " +
      "allowlist, and origination plus provider reconciliation have live certification. The " +
      "mounted no-store 503 boundary remains observable while the dormant resolver stays unreachable.",
  },
  {
    file: "apps/api/internal/retention_offers/winback.go",
    name: "WinbackDispatchAvailable",
    expected: "false",
    note:
      "Withholds churn-triggered win-back sends until send plus cooldown persistence is atomic/" +
      "exactly-once, a recipient-bound acceptance portal is mounted, fixed-amount offers carry " +
      "explicit currency, and provider delivery/application reconciliation has live certification. " +
      "No production composition root runs the worker; only the settings GET is mounted.",
  },
  {
    file: "apps/api/internal/deliverability_hub/hub.go",
    name: "AccountComplianceSuspensionAvailable",
    expected: "false",
    note:
      "Withholds account.compliance_suspend because the product has no authoritative tenant/" +
      "account suspension state or mutation. Privacy incidents, erasure requests, audit findings, " +
      "and sending throttles are adjacent workflows, not proof that an account was suspended. " +
      "Flip only with an owner that atomically writes suspension state, audit evidence, and event " +
      "intent; do not synthesize this lifecycle event from those adjacent compliance surfaces.",
  },
  {
    file: "apps/api/internal/deliverability_hub/hub.go",
    name: "AccountBillingLifecycleAvailable",
    expected: "false",
    note:
      "Withholds account.deactivate/reactivate because no paired account-state transition exists. " +
      "customer.subscription.deleted deprovisions paid sending but deliberately retains Studio " +
      "account access, while invoice dunning clear is a separate debt-recovery transition and can " +
      "occur without any deactivate event. Flip only with a durable authoritative account-state " +
      "model whose deactivate/reactivate transitions are paired and idempotent.",
  },
  {
    file: "apps/api/internal/sending/provisioner.go",
    name: "ManagedPostmarkProvisioningAvailable",
    expected: "false",
    note:
      "Withholds managed Sending and Pro provisioning before any provider or repository call. " +
      "Postmark CreateServer/CreateMessageStream lack a replay-safe idempotency key while local " +
      "sending_state is written only after remote effects, so ambiguous retries can orphan " +
      "billable resources. The Pro candidate also targets an undocumented /dedicated-ips endpoint; " +
      "Postmark publicly describes dedicated IP assignment as eligibility-gated and support-requested. " +
      "Flip only with durable pre-effect intent, resumable steps, reconciliation/compensation, and a " +
      "provider-certified dedicated-IP contract.",
  },
  {
    file: "apps/api/internal/billing/overage_reconciler.go",
    name: "OverageReportingAvailable",
    expected: "false",
    note:
      "Withholds Stripe usage-record POSTs while preserving local delivered-usage accrual. The " +
      "ledger is keyed to UTC calendar months, but no in-tree subscription creator or webhook " +
      "projection proves a first-of-month billing_cycle_anchor for the metered item. Cumulative " +
      "action=set quantities can cross a different Stripe billing boundary and misattribute charges. " +
      "Flip only with authoritative period identity, provider reconciliation, and tests covering " +
      "boundary rollover; held passes must not advance reported_quantity/reported_at.",
  },
  {
    file: "apps/api/internal/sendallowance/allowance.go",
    name: "ManagedSendAllowanceReleased",
    expected: "true",
    note:
      "OPEN only while the managed-send coverage audit proves one tenant/month reservation " +
      "authority at campaign recipient, campaign test-send, automation email, transactional " +
      "API/scheduled-worker, and SMTP provider boundaries. The ledger is recipient-bound and " +
      "append-only, bucket updates serialize under a row lock, Studio/BYO is explicitly bypassed, " +
      "managed plans fail closed, and no overage decision may admit sends above the allowance.",
  },
  {
    file: "apps/api/internal/agentgov/governor.go",
    name: "NativeMCPPerToolQuotaReleased",
    expected: "false",
    note:
      "Withholds legacy per-tool quota enforcement for native MCP. The outer HTTP recorder " +
      "cannot authoritatively attribute the inner tool invocation, and reservation plus " +
      "server-owned usage evidence are not atomic. Flip only with an authoritative per-key, " +
      "per-tenant, per-tool reservation path.",
  },
  {
    file: "apps/api/internal/agenttools/execute.go",
    name: "InteractiveWriteTierReleased",
    expected: "false",
    note:
      "Withholds write execution across both native MCP and the in-app agent. Mutation, send " +
      "budget charging, approval binding, and audit evidence do not yet share one durable " +
      "atomic/outbox contract; releasing only one interactive surface would leave a bypass.",
  },
  {
    file: "apps/api/internal/ai_agent/sessions.go",
    name: "AgentInteractiveReleased",
    expected: "false",
    note:
      "Withholds the full /api/v1/ai-agent family, including chat, durable sessions, and BYOK " +
      "configuration. Session ownership/retention and the wider provider/governance boundary " +
      "remain unqualified. Manifest impact NOT audited.",
  },
  {
    file: "apps/api/internal/apikeycalls/apikeycalls.go",
    name: "LegacyHTTPQuotaEnforcementReleased",
    expected: "false",
    note:
      "Keeps the legacy HTTP quota middleware observation-only. Its caller-selected tool label " +
      "and asynchronously recorded tenant-wide rows can let one key deny another. Flip only " +
      "with authenticated, atomic server-owned key/tenant/tool reservation evidence.",
  },
  {
    file: "apps/api/internal/mcp/server.go",
    name: "NativeProtocolLifecycleReleased",
    expected: "false",
    note:
      "Withholds claims of MCP Streamable HTTP lifecycle conformance. The preview does not yet " +
      "negotiate initialize parameters or enforce initialize then notifications/initialized. " +
      "Protocol route/manifest impact NOT audited.",
  },
  {
    file: "apps/api/internal/mcp/server.go",
    name: "NativeWriteTierReleased",
    expected: "false",
    note:
      "Withholds native MCP write-tool discovery and execution. Domain writes can commit before " +
      "audit evidence and send-budget usage become durable; flip only when those effects share " +
      "one atomic transaction or reconciled outbox boundary.",
  },
  {
    file: "apps/api/internal/sms/handlers.go",
    name: "smsLegacyDispatchReleaseReady",
    expected: "false",
    note:
      "Withholds legacy SMS provider sends until durable budget reservation and provider-outcome " +
      "reconciliation share one proven intent/outbox lifecycle.",
  },
  {
    file: "apps/api/internal/sms/handlers.go",
    name: "smsDispatchSagaReleaseReady",
    expected: "false",
    note:
      "Withholds reply and broadcast provider effects. Existing intents remain recoverable, but " +
      "new effects require durable idempotent dispatch and budget settlement evidence.",
  },
  {
    file: "apps/api/internal/sms/handlers.go",
    name: "smsComplianceAutoReplyReleaseReady",
    expected: "false",
    note:
      "Withholds HELP/custom compliance auto-replies because a TwiML Message is a provider " +
      "effect and still lacks its own durable, budgeted evidence path.",
  },
  {
    file: "apps/api/internal/sms/handlers.go",
    name: "smsA2PRegistrationReleaseReady",
    expected: "false",
    note:
      "Withholds billable A2P brand/campaign submission and polling until provider requests, " +
      "local intents, reconciliation, idempotency, and bounded minimized receipts are one " +
      "lifecycle.",
  },
  {
    file: "apps/api/internal/sms/handlers.go",
    name: "smsFinancialLedgerReleaseReady",
    expected: "false",
    note:
      "Withholds SMS balance, usage, quote, and top-up claims because no authoritative purchased-" +
      "credit/payment ledger exists. This is independent of dispatch readiness.",
  },
  {
    file: "apps/api/internal/sms/handlers.go",
    name: "smsMMSReadinessReleaseReady",
    expected: "false",
    note:
      "Withholds MMS readiness claims. Outbound media URL plumbing does not prove bounded inbound " +
      "MMS evidence or provider-authenticated end-to-end smoke coverage.",
  },
  {
    file: "apps/api/internal/sms/handlers.go",
    name: "smsSupportMirrorReleaseReady",
    expected: "false",
    note:
      "Withholds the legacy raw phone/body support mirror into a weaker read:reports plane. " +
      "Requires a durable minimized outbox plus exact content authority, retention, erasure, and " +
      "subject-access coverage.",
  },
  {
    file: "apps/api/internal/sms/handlers.go",
    name: "smsProviderCallbackReleaseReady",
    expected: "false",
    note:
      "Withholds hosted provider callbacks while adapters/verifiers are process-global and sender " +
      "profiles are tenant-scoped. Flip only with tenant-bound credential/account ownership " +
      "resolution at the callback authority boundary.",
  },
  {
    file: "apps/api/internal/sms/handlers.go",
    name: "smsClickResolverReleaseReady",
    expected: "false",
    note:
      "Keeps bearer click URLs inert pending a dedicated least-privilege resolver, token expiry/" +
      "retention, and edge-log governance. A caller-settable RLS bypass must not return.",
  },
  {
    file: "apps/api/internal/social_capture/social_capture.go",
    name: "tapToTextConsentReleaseReady",
    expected: "false",
    note:
      "Withholds positive SMS consent from tap redirects. Navigation does not prove phone " +
      "possession or affirmative purpose-bound consent, and tap evidence plus consent currently " +
      "span two transactions instead of one atomic idempotent write.",
  },
];

function goFilesUnder(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === "vendor")
      continue;
    const full = join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) goFilesUnder(full, out);
    else if (entry.endsWith(".go") && !entry.endsWith("_test.go"))
      out.push(full);
  }
  return out;
}

export function discover(files, readFile) {
  const found = [];
  for (const file of files) {
    const source = readFile(file);
    let insideTopLevelBlock = false;
    source.split("\n").forEach((line, index) => {
      if (isBlockOpen(line)) {
        insideTopLevelBlock = true;
        return;
      }
      if (insideTopLevelBlock && isBlockClose(line)) {
        insideTopLevelBlock = false;
        return;
      }
      const single = SINGLE_LINE_DECL.exec(line);
      if (single) {
        found.push({
          file,
          name: single[1],
          value: single[2],
          line: index + 1,
        });
        return;
      }
      if (!insideTopLevelBlock) return;
      const member = BLOCK_MEMBER_DECL.exec(line);
      if (member) {
        found.push({
          file,
          name: member[1],
          value: member[2],
          line: index + 1,
        });
      }
    });
  }
  return found;
}

export function reconcile(found, registry) {
  const key = (entry) => `${entry.file}::${entry.name}`;
  const foundByKey = new Map(found.map((entry) => [key(entry), entry]));
  const registryByKey = new Map(registry.map((entry) => [key(entry), entry]));

  const unregistered = found.filter((entry) => !registryByKey.has(key(entry)));
  const missing = registry.filter((entry) => !foundByKey.has(key(entry)));
  const changed = [];
  for (const entry of registry) {
    const actual = foundByKey.get(key(entry));
    if (actual && actual.value !== entry.expected) {
      changed.push({ ...entry, actual: actual.value, line: actual.line });
    }
  }
  return { unregistered, missing, changed, total: found.length };
}

function selfTest() {
  const files = ["a.go", "b.go"];
  const sources = {
    "a.go": "package a\n\nconst FooAvailable = false\n",
    "b.go": "package b\n\nconst BarQualified = true\n",
  };
  const read = (f) => sources[f];

  const cases = [
    {
      name: "finds both lock forms with their values",
      run: () => {
        const found = discover(files, read);
        return (
          found.length === 2 &&
          found[0].name === "FooAvailable" &&
          found[0].value === "false" &&
          found[1].value === "true"
        );
      },
    },
    {
      name: "a lock absent from the registry is reported",
      run: () => reconcile(discover(files, read), []).unregistered.length === 2,
    },
    {
      name: "a flipped lock is reported as changed",
      run: () => {
        const registry = [
          { file: "a.go", name: "FooAvailable", expected: "true", note: "" },
          { file: "b.go", name: "BarQualified", expected: "true", note: "" },
        ];
        const result = reconcile(discover(files, read), registry);
        return (
          result.changed.length === 1 &&
          result.changed[0].name === "FooAvailable" &&
          result.changed[0].actual === "false"
        );
      },
    },
    {
      name: "a registry entry whose lock is gone is reported as stale",
      run: () => {
        const registry = [
          {
            file: "gone.go",
            name: "GoneAvailable",
            expected: "false",
            note: "",
          },
        ];
        return reconcile(discover(files, read), registry).missing.length === 1;
      },
    },
    {
      name: "two locks of the same name in different files stay distinct",
      run: () => {
        const twin = {
          "x.go": "const CouponAvailable = false\n",
          "y.go": "const CouponAvailable = false\n",
        };
        const found = discover(["x.go", "y.go"], (f) => twin[f]);
        const registry = [
          {
            file: "x.go",
            name: "CouponAvailable",
            expected: "false",
            note: "",
          },
        ];
        const result = reconcile(found, registry);
        return (
          result.unregistered.length === 1 &&
          result.unregistered[0].file === "y.go"
        );
      },
    },
    {
      name: "a non-boolean assignment is not a lock",
      run: () => {
        const other = {
          "z.go":
            "var ThingAvailable = computeIt()\nconst OtherQualified = someConst\n",
        };
        return discover(["z.go"], (f) => other[f]).length === 0;
      },
    },
    {
      // The whole reason discovery was rewritten: naming must not gate it, or
      // erasureHistoryCoverageComplete stays invisible.
      name: "a lock is found regardless of its name",
      run: () => {
        const src = {
          "e.go": "const (\n\terasureHistoryCoverageComplete = false\n)\n",
        };
        const found = discover(["e.go"], (f) => src[f]);
        return (
          found.length === 1 &&
          found[0].name === "erasureHistoryCoverageComplete"
        );
      },
    },
    {
      // The corresponding risk of structural detection: hundreds of ordinary
      // locals like `allowed = false` live inside functions and are not locks.
      name: "assignments inside a function body are NOT locks",
      run: () => {
        const src = {
          "f.go":
            "package f\n\nfunc doThing() {\n\tallowed := true\n\tif x {\n\t\tallowed = false\n\t}\n\tprevDash = false\n}\n",
        };
        return discover(["f.go"], (f) => src[f]).length === 0;
      },
    },
    {
      name: "a top-level var block member is a lock, and the block closes",
      run: () => {
        const src = {
          "g.go":
            "var (\n\tenforcedAtSendTime = true\n)\n\nfunc g() {\n\tinner = false\n}\n",
        };
        const found = discover(["g.go"], (f) => src[f]);
        return (
          found.length === 1 &&
          found[0].name === "enforcedAtSendTime" &&
          found[0].value === "true"
        );
      },
    },
  ];

  let failed = 0;
  for (const testCase of cases) {
    let ok = false;
    try {
      ok = testCase.run();
    } catch (error) {
      console.error(`  self-test threw: ${error.message}`);
    }
    if (!ok) {
      failed += 1;
      console.error(`  FAIL ${testCase.name}`);
    }
  }
  if (failed > 0) {
    console.error(`check-release-lock-registry: ${failed} self-test(s) failed`);
    process.exit(1);
  }
  console.log(`check-release-lock-registry: ${cases.length} self-tests passed`);
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const files = SCAN_ROOTS.flatMap((root) =>
    goFilesUnder(join(repoRoot, root)),
  );

  // A floor, because scanning nothing produces a clean report — the exact
  // failure shape this repo's guards keep being written to prevent.
  const MIN_GO_FILES = 500;
  if (files.length < MIN_GO_FILES) {
    console.error(
      `check-release-lock-registry: scanned only ${files.length} Go files, expected at least ` +
        `${MIN_GO_FILES}. Refusing to report a clean result over a tree this guard failed to read.`,
    );
    process.exit(1);
  }

  const found = discover(files, (file) => readFileSync(file, "utf8")).map(
    (entry) => ({
      ...entry,
      file: relative(repoRoot, entry.file),
    }),
  );
  const result = reconcile(found, REGISTRY);

  let failures = 0;

  for (const entry of result.unregistered) {
    failures += 1;
    console.error(
      `check-release-lock-registry: ${entry.file}:${entry.line} defines release lock ` +
        `${entry.name} = ${entry.value}, which is not in the registry.\n` +
        `  Add it to REGISTRY in this file with what it withholds. A lock nobody recorded is a ` +
        `feature that can be released, or kept back, without anyone deciding to.`,
    );
  }

  for (const entry of result.changed) {
    failures += 1;
    console.error(
      `check-release-lock-registry: ${entry.file}:${entry.line} — ${entry.name} is now ` +
        `${entry.actual}, recorded as ${entry.expected}.\n` +
        `  If this flip is intended, re-read the route policies it releases BEFORE updating the ` +
        `expectation, then update it in the same change. The manifest and openapi.json already ` +
        `declare the withheld routes, so flipping a lock makes them live carrying policies that ` +
        `have not been reviewed since they were withheld.\n` +
        `  Recorded note: ${entry.note}`,
    );
  }

  for (const entry of result.missing) {
    failures += 1;
    console.error(
      `check-release-lock-registry: the registry lists ${entry.name} in ${entry.file}, which no ` +
        `longer exists. If the lock was removed because the feature shipped, delete the entry in ` +
        `the same change; a registry that describes locks that are gone stops describing the ones ` +
        `that are here.`,
    );
  }

  if (failures > 0) {
    console.error(
      `check-release-lock-registry: ${failures} problem(s) across ${result.total} release lock(s)`,
    );
    process.exit(1);
  }

  const engaged = found.filter((entry) => entry.value === "false").length;
  console.log(
    `check-release-lock-registry: OK — ${result.total} release lock(s) recorded, ${engaged} ` +
      `currently withholding surface.`,
  );
}

main();
