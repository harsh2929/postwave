/**
 * SampleDataCard — load or clear the demo workspace, from a phone.
 *
 * SHELL#24. Desktop renders `<SampleDataSection />` in Settings; mobile had no
 * way to populate an empty workspace at all, which is the first thing a
 * prospect evaluating on a phone wants and the last thing they can do.
 *
 * ROUTES AND GUARDS, read off main.go:4398-4402:
 *   GET    /api/v1/onboarding/sample-data   no scope wrapper — any tenant
 *                                           principal may read the marker.
 *   POST   /api/v1/onboarding/sample-data   RequireScope(ScopeAdmin)
 *   DELETE /api/v1/onboarding/sample-data   RequireScope(ScopeAdmin)
 * On the session path ScopeAdmin resolves to owner|admin
 * (apikeys/middleware.go:211), so the STATUS is shown to everyone who can see
 * Settings and the two verbs appear only for an admin. A viewer sees the truth
 * about their workspace and no button that would 403.
 *
 * WHY THE COUNTS CAN BE UNKNOWN. The marker lives in tenants.metadata and
 * predates the counts field, so `seeded: true` with no `counts` is a real
 * response. That is an em-dash — reporting it as 0 would claim the seeder
 * produced nothing, which is a different and false statement. The arithmetic
 * is in lib/workspaceSetup and is unit-tested there.
 *
 * WRITES ARE NEVER QUEUED OFFLINE. Seeding inserts demo subscribers and
 * campaigns; replaying that hours later against a workspace the operator has
 * since filled with real data is not a convenience.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";

import {
  getSampleDataStatus,
  removeSampleData,
  seedSampleData,
} from "@/api/workspaceSetup";
import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import { Card, Row } from "@/components/settings/SettingsScreenPrimitives";
import { SetupActionButton } from "@/components/settings/SetupActionButton";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { num, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  NO_VALUE,
  sampleDataAction,
  sampleDataSummary,
} from "@/lib/workspaceSetup";

export function SampleDataCard({ canManage }: { canManage: boolean }) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [working, setWorking] = useState(false);

  const status = useQuery({
    queryKey: ["sample-data-status", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async () => {
      const res = await getSampleDataStatus();
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return sampleDataSummary(res.data);
    },
    staleTime: 60_000,
  });

  const summary = status.data;
  const action = summary ? sampleDataAction(summary) : "seed";

  async function onAct(): Promise<void> {
    const removing = action === "remove";
    const ok = await confirm({
      title: removing ? "Remove sample data?" : "Load sample data?",
      message: removing
        ? "Deletes only the rows Moosewave seeded — they carry a sample marker, so your real subscribers and campaigns are untouched."
        : "Adds a small demo set of subscribers, lists, segments, campaigns and sequences to this workspace so the app has something to show.",
      confirmLabel: removing ? "Remove" : "Load",
      ...(removing ? { destructive: true } : {}),
    });
    if (!ok) return;
    setWorking(true);
    const res = removing ? await removeSampleData() : await seedSampleData();
    setWorking(false);
    if (res.error) {
      haptics.error();
      // A partial seed answers 500 WITH partial_counts, so the honest advice
      // after a failure is to remove rather than to retry blindly.
      toast({ message: res.error.message, kind: "error" });
      await queryClient.invalidateQueries({ queryKey: ["sample-data-status"] });
      return;
    }
    haptics.success();
    toast({
      message: res.data?.note
        ? res.data.note
        : removing
          ? "Sample data removed."
          : "Sample data loaded.",
      kind: "success",
    });
    await queryClient.invalidateQueries({ queryKey: ["sample-data-status"] });
  }

  return (
    <Card>
      <QueryStates
        query={status}
        gate={gate}
        isEmpty={!summary}
        skeleton={<SkeletonList rows={2} />}
        offlineMessage="You're offline, so this workspace's sample-data state hasn't been read yet."
      >
        {summary ? (
          <View>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
              <Pill
                label={summary.seeded ? "Sample data loaded" : "No sample data"}
                tone={summary.seeded ? "info" : "neutral"}
              />
            </View>

            {summary.seeded ? (
              <>
                <Row
                  label="Rows seeded"
                  // ABSENCE IS NOT ZERO: a marker written before the counts
                  // field existed knows it seeded, not how much.
                  value={summary.total === null ? NO_VALUE : num(summary.total)}
                />
                <Row
                  label="Loaded"
                  value={
                    summary.seededAt ? relativeTime(summary.seededAt) : NO_VALUE
                  }
                />
                {summary.breakdown.map((entry) => (
                  <Row
                    key={entry.label}
                    label={entry.label}
                    value={num(entry.count)}
                  />
                ))}
              </>
            ) : null}

            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 10,
              }}
            >
              {canManage
                ? "Seeded rows carry a sample marker, so removing them never touches your own data."
                : "Loading and removing sample data needs an owner or admin."}
            </Text>

            {canManage ? (
              <View style={{ marginTop: 12 }}>
                <SetupActionButton
                  label={
                    action === "remove" ? "Remove sample data" : "Load sample data"
                  }
                  busyLabel={
                    action === "remove" ? "Removing…" : "Loading sample data…"
                  }
                  busy={working}
                  disabled={!gate.enabled}
                  {...(action === "remove" ? { tone: "danger" as const } : {})}
                  accessibilityHint={
                    action === "remove"
                      ? "Deletes only the rows Moosewave seeded."
                      : "Adds demo subscribers, campaigns and sequences to this workspace."
                  }
                  onPress={() => void onAct()}
                  testID="sample-data-action"
                />
              </View>
            ) : null}
          </View>
        ) : null}
      </QueryStates>
    </Card>
  );
}
