/**
 * TemplateRenderedPreview — see the design itself, not a sentence about it.
 *
 * The sheet's own header calls browsing-a-shelf the job a phone is best at,
 * then described the body in words. Desktop's TemplateDetailSlideover renders
 * it in an iframe with device-width + light/dark toggles; this is the mobile
 * port: the pure half (lockdown CSP + viewport + dark ground) lives in
 * lib/templateRenderPreview, and the WebView here additionally disables JS —
 * the CSP is the second lock.
 *
 * Client-side render only — the body arrives on the same
 * GET /campaign-templates/{id} (viewer) the sheet already reads; no server
 * round trip is added, so this works for exactly whoever can open the sheet.
 */
import { useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";

import { SegmentedControl } from "@/components/SegmentedControl";
import {
  TEMPLATE_PREVIEW_MODES,
  templateHasRenderableBody,
  templatePreviewDocument,
  type TemplatePreviewMode,
  type TemplatePreviewScheme,
} from "@/lib/templateRenderPreview";
import { useTheme } from "@/lib/theme";

export function TemplateRenderedPreview({
  bodyHtml,
}: {
  bodyHtml: string | null | undefined;
}) {
  const { t } = useTheme();
  const [modeId, setModeId] = useState<TemplatePreviewMode["id"]>("mobile");
  const [scheme, setScheme] = useState<TemplatePreviewScheme>("light");

  if (!templateHasRenderableBody(bodyHtml)) return null;
  const mode = TEMPLATE_PREVIEW_MODES.find((m) => m.id === modeId)!;

  return (
    <View style={{ gap: 8, marginTop: 12 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <SegmentedControl<TemplatePreviewMode["id"]>
            options={TEMPLATE_PREVIEW_MODES.map((m) => ({
              value: m.id,
              label: m.label,
            }))}
            value={modeId}
            onChange={setModeId}
            accessibilityLabel="Preview device width"
          />
        </View>
        <View style={{ flex: 1 }}>
          <SegmentedControl<TemplatePreviewScheme>
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            value={scheme}
            onChange={setScheme}
            accessibilityLabel="Preview color scheme"
          />
        </View>
      </View>
      <View
        accessible
        accessibilityLabel={`Rendered template preview, ${mode.label} width, ${scheme} scheme`}
        style={{
          height: 380,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <WebView
          source={{
            html: templatePreviewDocument(bodyHtml ?? "", mode, scheme),
          }}
          // Template bodies are stored HTML: no scripts, ever. The injected
          // CSP (lib/campaignRenderPreview) is the second lock.
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
    </View>
  );
}
