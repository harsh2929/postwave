import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectDesignSystemFindings } from "./design-system-guardrails.mjs";

function fixtureManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    legacyClassBudgets: {
      legacyNoticeClass: 0,
      legacyAlertClass: 0,
      legacyCalloutClass: 0,
      legacyCardClass: 0,
      rawSkeletonClass: 0,
    },
    governedSources: ["pages/Safe.tsx"],
    inlineSemanticStyleExceptions: [],
    skeletonGroupOwners: [],
    primitiveSources: [],
    storySources: [],
    ...overrides,
  };
}

describe("desktop design-system source guardrails", () => {
  it("allows domain layout without granting semantic paint", () => {
    const findings = collectDesignSystemFindings(
      new Map([
        [
          "pages/Safe.tsx",
          "export const safe = <div style={{ display: 'grid', gap: 8, marginTop: 12 }} />;",
        ],
      ]),
      fixtureManifest(),
    );
    assert.deepEqual(findings, []);
  });

  it("rejects undefined callout/card patterns and inline semantic chrome", () => {
    const findings = collectDesignSystemFindings(
      new Map([
        [
          "pages/Safe.tsx",
          'export const unsafe = <div className="card" style={{ background: "red", borderRadius: 9 }} />;',
        ],
      ]),
      fixtureManifest(),
    );
    assert.match(findings.join("\n"), /legacyCardClass grew/);
    assert.match(findings.join("\n"), /inline background paint/);
    assert.match(findings.join("\n"), /inline borderRadius paint/);
  });

  it("rejects a legacy Card promoted to a pseudo-button", () => {
    const findings = collectDesignSystemFindings(
      new Map([
        [
          "pages/Safe.tsx",
          'export const unsafe = <div className="card item" role="button" tabIndex={0} />;',
        ],
      ]),
      fixtureManifest({
        legacyClassBudgets: {
          ...fixtureManifest().legacyClassBudgets,
          legacyCardClass: 1,
        },
      }),
    );
    assert.match(findings.join("\n"), /interactive legacy Card wrapper/);
  });

  it("accepts only bounded, explained domain exceptions", () => {
    const manifest = fixtureManifest({
      inlineSemanticStyleExceptions: [
        {
          source: "pages/Safe.tsx",
          contains: "background: metricColor",
          maxOccurrences: 1,
          reason: "Measured data-series encoding.",
        },
      ],
    });
    const sourceMap = new Map([
      [
        "pages/Safe.tsx",
        "export const data = { background: metricColor(value) };",
      ],
    ]);
    assert.deepEqual(collectDesignSystemFindings(sourceMap, manifest), []);

    sourceMap.set("pages/Safe.tsx", "export const data = { display: 'grid' };");
    assert.match(
      collectDesignSystemFindings(sourceMap, manifest).join("\n"),
      /ratchet maximum 1/,
    );
  });

  it("requires one reviewed announcement owner for decorative Skeleton groups", () => {
    const sourceMap = new Map([
      ["pages/Safe.tsx", "export const loading = <Skeleton lines={3} />;"],
    ]);
    assert.match(
      collectDesignSystemFindings(sourceMap, fixtureManifest()).join("\n"),
      /without a reviewed group owner/,
    );

    const manifest = fixtureManifest({
      skeletonGroupOwners: [
        {
          source: "pages/Safe.tsx",
          requiresAny: ['role="status"'],
          reason: "The parent announces the loading group once.",
        },
      ],
    });
    sourceMap.set(
      "pages/Safe.tsx",
      'export const loading = <div role="status"><Skeleton lines={3} /></div>;',
    );
    assert.deepEqual(collectDesignSystemFindings(sourceMap, manifest), []);
  });
});
