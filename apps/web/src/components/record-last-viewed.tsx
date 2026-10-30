// SPDX-License-Identifier: AGPL-3.0-only
//
// Fire-and-forget recorder for the cross-device resume cursor (Phase 1 —
// Continuity). Dropped onto an entity detail view, it records that entity as
// the user's "last viewed" so any of their other devices can offer "Continue".
// Renders nothing. The write is best-effort (see lib/activity-cursor).
"use client";

import { useEffect } from "react";

import { recordLastViewed } from "@/lib/activity-cursor";

export function RecordLastViewed({ entity, id }: { entity: string; id: string }) {
  useEffect(() => {
    void recordLastViewed(entity, id);
  }, [entity, id]);
  return null;
}
