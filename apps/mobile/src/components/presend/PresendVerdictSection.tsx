/**
 * PresendVerdictSection — the AI checks the send sheet offers an editor.
 *
 * Two on-demand cards, one gate. POST /api/v1/presend/verdict and
 * POST /api/v1/voice/drift are both write:campaigns at their mount sites
 * (presend/verdict.go:116, main.go:4146) and `editor` in
 * routeauth/manifest.json, so the sheet computes the floor once (`offered`)
 * and this section renders both cards — or neither — behind it. Below the
 * floor nothing is rendered rather than disabled: a button that can only 403
 * is worse than no button.
 *
 * Each card lifts its reading to the sheet through its own callback; the
 * sheet, not this section, decides what a reading does to the Send button
 * (lib/presendVerdictGate, lib/voiceDrift). Nothing here can block a send.
 *
 * ORDER IS LOAD-BEARING. The verdict card mounts before the drift card. The
 * route-test react-query mock captures only the LAST `useMutation` options,
 * and both native suites reach their card through that capture:
 * presend-verdict-send stubs the drift card so the verdict's options are the
 * last captured; voice-drift-presend renders both and relies on the drift
 * card mounting last. Swap them and one suite drives the wrong mutation.
 *
 * Extracted from CampaignSendModal to keep that component under its
 * 300-line function budget (scripts/source-budgets.json).
 */
import { PresendVerdictCard } from "@/components/presend/PresendVerdictCard";
import { VoiceDriftCard } from "@/components/voice/VoiceDriftCard";
import type { PresendVerdictReading } from "@/lib/campaignVerdict";
import type { VoiceDriftReading } from "@/lib/voiceDrift";

export interface PresendVerdictSectionProps {
  /** Editor floor AND online gate, computed once by the sheet. */
  offered: boolean;
  subject: string;
  bodyHtml: string;
  /** What the From header will read; the verdict card extracts the address. */
  fromLine?: string | undefined;
  /** The unified verdict, lifted to the sheet. Null clears it. */
  onVerdict: (reading: PresendVerdictReading | null) => void;
  /** The drift-only reading, lifted to the sheet. Null clears it. */
  onDrift: (reading: VoiceDriftReading | null) => void;
  /** The sheet is mid-send; neither check may race the queue call. */
  disabled: boolean;
}

export function PresendVerdictSection({
  offered,
  subject,
  bodyHtml,
  fromLine,
  onVerdict,
  onDrift,
  disabled,
}: PresendVerdictSectionProps) {
  if (!offered) return null;
  return (
    <>
      <PresendVerdictCard
        subject={subject}
        bodyHtml={bodyHtml}
        fromLine={fromLine}
        onReading={onVerdict}
        disabled={disabled}
      />
      <VoiceDriftCard
        subject={subject}
        bodyHtml={bodyHtml}
        onReading={onDrift}
        disabled={disabled}
      />
    </>
  );
}
