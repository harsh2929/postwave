/**
 * WorkspaceRolesSection — read-only "which role can do what" card.
 *
 * Desktop's RolesSection renders a role × scope checkbox matrix and lets an
 * admin re-permission a role in place. The phone-appropriate slice is the
 * READ: seeing that "viewer" holds no configure scopes answers the constant
 * "why can't my colleague see X" question from anywhere; re-permissioning a
 * role re-permissions every member holding it and stays a desk decision.
 *
 * Hides itself when the server answers 403/404/501 (the route's effective
 * floor is admin), exactly like PlatformConfigSection's surfaces — never an
 * error banner for a card the reader was never entitled to.
 */
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import {
  isHiddenRolesError,
  useWorkspaceRolesQuery,
} from "@/hooks/useSettingsRoles";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { roleScopeSummary } from "@/lib/workspaceRoles";

export function WorkspaceRolesSection() {
  const { t } = useTheme();
  const roles = useWorkspaceRolesQuery();
  if (roles.isError && isHiddenRolesError(roles.error)) return null;
  const rows = Array.isArray(roles.data) ? roles.data : [];
  return (
    <>
      <SectionHeader
        title="Roles"
        subtitle="What each workspace role is allowed to do. Changed on the web admin."
      />
      <Card>
        {roles.isLoading ? (
          <SkeletonList rows={3} label="Loading roles" />
        ) : roles.isError ? (
          <ErrorState
            compact
            error={roles.error}
            onRetry={() => void roles.refetch()}
          />
        ) : rows.length === 0 ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            No roles defined yet. Roles are seeded on the next migration run.
          </Text>
        ) : (
          rows.map((role, index) => (
            <View
              key={role.id}
              accessible
              accessibilityLabel={`${role.name}. ${
                role.description || "No description."
              } Scopes: ${roleScopeSummary(role)}.`}
              style={{
                paddingVertical: 8,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: t.borderSubtle,
              }}
            >
              <Text
                {...typeCap("body")}
                style={{
                  color: t.fg,
                  ...typeStyle("body"),
                  fontFamily: FONT.semibold,
                }}
              >
                {role.name}
              </Text>
              {role.description ? (
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("bodySmall"),
                    marginTop: 2,
                    fontFamily: FONT.regular,
                  }}
                >
                  {role.description}
                </Text>
              ) : null}
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  marginTop: 4,
                  fontFamily: FONT.regular,
                }}
              >
                {roleScopeSummary(role)}
              </Text>
            </View>
          ))
        )}
      </Card>
    </>
  );
}
