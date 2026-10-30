// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery } from "@tanstack/react-query";
import { Fingerprint, ShieldAlert } from "lucide-react";
import dynamic from "next/dynamic";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  GovernanceError,
  GovernanceLoading,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";

// The admin workspace is ~1,500 lines and only renders for owners/admins
// after the identity read settles; loading it on demand keeps the route
// under the dashboard bundle budget.
const PrivacyPortalAdmin = dynamic(
  () =>
    import("./privacy-portal-admin").then(
      (module) => module.PrivacyPortalAdmin,
    ),
  {
    loading: () => (
      <PageShell>
        <Header />
        <GovernanceLoading label="Loading privacy controls…" rows={4} />
      </PageShell>
    ),
  },
);

function Header({
  refreshing = false,
  onRefresh,
}: {
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <GovernancePageHeader
      icon={Fingerprint}
      title="Privacy portal"
      description="Consent evidence, statutory requests, regional policy, pending confirmation operations, and the subscriber-facing preference center."
      refreshLabel="Refresh privacy data"
      refreshing={refreshing}
      onRefresh={onRefresh}
    />
  );
}

export default function PrivacyPortalPage() {
  const me = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });

  if (me.isPending) {
    return (
      <PageShell className="max-w-7xl">
        <Header />
        <GovernanceSection icon={ShieldAlert} title="Access verification">
          <GovernanceLoading
            label="Verifying privacy-portal administrator access…"
            rows={4}
          />
        </GovernanceSection>
      </PageShell>
    );
  }

  if (me.isError || !me.data) {
    return (
      <PageShell className="max-w-7xl">
        <Header
          refreshing={me.isFetching}
          onRefresh={() => void me.refetch()}
        />
        <GovernanceSection icon={ShieldAlert} title="Access verification">
          <GovernanceError
            message="Could not verify your workspace role. No privacy-portal data was requested."
            retrying={me.isFetching}
            onRetry={() => void me.refetch()}
          />
        </GovernanceSection>
      </PageShell>
    );
  }

  const role = effectiveAuthRole(me.data);
  const canAdmin =
    me.data.viewer_mode !== true && (role === "owner" || role === "admin");
  if (!canAdmin) {
    return (
      <PageShell className="max-w-7xl">
        <Header onRefresh={() => void me.refetch()} />
        <Alert variant="warning">
          <ShieldAlert aria-hidden />
          <AlertTitle>Owner or administrator access required</AlertTitle>
          <AlertDescription>
            Privacy evidence and policy controls were not requested for your
            effective {role} role{me.data.viewer_mode ? " in viewer mode" : ""}.
          </AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  return <PrivacyPortalAdmin me={me.data} role={role} />;
}
