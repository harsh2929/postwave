/**
 * CardBoundary — isolates one card so a bad render cannot take the screen down.
 *
 * The app's only error boundary is mounted at the ROOT (app/_layout.tsx), which
 * is the right place for "the app crashed" but the wrong granularity for a
 * dashboard: a single malformed series, an unexpected audit shape or an
 * anomaly row with a hostile value would blank the entire app rather than the
 * one card that could not cope. That trade gets worse the more chart cards a
 * screen carries, which is exactly the direction this surface is going.
 *
 * The fallback is deliberately small and factual — it names the card that
 * failed and leaves the rest of the screen intact. It does not offer a retry:
 * re-rendering the same props would fail the same way, and a button that
 * reliably does nothing is worse than no button.
 */
import { Component, type ReactNode } from "react";
import { Text, View } from "react-native";

import { captureRootError } from "@/lib/sentry";
import { typeCap, typeStyle } from "@/lib/typeScale";

interface Props {
  /** Names the failing region in the fallback and in the report. */
  label: string;
  children: ReactNode;
  /** Theme surface colours, passed in so the boundary itself has no hooks. */
  colors: { surface: string; border: string; text: string };
}

interface State {
  failed: boolean;
}

export class CardBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    // Routed through lib/sentry, which applies the app's redaction rules.
    captureRootError(error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { colors, label } = this.props;
    return (
      <View
        accessibilityRole="alert"
        accessibilityLabel={`${label} could not be displayed. The rest of this screen is unaffected.`}
        style={{
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 14,
          padding: 14,
        }}
      >
        {/* `typeStyle` / `typeCap` are plain functions, not hooks, so the
            boundary keeps its no-hooks property. */}
        <Text
          {...typeCap("bodySmall")}
          style={{ color: colors.text, ...typeStyle("bodySmall") }}
        >
          {label} couldn&apos;t be displayed. Everything else on this screen is
          unaffected.
        </Text>
      </View>
    );
  }
}
