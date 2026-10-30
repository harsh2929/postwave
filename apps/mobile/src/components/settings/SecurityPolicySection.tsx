/**
 * SecurityPolicySection — the workspace security policy, read-only.
 *
 * Mobile enforces this policy in three places and explained it in none:
 * TotpSecuritySection refuses to remove two-factor "while your workspace policy
 * requires it", the MFA gate bounces users into enrollment, and the cookie dies
 * at `session_max_minutes`. This card is the one tap that turns each of those
 * walls into a stated rule.
 *
 * It is READ-ONLY on purpose — see src/api/securitySettings.ts. The write half
 * can lock every colleague out of the workspace, so it stays on the web admin
 * and this card links there.
 *
 * The card is hidden — not errored — when the server says the policy is not
 * this user's to read. That decision belongs to the server (the route is
 * admin-scoped) rather than to `session.effectiveRole`, which can be a stale
 * cached value on a phone that has been offline.
 */
import { useQuery } from "@tanstack/react-query";
import * as Linking from "expo-linking";
import { Text, View } from "react-native";

import {
  formatSessionTtl,
  getSecuritySettings,
  isPolicyHidden,
  ssoProviderHint,
  ssoProviderLabel,
  twoFactorPolicyLabel,
  type TenantSecurityPolicy,
} from "@/api/securitySettings";
import { ErrorState } from "@/components/ErrorState";
import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { TextLink } from "@/components/TextLink";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { PUBLIC_APP_BASE_URL } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

// PUBLIC_APP_BASE_URL is already normalised (https-or-dev-http, no credentials,
// no trailing slash) where it is defined, so appending a fixed path cannot
// produce something unsafe to hand to Linking.openURL.
const WEB_SECURITY_URL = `${PUBLIC_APP_BASE_URL}/app/settings/security`;

function PolicyRow({
  label,
  value,
  hint,
  first,
}: {
  label: string;
  value: string;
  hint?: string;
  first?: boolean;
}) {
  const { t } = useTheme();
  return (
    <View
      // Values here run to five words ("Required for admins and owners"), so
      // they stack under their label and wrap rather than sharing a single
      // truncated line with it.
      style={{
        paddingTop: first ? 0 : 10,
        marginTop: first ? 0 : 10,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: t.border,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          marginTop: 2,
          fontFamily: FONT.regular,
        }}
      >
        {value}
      </Text>
      {hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function PolicyRows({ policy }: { policy: TenantSecurityPolicy }) {
  const ssoHint = ssoProviderHint(policy);
  return (
    <>
      <PolicyRow
        first
        label="Two-factor authentication"
        value={twoFactorPolicyLabel(policy)}
        {...(policy.require2faForAll || policy.require2faForAdmins
          ? {
              hint: "Two-factor cannot be turned off on this device while the policy applies to your role.",
            }
          : {})}
      />
      <PolicyRow
        label="Session length"
        value={formatSessionTtl(policy.sessionMaxMinutes)}
        hint="How long a sign-in lasts before this workspace requires you to sign in again."
      />
      {/* The hint comes from ssoProviderHint, not from a literal here. The
          literal used to read "Sign-in is delegated to this identity provider",
          which was false in every deployment — nothing consumes sso_provider.
          Unlike the two rows above it, this one states a preference, not a
          rule the server enforces. */}
      <PolicyRow
        label="Single sign-on"
        value={ssoProviderLabel(policy)}
        {...(ssoHint ? { hint: ssoHint } : {})}
      />
    </>
  );
}

export function SecurityPolicySection() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();

  const policy = useQuery({
    queryKey: ["tenant-security-policy", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    // A 403/404 is a final answer about entitlement, not a transient failure;
    // retrying it three times just delays hiding the card.
    retry: (count, error) => !isPolicyHidden(error) && count < 2,
    queryFn: (): Promise<TenantSecurityPolicy> => getSecuritySettings(),
  });

  // The server is the authority on who may read this. Hide, don't error.
  if (isPolicyHidden(policy.error)) return null;

  return (
    <>
      <SectionHeader
        title="Workspace security policy"
        subtitle="The rules this workspace enforces on every sign-in. Managed on the web admin."
      />
      <Card>
        {policy.isLoading ? (
          <SkeletonList rows={3} />
        ) : policy.isError ? (
          <ErrorState
            compact
            error={policy.error}
            onRetry={() => void policy.refetch()}
          />
        ) : policy.data ? (
          <>
            <PolicyRows policy={policy.data} />
            <View style={{ marginTop: 12 }}>
              <TextLink
                onPress={() => void Linking.openURL(WEB_SECURITY_URL)}
                accessibilityLabel="Manage security policy on the web admin"
                textStyle={{
                  color: t.accent,
                  fontSize: 12,
                  fontWeight: "600",
                  fontFamily: FONT.semibold,
                }}
              >
                Manage on the web admin
              </TextLink>
            </View>
          </>
        ) : null}
      </Card>
    </>
  );
}
