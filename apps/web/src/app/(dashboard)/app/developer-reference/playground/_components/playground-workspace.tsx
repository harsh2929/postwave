// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * The playground workspace: summary strip plus the Runner / Reference /
 * History tabs. Split out of page.tsx so the runner, the request transport,
 * and the contract catalog load only once identity and the contract have
 * resolved — the page shell and its gates stay in the route's entry graph.
 */
import { useCallback, useMemo, useRef, useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  playgroundPolicyFor,
  type PlaygroundCatalog,
} from "@/lib/api-playground-catalog";
import {
  appendPlaygroundHistory,
  clearPlaygroundHistory,
  readPlaygroundFavorites,
  readPlaygroundHistory,
  writePlaygroundFavorites,
  PLAYGROUND_FAVORITES_MAX,
  type PlaygroundHistoryEntry,
} from "@/lib/api-playground-storage";
import type { AuthRole } from "@/lib/auth-api";

import { PlaygroundHistory } from "./playground-history";
import { PlaygroundReference } from "./playground-reference";
import { PlaygroundRunner } from "./playground-runner";
import { usePlaygroundController } from "./use-playground-controller";

type PlaygroundTab = "runner" | "reference" | "history";

export function PlaygroundWorkspace({
  catalog,
  role,
  scope,
  workspaceLabel,
}: {
  catalog: PlaygroundCatalog;
  role: AuthRole | null;
  scope: string | null;
  workspaceLabel: string;
}) {
  const operations = catalog.operations;
  const [tab, setTab] = useState<PlaygroundTab>("runner");
  const operationKeys = useMemo(
    () => new Set(operations.map((operation) => operation.key)),
    [operations],
  );
  const [favorites, setFavorites] = useState<Set<string>>(() =>
    readPlaygroundFavorites(scope, operationKeys),
  );
  const [history, setHistory] = useState<PlaygroundHistoryEntry[]>(() =>
    readPlaygroundHistory(scope),
  );
  // The write happens here, not inside a state updater, so a double-invoked
  // updater can never store an attempt twice.
  const historyRef = useRef(history);
  const recordAttempt = useCallback(
    (entry: Omit<PlaygroundHistoryEntry, "id" | "at">) => {
      const next = appendPlaygroundHistory(scope, entry, historyRef.current);
      historyRef.current = next;
      setHistory(next);
    },
    [scope],
  );
  const controller = usePlaygroundController({
    operations,
    role,
    onAttempt: recordAttempt,
  });
  const [referenceKey, setReferenceKey] = useState(controller.selected.key);
  const summary = useMemo(() => {
    let runnable = 0;
    let held = 0;
    for (const operation of operations) {
      if (playgroundPolicyFor(operation).executable) runnable += 1;
      if (operation.releaseHold) held += 1;
    }
    return { runnable, held };
  }, [operations]);

  const toggleFavorite = (key: string) => {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else if (next.size < PLAYGROUND_FAVORITES_MAX) next.add(key);
      writePlaygroundFavorites(scope, next);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 rounded-xl border bg-muted/10 p-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Operations</dt>
          <dd className="font-semibold tabular-nums">{operations.length}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Run on web</dt>
          <dd className="font-semibold tabular-nums">{summary.runnable}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Release-held</dt>
          <dd className="font-semibold tabular-nums">{summary.held}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Contract</dt>
          <dd className="truncate font-semibold">
            {catalog.title} <code className="text-xs">v{catalog.version}</code>
          </dd>
        </div>
      </dl>
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as PlaygroundTab)}
      >
        <TabsList aria-label="Playground sections">
          <TabsTrigger value="runner">Runner</TabsTrigger>
          <TabsTrigger value="reference" disabled={controller.sending}>
            Reference
          </TabsTrigger>
          <TabsTrigger value="history" disabled={controller.sending}>
            History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="runner">
          <PlaygroundRunner
            operations={operations}
            controller={controller}
            favorites={favorites}
            onToggleFavorite={toggleFavorite}
            workspaceLabel={workspaceLabel}
          />
        </TabsContent>
        <TabsContent value="reference">
          <PlaygroundReference
            operations={operations}
            selectedKey={referenceKey}
            onSelect={setReferenceKey}
            onOpenInRunner={(key) => {
              if (controller.select(key)) setTab("runner");
            }}
          />
        </TabsContent>
        <TabsContent value="history">
          <PlaygroundHistory
            entries={history}
            onOpen={(entry) => {
              if (controller.replay(entry)) setTab("runner");
            }}
            onClear={() => {
              clearPlaygroundHistory(scope);
              historyRef.current = [];
              setHistory([]);
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
