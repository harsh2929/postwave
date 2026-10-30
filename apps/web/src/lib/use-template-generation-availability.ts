// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";

import { listCampaignTemplateDesigns } from "@/lib/campaign-templates-api";
import { useVerifiedAuthScopeOptional } from "@/lib/auth-scope";

export type TemplateGenerationAvailability =
  | "checking"
  | "available"
  | "unavailable"
  | "error";

type CheckResult = Exclude<TemplateGenerationAvailability, "checking">;
const checks = new Map<string, {
  until: number;
  result: Promise<CheckResult>;
  value?: CheckResult;
}>();

function availabilityCheck(scope: string): Promise<CheckResult> {
  const cached = checks.get(scope);
  if (cached && cached.until > Date.now()) return cached.result;
  const entry: { until: number; result: Promise<CheckResult>; value?: CheckResult } = {
    until: Date.now() + 30_000,
    result: Promise.resolve("error"),
  };
  entry.result = listCampaignTemplateDesigns({ limit: 1 })
    .then((page): CheckResult => page.generation_available === true ? "available" : "unavailable")
    .catch((): CheckResult => {
      entry.until = Date.now() + 5_000;
      return "error";
    })
    .then((value) => {
      entry.value = value;
      return value;
    });
  checks.set(scope, entry);
  return entry.result;
}

/**
 * Fail closed on older API releases and failed reads. The API announces
 * configured generation on the existing actor-private design-list response;
 * the browser must never infer it from permission to write campaigns.
 */
export function useTemplateGenerationAvailability(
  enabled = true,
): TemplateGenerationAvailability {
  const authScope = useVerifiedAuthScopeOptional();
  const scopeKey = authScope
    ? `${authScope.tenantId}:${authScope.userId}`
    : "";
  const [availability, setAvailability] =
    useState<TemplateGenerationAvailability>("checking");

  useEffect(() => {
    if (!enabled) {
      setAvailability("unavailable");
      return;
    }
    if (!scopeKey) {
      setAvailability("checking");
      return;
    }
    let active = true;
    const cached = checks.get(scopeKey);
    if (cached?.value && cached.until > Date.now()) {
      setAvailability(cached.value);
      return;
    }
    setAvailability("checking");
    void availabilityCheck(scopeKey).then((value) => {
      if (active) setAvailability(value);
    });
    return () => { active = false; };
  }, [enabled, scopeKey]);

  return availability;
}
