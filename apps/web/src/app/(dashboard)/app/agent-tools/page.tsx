// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Agent tools — what an agent can reach, and whether anything limits it.
 *
 * The `/api/v1/mcp/*` surface desktop reached and web did not: the governed
 * tool catalogue, the quota configuration, and (below) the recorded execution
 * history. Client setup stays visibly release-held until distribution and
 * runtime qualification are complete.
 *
 * THE QUOTAS DO NOT BIND, AND THAT IS THE HEADLINE. The server reports
 * `authoritative: false`, `enforcementMode: "advisory_unverified"` and a
 * `releaseHold`. A governance page that lists limits without those fields is
 * worse than no page: it tells an operator agent access is bounded when
 * nothing is actually stopping it, and that is a claim they may act on.
 *
 * So enforcement status leads, before the catalogue.
 *
 * THE LIVE-EXECUTIONS SECTION AND THE HISTORY TAIL ARE SEPARATE ON PURPOSE.
 * This one answers "is the stream reachable, and has anything run since I
 * opened the page" and stays connected whether or not anyone is reading rows.
 * The history panel's opt-in tail is what prepends rows into the table. An
 * admin who turns that on holds two subscriptions; the server caps each at two
 * minutes and the browser reconnects, so the cost is bounded and only paid on
 * request.
 */

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  Copy,
  History,
  Search,
  ShieldAlert,
  Wrench,
} from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import { ContentQueryError } from "../_content-automation/content-query-error";
import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceMetrics,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { copyToClipboard } from "@/lib/clipboard";
import type { StreamStatus } from "@/lib/live-streams-api";
import { whoami } from "@/lib/auth-api";
import { getMcpQuotas, listMcpTools, toolsByCategory } from "@/lib/mcp-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { McpSetupPanel } from "./_components/mcp-setup-panel";

// The history panel sits below the live section and carries the telemetry
// table, its detail dialog, and the stream client, so it loads after the
// enforcement status and the catalogue render.
const McpExecutionHistory = dynamic(
  () =>
    import("./_components/mcp-execution-history").then(
      (module) => module.McpExecutionHistory,
    ),
  {
    loading: () => (
      <GovernanceSection
        icon={History}
        title="Execution history"
        description="Recorded API-key telemetry for agent calls."
      >
        <GovernanceLoading label="Loading execution history…" rows={4} />
      </GovernanceSection>
    ),
  },
);

function categoryLabel(category: string): string {
  return category.replace(/-/gu, " ");
}

export default function AgentToolsPage() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const canLoad = Boolean(
    meQuery.isSuccess && meQuery.data?.tenant_id && meQuery.data?.user_id,
  );
  const keyBase = useMemo(
    () =>
      base(
        "mcp",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const tools = useQuery({
    queryKey: [...keyBase, "catalog"],
    queryFn: listMcpTools,
    enabled: canLoad,
    staleTime: STALE.reference,
  });
  const quotas = useQuery({
    queryKey: [...keyBase, "quotas"],
    queryFn: getMcpQuotas,
    enabled: canLoad,
    staleTime: STALE.reference,
  });

  const toolRows = useMemo(
    () => (Array.isArray(tools.data) ? tools.data : []),
    [tools.data],
  );
  const categories = useMemo(() => toolsByCategory(toolRows), [toolRows]);
  const q = quotas.data;

  const [execStatus, setExecStatus] = useState<StreamStatus>("connecting");
  const [execCount, setExecCount] = useState(0);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("");
  const [copiedTool, setCopiedTool] = useState("");
  const [copyProblem, setCopyProblem] = useState("");

  const filtering = Boolean(search.trim() || activeCategory);
  const filteredTools = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle && !activeCategory) return [];
    return toolRows.filter(
      (tool) =>
        (!activeCategory || tool.category === activeCategory) &&
        (!needle ||
          `${tool.name} ${tool.category} ${tool.description ?? ""}`
            .toLocaleLowerCase()
            .includes(needle)),
    );
  }, [activeCategory, search, toolRows]);

  const copyToolName = async (name: string) => {
    const result = await copyToClipboard(name);
    setCopiedTool(result === "copied" ? name : "");
    setCopyProblem(
      result === "copied"
        ? ""
        : result === "unavailable"
          ? "This browser did not expose a clipboard, so nothing was copied. Select the identifier instead."
          : "The clipboard rejected the write, so nothing was copied. Focus this tab and retry.",
    );
  };

  useEffect(() => {
    if (!canLoad) return;
    // The stream client shares its module with the dashboard analytics client,
    // so it is fetched here, once identity is known, rather than eagerly.
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    void import("@/lib/live-streams-api").then(({ subscribeMcpExecutions }) => {
      if (cancelled) return;
      unsubscribe = subscribeMcpExecutions({
        onStatus: setExecStatus,
        onEvent: () => setExecCount((n) => n + 1),
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [canLoad, meQuery.data?.tenant_id, meQuery.data?.user_id]);

  const refreshing =
    meQuery.isFetching || tools.isFetching || quotas.isFetching;

  if (!canLoad) {
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Agent tools
        </h1>
        {meQuery.isPending ? (
          <p role="status">Loading workspace identity…</p>
        ) : (
          <ContentQueryError
            message="Workspace identity could not be loaded. No private data was requested."
            onRetry={() => meQuery.refetch()}
            retrying={meQuery.isFetching}
          />
        )}
      </PageShell>
    );
  }

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <GovernancePageHeader
        icon={Bot}
        eyebrow="Agent governance"
        title="Agent tools"
        description="What an agent connected to this workspace can reach, whether its limits actually bind, and what executes while this page is open."
        refreshLabel="Refresh tool access"
        refreshing={refreshing}
        onRefresh={() => {
          void tools.refetch();
          void quotas.refetch();
        }}
      />

      <GovernanceSection
        icon={ShieldAlert}
        title="Enforcement"
        description="Configured limits are not represented as safeguards unless the server says they are authoritative."
      >
        {quotas.isPending ? (
          <GovernanceLoading
            label="Loading agent quota enforcement…"
            rows={3}
          />
        ) : quotas.isError ? (
          <GovernanceError
            message="Could not read quota configuration. Nothing here should be read as limits being in force."
            retrying={quotas.isFetching}
            onRetry={() => void quotas.refetch()}
          />
        ) : q ? (
          <>
            {/* authoritative:false is the field to believe. */}
            <div
              className={
                q.authoritative
                  ? "rounded-xl border border-success/20 bg-success-subtle p-4"
                  : "rounded-xl border border-destructive/20 bg-destructive/5 p-4"
              }
            >
              <Badge variant={q.authoritative ? "success" : "destructive"}>
                {q.authoritative ? "Enforced" : "Not enforced"}
              </Badge>
              <p className="mt-2 text-sm leading-6">
                {q.authoritative
                  ? "Quota rules are reported as authoritative."
                  : "Quota rules are advisory and do not provide a boundary an agent is guaranteed to hit."}
              </p>
            </div>
            <div className="mt-4">
              <GovernanceMetrics
                columns={2}
                items={[
                  {
                    label: "Quota rules",
                    value: q.quotas.length.toLocaleString(),
                    detail:
                      q.quotas.length === 0
                        ? "No quota intent configured"
                        : "Configured rule definitions",
                  },
                  {
                    label: "Enforcement mode",
                    value:
                      q.enforcementMode.replace(/_/gu, " ") || "Not reported",
                    detail: q.authoritative
                      ? "Reported as authoritative"
                      : "Advisory only",
                  },
                ]}
              />
            </div>
            {q.releaseHold ? (
              <p className="mt-3 break-all text-xs leading-5 text-muted-foreground">
                Release hold: <code>{q.releaseHold}</code>
              </p>
            ) : null}
          </>
        ) : (
          <GovernanceEmpty>No quota configuration reported.</GovernanceEmpty>
        )}
      </GovernanceSection>

      <GovernanceSection
        icon={Wrench}
        title="Tool catalogue"
        description="Browse category coverage, then search names and descriptions for the exact capability an agent can reach."
      >
        {tools.isPending ? (
          <GovernanceLoading label="Loading agent tool catalogue…" rows={5} />
        ) : tools.isError ? (
          <GovernanceError
            message="Could not load the tool catalogue. It has not been shown as empty—no tools is the most reassuring reading and the least safe one to guess."
            retrying={tools.isFetching}
            onRetry={() => void tools.refetch()}
          />
        ) : toolRows.length === 0 ? (
          <GovernanceEmpty>No agent tools reported.</GovernanceEmpty>
        ) : (
          <>
            <p className="text-sm leading-5 text-muted-foreground">
              {toolRows.length.toLocaleString()} tools across{" "}
              {categories.length.toLocaleString()} categories.
            </p>
            <div className="relative mt-4">
              <Label htmlFor="mcp-tool-search" className="sr-only">
                Search agent tools
              </Label>
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="mcp-tool-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search tools, categories, or descriptions"
                className="pl-9"
              />
            </div>
            {/* Category counts were a read-only legend; each is now the
                filter it always looked like. */}
            <div
              role="group"
              aria-label="Filter tools by category"
              className="mt-4 flex flex-wrap gap-2"
            >
              <Button
                type="button"
                size="sm"
                variant={activeCategory ? "outline" : "default"}
                aria-pressed={!activeCategory}
                onClick={() => setActiveCategory("")}
              >
                All
                <Badge variant="secondary">
                  {toolRows.length.toLocaleString()}
                </Badge>
              </Button>
              {categories.map(([category, count]) => (
                <Button
                  key={category}
                  type="button"
                  size="sm"
                  className="capitalize"
                  variant={activeCategory === category ? "default" : "outline"}
                  aria-pressed={activeCategory === category}
                  onClick={() =>
                    setActiveCategory(
                      activeCategory === category ? "" : category,
                    )
                  }
                >
                  {categoryLabel(category)}
                  <Badge variant="secondary">{count.toLocaleString()}</Badge>
                </Button>
              ))}
              {filtering ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setActiveCategory("");
                    setSearch("");
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </div>
            {filtering ? (
              <div className="mt-4">
                <p role="status" className="text-xs text-muted-foreground">
                  {filteredTools.length.toLocaleString()} matching{" "}
                  {filteredTools.length === 1 ? "tool" : "tools"}
                  {activeCategory ? ` in ${categoryLabel(activeCategory)}` : ""}
                  .
                </p>
                {filteredTools.length === 0 ? (
                  <GovernanceEmpty>
                    {search.trim() ? (
                      <>
                        No tools match “{search.trim()}”
                        {activeCategory
                          ? ` in ${categoryLabel(activeCategory)}`
                          : ""}
                        . Try a capability or category name.
                      </>
                    ) : (
                      <>
                        No tool is listed under {categoryLabel(activeCategory)}.
                      </>
                    )}
                  </GovernanceEmpty>
                ) : (
                  <ul className="mt-2 divide-y rounded-xl border">
                    {filteredTools.slice(0, 100).map((tool, index) => (
                      <li
                        key={`${tool.name}:${index}`}
                        className="min-w-0 p-3.5"
                      >
                        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                          <p className="min-w-0 break-all font-mono text-xs font-medium">
                            {tool.name || "Unnamed tool"}
                          </p>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge
                              className="w-fit capitalize"
                              variant="outline"
                            >
                              {categoryLabel(tool.category)}
                            </Badge>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              aria-label={`Copy tool identifier ${tool.name}`}
                              onClick={() => void copyToolName(tool.name)}
                            >
                              <Copy aria-hidden="true" />
                              {copiedTool === tool.name ? "Copied" : "Copy"}
                            </Button>
                          </div>
                        </div>
                        {tool.description ? (
                          <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">
                            {tool.description}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                <p
                  role="status"
                  className="mt-2 text-xs leading-5 text-muted-foreground"
                >
                  {copyProblem ||
                    (copiedTool
                      ? `Copied the identifier ${copiedTool}.`
                      : "Copy an identifier to paste it into an allowlist or a tool filter.")}
                </p>
                {filteredTools.length > 100 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Showing the first 100 matches. Narrow the search to inspect
                    the remaining tools.
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </GovernanceSection>

      <GovernanceSection
        icon={Activity}
        title="Live executions"
        description="Connection state and event arrival are reported separately."
      >
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col gap-3 rounded-xl border bg-muted/20 p-3.5 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm leading-6 text-muted-foreground">
            {execStatus === "open"
              ? execCount === 0
                ? "Connected. No agent tool has run since this page opened—the stream is idle, not broken."
                : `Connected. ${execCount.toLocaleString()} execution${execCount === 1 ? "" : "s"} since this page opened.`
              : execStatus === "connecting"
                ? "Connecting or reconnecting to the execution stream…"
                : "The execution stream is closed."}
          </p>
          <Badge
            className="w-fit shrink-0 capitalize"
            variant={
              execStatus === "open"
                ? "success"
                : execStatus === "connecting"
                  ? "warning"
                  : "outline"
            }
          >
            {execStatus}
          </Badge>
        </div>
      </GovernanceSection>

      <McpExecutionHistory
        identity={meQuery.data}
        onRefreshQuotas={() => void quotas.refetch()}
      />

      <McpSetupPanel />
    </PageShell>
  );
}
