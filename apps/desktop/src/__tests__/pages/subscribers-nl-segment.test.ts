import { describe, expect, it } from "vitest";

import type { SegmentNode, SegmentNutritionFacts } from "../../lib/api-client";
import {
  composeNLCompiledAST,
  deriveNLSavedFilters,
  flattenNLChips,
  normalizeNLStatusCondition,
  pruneNLFacts,
  removeNLNodeAtPath,
  validateNLCompiledAST,
} from "../../pages/subscribers-nl-segment";

const AST: SegmentNode = {
  op: "and",
  children: [
    {
      op: "condition",
      field: "status",
      comparator: "equals",
      value: "subscribed",
    },
    {
      op: "or",
      children: [
        {
          op: "condition",
          field: "opened_at",
          comparator: "gte",
          value: "now-7d",
        },
        {
          op: "not",
          child: {
            op: "condition",
            field: "country",
            comparator: "in",
            value: ["IN", "US"],
          },
        },
      ],
    },
  ],
};

describe("subscriber natural-language segment helpers", () => {
  it("uses the same status columns and aliases as the Directory filter", () => {
    expect(normalizeNLStatusCondition("subscribed")).toEqual({
      field: "mailchimp_status",
      value: "subscribed",
    });
    expect(normalizeNLStatusCondition("bounced")).toEqual({
      field: "mailchimp_status",
      value: "cleaned",
    });
    expect(normalizeNLStatusCondition("disabled")).toEqual({
      field: "status",
      value: "disabled",
    });
    expect(normalizeNLStatusCondition("all")).toBeNull();
    expect(normalizeNLStatusCondition("invented")).toBeNull();
  });

  it("flattens condition leaves with stable paths, labels, and negation", () => {
    expect(flattenNLChips(AST)).toEqual([
      {
        label: "status equals subscribed",
        path: [0],
        negated: false,
      },
      {
        label: "opened_at gte now-7d",
        path: [1, 0],
        negated: false,
      },
      {
        label: 'country in ["IN","US"]',
        path: [1, 1, -1],
        negated: true,
      },
    ]);
    expect(
      flattenNLChips({
        op: "condition",
        field: "score",
        comparator: "not_equals",
        value: null,
      }),
    ).toEqual([{ label: "score not equals", path: [], negated: false }]);
    expect(flattenNLChips(null)).toEqual([]);
    expect(flattenNLChips({ op: "unknown" })).toEqual([]);
  });

  it("removes a selected leaf and collapses single-child boolean shells", () => {
    expect(removeNLNodeAtPath(AST, [1, 0])).toEqual({
      op: "and",
      children: [
        AST.children[0],
        {
          op: "not",
          child: {
            op: "condition",
            field: "country",
            comparator: "in",
            value: ["IN", "US"],
          },
        },
      ],
    });
    expect(removeNLNodeAtPath(AST, [1, 1, -1])).toEqual({
      op: "and",
      children: [
        {
          op: "condition",
          field: "status",
          comparator: "equals",
          value: "subscribed",
        },
        {
          op: "condition",
          field: "opened_at",
          comparator: "gte",
          value: "now-7d",
        },
      ],
    });
    expect(removeNLNodeAtPath(AST, [])).toBeNull();
    expect(removeNLNodeAtPath(AST, [99])).toEqual(AST);
  });

  it("prunes nutrition facts to fields and time windows still in the AST", () => {
    const facts: SegmentNutritionFacts = {
      predicates: ["status", "opened_at", "country", "unused"],
      time_windows: ["now-7d", "2026-07-01", "now+30d"],
      source: "ai-compiler",
      model: "test",
    };

    expect(pruneNLFacts(facts, AST)).toEqual({
      ...facts,
      predicates: ["status", "opened_at", "country"],
      time_windows: ["now-7d"],
    });
    expect(pruneNLFacts(facts, null)).toEqual({
      ...facts,
      predicates: [],
      time_windows: [],
    });
    expect(pruneNLFacts(null, AST)).toBeNull();
  });

  it("validates and canonicalizes untrusted compiler trees within review budgets", () => {
    expect(validateNLCompiledAST(AST)).toMatchObject({
      ok: true,
      nodeCount: 6,
    });
    expect(
      validateNLCompiledAST({
        op: "not",
        children: [AST.children[0]],
      }),
    ).toEqual({
      ok: true,
      ast: { op: "not", child: AST.children[0] },
      nodeCount: 2,
    });
    expect(
      validateNLCompiledAST({
        op: "condition",
        field: "email",
        comparator: "execute_sql",
        value: "anything",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateNLCompiledAST({
        op: "not",
        child: AST.children[0],
        children: [AST.children[1]],
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateNLCompiledAST({
        op: "and",
        children: Array.from({ length: 33 }, () => AST.children[0]),
      }),
    ).toMatchObject({ ok: false });

    let tooDeep: unknown = AST.children[0];
    for (let index = 0; index < 14; index += 1) {
      tooDeep = { op: "not", child: tooDeep };
    }
    expect(validateNLCompiledAST(tooDeep)).toMatchObject({ ok: false });
  });

  it("freezes status as a mandatory top-level constraint and rejects broad directory search", () => {
    const compiled: SegmentNode = {
      op: "condition",
      field: "tag",
      comparator: "equals",
      value: "vip",
    };
    const composed = composeNLCompiledAST(compiled, {
      status: "subscribed",
      query: "",
    });
    expect(composed).toEqual({
      op: "and",
      children: [
        compiled,
        {
          op: "condition",
          field: "mailchimp_status",
          comparator: "equals",
          value: "subscribed",
        },
      ],
    });
    expect(
      deriveNLSavedFilters(composed, {
        status: "subscribed",
        query: "",
      }),
    ).toEqual({ status: "subscribed" });

    const withoutStatus = removeNLNodeAtPath(composed, [1]);
    expect(
      withoutStatus &&
        deriveNLSavedFilters(withoutStatus, {
          status: "subscribed",
          query: "",
        }),
    ).toEqual({});

    expect(() =>
      composeNLCompiledAST(compiled, {
        status: "subscribed",
        query: "vip customer",
      }),
    ).toThrow("Clear the directory search");

    const statusInsideAny: SegmentNode = {
      op: "or",
      children: [
        {
          op: "condition",
          field: "mailchimp_status",
          comparator: "equals",
          value: "subscribed",
        },
        compiled,
      ],
    };
    expect(
      composeNLCompiledAST(statusInsideAny, {
        status: "subscribed",
        query: "",
      }),
    ).toEqual({
      op: "and",
      children: [
        statusInsideAny,
        {
          op: "condition",
          field: "mailchimp_status",
          comparator: "equals",
          value: "subscribed",
        },
      ],
    });
  });
});
