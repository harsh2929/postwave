/**
 * WorkspaceSetupSection — the two desktop Settings sections mobile was missing
 * (SHELL#24): the Slack workspace connection and the sample-data seeder.
 *
 * They ship as one composer rather than two mounts in `app/(tabs)/settings.tsx`
 * for a reason that is not cosmetic: that file sits one line under its source
 * budget, and each of these is a section header plus a card. Grouping them
 * under one heading is also the truer information architecture — both answer
 * "is this workspace set up", which is what a person opening Settings on a
 * phone during an evaluation is actually asking.
 *
 * ROLE GATING IS DONE HERE, not by the screen, because the two halves have
 * DIFFERENT floors, both read off the Go handlers:
 *
 *   Slack workspace  GET and DELETE /api/v1/integrations/slack-workspace are
 *                    both wrapped in apikeys.RequireScope(apikeys.ScopeAdmin)
 *                    (collaboration_integrations.go:42-43), which on the
 *                    session path is owner|admin. The whole card is therefore
 *                    admin-only — showing it to a viewer could only ever render
 *                    a 403.
 *   Sample data      GET is mounted with NO scope wrapper (main.go:4398), so
 *                    any tenant principal may read the marker; POST and DELETE
 *                    are ScopeAdmin (main.go:4399-4402). The card renders for
 *                    everyone and passes `canManage` down so the verbs appear
 *                    only for an admin.
 *
 * An api_key session is treated as viewer by canAccessMinimumRole, which is the
 * fail-closed answer: a key's scopes are not knowable from the client.
 */
import { SampleDataCard } from "@/components/settings/SampleDataCard";
import { SectionHeader } from "@/components/settings/SettingsScreenPrimitives";
import { SlackWorkspaceCard } from "@/components/settings/SlackWorkspaceCard";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";

export function WorkspaceSetupSection() {
  const effectiveRole = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const mode = useAuthStore((s) => s.mode);
  const canManage = canAccessMinimumRole("admin", effectiveRole, mode);

  return (
    <>
      {canManage ? (
        <>
          <SectionHeader
            anchor="slack-workspace"
            title="Slack workspace"
            subtitle="Where the approval bot posts, and how to revoke it."
          />
          <SlackWorkspaceCard />
        </>
      ) : null}

      <SectionHeader
        anchor="sample-data"
        title="Sample data"
        subtitle="A demo set of subscribers, campaigns and sequences for an empty workspace."
      />
      <SampleDataCard canManage={canManage} />
    </>
  );
}
