/**
 * MoreWorkspaceSection — the identity block at the top of More: who you are,
 * which tenant you are in, and which SERVER this device is talking to.
 *
 * Extracted from `app/(tabs)/more.tsx` when the screen function crossed its
 * 300-line budget after gaining the connection switcher. The seam is the same
 * one that produced MoreRows and useMoreDestinations: this is the WORKSPACE
 * panel, and the screen is left holding the destination list and its two side
 * effects.
 *
 * The three children belong together and are ordered from the narrowest
 * question to the widest, which is also the order of how consequential a tap
 * is:
 *
 *   MoreWorkspaceCard      where am I?                (read-only)
 *   WorkspaceSwitcher      other tenants, same server (session exchange)
 *   ConnectionProfilesCard other servers, same device (sign-out + sign-in)
 *
 * They share one SectionBoundary because they read the same session state: a
 * surprise in it must degrade this panel, never take the destination list —
 * which is the only way to reach 24 of the app's screens — with it.
 */
import { SectionBoundary } from "@/components/SectionBoundary";
import {
  MoreWorkspaceCard,
  type MoreWorkspaceCardProps,
} from "@/components/more/MoreWorkspaceCard";
import { ConnectionProfilesCard } from "@/components/workspace/ConnectionProfilesCard";
import { WorkspaceSwitcher } from "@/components/workspace/WorkspaceSwitcher";
import { type ThemeTokens } from "@/lib/theme";

export function MoreWorkspaceSection({
  t,
  onRetry,
  ...card
}: MoreWorkspaceCardProps & {
  t: ThemeTokens;
  /** Refetch the session that produced the bad data, alongside the remount. */
  onRetry: () => void;
}) {
  return (
    <SectionBoundary label="Workspace" t={t} onRetry={onRetry}>
      <MoreWorkspaceCard {...card} />
      {/* SHELL#6. Renders nothing at all unless this email belongs to more
          than one workspace, so the single-workspace majority sees exactly
          the screen they saw before. */}
      <WorkspaceSwitcher />
      {/* Multiple SERVERS on one device (a staging and a production install,
          or two customers'). Unlike the switcher above it never hides itself:
          a control that disappeared at one saved connection could never be
          used to add the second. */}
      <ConnectionProfilesCard />
    </SectionBoundary>
  );
}
