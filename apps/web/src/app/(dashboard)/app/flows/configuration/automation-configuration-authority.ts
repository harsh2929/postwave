// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef } from "react";
import {
  effectiveAuthRole,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";

export function assertFreshAutomationAdmin(
  opened: MeResponse,
  fresh: MeResponse,
): void {
  if (
    opened.user_id !== fresh.user_id ||
    opened.tenant_id !== fresh.tenant_id ||
    effectiveAuthRole(opened) !== effectiveAuthRole(fresh) ||
    Boolean(opened.viewer_mode) !== Boolean(fresh.viewer_mode) ||
    fresh.viewer_mode
  )
    throw new Error(
      "Your workspace authority changed. Nothing was written; refresh and retry.",
    );
  if (!["owner", "admin"].includes(effectiveAuthRole(fresh)))
    throw new Error("Administrator access is required.");
}

export async function verifyFreshAutomationAdmin(
  opened: MeResponse,
  signal?: AbortSignal,
): Promise<MeResponse> {
  const fresh = await whoamiFresh(signal);
  assertFreshAutomationAdmin(opened, fresh);
  return fresh;
}

export function useAutomationReadAbort() {
  const active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );
  return () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    return controller;
  };
}
