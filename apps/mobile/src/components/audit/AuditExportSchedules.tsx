/**
 * AuditExportSchedules — the recurring evidence-pack schedules inside the
 * export sheet: list, create, delete.
 *
 * TWO DELIVERY MODELS SHARE ONE SHEET, and the copy must keep them apart. The
 * AD-HOC export above this section is collect-from-web (its download is
 * session-bound); a SCHEDULED export is the one path the server actually
 * MAILS — the schedule worker enqueues the job and emails the link to the
 * schedule's recipients. So the create form talks about recipients, and the
 * ad-hoc copy keeps saying "collect from the web admin".
 *
 * Writes are admin-floor (`canManage` — the routeauth rows on POST/DELETE),
 * so the form and the delete verbs are WITHHELD, not disabled, from everyone
 * else; readers still see the roster because knowing a recurring evidence
 * export exists is itself the compliance answer.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { ChipRow } from "@/components/ChipRow";
import { useConfirm } from "@/components/ConfirmSheet";
import { SectionLabel } from "@/components/SectionLabel";
import { SettingsTextInput } from "@/components/settings/FormControls";
import type { AuditExportSchedulesController } from "@/hooks/useAuditExport";
import {
  EXPORT_SCHEDULE_CADENCES,
  buildExportScheduleBody,
  exportScheduleLine,
  validateExportScheduleInput,
  type AuditExportSchedule,
  type ExportScheduleCadence,
} from "@/lib/auditExportSchedules";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { AuditAction } from "./AuditAction";

const CADENCE_OPTIONS: readonly { value: ExportScheduleCadence; label: string }[] =
  EXPORT_SCHEDULE_CADENCES.map((value) => ({
    value,
    label: value === "weekly" ? "Weekly" : "Monthly",
  }));

export function AuditExportSchedules({
  controller,
}: {
  controller: AuditExportSchedulesController;
}) {
  const { t } = useTheme();
  const confirm = useConfirm();
  const [cadence, setCadence] = useState<ExportScheduleCadence>("weekly");
  const [recipientsRaw, setRecipientsRaw] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  const submit = async () => {
    const found = validateExportScheduleInput(cadence, recipientsRaw);
    if (found.length > 0) {
      setErrors(found);
      return;
    }
    const body = buildExportScheduleBody(cadence, recipientsRaw);
    if (!body) return;
    setErrors([]);
    if (await controller.create(body)) setRecipientsRaw("");
  };

  const onDelete = async (schedule: AuditExportSchedule) => {
    const ok = await confirm({
      title: "Delete this schedule?",
      message: `${exportScheduleLine(schedule)}. Future runs stop; exports already produced are unaffected.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    await controller.remove(schedule);
  };

  // Array.isArray, not `?? []`: the schedules come off the wire, and `??`
  // passes a truthy non-array (a paged envelope, an HTML error page) straight
  // into the .map below. `controller.rows` itself stays the loaded/not-loaded
  // signal for the empty-state branch.
  const rows = Array.isArray(controller.rows) ? controller.rows : [];
  return (
    <View>
      <SectionLabel>Scheduled exports</SectionLabel>
      <Muted text="Recurring evidence packs. Unlike the one-off export above, each scheduled run is emailed to its recipients when it completes." />
      {controller.loading ? <Muted text="Loading schedules…" /> : null}
      {controller.failed ? (
        <Muted text="Couldn't load the schedules. Close and reopen the sheet to retry." />
      ) : null}
      {controller.rows && rows.length === 0 ? (
        <Muted
          text={
            controller.canManage
              ? "No recurring exports are set up."
              : "No recurring exports are set up. A workspace admin can create one here or on desktop."
          }
        />
      ) : null}
      {rows.map((schedule) => (
        <View
          key={schedule.id}
          accessible
          accessibilityLabel={exportScheduleLine(schedule)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            minHeight: 44,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              flex: 1,
              fontFamily: FONT.regular,
              ...typeStyle("bodySmall"),
            }}
          >
            {exportScheduleLine(schedule)}
          </Text>
          {controller.canManage ? (
            <View style={{ maxWidth: 110, flexDirection: "row" }}>
              <AuditAction
                label={controller.removing ? "…" : "Delete"}
                hint="Deletes this recurring export schedule"
                destructive
                disabled={controller.removing}
                onPress={() => void onDelete(schedule)}
              />
            </View>
          ) : null}
        </View>
      ))}

      {controller.canManage ? (
        <View style={{ gap: 10, marginTop: 12 }}>
          <ChipRow
            options={CADENCE_OPTIONS}
            value={cadence}
            onChange={(next) => {
              setErrors([]);
              setCadence(next);
            }}
            accessibilityLabel="Schedule cadence"
            paddingHorizontal={0}
          />
          <SettingsTextInput
            label="Recipients"
            hint="Comma-separated emails — each finished export is mailed to them. Up to 20."
            placeholder="soc@example.com, auditor@example.com"
            value={recipientsRaw}
            onChangeText={(next) => {
              setErrors([]);
              setRecipientsRaw(next);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
          {errors.map((error) => (
            <Text
              key={error}
              accessibilityRole="alert"
              {...typeCap("bodySmall")}
              style={{
                color: t.danger,
                fontFamily: FONT.regular,
                ...typeStyle("bodySmall"),
              }}
            >
              {error}
            </Text>
          ))}
          <View style={{ flexDirection: "row" }}>
            <AuditAction
              label={controller.creating ? "Creating…" : "Create schedule"}
              hint="Creates the recurring export. The first run happens on the next due scan."
              emphasis
              disabled={controller.creating}
              onPress={() => void submit()}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Muted({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fgMuted,
        fontFamily: FONT.regular,
        marginBottom: 6,
        ...typeStyle("bodySmall"),
      }}
    >
      {text}
    </Text>
  );
}
