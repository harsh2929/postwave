// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { post: mocks.post } }));

import {
  composeEmailBlocks,
  WorkspaceOpsContractError,
} from "@/lib/workspace-ops-api";

const brand = {
  primary_color: "#123456",
  body_font: "Arial",
  heading_font: "Arial",
  background_color: "#ffffff",
};

beforeEach(() => mocks.post.mockReset());

describe("email block composition contract", () => {
  it("posts ordered block instances and parses warnings without block_ids", async () => {
    mocks.post.mockResolvedValue({
      mjml: "<mjml>\n<mj-body />\n</mjml>",
      warnings: ["Footer address is empty"],
    });
    await expect(
      composeEmailBlocks({
        brand,
        blocks: [{ block_id: "text", config: { content: "Hello" } }],
        subject: " Launch ",
      }),
    ).resolves.toMatchObject({ warnings: ["Footer address is empty"] });

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/email-blocks/compose",
      {
        brand,
        blocks: [{ block_id: "text", config: { content: "Hello" } }],
        subject: "Launch",
      },
      { requireOnline: true, maxAttempts: 1 },
    );
    expect(JSON.stringify(mocks.post.mock.calls[0])).not.toContain("block_ids");
  });

  it("rejects malformed input and malformed success without transport ambiguity", async () => {
    await expect(
      composeEmailBlocks({ brand, blocks: [{ block_id: "../text", config: {} }] }),
    ).rejects.toBeInstanceOf(WorkspaceOpsContractError);
    expect(mocks.post).not.toHaveBeenCalled();

    mocks.post.mockResolvedValue({ mjml: "", warnings: "not-an-array" });
    await expect(
      composeEmailBlocks({ brand, blocks: [{ block_id: "text", config: {} }] }),
    ).rejects.toBeInstanceOf(WorkspaceOpsContractError);
  });
});

