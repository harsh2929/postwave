import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), "../..", path), "utf8");
}

describe("mobile push documentation contract", () => {
  it("documents the dedicated device channel, not the retired relay design", () => {
    const readme = repoFile("apps/mobile/README.md");
    const settings = repoFile("apps/mobile/app/(tabs)/settings.tsx");

    expect(readme).toContain("POST /api/v1/mobile/push/devices");
    expect(readme).toContain("envelope-encrypted token");
    expect(readme).toContain("receipt reconciliation");
    expect(readme).not.toContain("/api/public/mobile/expo-push");
    expect(readme).not.toContain("POST /api/v1/webhooks` to register");
    expect(settings).toContain("server-enabled Moosewave alerts");
    expect(settings).not.toContain("receive subscriber events");
  });
});
