/**
 * PlatformConfigSection — read-only visibility for four workspace-platform
 * surfaces that mobile could not see at all.
 *
 * Data region, feature flags, the signup firewall and identifier transforms
 * each have a desktop section (apps/desktop/src/pages/Settings.tsx) and had
 * zero mobile representation. Each of the four silently changes what the user
 * observes elsewhere in this same app — an import that "loses" subscribers is
 * identifier transforms collapsing +tag addresses; signups that stop arriving
 * may be attack mode; a feature that a colleague has and you do not is a flag.
 * Being unable to check any of that from a phone turns each into a mystery.
 *
 * FOUR INDEPENDENT ROWS, FOUR INDEPENDENT FAILURES. Each surface has its own
 * query and hides itself on 403/404/501 — the server is the authority on who
 * may read what, and a self-hosted build can legitimately omit a module. One
 * unavailable surface must not blank the other three, and the whole section
 * renders nothing at all when none of the four answered.
 *
 * THREE OF THE FOUR NOW ACT (docs/mobile-desktop-parity-2026-08-28.md, the
 * settings P3 rows): flags open FeatureFlagSheet, the firewall opens
 * FirewallAdminSheet, transforms open IdentifierTransformsSheet. Every write
 * behind them is admin (usePlatformConfigRole); a viewer sees the state and
 * — for the firewall, whose reads are viewer — the activity, never a control
 * that would 403.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { FeatureFlagSheet } from "@/components/settings/platform-config/FeatureFlagSheet";
import { FirewallAdminSheet } from "@/components/settings/platform-config/FirewallAdminSheet";
import { FlagRow } from "@/components/settings/platform-config/FlagRow";
import { IdentifierTransformsSheet } from "@/components/settings/platform-config/IdentifierTransformsSheet";
import { SurfaceAction } from "@/components/settings/platform-config/PlatformConfigPrimitives";
import {
  Card,
  Row,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import {
  isHiddenPlatformError,
  useFeatureFlagsQuery,
  useFirewallSettingsQuery,
  useIdentifierTransformsQuery,
  useTenantRegionQuery,
} from "@/hooks/usePlatformConfig";
import { useCanAdminPlatformConfig } from "@/hooks/usePlatformConfigRole";
import { FONT } from "@/lib/fonts";
import {
  firewallModeLabel,
  identifierTransformSummary,
  regionLabel,
  residencySummary,
  surgeRuleLabel,
  type FeatureFlagView,
} from "@/lib/platformConfig";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** How many flags one card shows before it stops being a list and starts
 *  being a table. The count line above always states the true total. */
const VISIBLE_FLAGS = 8;

function Note({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        marginTop: 8,
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

/**
 * One surface's card body. Collapses the four-way loading/hidden/error/data
 * ladder each row would otherwise repeat, and returns null for `hidden` so the
 * caller can drop its heading too.
 */
function Surface({
  title,
  subtitle,
  isLoading,
  isError,
  error,
  onRetry,
  children,
}: {
  title: string;
  subtitle: string;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (isError && isHiddenPlatformError(error)) return null;
  return (
    <>
      <SectionHeader title={title} subtitle={subtitle} />
      <Card>
        {isLoading ? (
          <SkeletonList rows={2} label={`Loading ${title.toLowerCase()}`} />
        ) : isError ? (
          <ErrorState compact error={error} onRetry={onRetry} />
        ) : (
          children
        )}
      </Card>
    </>
  );
}

function RegionSurface() {
  const region = useTenantRegionQuery();
  const data = region.data;
  return (
    <Surface
      title="Data residency"
      subtitle="Where this workspace's data rests, and where this request was served."
      isLoading={region.isLoading}
      isError={region.isError}
      error={region.error}
      onRetry={() => void region.refetch()}
    >
      {data ? (
        <>
          <Row label="Data region" value={regionLabel(data.dataRegion)} />
          <Row
            label="Serving region"
            value={regionLabel(data.deploymentRegion)}
          />
          {/* The comparison is the answer, and it is the server's to make —
              two codes side by side leave the reader to do it themselves. */}
          <Note>{residencySummary(data)}</Note>
        </>
      ) : null}
    </Surface>
  );
}

function FlagsSurface() {
  const { t } = useTheme();
  const canAdmin = useCanAdminPlatformConfig();
  const flags = useFeatureFlagsQuery();
  const rows = Array.isArray(flags.data) ? flags.data : [];
  // null = closed; {flag: null} = a new override; {flag} = that row.
  const [editing, setEditing] = useState<{
    flag: FeatureFlagView | null;
  } | null>(null);
  return (
    <Surface
      title="Feature flags"
      subtitle={
        canAdmin
          ? "What this workspace has switched on. Tap a flag to change its override."
          : "What this workspace has switched on. Changed by an admin."
      }
      isLoading={flags.isLoading}
      isError={flags.isError}
      error={flags.error}
      onRetry={() => void flags.refetch()}
    >
      {rows.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          No feature flags apply to this workspace.
        </Text>
      ) : (
        <>
          {rows.slice(0, VISIBLE_FLAGS).map((flag) => (
            <FlagRow
              key={flag.key}
              flag={flag}
              // The value, then whether it is this workspace's own decision:
              // "on (default)" and "on (workspace override)" mean different
              // things to anyone trying to work out why two accounts differ.
              value={`${flag.enabled ? flag.value || "on" : "off"} · ${
                flag.isDefault ? "platform default" : "workspace override"
              }`}
              onPress={canAdmin ? () => setEditing({ flag }) : undefined}
            />
          ))}
          {rows.length > VISIBLE_FLAGS ? (
            <Note>{`${rows.length - VISIBLE_FLAGS} more on the web admin.`}</Note>
          ) : null}
        </>
      )}
      {canAdmin ? (
        <SurfaceAction
          label="Add an override"
          onPress={() => setEditing({ flag: null })}
          accessibilityHint="Opens a sheet to set a flag for this workspace by key."
        />
      ) : null}
      <FeatureFlagSheet
        visible={editing !== null}
        flag={editing?.flag ?? null}
        onClose={() => setEditing(null)}
      />
    </Surface>
  );
}

function FirewallSurface() {
  const canAdmin = useCanAdminPlatformConfig();
  const firewall = useFirewallSettingsQuery();
  const [open, setOpen] = useState(false);
  const data = firewall.data;
  return (
    <Surface
      title="Signup firewall"
      subtitle="Moosewave's defence against bot signups on your forms."
      isLoading={firewall.isLoading}
      isError={firewall.isError}
      error={firewall.error}
      onRetry={() => void firewall.refetch()}
    >
      {data ? (
        <>
          <Row label="Attack mode" value={firewallModeLabel(data)} />
          <Row
            label="Browser fingerprint"
            value={data.fingerprintRequired ? "Required" : "Not required"}
          />
          <Row
            label="Block score"
            value={
              data.attackModeThreshold > 0
                ? `${data.attackModeThreshold} and above`
                : "Not set"
            }
          />
          <Note>{surgeRuleLabel(data)}</Note>
          {/* The events and counts are viewer reads; only the settings form
              inside the sheet is admin, and it says so there. */}
          <SurfaceAction
            label={canAdmin ? "Manage firewall" : "Recent activity"}
            onPress={() => setOpen(true)}
            accessibilityHint={
              canAdmin
                ? "Opens attack mode, thresholds, signup counts and recent events."
                : "Opens signup counts and recent events."
            }
          />
          <FirewallAdminSheet
            visible={open}
            server={data}
            onClose={() => setOpen(false)}
          />
        </>
      ) : null}
    </Surface>
  );
}

function TransformsSurface() {
  const canAdmin = useCanAdminPlatformConfig();
  const transforms = useIdentifierTransformsQuery();
  const [open, setOpen] = useState(false);
  const data = transforms.data;
  const active = data ? identifierTransformSummary(data) : [];
  return (
    <Surface
      title="Identifier transforms"
      subtitle="How incoming email addresses and phone numbers are rewritten before they are matched."
      isLoading={transforms.isLoading}
      isError={transforms.isError}
      error={transforms.error}
      onRetry={() => void transforms.refetch()}
    >
      {data ? (
        <>
          <Row
            label="Email dots"
            value={data.emailNormalizeDots ? "Stripped" : "Kept"}
          />
          <Row
            label="Email “+tag”"
            value={data.emailNormalizePlus ? "Dropped" : "Kept"}
          />
          <Row
            label="Phone format"
            value={data.phoneE164Format ? "E.164" : "As received"}
          />
          {data.phoneE164Format ? (
            <Row
              label="Default region"
              value={data.phoneDefaultRegion || "None"}
            />
          ) : null}
          {/* "Nothing is being rewritten" is the answer a reader came for as
              often as the list is, so it is said in words. */}
          <Note>
            {active.length === 0
              ? "Identifiers are stored as received, apart from lower-casing."
              : active.join(". ") + "."}
          </Note>
          {canAdmin ? (
            <>
              <SurfaceAction
                label="Edit rules and preview"
                onPress={() => setOpen(true)}
                accessibilityHint="Opens the rules with a live preview; saving asks for confirmation."
              />
              <IdentifierTransformsSheet
                visible={open}
                server={data}
                onClose={() => setOpen(false)}
              />
            </>
          ) : null}
        </>
      ) : null}
    </Surface>
  );
}

export function PlatformConfigSection() {
  return (
    <View>
      <RegionSurface />
      <FlagsSurface />
      <FirewallSurface />
      <TransformsSurface />
    </View>
  );
}
