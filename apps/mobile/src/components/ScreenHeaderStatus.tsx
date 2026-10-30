/**
 * ScreenHeaderStatus — the app shell's one persistent state indicator.
 *
 * Two signals that previously existed only in places you had to go looking for:
 *
 *  - VIEWER PREVIEW. `session.viewerMode` was parsed, stored, and read by
 *    nothing. An admin who left the preview on from the desktop app got a
 *    silently read-only mobile app with no explanation. Desktop has shown a
 *    persistent "Viewer preview" badge in its TopBar the whole time.
 *  - CONNECTION. The only representation of "you are on cached data" was a
 *    coloured dot on the More screen's workspace card. OfflineBanner covers
 *    hard-offline; the softer offline_cached / still-checking states had no
 *    chrome at all.
 *
 * THE HAPPY PATH RENDERS NOTHING. A permanently-lit indicator is noise, and
 * chrome that is always on is chrome nobody reads.
 *
 * AT MOST ONE PILL, by design. The header's title has `flex: 1` beside a
 * `flexShrink: 0` action group, so every pixel spent here is taken from the
 * screen title. Viewer preview wins the tie because it changes what the user
 * can DO, whereas staleness already has OfflineBanner and StaleDataBanner
 * carrying it on the data surfaces where it matters.
 */
import { Pill } from "@/components/Pill";
import {
  connectionStatus,
  shouldShowConnectionIndicator,
  type ConnectionTone,
} from "@/lib/connectionStatus";
import {
  VIEWER_BADGE_LABEL,
  VIEWER_BADGE_SPOKEN,
  shouldShowViewerBadge,
} from "@/lib/viewerModePolicy";
import { useAuthStore } from "@/store/auth";

/** ConnectionTone is a subset of PillTone; this keeps the mapping explicit. */
function pillTone(tone: ConnectionTone) {
  return tone;
}

export function ScreenHeaderStatus() {
  const mode = useAuthStore((s) => s.mode);
  const sessionValidation = useAuthStore((s) => s.sessionValidation);
  const viewerMode = useAuthStore((s) => Boolean(s.session?.viewerMode));

  if (shouldShowViewerBadge({ mode, viewerMode })) {
    return (
      <Pill
        label={VIEWER_BADGE_LABEL}
        tone="warning"
        // The visible label is two words; the spoken one has to carry the
        // consequence, because "Viewer preview" alone does not explain why
        // every write control disappeared.
        accessibilityLabel={VIEWER_BADGE_SPOKEN}
      />
    );
  }

  const status = connectionStatus({ mode, sessionValidation });
  if (!shouldShowConnectionIndicator(status)) return null;
  return (
    <Pill
      label={status.label}
      tone={pillTone(status.tone)}
      accessibilityLabel={status.spoken}
    />
  );
}
