// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  delayToHours,
  describeDelay,
  filterSortSequences,
  hoursToDelay,
  isProfileStale,
  resolveTemplateName,
  sequenceStatusGroup,
  sequenceToMarkdown,
  stepsForDuplicate,
  templateNameLookup,
} from "@/lib/sequence-helpers";
import type {
  Sequence,
  SequenceListItem,
  SequenceTemplate,
  VoiceSource,
} from "@/lib/voice-types";

function row(patch: Partial<SequenceListItem> = {}): SequenceListItem {
  return {
    id: "s1",
    name: "Alpha",
    templateName: "welcome",
    status: "draft",
    fidelityAvg: 50,
    updatedAt: "2026-01-01T00:00:00.000Z",
    emailCount: 3,
    ...patch,
  };
}

describe("filterSortSequences", () => {
  const rows = [
    row({ id: "a", name: "Beta", fidelityAvg: 90, updatedAt: "2026-01-03T00:00:00Z", status: "draft" }),
    row({ id: "b", name: "alpha", fidelityAvg: 70, updatedAt: "2026-01-02T00:00:00Z", status: "archived" }),
    row({ id: "c", name: "Gamma", fidelityAvg: 70, updatedAt: "2026-01-01T00:00:00Z", status: "active" }),
  ];

  it("filters by status group", () => {
    expect(
      filterSortSequences(rows, {
        query: "",
        statusFilter: "read-only",
        sort: "name",
        dir: "asc",
      }).map((r) => r.id),
    ).toEqual(["c"]);
  });

  it("filters by name/template query case-insensitively", () => {
    expect(
      filterSortSequences(rows, {
        query: "alph",
        statusFilter: "all",
        sort: "name",
        dir: "asc",
      }).map((r) => r.id),
    ).toEqual(["b"]);
  });

  it("sorts by fidelity desc with name tiebreaker", () => {
    expect(
      filterSortSequences(rows, {
        query: "",
        statusFilter: "all",
        sort: "fidelity",
        dir: "desc",
      }).map((r) => r.id),
    ).toEqual(["a", "b", "c"]); // 90, then 70/70 tie → alpha(b) before Gamma(c)
  });

  it("sorts by updated ascending", () => {
    expect(
      filterSortSequences(rows, {
        query: "",
        statusFilter: "all",
        sort: "updated",
        dir: "asc",
      }).map((r) => r.id),
    ).toEqual(["c", "b", "a"]);
  });

  it("does not mutate the input array", () => {
    const input = [...rows];
    filterSortSequences(input, {
      query: "",
      statusFilter: "all",
      sort: "name",
      dir: "asc",
    });
    expect(input.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("sequenceStatusGroup", () => {
  it("maps lifecycle to groups", () => {
    expect(sequenceStatusGroup("draft")).toBe("draft");
    expect(sequenceStatusGroup("archived")).toBe("archived");
    expect(sequenceStatusGroup("active")).toBe("read-only");
    expect(sequenceStatusGroup("unknown")).toBe("read-only");
  });
});

describe("resolveTemplateName", () => {
  const templates: SequenceTemplate[] = [
    {
      id: "tpl_123",
      slug: "welcome-series",
      name: "Welcome series",
      description: "",
      category: "Onboarding",
      length: 3,
      variables: [],
      emails: [],
    },
  ];

  it("resolves by id and by slug", () => {
    const lookup = templateNameLookup(templates);
    expect(resolveTemplateName("tpl_123", lookup)).toBe("Welcome series");
    expect(resolveTemplateName("welcome-series", lookup)).toBe("Welcome series");
  });

  it("falls back to the raw id when unknown", () => {
    const lookup = templateNameLookup(templates);
    expect(resolveTemplateName("mystery", lookup)).toBe("mystery");
    expect(resolveTemplateName("", lookup)).toBe("—");
  });
});

function seq(patch: Partial<Sequence> = {}): Sequence {
  return {
    id: "seq1",
    name: "Launch",
    templateId: "tpl",
    templateName: "tpl",
    status: "draft",
    fidelityAvg: 0,
    emails: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

describe("stepsForDuplicate", () => {
  it("preserves all step types and renumbers positions", () => {
    const source = seq({
      steps: [
        { type: "email", position: 5, email: { subject: "Hi" } },
        { type: "delay", position: 6, delay: { seconds: 3600 } },
        { type: "condition", position: 7, condition: { predicate: "opened_previous" } },
        { type: "tag_add", position: 8, tag: { tag: "vip" } },
        { type: "exit", position: 9 },
      ],
    });
    const result = stepsForDuplicate(source);
    expect(result.map((s) => s.type)).toEqual([
      "email",
      "delay",
      "condition",
      "tag_add",
      "exit",
    ]);
    expect(result.map((s) => s.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it("falls back to email steps for legacy step-less rows", () => {
    const source = seq({
      emails: [
        {
          id: "e1",
          position: 1,
          subject: "One",
          bodyMarkdown: "Body",
          bodyHtml: "",
          bodyMjml: null,
          delayHours: 24,
          fidelity: 80,
          fidelityBreakdown: { embedding: 0, stylistic: 0, vocab: 0, structural: 0 },
        },
      ],
    });
    const result = stepsForDuplicate(source);
    expect(result).toEqual([
      {
        type: "email",
        position: 1,
        email: {
          subject: "One",
          body: "Body",
          body_html: undefined,
          body_mjml: undefined,
          delay_seconds: 86400,
        },
      },
    ]);
  });
});

describe("delay math", () => {
  it("converts hours to the largest clean unit", () => {
    expect(hoursToDelay(72)).toEqual({ value: 3, unit: "days" });
    expect(hoursToDelay(2)).toEqual({ value: 2, unit: "hours" });
    expect(hoursToDelay(0.5)).toEqual({ value: 30, unit: "minutes" });
    expect(hoursToDelay(0)).toEqual({ value: 0, unit: "hours" });
  });

  it("round-trips value+unit to hours", () => {
    expect(delayToHours(3, "days")).toBe(72);
    expect(delayToHours(30, "minutes")).toBe(0.5);
    expect(delayToHours(2, "hours")).toBe(2);
  });

  it("describes delays in words", () => {
    expect(describeDelay(0)).toBe("Send immediately");
    expect(describeDelay(72)).toBe("3 days");
    expect(describeDelay(1)).toBe("1 hour");
  });
});

describe("sequenceToMarkdown", () => {
  it("serializes emails with delays and separators", () => {
    const md = sequenceToMarkdown(
      seq({
        name: "My Seq",
        emails: [
          {
            id: "e1",
            position: 1,
            subject: "First",
            bodyMarkdown: "Hello there",
            bodyHtml: "",
            bodyMjml: null,
            delayHours: 0,
            fidelity: 0,
            fidelityBreakdown: { embedding: 0, stylistic: 0, vocab: 0, structural: 0 },
          },
          {
            id: "e2",
            position: 2,
            subject: "Second",
            bodyMarkdown: "Follow up",
            bodyHtml: "",
            bodyMjml: null,
            delayHours: 48,
            fidelity: 0,
            fidelityBreakdown: { embedding: 0, stylistic: 0, vocab: 0, structural: 0 },
          },
        ],
      }),
    );
    expect(md).toContain("# My Seq");
    expect(md).toContain("## Email 1 — First");
    expect(md).toContain("_Send immediately_");
    expect(md).toContain("## Email 2 — Second");
    expect(md).toContain("_2 days after the previous email_");
    expect(md).toContain("---");
    expect(md.endsWith("\n")).toBe(true);
  });
});

describe("isProfileStale", () => {
  const source = (patch: Partial<VoiceSource> = {}): VoiceSource => ({
    id: "src",
    type: "paste",
    label: "Paste",
    itemCount: 1,
    lastIngestedAt: null,
    status: "ready",
    ...patch,
  });

  it("is stale when a source ingested after the build", () => {
    expect(
      isProfileStale("2026-01-01T00:00:00Z", [
        source({ lastIngestedAt: "2026-01-02T00:00:00Z" }),
      ]),
    ).toBe(true);
  });

  it("is fresh when all ingests predate the build", () => {
    expect(
      isProfileStale("2026-01-03T00:00:00Z", [
        source({ lastIngestedAt: "2026-01-02T00:00:00Z" }),
        source({ lastIngestedAt: null }),
      ]),
    ).toBe(false);
  });

  it("is fresh with no ingested sources", () => {
    expect(isProfileStale("2026-01-03T00:00:00Z", [source()])).toBe(false);
  });
});
