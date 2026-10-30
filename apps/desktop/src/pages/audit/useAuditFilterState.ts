import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ActionCategory,
  ActorType,
  DayRange,
} from "../../components/audit/AuditFilters";
import { toast } from "../../components/Toast";
import { desktopRouteIdentityScope } from "../../lib/desktop-router";
import { useMe } from "../../lib/store";
import type { AuditViewMode } from "./audit-page-types";
import {
  createAuditFilterArgs,
  decodeAuditSavedViewFilters,
  isAuditActorType,
  readAuditViewMode,
  readIncludeManifest,
  readPersistedAuditFilters,
  writeAuditViewMode,
  writeIncludeManifest,
  writePersistedAuditFilters,
} from "./audit-page-utils";

export function useAuditFilterState() {
  const me = useMe();
  const storageScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  const persisted = useMemo(
    () => readPersistedAuditFilters(storageScope),
    [storageScope],
  );
  const [hydratedScope, setHydratedScope] = useState(storageScope);
  const [actorType, setActorType] = useState<ActorType>(
    persisted.actorType ?? "any",
  );
  const [actorLabel, setActorLabel] = useState(persisted.actorLabel ?? "");
  const [actionQuery, setActionQuery] = useState(persisted.actionQuery ?? "");
  const [resourceType, setResourceType] = useState(
    persisted.resourceType ?? "",
  );
  const [resourceId, setResourceId] = useState(persisted.resourceId ?? "");
  const [days, setDays] = useState<DayRange>(persisted.days ?? 30);
  const [category, setCategory] = useState<ActionCategory>(
    persisted.category ?? "all",
  );
  const [viewMode, setViewMode] = useState<AuditViewMode>(() =>
    readAuditViewMode(storageScope),
  );
  const [includeManifest, setIncludeManifest] = useState<boolean>(() =>
    readIncludeManifest(storageScope),
  );

  useEffect(() => {
    if (hydratedScope === storageScope) return;
    setActorType(persisted.actorType ?? "any");
    setActorLabel(persisted.actorLabel ?? "");
    setActionQuery(persisted.actionQuery ?? "");
    setResourceType(persisted.resourceType ?? "");
    setResourceId(persisted.resourceId ?? "");
    setDays(persisted.days ?? 30);
    setCategory(persisted.category ?? "all");
    setViewMode(readAuditViewMode(storageScope));
    setIncludeManifest(readIncludeManifest(storageScope));
    setHydratedScope(storageScope);
  }, [hydratedScope, persisted, storageScope]);

  useEffect(() => {
    if (hydratedScope === storageScope) {
      writeAuditViewMode(viewMode, storageScope);
    }
  }, [hydratedScope, storageScope, viewMode]);
  useEffect(() => {
    if (hydratedScope === storageScope) {
      writeIncludeManifest(includeManifest, storageScope);
    }
  }, [hydratedScope, includeManifest, storageScope]);
  useEffect(() => {
    if (hydratedScope !== storageScope) return;
    writePersistedAuditFilters(
      {
        actorType,
        actorLabel,
        actionQuery,
        resourceType,
        resourceId,
        days,
        category,
      },
      storageScope,
    );
  }, [
    actorType,
    actorLabel,
    actionQuery,
    resourceType,
    resourceId,
    days,
    category,
    hydratedScope,
    storageScope,
  ]);

  const filterArgs = useMemo(
    () =>
      createAuditFilterArgs({
        actorType,
        actorLabel,
        actionQuery,
        resourceType,
        resourceId,
        days,
        category,
      }),
    [
      actorType,
      actorLabel,
      actionQuery,
      resourceType,
      resourceId,
      days,
      category,
    ],
  );
  const filterReqIdRef = useRef(0);
  useEffect(() => {
    filterReqIdRef.current++;
  }, [filterArgs]);

  const setActorFromRow = (label: string): void => {
    setActorType("any");
    setActorLabel(label);
  };
  const applySavedView = (filters: Record<string, unknown>): void => {
    const value = decodeAuditSavedViewFilters(filters);
    if (!value) {
      toast.error(
        "This saved query uses an unsupported or invalid filter format.",
      );
      return;
    }
    // Saved queries replace the complete query. Leaving omitted fields in
    // place silently created hybrids that no longer matched the saved name.
    setActorType(isAuditActorType(value.actorType) ? value.actorType : "any");
    setActorLabel(typeof value.actorLabel === "string" ? value.actorLabel : "");
    setActionQuery(
      typeof value.actionQuery === "string" ? value.actionQuery : "",
    );
    setResourceType(
      typeof value.resourceType === "string" ? value.resourceType : "",
    );
    setResourceId(typeof value.resourceId === "string" ? value.resourceId : "");
    setDays(
      value.days === 0 ||
        value.days === 7 ||
        value.days === 30 ||
        value.days === 90
        ? value.days
        : 30,
    );
    setCategory(
      value.category === "destructive" ||
        value.category === "auth" ||
        value.category === "export" ||
        value.category === "one_click" ||
        value.category === "meta_audit"
        ? value.category
        : "all",
    );
  };

  return {
    actorType,
    setActorType,
    actorLabel,
    setActorLabel,
    actionQuery,
    setActionQuery,
    resourceType,
    setResourceType,
    resourceId,
    setResourceId,
    days,
    setDays,
    category,
    setCategory,
    viewMode,
    setViewMode,
    includeManifest,
    setIncludeManifest,
    filterArgs,
    filterReqIdRef,
    setActorFromRow,
    applySavedView,
  };
}

export type AuditFilterState = ReturnType<typeof useAuditFilterState>;
