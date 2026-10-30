// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bell,
  CreditCard,
  Gavel,
  Info,
  Mail,
  RefreshCw,
  ShieldAlert,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  OperationsFailure,
  OperationsHeader,
  OperationsLoading,
  OperationsSection,
  OperationsShell,
} from "@/components/operations/operations-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  notificationFeedApi,
  type NotificationFeedItem,
} from "@/lib/notification-feed-api";
import { notificationFeedDestination } from "@/lib/notification-destination";
import { base, qk, STALE } from "@/lib/query-keys";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import { asRoute } from "@/lib/typed-routes";

const KIND_ICONS: Record<string, typeof Bell> = {
  campaign: Mail,
  send: Mail,
  delivery: Mail,
  billing: CreditCard,
  invoice: CreditCard,
  approval: Gavel,
  approvals: Gavel,
  security: ShieldAlert,
  warning: AlertTriangle,
  alert: AlertTriangle,
  subscriber: Users,
  team: Users,
  system: Info,
};
const PAGE_SIZE = 30;
type Filter = "all" | "unread";

export default function NotificationsPage() {
  const queryClient = useQueryClient();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [filter, setFilter] = useState<Filter>("all");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "";
  const effectiveRole = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const historyKey = base(
    "notifications-history",
    tenantId || "anonymous",
    effectiveRole,
  );
  const feed = useQuery({
    queryKey: [...historyKey, limit] as const,
    queryFn: () => notificationFeedApi.list(limit),
    enabled: meQuery.isSuccess && tenantId.length > 0,
    staleTime: STALE.list,
    placeholderData: keepPreviousData,
  });

  const items = useMemo(
    () => (Array.isArray(feed.data?.items) ? feed.data.items : []),
    [feed.data?.items],
  );
  const unreadCount = feed.data?.unread_count ?? 0;
  const visible = useMemo(
    () => (filter === "unread" ? items.filter((item) => !item.read_at) : items),
    [filter, items],
  );
  const canLoadMore = items.length >= limit;

  const invalidateAll = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: historyKey }),
      queryClient.invalidateQueries({
        queryKey: qk.notificationFeed(tenantId, effectiveRole),
        exact: true,
      }),
    ]);
  };

  const markRead = async (id?: string): Promise<void> => {
    const key = id ?? "all";
    setActionError(null);
    setActionKey(key);
    try {
      if (id) await notificationFeedApi.markRead(id);
      else await notificationFeedApi.markReadAll();
      await invalidateAll();
    } catch {
      const message = id
        ? "That notification could not be marked as read. You can retry without losing your place."
        : "Notifications could not be marked as read. Nothing was changed.";
      setActionError(message);
      // A row with a destination marks itself read from a <Link> onClick, so
      // this page is usually unmounting while the POST is open — the alert
      // above would render into nothing and the failure would be invisible.
      // The toast outlives the route change.
      toast.error(message);
    } finally {
      setActionKey(null);
    }
  };

  if (meQuery.isPending) {
    return (
      <OperationsShell className="max-w-4xl">
        <OperationsHeader
          icon={Bell}
          eyebrow="Inbox"
          title="Notifications"
          description="Review workspace activity and follow each notification to its source."
        />
        <OperationsLoading label="Loading notification access" rows={5} />
      </OperationsShell>
    );
  }

  if (meQuery.isError) {
    return (
      <OperationsShell className="max-w-4xl">
        <OperationsHeader
          icon={Bell}
          eyebrow="Inbox"
          title="Notifications"
          description="Review workspace activity and follow each notification to its source."
        />
        <OperationsFailure
          title="Notification access could not be verified"
          description="Your workspace was not queried. Check the connection and try again."
          onRetry={() => void meQuery.refetch()}
          retrying={meQuery.isFetching}
        />
      </OperationsShell>
    );
  }

  return (
    <OperationsShell className="max-w-4xl">
      <OperationsHeader
        icon={Bell}
        eyebrow="Inbox"
        title="Notifications"
        description={
          feed.data
            ? unreadCount > 0
              ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"} in this workspace.`
              : "No unread notifications in the loaded history."
            : "Review workspace activity and follow each notification to its source."
        }
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={() => void feed.refetch()}
            loading={feed.isFetching && !feed.isPlaceholderData}
            aria-label="Refresh notifications"
          >
            <RefreshCw aria-hidden />
            Refresh
          </Button>
        }
      />

      <OperationsSection
        id="notification-history"
        title="Notification history"
        description="Unread status is shared with the dashboard bell. Loading more keeps the current history visible."
        aside={
          unreadCount > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void markRead()}
              loading={actionKey === "all"}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      >
        {actionError ? (
          <Alert variant="destructive" className="mb-4" role="alert">
            <AlertTitle>Read status was not updated</AlertTitle>
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}

        <Tabs
          value={filter}
          onValueChange={(value) => setFilter(value as Filter)}
        >
          <TabsList
            aria-label="Filter notifications"
            className="mb-4 grid h-auto w-full grid-cols-2 border bg-transparent p-0.5 sm:w-fit"
          >
            {(["all", "unread"] as const).map((value) => (
              <TabsTrigger key={value} value={value} className="capitalize">
                {value}
                {value === "unread" && unreadCount > 0 ? (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value={filter} className="mt-0">
            {feed.isError && !feed.data ? (
              <OperationsFailure
                title="Notifications could not be loaded"
                description="No notification history was returned. Try again; your read state was not changed."
                onRetry={() => void feed.refetch()}
                retrying={feed.isFetching}
              />
            ) : (
              <>
                {feed.isError && feed.data ? (
                  <Alert variant="destructive" className="mb-4" role="alert">
                    <AlertTitle>More history could not be loaded</AlertTitle>
                    <AlertDescription>
                      The previously loaded notifications remain below. Retry
                      when the connection recovers.
                    </AlertDescription>
                  </Alert>
                ) : null}
                {feed.isPending ? (
                  <OperationsLoading
                    label="Loading notification history"
                    rows={6}
                  />
                ) : visible.length === 0 ? (
                  <div className="rounded-lg border border-dashed px-4 py-10 text-center">
                    <Bell
                      className="mx-auto size-7 text-muted-foreground"
                      aria-hidden
                    />
                    {/* `unread_count` is every unread row for this user, but
                        this tab filters only the page already loaded — so with
                        a read newest page the badge says 12 while the list is
                        empty. Never let that read as "you have none". */}
                    <p className="mt-3 text-sm font-medium">
                      {filter === "unread"
                        ? unreadCount > 0
                          ? "Unread notifications are older than the loaded history"
                          : "No unread notifications"
                        : "No notifications yet"}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {filter === "unread"
                        ? unreadCount > 0
                          ? `${unreadCount} unread notification${unreadCount === 1 ? " is" : "s are"} outside the ${items.length} loaded here.${canLoadMore ? ` Load more to reach ${unreadCount === 1 ? "it" : "them"}.` : ""}`
                          : "Everything in the loaded history has been read."
                        : "Workspace events will appear here when they occur."}
                    </p>
                  </div>
                ) : (
                  <ul className="space-y-2" aria-label="Notifications">
                    {visible.map((item) => (
                      <NotificationRow
                        key={item.id}
                        item={item}
                        busy={actionKey === item.id}
                        onMarkRead={() => void markRead(item.id)}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}

            {/* Also on the Unread tab: it filters the loaded page client-side,
                so paging back is the ONLY way to reach unread rows older than
                the newest `limit`. Gating this on "all" stranded them. */}
            {canLoadMore && feed.data ? (
              <div className="mt-4 flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setLimit((current) => current + PAGE_SIZE)}
                  loading={feed.isFetching && feed.isPlaceholderData}
                >
                  Load more
                </Button>
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </OperationsSection>
    </OperationsShell>
  );
}

function NotificationRow({
  item,
  busy,
  onMarkRead,
}: {
  item: NotificationFeedItem;
  busy: boolean;
  onMarkRead: () => void;
}) {
  const destination = notificationFeedDestination(item);
  const KindIcon = (item.kind && KIND_ICONS[item.kind]) || Bell;
  const relative = timeAgo(item.created_at);
  const unread = !item.read_at;
  const content = (
    <>
      <span
        className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        aria-hidden
      >
        <KindIcon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-medium">
          {item.title?.trim() || "Untitled notification"}
        </span>
        {item.body ? (
          <span className="mt-1 block break-words text-xs leading-5 text-muted-foreground">
            {item.body}
          </span>
        ) : null}
        {relative ? (
          <time
            className="mt-1 block text-xs text-muted-foreground"
            dateTime={item.created_at}
            title={absoluteTime(item.created_at)}
          >
            {relative}
          </time>
        ) : null}
      </span>
      {unread ? (
        <>
          <span
            aria-hidden
            className="mt-2 size-2 shrink-0 rounded-full bg-primary"
          />
          <span className="sr-only">Unread</span>
        </>
      ) : null}
    </>
  );
  const rowClass = `flex min-h-11 min-w-0 gap-3 rounded-lg border px-3 py-3 transition-colors hover:bg-accent ${
    unread ? "border-primary/20 bg-primary/[0.025]" : "opacity-75"
  }`;

  return (
    <li className="min-w-0">
      {destination ? (
        <Link
          href={asRoute(destination)}
          className={rowClass}
          onClick={unread ? onMarkRead : undefined}
        >
          {content}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <div className={`${rowClass} flex-1`}>{content}</div>
          {unread ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={onMarkRead}
              loading={busy}
            >
              Mark read
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
}
