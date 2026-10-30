import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const deliverability = readFileSync(
  new URL("../app/(dashboard)/app/deliverability/page.tsx", import.meta.url),
  "utf8",
);
const replies = readFileSync(
  new URL("../app/(dashboard)/app/replies/page.tsx", import.meta.url),
  "utf8",
);

describe("reply mailbox web mounts", () => {
  it("mounts the operator manager in deliverability", () => {
    expect(deliverability).not.toContain('from "./reply-mailbox-manager"');
    expect(deliverability).toContain('import("./reply-mailbox-manager")');
    expect(deliverability).toContain("mod.ReplyMailboxManager");
    expect(deliverability).toContain(
      "<ReplyMailboxManager identity={meQuery.data} />",
    );
  });

  it("mounts the same authority-aware manager beside reply analytics", () => {
    expect(replies).toContain(
      'import { ReplyMailboxManager } from "../deliverability/reply-mailbox-manager";',
    );
    expect(replies).toContain(
      "<ReplyMailboxManager identity={meQuery.data} />",
    );
  });
});
