/**
 * Article50ReadinessCard — EU AI Act Article 50 transparency posture.
 *
 * Desktop's Article50ReadinessPanel, translated to what a phone can verify:
 * the disclosure that ships on every AI surface (a build-time fact), the live
 * agent-actor event count over the same 30-day window desktop reads, and the
 * AIVS inspector bundle export.
 *
 * THE EXPORT, honestly per platform. The bundle route streams a signed
 * .tar.gz behind the session, so a bare download link can never work on the
 * phone (the AuditExportSheet doctrine). On iOS the card does what desktop's
 * paste-a-session-id flow does, in phone idiom: fetch the BYTES through the
 * authenticated session (api/complianceEvidence.fetchAivsBundle), write them
 * to the app cache, and hand the FILE to the share sheet. Android's core
 * Share cannot attach a file and expo-sharing is not in this build, so
 * Android keeps the web-admin handoff copy instead of a dead button.
 *
 * The fetch is PRESS-DRIVEN, never a prefetch: pulling inspector evidence is
 * a deliberate act, and the session id comes from the operator.
 *
 * NativeWind v4: static style objects only.
 */
import { useState } from "react";
import { Platform, Pressable, Share, Text, TextInput, View } from "react-native";
import { File, Paths } from "expo-file-system";

import { SectionLabel } from "@/components/SectionLabel";
import { useComplianceCardStyle } from "@/components/compliance/complianceEvidenceStyle";
import { settingsInputStyle } from "@/components/settings/FormControls";
import { fetchAivsBundle } from "@/api/complianceEvidence";
import { useAgentEventWindow } from "@/hooks/useComplianceEvidence";
import {
  agentActivityLine,
  AIVS_BUNDLE_EXPORT_COPY,
  AIVS_BUNDLE_HANDOFF_COPY,
  aivsExportIssue,
  aivsSessionIdIssue,
  ARTICLE50_DISCLOSURE_COPY,
} from "@/lib/complianceEvidence";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain } from "@/lib/keyboardChain";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function Article50ReadinessCard({ allowed }: { allowed: boolean }) {
  const agentWindow = useAgentEventWindow(allowed);
  const { t } = useTheme();
  const styles = useComplianceCardStyle();

  if (!allowed) return null;

  const countLine = agentWindow.isLoading
    ? "Counting agent activity…"
    : agentActivityLine(agentWindow.data ?? null);
  const exportLive = Platform.OS === "ios";

  return (
    <View style={{ marginTop: 16 }}>
      <SectionLabel
        topMargin={0}
        subtitle="EU AI Act Article 50 — what this workspace can show an inspector."
      >
        AI transparency
      </SectionLabel>
      <View
        style={styles.card}
        accessible
        accessibilityLabel="Article 50 readiness"
      >
        <ReadinessRow
          title="Disclosure shipped"
          body={ARTICLE50_DISCLOSURE_COPY}
        />
        <ReadinessRow title="Agent activity logged" body={countLine} />
        <ReadinessRow
          title="Inspector bundle"
          body={exportLive ? AIVS_BUNDLE_EXPORT_COPY : AIVS_BUNDLE_HANDOFF_COPY}
        />
      </View>
      {exportLive ? <AivsBundleExport /> : null}
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        The bundle carries the generator, version and Ed25519 public key, so
        verification runs offline with the included script.
      </Text>
    </View>
  );
}

/**
 * The iOS export flow: session id → authenticated byte fetch → cache file →
 * share sheet. A dismissed share sheet is not a failure — the file was
 * fetched and shown; the success line stays.
 */
function AivsBundleExport() {
  const { t } = useTheme();
  const [sessionId, setSessionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const onExport = async () => {
    const idIssue = aivsSessionIdIssue(sessionId);
    if (idIssue) {
      setIssue(idIssue);
      setDone(null);
      return;
    }
    haptics.tap();
    setBusy(true);
    setIssue(null);
    setDone(null);
    try {
      const bundle = await fetchAivsBundle(sessionId);
      const file = new File(Paths.cache, bundle.filename);
      file.create({ intermediates: true, overwrite: true });
      file.write(bundle.bytes);
      await Share.share({ url: file.uri, title: bundle.filename });
      haptics.success();
      setDone(
        `Fetched ${bundle.filename} (${Math.max(
          1,
          Math.round(bundle.bytes.byteLength / 1024),
        )} KB) and handed it to the share sheet.`,
      );
    } catch (err) {
      haptics.error();
      setIssue(aivsExportIssue(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ marginTop: 8, gap: 8 }}>
      <TextInput
        {...typeCap("body")}
        value={sessionId}
        onChangeText={setSessionId}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="AI session id (from an agent audit row)"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="AI session id"
        // The only field in this card: the return key runs the export the
        // button below runs, rather than sitting inert over the keyboard.
        {...keyboardChain({ onSubmit: () => void onExport(), disabled: busy })}
        style={settingsInputStyle(t)}
      />
      <Pressable
        onPress={() => void onExport()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Fetch and share the AIVS inspector bundle"
        accessibilityState={{ disabled: busy }}
        style={{
          minHeight: 44,
          justifyContent: "center",
          alignItems: "center",
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.borderSubtle,
          backgroundColor: busy ? t.bgSubtle : t.surface,
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: busy ? t.fgSubtle : t.accent,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {busy ? "Fetching…" : "Fetch & share bundle"}
        </Text>
      </Pressable>
      {issue ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {issue}
        </Text>
      ) : null}
      {done ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {done}
        </Text>
      ) : null}
    </View>
  );
}

function ReadinessRow({ title, body }: { title: string; body: string }) {
  const { t } = useTheme();
  return (
    <View style={{ marginBottom: 8 }}>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
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
