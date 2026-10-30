/**
 * MaintenanceWindowsSection — scheduled maintenance windows: what is running
 * now, what is coming, what has passed; and, for an admin, the verbs to
 * schedule one and move it through its life.
 *
 * apps/api/internal/maintenance has carried full tenant-admin CRUD for these
 * with no shipping client anywhere (desktop's MaintenanceWindowsPanel is
 * rendered nowhere). A window is exactly the thing an on-call admin needs to
 * see — and start, finish, or cancel — from a phone.
 *
 * Role: the manifest floors the GET at viewer, but the Go mount wraps every
 * verb in RequireScope(ScopeAdmin), which floors a session at admin too. So a
 * 403 here is "not this reader's to see" and hides the card (the same policy
 * as PlatformConfigSection and the roles card), never an error banner. Writes
 * are gated by the shared role helper as well, so a viewer who CAN read never
 * sees a button the server would refuse.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { listMaintenanceWindows } from "@/api/maintenanceWindows";
import { QueryStates } from "@/components/QueryStates";
import { MaintenanceWindowForm } from "@/components/settings/MaintenanceWindowForm";
import { MaintenanceWindowRow } from "@/components/settings/MaintenanceWindowRow";
import {
  Card,
  FieldLabel,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import {
  groupMaintenanceWindows,
  isMaintenanceSurfaceHidden,
  type MaintenanceWindowView,
} from "@/lib/maintenanceWindows";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** Past windows shown before the list is expanded. */
const PAST_VISIBLE = 3;

export function MaintenanceWindowsSection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const canAdmin = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const [formOpen, setFormOpen] = useState(false);
  const [showAllPast, setShowAllPast] = useState(false);

  const windows = useQuery({
    queryKey: ["maintenance-windows", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    // A hidden status is a final answer, not a transient to hammer.
    retry: (count, error) => !isMaintenanceSurfaceHidden(error) && count < 2,
    queryFn: async (): Promise<MaintenanceWindowView[]> => {
      const res = await listMaintenanceWindows();
      if (res.error) {
        throw Object.assign(new Error(res.error.message), res.error);
      }
      return res.data;
    },
  });

  if (windows.isError && isMaintenanceSurfaceHidden(windows.error)) return null;

  const rows = Array.isArray(windows.data) ? windows.data : [];
  const groups = groupMaintenanceWindows(rows);
  const past = showAllPast ? groups.past : groups.past.slice(0, PAST_VISIBLE);
  const hiddenPast = groups.past.length - PAST_VISIBLE;
  const refresh = () => void windows.refetch();

  const group = (label: string, list: MaintenanceWindowView[]) =>
    list.length === 0 ? null : (
      <View key={label}>
        <FieldLabel marginBottom={0}>{label}</FieldLabel>
        {list.map((w, index) => (
          <MaintenanceWindowRow
            key={w.id}
            window={w}
            canAdmin={canAdmin}
            first={index === 0}
            onChanged={refresh}
          />
        ))}
      </View>
    );

  return (
    <>
      <SectionHeader
        title="Maintenance windows"
        subtitle="Planned downtime, the components it affects, and what is running now."
      />
      <Card>
        {canAdmin ? (
          <Pressable
            onPress={() => {
              haptics.tap();
              setFormOpen(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Schedule a maintenance window"
            accessibilityHint="Opens a form for the title, affected components, and time range."
            style={{
              minHeight: 44,
              justifyContent: "center",
              alignItems: "center",
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.surface,
              marginBottom: 12,
            }}
          >
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontWeight: "700",
                fontFamily: FONT.bold,
              }}
            >
              Schedule a window
            </Text>
          </Pressable>
        ) : null}
        <QueryStates
          query={windows}
          isEmpty={rows.length === 0}
          gate={gate}
          empty={{
            title: "No maintenance windows",
            description: canAdmin
              ? "Schedule one above to announce planned downtime."
              : "Nothing is scheduled for this workspace.",
          }}
          offlineMessage="Reconnect to load maintenance windows."
          skeleton={
            <SkeletonList rows={2} lines={2} label="Loading maintenance windows" />
          }
        >
          <View style={{ gap: 12 }}>
            {group("Active", groups.active)}
            {group("Upcoming", groups.upcoming)}
            {group("Past", past)}
            {hiddenPast > 0 ? (
              <Pressable
                onPress={() => {
                  haptics.tap();
                  setShowAllPast((prev) => !prev);
                }}
                accessibilityRole="button"
                accessibilityState={{ expanded: showAllPast }}
                accessibilityLabel={
                  showAllPast
                    ? `Show only the ${num(PAST_VISIBLE)} most recent past windows`
                    : `Show ${num(hiddenPast)} older windows`
                }
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.accent,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {showAllPast
                    ? "Show fewer"
                    : `Show ${num(hiddenPast)} older`}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </QueryStates>
      </Card>
      {canAdmin ? (
        <MaintenanceWindowForm
          visible={formOpen}
          onClose={() => setFormOpen(false)}
          onCreated={refresh}
        />
      ) : null}
    </>
  );
}
