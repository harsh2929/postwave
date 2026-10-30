import { useEffect, useState } from "react";

import { toast } from "../../components/Toast";
import type { Tag } from "../../lib/api-client";
import {
  consumePendingDeepLinkTarget,
  onPendingDeepLinkTarget,
} from "../../lib/deep-link";
import {
  getDesktopRoute,
  requestDesktopRouteNavigation,
} from "../../lib/desktop-router";
import { routeWithTagDetail } from "./tagRouteState";

export function useTagCatalogDeepLink(rows: Tag[] | null): void {
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    const accept = (target: { section: string; id: string } | null): void => {
      if (target?.section === "tags" && target.id) setPendingId(target.id);
    };
    accept(consumePendingDeepLinkTarget());
    return onPendingDeepLinkTarget((target) => {
      if (target.section !== "tags") return;
      consumePendingDeepLinkTarget();
      accept(target);
    });
  }, []);

  useEffect(() => {
    if (!pendingId || !rows) return;
    setPendingId(null);
    const match = rows.find((row) => row.id === pendingId);
    if (!match) {
      toast.error("Couldn't find that tag — it may have been deleted.");
      return;
    }
    void requestDesktopRouteNavigation(
      routeWithTagDetail(getDesktopRoute(), match.id),
      { replace: true, source: "deep-link" },
    );
  }, [pendingId, rows]);
}
