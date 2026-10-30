// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { MessageSquareText } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";
import { canAccessSmsAdminSurface } from "./sms-page-access";
import {
  EngagementLoading,
  EngagementPageHeader,
  EngagementQueryError,
} from "../_engagement/engagement-ui";

const SmsAdminPage = dynamic(
  () => import("./sms-workspace").then((module) => module.SmsAdminPage),
  {
    ssr: false,
    loading: () => (
      <PageShell className="max-w-6xl">
        <EngagementPageHeader
          eyebrow="Messaging channel"
          title="SMS"
          description="Consent-first SMS operations, campaign preparation, registration, inbox evidence, and release-held outbound controls."
          icon={<MessageSquareText aria-hidden />}
        />
        <EngagementLoading label="Loading protected SMS workspace" rows={4} />
      </PageShell>
    ),
  },
);

export default function SmsPage() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const me = meQuery.data ?? null;
  const role = me ? effectiveAuthRole(me) : null;
  const canAccess = canAccessSmsAdminSurface(me, role);

  useEffect(() => {
    if (canAccess) return;
    const predicate = (query: { queryKey: readonly unknown[] }) =>
      query.queryKey[0] === "sms";
    void queryClient.cancelQueries({ predicate });
    queryClient.removeQueries({ predicate });
  }, [canAccess, queryClient]);

  if (meQuery.isPending) {
    return (
      <PageShell className="max-w-6xl">
        <EngagementPageHeader
          eyebrow="Messaging channel"
          title="SMS"
          description="Consent-first SMS operations, campaign preparation, registration, inbox evidence, and release-held outbound controls."
          icon={<MessageSquareText aria-hidden />}
        />
        <EngagementLoading label="Checking SMS workspace access" rows={4} />
      </PageShell>
    );
  }

  if (meQuery.isError || !me) {
    return (
      <PageShell className="max-w-6xl">
        <EngagementPageHeader
          eyebrow="Messaging channel"
          title="SMS"
          description="Consent-first SMS operations, campaign preparation, registration, inbox evidence, and release-held outbound controls."
          icon={<MessageSquareText aria-hidden />}
        />
        <EngagementQueryError
          title="SMS workspace access could not be verified"
          description="No SMS data was requested. Retry after your session or the API connection is restored."
          retrying={meQuery.isFetching}
          onRetry={() => void meQuery.refetch()}
        />
      </PageShell>
    );
  }

  if (!canAccess) {
    return (
      <PageShell className="max-w-6xl">
        <EngagementPageHeader
          eyebrow="Messaging channel"
          title="SMS"
          description="Consent-first SMS operations, campaign preparation, registration, inbox evidence, and release-held outbound controls."
          icon={<MessageSquareText aria-hidden />}
        />
        <Alert>
          <AlertTitle>Owner or admin access required</AlertTitle>
          <AlertDescription>
            SMS data is not requested or displayed in viewer access mode. Exit
            view-as mode or ask an owner for the required role.
          </AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  const identityKey = `${me.user_id}:${me.tenant_id}:${role}`;
  return <SmsAdminPage key={identityKey} me={me} />;
}
