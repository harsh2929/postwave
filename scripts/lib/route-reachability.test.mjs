import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compositeGatewayRouteInventory,
  gatewayRouteInventory,
  reachableRouteSourceFiles,
  validateAdditionalSourceMounts,
} from "./route-reachability.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture({ importExcluded = false, mountForbidden = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "postwave-route-reachability-"));
  for (const path of [
    "apps/api/internal/mounted",
    "apps/api/internal/unmounted",
    "packages/openapi",
  ]) {
    mkdirSync(join(root, path), { recursive: true });
  }
  writeFileSync(
    join(root, "apps/api/main.go"),
    `package main\nimport _ "github.com/postwave/postwave/apps/api/internal/${
      importExcluded ? "unmounted" : "mounted"
    }"\nfunc main() { ${mountForbidden ? "affiliatesDeps.MountPublicRoutes(r)" : ""} }\n`,
  );
  writeFileSync(
    join(root, "apps/api/internal/mounted/routes.go"),
    'package mounted\n// r.Get("/api/v1/mounted", handler)\n',
  );
  writeFileSync(
    join(root, "apps/api/internal/mounted/unmounted_routes.go"),
    'package mounted\n// r.Get("/api/v1/unmounted-in-mounted-package", handler)\n',
  );
  writeFileSync(
    join(root, "apps/api/internal/unmounted/routes.go"),
    'package unmounted\n// r.Get("/api/v1/unmounted", handler)\n',
  );
  writeFileSync(
    join(root, "packages/openapi/route-reachability.json"),
    JSON.stringify({
      version: 1,
      composition_root: "apps/api/main.go",
      additional_sources: [],
      forbidden_composition_calls: [
        {
          symbol: "affiliatesDeps.MountPublicRoutes",
          reason: "fixture mount is release-blocked",
        },
        {
          symbol: "nbp.MountExtended",
          reason: "fixture extension is deliberately unmounted",
        },
      ],
      excluded_routes: [],
      excluded_sources: [
        {
          path: "apps/api/internal/unmounted",
          reason: "fixture scaffold is not mounted",
        },
        {
          path: "apps/api/internal/mounted/unmounted_routes.go",
          reason: "fixture route file is not mounted",
        },
      ],
    }),
  );
  return root;
}

test("unmounted handler source is absent by default", () => {
  const root = fixture();
  const relativeFiles = reachableRouteSourceFiles(root).map((path) =>
    path.slice(root.length + 1),
  );
  assert.deepEqual(relativeFiles, [
    "apps/api/internal/mounted/routes.go",
    "apps/api/main.go",
  ]);
});

test("an excluded source imported by the composition root fails closed", () => {
  const root = fixture({ importExcluded: true });
  assert.throws(
    () => reachableRouteSourceFiles(root),
    /API composition imports excluded route source apps\/api\/internal\/unmounted/u,
  );
});

test("a forbidden route mount in the composition root fails closed", () => {
  const root = fixture({ mountForbidden: true });
  assert.throws(
    () => reachableRouteSourceFiles(root),
    /API composition calls forbidden route mount affiliatesDeps\.MountPublicRoutes/u,
  );
});

test("forbidden mount checks ignore comments and string literals", () => {
  const root = fixture();
  writeFileSync(
    join(root, "apps/api/main.go"),
    `package main
import _ "github.com/postwave/postwave/apps/api/internal/mounted"
func main() {
  _ = "affiliatesDeps.MountPublicRoutes(r)"
  // nbp.MountExtended(r)
}
`,
  );
  assert.doesNotThrow(() => reachableRouteSourceFiles(root));
});

test("a forbidden NBP extension mount cannot be hidden by route exclusions", () => {
  const root = fixture();
  writeFileSync(
    join(root, "apps/api/main.go"),
    `package main
import _ "github.com/postwave/postwave/apps/api/internal/mounted"
func main() { nbp.MountExtended(r) }
`,
  );
  assert.throws(
    () => reachableRouteSourceFiles(root),
    /API composition calls forbidden route mount nbp\.MountExtended/u,
  );
});

test("every reviewed additional source fails closed when any required call is removed", () => {
  const policy = JSON.parse(
    readFileSync(
      join(repoRoot, "packages/openapi/route-reachability.json"),
      "utf8",
    ),
  );
  assert.ok(policy.additional_sources.length > 0);

  for (const entry of policy.additional_sources) {
    assert.ok(entry.required_calls.length >= 2, entry.path);
    for (const removedCall of entry.required_calls) {
      const root = mkdtempSync(join(tmpdir(), "postwave-required-route-call-"));
      const isolatedPolicy = {
        ...policy,
        additional_sources: [entry],
      };
      const policyPath = join(root, "packages/openapi/route-reachability.json");
      mkdirSync(dirname(policyPath), { recursive: true });
      writeFileSync(policyPath, JSON.stringify(isolatedPolicy));

      for (const sourcePath of new Set(
        entry.required_calls.map((call) => call.source),
      )) {
		const destination = join(root, sourcePath);
        mkdirSync(dirname(destination), { recursive: true });
		let source = readFileSync(join(repoRoot, sourcePath), "utf8");
        if (
		  sourcePath === removedCall.source
        ) {
          source = source.replaceAll(
            removedCall.symbol,
            `${removedCall.symbol}Removed`,
          );
        }
        writeFileSync(destination, source);
      }

      assert.throws(
        () => validateAdditionalSourceMounts(root),
        (error) =>
          error instanceof Error &&
          error.message.includes(removedCall.symbol) &&
          error.message.includes(entry.path),
        `${entry.path} remained reachable without ${removedCall.symbol}`,
      );
    }
  }
});

const compositeSources = [
  "apps/api/main.go",
  "apps/api/ops_console_wiring.go",
  "apps/api/internal/mailchimpv3/handlers.go",
  "apps/api/internal/nbp/handlers.go",
  "apps/api/internal/server/editor_queue_routes.go",
  "services/migration/main.go",
  "services/migration/internal/handlers/migration.go",
];

function compositeFixture(mutation) {
  const root = mkdtempSync(join(tmpdir(), "postwave-composite-routes-"));
  for (const sourcePath of compositeSources) {
    const destination = join(root, sourcePath);
    mkdirSync(dirname(destination), { recursive: true });
    let source = readFileSync(join(repoRoot, sourcePath), "utf8");
    if (mutation?.source === sourcePath) {
      const changed = mutation.change(source);
      assert.notEqual(changed, source, `mutation did not alter ${sourcePath}`);
      source = changed;
    }
    writeFileSync(destination, source);
  }
  return root;
}

test("composite gateway inventories fail closed when any call-chain link disappears", async (t) => {
  const cases = [
    {
      name: "migration gateway proxy mount",
      source: "apps/api/main.go",
      change: (source) =>
        source.replace(
          '.Handle("/api/v1/migrations", migrationProxy)',
          '.Handle("/api/v1/migrations", disabledMigrationProxy)',
        ),
      error: "exact migrationProxy mount /api/v1/migrations is absent",
    },
    {
      name: "migration service mount",
      source: "services/migration/main.go",
      change: (source) =>
        source.replace(
          "migrationAPI.Mount(protected)",
          "disabledMigrationMount(protected)",
        ),
      error: "executable call migrationAPI.Mount is absent",
    },
    {
      name: "ops composition call",
      source: "apps/api/main.go",
      change: (source) =>
        source.replace("mountOpsRoutes(", "disabledOpsRoutes("),
      error: "executable call mountOpsRoutes is absent",
    },
    {
      name: "ops route block",
      source: "apps/api/ops_console_wiring.go",
      change: (source) =>
        source.replace(
          'router.Route("/api/internal/ops"',
          'router.Route("/disabled/internal/ops"',
        ),
      error: "/api/internal/ops Route block is absent",
    },
    {
      name: "Mailchimp composition call",
      source: "apps/api/main.go",
      change: (source) =>
        source.replace("mailchimpv3.Mount(", "mailchimpv3.DisabledMount("),
      error: "executable call mailchimpv3.Mount is absent",
    },
    {
      name: "Mailchimp API bases",
      source: "apps/api/internal/mailchimpv3/handlers.go",
      change: (source) =>
        source
          .replace(
            'mountBase(r, "/api/mailchimp/3.0", d)',
            'mountBase(r, "/disabled/mailchimp/3.0", d)',
          )
          .replace(
            'mountBase(r, "/api/v1/mailchimp/3.0", d)',
            'mountBase(r, "/disabled/v1/mailchimp/3.0", d)',
          ),
      error: "has no executable /api mountBase call",
    },
    {
      name: "NBP composition-root helper call",
      source: "apps/api/main.go",
      change: (source) =>
        source.replace(
          "apiserver.MountEditorQueueRoutes(",
          "apiserver.DisabledEditorQueueRoutes(",
        ),
      error: "executable call apiserver.MountEditorQueueRoutes is absent",
    },
    {
      name: "NBP helper mount call",
      source: "apps/api/internal/server/editor_queue_routes.go",
      change: (source) => source.replace("nbp.Mount(", "nbp.DisabledMount("),
      error: "executable call nbp.Mount is absent",
    },
    {
      name: "NBP API declarations",
      source: "apps/api/internal/nbp/handlers.go",
      change: (source) => source.replaceAll("/api/v1/nbp", "/disabled/nbp"),
      error: "nbp.Mount declares no executable /api routes",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const root = compositeFixture(testCase);
      assert.throws(
        () => compositeGatewayRouteInventory(root),
        (error) =>
          error instanceof Error && error.message.includes(testCase.error),
      );
    });
  }
});

test("generated capability manifest exactly matches the shared gateway inventory", () => {
  const inventory = gatewayRouteInventory(repoRoot);
  const manifest = JSON.parse(
    readFileSync(
      join(repoRoot, "apps/api/internal/routeauth/manifest.json"),
      "utf8",
    ),
  );
  const manifestRoutes = new Set(
    manifest.routes.map((route) => `${route.method} ${route.path}`),
  );
  assert.deepEqual(
    [...manifestRoutes].sort(),
    [...inventory.routes].sort(),
    "parity and authorization capabilities must consume the same executable route boundary",
  );
});
