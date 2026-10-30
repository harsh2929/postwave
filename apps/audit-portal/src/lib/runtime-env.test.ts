import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const script = `${packageRoot}validate-runtime-env.sh`;

/**
 * Runs the validator the way the nginx entrypoint does for an `*.envsh` hook —
 * sourced into the shell that later runs `20-envsubst-on-templates.sh` — and
 * reports what that shell would hand to envsubst.
 */
function sourced(env: Record<string, string>): {
  status: number;
  apiOrigin: string;
  frameAncestors: string;
} {
  try {
    const stdout = execFileSync(
      "sh",
      [
        "-c",
        `. "$1"; printf '%s\\n%s\\n' "$POSTWAVE_API_ORIGIN" "$POSTWAVE_PORTAL_FRAME_ANCESTORS"`,
        "sh",
        script,
      ],
      { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", stdio: "pipe" },
    );
    const [apiOrigin = "", frameAncestors = ""] = stdout.split("\n");
    return { status: 0, apiOrigin, frameAncestors };
  } catch (error) {
    return {
      status: (error as { status?: number }).status ?? -1,
      apiOrigin: "",
      frameAncestors: "",
    };
  }
}

describe("audit-portal runtime env validation", () => {
  it("hands the resolved values to the envsubst pass rather than to a dead child", () => {
    expect(sourced({ POSTWAVE_API_ORIGIN: "https://api.postwave.example" })).toEqual({
      status: 0,
      apiOrigin: "https://api.postwave.example",
      frameAncestors: "'none'",
    });
    expect(
      sourced({
        POSTWAVE_API_ORIGIN: "https://api.postwave.example",
        POSTWAVE_PORTAL_FRAME_ANCESTORS: "'self' https://acme.example",
      }).frameAncestors,
    ).toBe("'self' https://acme.example");
  });

  it("refuses an explicitly empty frame-ancestor list instead of rendering none at all", () => {
    // An empty source list is a directive parse error, so the browser drops
    // frame-ancestors entirely and nothing else in nginx.conf forbids framing.
    expect(
      sourced({
        POSTWAVE_API_ORIGIN: "https://api.postwave.example",
        POSTWAVE_PORTAL_FRAME_ANCESTORS: "",
      }).status,
    ).toBe(78);
    expect(
      sourced({
        POSTWAVE_API_ORIGIN: "https://api.postwave.example",
        POSTWAVE_PORTAL_FRAME_ANCESTORS: "   ",
      }).status,
    ).toBe(78);
  });

  it("still fails closed on a hostile upstream or ancestor", () => {
    expect(sourced({ POSTWAVE_API_ORIGIN: "https://api.example/path" }).status).toBe(78);
    expect(sourced({}).status).toBe(78);
    expect(
      sourced({
        POSTWAVE_API_ORIGIN: "https://api.postwave.example",
        POSTWAVE_PORTAL_FRAME_ANCESTORS: "*",
      }).status,
    ).toBe(78);
    expect(
      sourced({
        POSTWAVE_API_ORIGIN: "https://api.postwave.example",
        POSTWAVE_PORTAL_FRAME_ANCESTORS: "http://acme.example",
      }).status,
    ).toBe(78);
  });

  it("is installed under the suffix the nginx entrypoint sources", () => {
    // `*.sh` hooks are executed in a child process, so their exports never
    // reach the envsubst pass; only `*.envsh` hooks are sourced.
    const dockerfile = readFileSync(`${packageRoot}Dockerfile`, "utf8");
    expect(dockerfile).toContain(
      "/docker-entrypoint.d/10-validate-postwave-runtime.envsh",
    );
    expect(dockerfile).not.toContain(
      "/docker-entrypoint.d/10-validate-postwave-runtime.sh",
    );
    expect(dockerfile).toMatch(/^USER 101:101$/mu);
    expect(dockerfile).toContain(
      "COPY apps/audit-portal apps/audit-portal",
    );
    expect(dockerfile).not.toContain("COPY . .");
  });
});
