/**
 * ArchiveDomainCard — the archive vanity host: set it, publish the CNAME,
 * re-check verification, and watch the certificate issue.
 *
 * Desktop's ArchiveDomainSection has owned this lifecycle since the
 * `archive-archive-domain-ui` gap feature; mobile had nothing, so the one
 * question this flow generates — "has DNS propagated / has the cert issued
 * yet?" — was the one question a phone could not answer, despite being the
 * device people check while waiting on a registrar.
 *
 * Sits on the Custom domains screen, above the sending-domain list: the same
 * DNS-setup errand, the same copyable-record grammar (it reuses DnsRecordCard,
 * so Host and Value are separate Copy controls, as a registrar form expects).
 *
 * ADMIN-ONLY, INCLUDING THE READ. All four routes are `admin` in the routeauth
 * manifest, so a lower role is shown nothing at all rather than a card that
 * would 403 on load.
 *
 * TWO VERBS, NOT ONE. Clearing the domain (PUT tenant-settings with "") and
 * removing the verification row (DELETE domain) are separate server-side, and
 * a verification row left behind keeps resolving that host to this tenant —
 * so the card offers both and says which is which.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import {
  deleteArchiveDomainVerification,
  getArchiveDomainStatus,
  saveArchiveDomain,
  verifyArchiveDomain,
} from "@/api/archiveDomain";
import { useConfirm } from "@/components/ConfirmSheet";
import { QueryStates } from "@/components/QueryStates";
import {
  Action,
  ArchiveDomainLifecycle,
  Caption,
  type ArchiveDomainBusy,
} from "@/components/settings/ArchiveDomainLifecycle";
import { SettingsTextInput } from "@/components/settings/FormControls";
import { FieldLabel } from "@/components/settings/SettingsScreenPrimitives";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  archiveDomainDirty,
  archiveDomainShouldPoll,
  archiveDomainWriteError,
  archiveVerifyOutcome,
  isArchiveDomainStatus,
  validateArchiveDomain,
  type ArchiveDomainStatus,
} from "@/lib/archiveDomain";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** SSL issuance is typically < 90s, so a 10s re-read is the desktop cadence. */
const SSL_POLL_MS = 10_000;

export function ArchiveDomainCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const canAdmin = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const qc = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<ArchiveDomainBusy>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const queryKey = ["archive-domain", gate.tenantId];

  const statusQuery = useQuery({
    queryKey,
    enabled: canAdmin && gate.enabled && Boolean(gate.tenantId),
    staleTime: 30_000,
    // The edge writes ssl_status out of band. `issuing` is the only state that
    // changes while the operator sits here doing nothing, and it is exactly
    // the state they are waiting on.
    refetchInterval: (query: { state: { data: unknown } }) =>
      archiveDomainShouldPoll(
        isArchiveDomainStatus(query.state.data) ? query.state.data : null,
      )
        ? SSL_POLL_MS
        : false,
    queryFn: async (): Promise<ArchiveDomainStatus | null> => {
      const res = await getArchiveDomainStatus();
      if (res.error) {
        throw Object.assign(new Error(res.error.message), res.error);
      }
      return res.data;
    },
  });
  const status = isArchiveDomainStatus(statusQuery.data)
    ? statusQuery.data
    : null;

  // The input follows the SAVED domain; a refetch that changes nothing must
  // not clobber an edit in progress, so it is keyed on the value.
  const savedDomain = status ? status.domain : "";
  useEffect(() => {
    setDraft(savedDomain);
  }, [savedDomain]);

  async function run(
    kind: Exclude<ArchiveDomainBusy, null>,
    action: () => Promise<void>,
  ) {
    if (busy) return;
    setBusy(kind);
    setWriteError(null);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    if (!status) return;
    const parsed = validateArchiveDomain(draft);
    if (!parsed.ok) {
      setWriteError(parsed.message);
      return;
    }
    await run("save", async () => {
      const res = await saveArchiveDomain(parsed.value);
      if (res.error) {
        const message = archiveDomainWriteError(res.error);
        setWriteError(message);
        haptics.error();
        toast({ kind: "error", message });
        return;
      }
      haptics.success();
      toast({
        kind: "success",
        message: parsed.value
          ? "Archive domain saved. Publish the CNAME below, then Verify."
          : "Archive domain cleared.",
      });
      await statusQuery.refetch();
    });
  }

  async function onVerify() {
    await run("verify", async () => {
      const res = await verifyArchiveDomain();
      if (res.error) {
        const message = archiveDomainWriteError(res.error);
        setWriteError(message);
        haptics.error();
        toast({ kind: "error", message });
        return;
      }
      if (!res.data) {
        setWriteError("The verification response was malformed.");
        return;
      }
      qc.setQueryData(queryKey, res.data);
      const outcome = archiveVerifyOutcome(res.data);
      if (outcome.kind === "success") haptics.success();
      else haptics.warning();
      toast({ kind: outcome.kind, message: outcome.message });
    });
  }

  async function onRemove() {
    const ok = await confirm({
      title: "Remove custom-domain verification?",
      message:
        "Your archive at this vanity host will stop resolving immediately. You can re-verify any time the CNAME is still in place.",
      confirmLabel: "Remove verification",
      cancelLabel: "Keep it",
      destructive: true,
    });
    if (!ok) return;
    await run("remove", async () => {
      const res = await deleteArchiveDomainVerification();
      if (res.error) {
        const message = archiveDomainWriteError(res.error);
        setWriteError(message);
        haptics.error();
        toast({ kind: "error", message });
        return;
      }
      haptics.success();
      toast({ kind: "success", message: "Verification cleared." });
      await statusQuery.refetch();
    });
  }

  // Nothing to show a role that cannot read the routes.
  if (!canAdmin) return null;

  const dirty = status ? archiveDomainDirty(status, draft) : false;
  const saveDisabled = !status || !dirty || busy !== null;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 16,
        padding: 14,
        marginBottom: 12,
        gap: 10,
      }}
    >
      <FieldLabel>Archive domain</FieldLabel>
      <QueryStates
        query={statusQuery}
        isEmpty={!status}
        gate={gate}
        empty={{
          title: "No archive-domain settings",
          description: "The server returned no archive-domain state.",
        }}
        offlineMessage="Reconnect to load the archive domain."
        skeleton={<SkeletonList rows={1} lines={2} label="Loading archive domain" />}
      >
        {status ? (
          <View style={{ gap: 10 }}>
            <SettingsTextInput
              label="Custom domain"
              hint="Lowercase hostname, no path or scheme. Use a sub-domain (e.g. news.example.com) — apex domains require ALIAS / ANAME on supporting providers. Leave blank to keep using the hosted archive URL."
              value={draft}
              onChangeText={(v) => setDraft(v.toLowerCase())}
              placeholder="news.example.com"
              placeholderTextColor={t.fgSubtle}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={busy === null}
            />
            <Action
              label={busy === "save" ? "Saving…" : "Save domain"}
              accessibilityLabel="Save archive domain"
              disabled={saveDisabled}
              busy={busy === "save"}
              onPress={() => void onSave()}
            />
            {writeError ? (
              <Text
                accessibilityRole="alert"
                {...typeCap("caption")}
                style={{
                  color: t.danger,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                {writeError}
              </Text>
            ) : null}
            {status.domain === "" ? (
              <Caption>
                No custom domain configured yet. Add one above to start
                verification.
              </Caption>
            ) : (
              <ArchiveDomainLifecycle
                status={status}
                busy={busy}
                onVerify={() => void onVerify()}
                onRemove={() => void onRemove()}
              />
            )}
          </View>
        ) : null}
      </QueryStates>
    </View>
  );
}
