/**
 * CampaignRenderedPreviewCard — see the email as a recipient will, not as
 * flattened text.
 *
 * CampaignPreviewCard's own header admits the plain-text preview flattens
 * dynamic content; an operator reviewing from a phone never saw the artifact
 * itself. Two services fix that, both ADMIN in the routeauth manifest — the
 * caller renders this card for admins only, so nobody is offered a button
 * that can only 403:
 *
 *   POST /api/v1/email-preview/render — per-client HTML (Gmail / Outlook /
 *        Apple / Dark), shown in a script-disabled WebView whose document is
 *        wrapped with a lockdown CSP (lib/campaignRenderPreview).
 *   POST /api/v1/render — the cross-client screenshot matrix via the
 *        deliverability proxy. PAID + SLOW, so it runs only from its own
 *        explicit press, mirroring desktop's CrossClientPreview.
 *
 * Neither ever prefetches: both are press-driven mutations, and a cached
 * rendering of a body that has since changed is worse than none.
 */
import { useState } from "react";
import { Image, Text, View } from "react-native";
import { WebView } from "react-native-webview";

import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import { SegmentedControl } from "@/components/SegmentedControl";
import {
  ActionButton,
  Card,
} from "@/components/campaigns/CampaignDetailControls";
import {
  useCampaignCrossClientRender,
  useCampaignEmailRender,
} from "@/hooks/useCampaignRenderedPreview";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import {
  EMAIL_PREVIEW_CLIENTS,
  isolatedPreviewDocument,
  type EmailPreviewClient,
} from "@/lib/campaignRenderPreview";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function Caption({ text, t }: { text: string; t: ThemeTokens }) {
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        marginBottom: 8,
      }}
    >
      {text}
    </Text>
  );
}

export function CampaignRenderedPreviewCard({
  bodySource,
}: {
  /** body_mjml when present, else body_html — a legal `mjml` value either way. */
  bodySource: string;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const [client, setClient] = useState<EmailPreviewClient["id"]>("gmail");
  const render = useCampaignEmailRender();
  const matrix = useCampaignCrossClientRender();
  const hasBody = bodySource.trim() !== "";

  const onRender = () => {
    if (render.isPending || !hasBody) return;
    haptics.tap();
    render.mutate(
      { mjml: bodySource },
      {
        onError: (err: unknown) =>
          toast({
            kind: "error",
            message: campaignErrorMessage(err, "Couldn't render the preview."),
          }),
      },
    );
  };

  const onMatrix = () => {
    if (matrix.isPending || !hasBody) return;
    haptics.tap();
    matrix.mutate(bodySource, {
      onError: (err: unknown) =>
        toast({
          kind: "error",
          message: campaignErrorMessage(
            err,
            "Couldn't render the cross-client screenshots.",
          ),
        }),
    });
  };

  const reading = render.data ?? null;
  const active = EMAIL_PREVIEW_CLIENTS.find((c) => c.id === client)!;
  const html = reading?.previews[client] ?? null;

  return (
    <Card>
      <Text
        {...typeCap("callout")}
        accessibilityRole="header"
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
          marginBottom: 4,
        }}
      >
        Rendered preview
      </Text>
      <Caption
        text={
          hasBody
            ? "The email as Gmail, Outlook, Apple Mail and dark mode will lay it out — rendered on demand, never cached."
            : "This campaign has no body to render yet."
        }
        t={t}
      />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <ActionButton
          label={render.isPending ? "Rendering…" : "Render preview"}
          primary
          onPress={onRender}
          disabled={render.isPending || !hasBody}
        />
      </View>

      {reading ? (
        <View style={{ marginTop: 12, gap: 8 }}>
          <SegmentedControl<EmailPreviewClient["id"]>
            options={EMAIL_PREVIEW_CLIENTS.map((c) => ({
              value: c.id,
              label: c.label,
            }))}
            value={client}
            onChange={setClient}
            accessibilityLabel="Email client to preview"
          />
          {reading.warnings.map((warning) => (
            <Text
              key={warning}
              {...typeCap("caption")}
              style={{
                color: t.warning,
                ...typeStyle("caption"),
                fontFamily: FONT.medium,
              }}
            >
              {warning}
            </Text>
          ))}
          {html ? (
            <View
              accessible
              accessibilityLabel={`Rendered email preview, ${active.label}`}
              style={{
                height: 420,
                borderColor: t.borderSubtle,
                borderWidth: 1,
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <WebView
                source={{ html: isolatedPreviewDocument(html, active.width) }}
                // Third-party email HTML: no scripts, ever. The injected CSP
                // is the second lock (lib/campaignRenderPreview).
                javaScriptEnabled={false}
                // A whitelist MISS does not cancel the navigation — react-native-webview
                // hands the URL to Linking.openURL (WebViewShared.js), so the document
                // could open the system browser, or the app's own `postwave` scheme,
                // with no tap. The prop is only consulted on a whitelist HIT, so the
                // whitelist must be permissive and the refusal must live here.
                originWhitelist={["*"]}
                onShouldStartLoadWithRequest={(request) =>
                request.url === "about:blank"
                }
                // The rendered document is third-party HTML; it has no business
                // sharing the app's cookie jar (Android) or the WebView cache.
                thirdPartyCookiesEnabled={false}
                cacheEnabled={false}
                setSupportMultipleWindows={false}
                allowFileAccess={false}
                style={{ backgroundColor: "transparent" }}
              />
            </View>
          ) : (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              The renderer returned nothing for {active.label}.
            </Text>
          )}
        </View>
      ) : null}

      <View
        style={{
          borderTopColor: t.borderSubtle,
          borderTopWidth: 1,
          marginTop: 14,
          paddingTop: 12,
        }}
      >
        <Caption
          text="Cross-client screenshots run through a paid, slow rendering service — they only ever run from this button."
          t={t}
        />
        <View style={{ flexDirection: "row" }}>
          <ActionButton
            label={
              matrix.isPending ? "Rendering screenshots…" : "Render across clients"
            }
            onPress={onMatrix}
            disabled={matrix.isPending || !hasBody}
          />
        </View>
        {matrix.data ? (
          matrix.data.length === 0 ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
                marginTop: 8,
              }}
            >
              The rendering service returned no environments.
            </Text>
          ) : (
            <View style={{ gap: 12, marginTop: 10 }}>
              {matrix.data.map((tile) => (
                <View key={`${tile.name}:${tile.darkMode}`} style={{ gap: 6 }}>
                  <View
                    style={{ flexDirection: "row", gap: 8, alignItems: "center" }}
                  >
                    <Text
                      {...typeCap("bodySmall")}
                      style={{
                        color: t.fg,
                        ...typeStyle("bodySmall"),
                        fontFamily: FONT.semibold,
                      }}
                    >
                      {tile.name}
                    </Text>
                    {tile.darkMode ? <Pill label="Dark" /> : null}
                  </View>
                  {tile.imageUrl ? (
                    <Image
                      source={{ uri: tile.imageUrl }}
                      accessibilityLabel={`Screenshot in ${tile.name}`}
                      resizeMode="contain"
                      style={{
                        width: "100%",
                        height: 260,
                        borderRadius: 8,
                        backgroundColor: t.bgSubtle,
                      }}
                    />
                  ) : null}
                  {tile.issues.map((issue) => (
                    <Text
                      key={issue}
                      {...typeCap("caption")}
                      style={{
                        color: t.warning,
                        ...typeStyle("caption"),
                        fontFamily: FONT.medium,
                      }}
                    >
                      {issue}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          )
        ) : null}
      </View>
    </Card>
  );
}
