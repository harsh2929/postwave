import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPTS = ["agent-mcp-demo.sh", "agent-chat-demo.sh"].map((name) =>
  path.join(ROOT, "scripts/demo", name),
);

test("agent demos fail closed before credentials or network", () => {
  for (const script of SCRIPTS) {
    const source = readFileSync(script, "utf8");
    const result = spawnSync("bash", [script], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        POSTWAVE_API_KEY: "private-test-secret",
        ANTHROPIC_API_KEY: "private-provider-secret",
        POSTWAVE_API_URL: "https://must-not-be-called.invalid",
      },
    });

    assert.equal(result.status, 78);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /mcp_distribution_release_held/u);
    assert.doesNotMatch(result.stderr, /private-(?:test|provider)-secret/u);
    assert.doesNotMatch(
      source,
      /curl|POSTWAVE_API_KEY|ANTHROPIC_API_KEY|\/api\/v1\/(?:mcp\/rpc|ai-agent)|tools\/call/u,
    );
  }
});
