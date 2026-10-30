// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { PageShell } from "@/components/dashboard/page-shell";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiErrorMessage } from "@/lib/api";
import { invalidateListCatalogue } from "@/lib/audience-invalidation";
import { effectiveAuthRole, whoami, whoamiFresh } from "@/lib/auth-api";
import { listKeys, qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

import { ListOverviewTab } from "./list-overview-tab";
import { parseListId } from "@/lib/list-id";
import { Pending } from "./tab-chrome";
import {
  assertWriteIdentity,
  MEMBERSHIP_ROLES,
  roleAllows,
  SETTINGS_ROLES,
} from "./write-identity";

// Only the overview tab is on screen when the workspace first paints. Every
// other panel is mounted by Radix when its tab is selected, so each ships in
// its own chunk and keeps the route under the dashboard bundle budget.
const ListMembersTab = dynamic(
  () => import("./list-members-tab").then((m) => m.ListMembersTab),
  { loading: () => <Pending label="Loading members" rows={4} /> },
);
const ListAnalyticsTab = dynamic(
  () => import("./list-analytics-tab").then((m) => m.ListAnalyticsTab),
  { loading: () => <Pending label="Loading analytics" /> },
);
const ListActivityTab = dynamic(
  () => import("./list-activity-tab").then((m) => m.ListActivityTab),
  { loading: () => <Pending label="Loading activity" rows={4} /> },
);
const ListWebhooksTab = dynamic(
  () => import("./list-webhooks-tab").then((m) => m.ListWebhooksTab),
  { loading: () => <Pending label="Loading webhooks" /> },
);
const ListMergeFieldsTab = dynamic(
  () => import("./list-merge-fields-tab").then((m) => m.ListMergeFieldsTab),
  { loading: () => <Pending label="Loading merge fields" /> },
);
const ListSuppressionTab = dynamic(
  () => import("./list-suppression-tab").then((m) => m.ListSuppressionTab),
  { loading: () => <Pending label="Loading suppression" /> },
);
const ListFormsAutomationsTab = dynamic(
  () =>
    import("./list-forms-automations-tab").then(
      (m) => m.ListFormsAutomationsTab,
    ),
  { loading: () => <Pending label="Loading forms" rows={2} /> },
);
const ListInboxRealityTab = dynamic(
  () => import("./list-inbox-reality-tab").then((m) => m.ListInboxRealityTab),
  { loading: () => <Pending label="Loading inbox reality" /> },
);
const ListSettingsTab = dynamic(
  () => import("./list-settings-tab").then((m) => m.ListSettingsTab),
  { loading: () => <Pending label="Loading settings" rows={4} /> },
);

/**
 * Tab ids double as the `?tab=` value. Radix mounts only the active panel, so
 * each tab issues its reads when opened, not on page load.
 */
const TABS = [
  "overview",
  "members",
  "analytics",
  "activity",
  "webhooks",
  "merge-fields",
  "suppression",
  "forms",
  "inbox-reality",
  "settings",
] as const;
type ListTab = (typeof TABS)[number];

function tabFrom(raw: string | null): ListTab {
  return (TABS as readonly string[]).includes(raw ?? "")
    ? (raw as ListTab)
    : "overview";
}

export function ListDetailWorkspace({ rawId }: { rawId: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = tabFrom(searchParams.get("tab"));
  const listId = parseListId(rawId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const me = useQuery({
    queryKey: qk.authMe(),
    queryFn: () => whoami(),
    staleTime: STALE.authMe,
  });
  const tenantId = me.data?.tenant_id ?? "anon";
  const roleKey = me.data ? effectiveAuthRole(me.data) : null;
  const canWrite = roleAllows(me.data, SETTINGS_ROLES);
  const canAdmin = roleAllows(me.data, MEMBERSHIP_ROLES);

  const list = useQuery({
    queryKey: listKeys.detail(tenantId, roleKey, listId ?? 0),
    // The lists API module is only needed once a read or write runs, so it
    // is loaded on demand rather than on the route's eager graph.
    queryFn: async ({ signal }) => {
      const { getAudienceList } = await import("@/lib/lists-api");
      return getAudienceList(listId ?? 0, signal);
    },
    enabled: me.isSuccess && listId !== null,
    staleTime: STALE.detail,
  });

  function selectTab(next: string): void {
    const query = new URLSearchParams(searchParams.toString());
    if (next === "overview") query.delete("tab");
    else query.set("tab", next);
    const suffix = query.toString();
    router.replace(asRoute(suffix ? `${pathname}?${suffix}` : pathname), {
      scroll: false,
    });
  }

  // The index, this record and every list picker share the `lists` family.
  function invalidateLists(): Promise<void> {
    return invalidateListCatalogue(qc, tenantId, roleKey);
  }

  /** Thrown errors render inside the confirm dialog, naming the refusal. */
  async function destroy(): Promise<void> {
    const record = list.data;
    if (!record || !me.data) return;
    assertWriteIdentity(
      me.data,
      await whoamiFresh(),
      SETTINGS_ROLES,
      "Editor access is required.",
    );
    const { getAudienceList } = await import("@/lib/lists-api");
    if (!(await getAudienceList(record.id)))
      throw new Error("This list no longer exists.");
    // The admin write API is otherwise only needed by the deferred tabs.
    const { deleteAudienceList, newWriteKey } =
      await import("@/lib/audience-admin-api");
    await deleteAudienceList(record.id, newWriteKey("list-delete"));
    await invalidateLists();
    toast.success(`List "${record.name}" deleted`);
    router.push("/app/lists");
  }

  const record = list.data ?? null;

  return (
    <PageShell>
      <Breadcrumb
        items={[
          { label: "Lists", href: "/app/lists" },
          { label: record?.name ?? "List" },
        ]}
      />

      {listId === null ? (
        <Terminal
          title="Invalid list link"
          description="This link does not name a list. No request was made."
        />
      ) : me.isError ? (
        <Failure
          title="Workspace access could not be verified"
          message={apiErrorMessage(me.error, "The session could not be read")}
          busy={me.isFetching}
          onRetry={() => void me.refetch()}
        />
      ) : list.isPending ? (
        <div aria-label="Loading list" role="status" className="space-y-4">
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : list.isError ? (
        <Failure
          title="List could not be loaded"
          message={apiErrorMessage(list.error, "The lists service failed")}
          busy={list.isFetching}
          onRetry={() => void list.refetch()}
        />
      ) : !record ? (
        <Terminal
          title="List not found"
          description="No list with this id exists in the current workspace, or it was deleted."
        />
      ) : (
        <>
          <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h1 className="break-words font-display text-2xl font-semibold tracking-tight md:text-3xl">
                {record.name}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="secondary">{record.type}</Badge>
                <Badge variant="outline">{record.optin} opt-in</Badge>
                {record.tags.map((t) => (
                  <Badge key={t} variant="outline">
                    {t}
                  </Badge>
                ))}
              </div>
              {record.description ? (
                <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                  {record.description}
                </p>
              ) : null}
            </div>
            {canWrite ? (
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => selectTab("settings")}
                >
                  <Pencil aria-hidden className="size-4" /> Edit
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 aria-hidden className="size-4" /> Delete
                </Button>
              </div>
            ) : null}
          </header>

          <Tabs value={tab} onValueChange={selectTab}>
            <TabsList aria-label={`${record.name} list sections`}>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="members">Members</TabsTrigger>
              <TabsTrigger value="analytics">Analytics</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
              <TabsTrigger value="merge-fields">Merge fields</TabsTrigger>
              <TabsTrigger value="suppression">Suppression</TabsTrigger>
              <TabsTrigger value="forms">Forms &amp; automations</TabsTrigger>
              <TabsTrigger value="inbox-reality">Inbox reality</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <ListOverviewTab
                list={record}
                tenantId={tenantId}
                roleKey={roleKey}
                onOpenMembers={() => selectTab("members")}
              />
            </TabsContent>
            <TabsContent value="members">
              <ListMembersTab
                list={record}
                me={me.data}
                tenantId={tenantId}
                roleKey={roleKey}
                canAdmin={canAdmin}
              />
            </TabsContent>
            <TabsContent value="analytics">
              <ListAnalyticsTab
                list={record}
                tenantId={tenantId}
                roleKey={roleKey}
              />
            </TabsContent>
            <TabsContent value="activity">
              <ListActivityTab
                list={record}
                tenantId={tenantId}
                roleKey={roleKey}
              />
            </TabsContent>
            <TabsContent value="webhooks">
              <ListWebhooksTab
                list={record}
                me={me.data}
                tenantId={tenantId}
                roleKey={roleKey}
                canAdmin={canAdmin}
              />
            </TabsContent>
            <TabsContent value="merge-fields">
              <ListMergeFieldsTab
                list={record}
                me={me.data}
                tenantId={tenantId}
                roleKey={roleKey}
                canWrite={canWrite}
              />
            </TabsContent>
            <TabsContent value="suppression">
              <ListSuppressionTab
                list={record}
                tenantId={tenantId}
                roleKey={roleKey}
              />
            </TabsContent>
            <TabsContent value="forms">
              <ListFormsAutomationsTab
                list={record}
                tenantId={tenantId}
                roleKey={roleKey}
              />
            </TabsContent>
            <TabsContent value="inbox-reality">
              <ListInboxRealityTab
                list={record}
                tenantId={tenantId}
                roleKey={roleKey}
              />
            </TabsContent>
            <TabsContent value="settings">
              <ListSettingsTab
                list={record}
                me={me.data}
                canWrite={canWrite}
                onSaved={invalidateLists}
              />
            </TabsContent>
          </Tabs>

          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title="Delete list?"
            description={`This permanently deletes "${record.name}" and every membership in it. Subscriber records are kept. Type its exact name to continue.`}
            confirmationToken={record.name}
            confirmLabel="Delete list"
            onConfirm={destroy}
          />
        </>
      )}
    </PageShell>
  );
}

function Terminal({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Card>
      <CardContent className="py-8">
        <EmptyState
          icon={ListChecks}
          title={title}
          description={description}
          action={
            <Button asChild variant="outline">
              <Link href="/app/lists">Back to lists</Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}

function Failure({
  title,
  message,
  busy,
  onRetry,
}: {
  title: string;
  message: string;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"
    >
      <p className="font-medium text-destructive">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <Button
        type="button"
        variant="outline"
        className="mt-3 gap-2"
        loading={busy}
        onClick={onRetry}
      >
        <RefreshCw aria-hidden className="size-4" /> Retry
      </Button>
    </div>
  );
}
