import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SENDING_SETTINGS_RECONCILIATION_QUIESCENCE_MS } from "../pages/useSendingSettingsController";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const REQUIRED_MARGIN_MS = 5_000;

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function numericLiteral(body: string, pattern: RegExp, label: string): number {
  const raw = pattern.exec(body)?.[1];
  if (!raw) throw new Error(`Could not read ${label}`);
  return Number(raw.replaceAll("_", ""));
}

describe("sending-settings causal-quiescence contract", () => {
  it("keeps every client wait and standalone guidance beyond the server mutation deadline", () => {
    const go = source("apps/api/internal/sending/cap_coordination.go");
    const serverSeconds = numericLiteral(
      go,
      /CapMutationMaxDuration\s*=\s*([\d_]+)\s*\*\s*time\.Second/u,
      "Go CapMutationMaxDuration",
    );
    const minimumClientWaitMs = serverSeconds * 1_000 + REQUIRED_MARGIN_MS;

    const ts = source("packages/sdk-ts/src/resources/sending-settings.ts");
    const python = source(
      "packages/sdk-py/postwave/resources/sending_settings.py",
    );
    const php = source(
      "packages/sdk-php/src/Resources/SendingSettingsResource.php",
    );
    const mcp = source("packages/mcp-server/src/tools/sending-settings.ts");
    const web = source("apps/web/src/lib/sending-settings-api.ts");
    const mobile = source("apps/mobile/src/lib/sendingSettingsMutation.ts");
    const waits = {
      desktop: SENDING_SETTINGS_RECONCILIATION_QUIESCENCE_MS,
      web: numericLiteral(
        web,
        /SENDING_SETTINGS_QUIESCENCE_MS\s*=\s*([\d_]+)/u,
        "web reconciliation wait",
      ),
      mobile: numericLiteral(
        mobile,
        /SENDING_SETTINGS_QUIESCENCE_MS\s*=\s*([\d_]+)/u,
        "mobile reconciliation wait",
      ),
      typescript: numericLiteral(
        ts,
        /SENDING_SETTINGS_RECONCILIATION_WAIT_MS\s*=\s*([\d_]+)/u,
        "TypeScript reconciliation wait",
      ),
      python:
        numericLiteral(
          python,
          /SENDING_SETTINGS_RECONCILIATION_WAIT_SECONDS\s*=\s*([\d_]+)/u,
          "Python reconciliation wait",
        ) * 1_000,
      php:
        numericLiteral(
          php,
          /RECONCILIATION_WAIT_SECONDS\s*=\s*([\d_]+)/u,
          "PHP reconciliation wait",
        ) * 1_000,
      mcp: numericLiteral(
        mcp,
        /SENDING_SETTINGS_RECONCILIATION_WAIT_MS\s*=\s*([\d_]+)/u,
        "MCP reconciliation wait",
      ),
    };

    for (const [client, waitMs] of Object.entries(waits)) {
      expect(
        waitMs,
        `${client} wait must cover server deadline + margin`,
      ).toBeGreaterThanOrEqual(minimumClientWaitMs);
    }
    for (const [label, body, waitMs] of [
      ["TypeScript", ts, waits.typescript],
      ["Python", python, waits.python],
      ["PHP", php, waits.php],
      ["MCP", mcp, waits.mcp],
    ] as const) {
      expect(
        body,
        `${label} must explain the wait before reconciliation`,
      ).toContain(`wait at least ${waitMs / 1_000} seconds`);
    }
  });
});
