// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@/lib/auth-api";
import {
  canWriteFlows,
  FlowWriteAuthorityError,
  verifyFreshFlowWriteAuthority,
} from "@/lib/flow-write-authority";

const mocks = vi.hoisted(() => ({ whoamiFresh: vi.fn() }));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: mocks.whoamiFresh,
}));

function identity(patch: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "operator@example.test",
    role: "owner",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Workspace",
    workspace_slug: "workspace",
    ...patch,
  };
}

beforeEach(() => mocks.whoamiFresh.mockReset());

describe("flow write authority", () => {
  it("matches the backend write:campaigns role and viewer-mode policy", () => {
    for (const role of ["owner", "admin", "editor"] as const) {
      expect(canWriteFlows(identity({ role }))).toBe(true);
    }
    expect(canWriteFlows(identity({ role: "viewer" }))).toBe(false);
    expect(canWriteFlows(identity({ viewer_mode: true }))).toBe(false);
    expect(
      canWriteFlows(identity({ role: "admin", effective_role: "viewer" })),
    ).toBe(false);
  });

  it("rechecks exact identity and authority before allowing transport", async () => {
    const opened = identity({ role: "editor" });
    mocks.whoamiFresh.mockResolvedValueOnce(identity({ role: "editor" }));
    await expect(verifyFreshFlowWriteAuthority(opened)).resolves.toEqual(
      identity({ role: "editor" }),
    );
    expect(mocks.whoamiFresh).toHaveBeenCalledOnce();

    for (const changed of [
      identity({ role: "viewer" }),
      identity({ role: "editor", viewer_mode: true }),
      identity({ role: "editor", tenant_id: "tenant-2" }),
      identity({ role: "editor", user_id: "user-2" }),
    ]) {
      mocks.whoamiFresh.mockResolvedValueOnce(changed);
      await expect(
        verifyFreshFlowWriteAuthority(opened),
      ).rejects.toBeInstanceOf(FlowWriteAuthorityError);
    }
  });

  it("keeps every Flow mutation behind fresh authority and its UI read-only", () => {
    const src = (path: string) =>
      readFileSync(resolve(process.cwd(), "src", path), "utf8");
    const list = src("app/(dashboard)/app/flows/page.tsx");
    const editor = src("app/(dashboard)/app/flows/_components/flow-editor.tsx");
    const versions = src(
      "app/(dashboard)/app/flows/_components/version-history.tsx",
    );

    expect(
      list.match(/verifyFreshFlowWriteAuthority\(meQuery\.data\)/gu),
    ).toHaveLength(4);
    expect(
      editor.match(/verifyFreshFlowWriteAuthority\(meQuery\.data\)/gu),
    ).toHaveLength(4);
    expect(
      versions.match(/verifyFreshFlowWriteAuthority\(identity\)/gu),
    ).toHaveLength(2);
    expect(list).toContain("disabled={!canWrite}");
    expect(editor).toContain("onMove={canWrite ? moveNode : undefined}");
    expect(editor).toContain("readOnly={!canWrite}");
    expect(versions).toContain("disabled={!canWrite}");
  });
});
