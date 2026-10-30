// SPDX-License-Identifier: AGPL-3.0-only
//
// Regression: three surfaces render a `scale` field and only one of them
// repaired an inverted range. The builder lets Minimum and Maximum be set
// independently (both accept 0–10), so Minimum=5 / Maximum=1 is reachable
// without any warning.
//
//   * published HTML (forms-types) — normalizeScaleRange() → 1..5, fine;
//   * builder preview (field-block) — Math.max(0, …) → renders nothing;
//   * SurveyForm — `for (let n = min; n <= max; n++)` → renders nothing.
//
// The last one is the damaging case: the respondent gets a REQUIRED question
// with no selectable option, so the step can never validate and the survey
// cannot be submitted at all. The published form and the survey UI disagreed
// about the same stored structure.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SurveyForm } from "@/components/SurveyForm";
import { normalizeScaleRange } from "@/lib/forms-types";
import type { Form, FormField } from "@/lib/forms-types";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

function formWith(fields: FormField[]): Form {
  return {
    id: "f1",
    tenantId: "t1",
    slug: "survey",
    name: "Survey",
    optInMode: "single",
    structure: { fields },
    settings: { successMessage: "Thanks" },
    status: "published",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const scale = (scaleMin: number, scaleMax: number): FormField => ({
  id: "s1",
  kind: "scale",
  label: "Rate us",
  required: true,
  scaleMin,
  scaleMax,
});

describe("scale range normalization", () => {
  it("repairs an inverted range to the default band", () => {
    expect(normalizeScaleRange(5, 1)).toEqual({ min: 1, max: 5 });
  });

  it("keeps a valid range untouched", () => {
    expect(normalizeScaleRange(0, 10)).toEqual({ min: 0, max: 10 });
  });

  it("renders answerable options for an inverted range in SurveyForm", () => {
    const html = renderToStaticMarkup(
      <SurveyForm form={formWith([scale(5, 1)])} actionUrl="/submit" />,
    );
    // A required question with zero radios can never be satisfied.
    const radios = html.match(/type="radio"/g) ?? [];
    expect(radios.length).toBeGreaterThan(0);
  });

  it("renders the requested band when the range is valid", () => {
    const html = renderToStaticMarkup(
      <SurveyForm form={formWith([scale(1, 3)])} actionUrl="/submit" />,
    );
    expect((html.match(/type="radio"/g) ?? []).length).toBe(3);
  });
});
