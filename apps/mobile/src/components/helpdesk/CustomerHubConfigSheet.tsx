/**
 * CustomerHubConfigSheet — read and replace the storefront Customer Hub
 * configuration record from the phone.
 *
 * Desktop reference: apps/desktop/src/components/helpdesk/CustomerHubConfig.tsx.
 * Server: GET + PUT /api/v1/service-suite/config (role=admin).
 *
 * What this sheet is careful about, in the order it matters:
 *
 *  - IT NEVER CLAIMS A RUNTIME. Every response carries `runtime_status:"held"`
 *    and a reason code; the record stores an operator's INTENT and nothing
 *    here proves a customer can see a feature. That sentence is standing copy,
 *    not an error state.
 *  - THE TWO HELD VALUES ARE REFUSED WITH THE SERVER'S OWN SENTENCE. Turning
 *    on Customer Agent, or moving status to Active, is answered 409
 *    `customer_hub_runtime_unavailable`. The toggles stay operable (so the
 *    operator can see what the record holds) but Save explains the refusal
 *    verbatim instead of spending a round trip on it.
 *  - SAVE IS A COMPLETE REPLACEMENT under the verified ETag. The six
 *    object-shaped members mobile does not edit ride along untouched.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { RoleGateNotice } from "@/components/RoleGateNotice";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SettingsSwitchRow } from "@/components/settings/FormControls";
import { useToast } from "@/components/Toast";
import {
  useCustomerHubConfig,
  useCustomerHubReplace,
} from "@/hooks/useCustomerHubConfig";
import type { HelpdeskAccess } from "@/hooks/useHelpdesk";
import {
  CUSTOMER_HUB_ABSENT_VERSION,
  CUSTOMER_HUB_CARRIED_FIELDS,
  CUSTOMER_HUB_STATUSES,
  CUSTOMER_HUB_TOGGLES,
  customerHubChangedKeys,
  customerHubDraftFrom,
  customerHubHeldReason,
  type CustomerHubDraft,
  type CustomerHubStatus,
} from "@/lib/customerHub";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { humanizeToken } from "@/lib/helpdesk";
import { messageFromError } from "@/api/request";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const STATUS_OPTIONS = CUSTOMER_HUB_STATUSES.map((value) => ({
  value,
  label: humanizeToken(value),
}));

export function CustomerHubConfigSheet({
  visible,
  onClose,
  access,
  returnFocusRef,
}: {
  visible: boolean;
  onClose: () => void;
  access: HelpdeskAccess;
  returnFocusRef?: { current: unknown } | undefined;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const query = useCustomerHubConfig(access, visible);
  const replace = useCustomerHubReplace(access);
  const resource = query.data ?? null;
  const [draft, setDraft] = useState<CustomerHubDraft | null>(null);

  // Re-seed the draft from each newly VERIFIED record (first load, refresh,
  // and the record the server returns from a replacement). Keyed on the
  // version so an operator's in-flight edits are not wiped by a refetch that
  // changed nothing.
  const version = resource?.config.version ?? null;
  useEffect(() => {
    if (!resource) {
      setDraft(null);
      return;
    }
    setDraft(customerHubDraftFrom(resource.config));
  }, [resource, version]);

  const changed = useMemo(
    () =>
      resource && draft ? customerHubChangedKeys(resource.config, draft) : [],
    [resource, draft],
  );
  const held = draft ? customerHubHeldReason(draft) : null;

  const onSave = () => {
    if (!resource || !draft || replace.isPending) return;
    if (changed.length === 0) {
      toast({ kind: "info", message: "No changes to save." });
      return;
    }
    if (held) {
      haptics.error();
      toast({ kind: "error", message: held });
      return;
    }
    haptics.tap();
    replace.mutate(
      { resource, draft },
      {
        onSuccess: () => {
          haptics.success();
          toast({
            kind: "success",
            message:
              "Configuration record replaced. The storefront runtime stays held.",
          });
        },
        onError: (error) => {
          haptics.error();
          toast({ kind: "error", message: messageFromError(error) });
        },
      },
    );
  };

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Customer Hub configuration"
      {...(returnFocusRef ? { returnFocusRef } : {})}
    >
      <View style={{ gap: 14 }}>
        <SheetTitle onClose={onClose} />

        {!access.roleAllowed ? (
          <RoleGateNotice
            title="Admin session required"
            body={
              access.denialReason ??
              "The Customer Hub configuration record was not requested for this session."
            }
          />
        ) : !access.online ? (
          <Notice
            tone="muted"
            title="Offline"
            body="The Customer Hub record is not stored on this device, so nothing is shown and no replacement can be sent."
          />
        ) : query.isPending ? (
          <View style={{ paddingVertical: 24, alignItems: "center" }}>
            <ActivityIndicator color={t.fgMuted} />
          </View>
        ) : query.isError || !resource || !draft ? (
          <ErrorState
            message={messageFromError(query.error)}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <>
            <Notice
              tone="warn"
              title="Runtime release held"
              body={
                "Server readiness: " +
                humanizeToken(resource.config.runtimeStatus) +
                " · " +
                resource.config.runtimeReasonCode +
                ". This record stores configuration intent; it does not prove a customer can see or use a feature."
              }
            />

            {resource.config.version === CUSTOMER_HUB_ABSENT_VERSION ? (
              <Notice
                tone="muted"
                title="No record stored yet"
                body="This workspace has never saved a Customer Hub record. The values below are the server's defaults; saving creates the record."
              />
            ) : null}

            <Field label="Status">
              <SegmentedControl<CustomerHubStatus>
                options={STATUS_OPTIONS}
                value={draft.status}
                onChange={(status) =>
                  setDraft((current) =>
                    current ? { ...current, status } : current,
                  )
                }
                accessibilityLabel="Customer Hub record status"
                scrollable
              />
            </Field>

            <View style={{ gap: 4 }}>
              {CUSTOMER_HUB_TOGGLES.map((toggle) => (
                <View key={toggle.key}>
                  <SettingsSwitchRow
                    label={toggle.label}
                    hint={toggle.hint}
                    value={draft[toggle.key]}
                    onValueChange={(value) =>
                      setDraft((current) =>
                        current ? { ...current, [toggle.key]: value } : current,
                      )
                    }
                    disabled={replace.isPending}
                  />
                </View>
              ))}
            </View>

            {held ? (
              <Notice tone="warn" title="Release-held value" body={held} />
            ) : null}

            <Notice
              tone="muted"
              title="Not edited here"
              body={
                "These members are carried forward exactly as the server returned them: " +
                CUSTOMER_HUB_CARRIED_FIELDS.map(humanizeToken).join(", ") +
                "."
              }
            />

            <SaveButton
              disabled={
                replace.isPending || changed.length === 0 || Boolean(held)
              }
              pending={replace.isPending}
              changedCount={changed.length}
              onPress={onSave}
            />
          </>
        )}
      </View>
    </KeyboardFormSheet>
  );
}

function SheetTitle({ onClose }: { onClose: () => void }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.bold,
          flex: 1,
        }}
      >
        Customer Hub
      </Text>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close the Customer Hub configuration sheet"
        style={{
          minHeight: 44,
          minWidth: 64,
          alignItems: "flex-end",
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("badge")}
          style={{
            color: t.accent,
            ...typeStyle("badge"),
            fontFamily: FONT.semibold,
          }}
        >
          Close
        </Text>
      </Pressable>
    </View>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      {children}
    </View>
  );
}

function Notice({
  tone,
  title,
  body,
}: {
  tone: "warn" | "muted";
  title: string;
  body: string;
}) {
  const { t } = useTheme();
  const accent = tone === "warn" ? t.warning : t.border;
  return (
    <View
      accessibilityRole="summary"
      style={{
        borderWidth: 1,
        borderColor: accent,
        backgroundColor: t.surface,
        borderRadius: 12,
        padding: 12,
        gap: 4,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fg,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        {title}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {body}
      </Text>
    </View>
  );
}

function SaveButton({
  disabled,
  pending,
  changedCount,
  onPress,
}: {
  disabled: boolean;
  pending: boolean;
  changedCount: number;
  onPress: () => void;
}) {
  const { t } = useTheme();
  const label = pending
    ? "Replacing…"
    : changedCount === 0
      ? "No changes to save"
      : "Replace configuration record";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: pending }}
      style={{
        minHeight: 48,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: t.accent,
        backgroundColor: t.surface,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text
        {...typeCap("badge")}
        style={{
          color: t.accent,
          ...typeStyle("badge"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
