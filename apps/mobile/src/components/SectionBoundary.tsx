/**
 * SectionBoundary — a boundary one level BELOW the route.
 *
 * Expo Router gives every route module an `ErrorBoundary` export, and that
 * sweep is done: a throw inside a screen now degrades that screen instead of
 * replacing the whole navigator. But several screens are really N independent
 * panels stacked in a ScrollView, each fetching its own endpoint and each
 * parsing its own third-party-shaped payload. At route granularity one bad
 * payload still blanks the other N-1 panels — including, on the More menu, the
 * navigation list that is the only way to leave.
 *
 * So: wrap a panel, name it, and a throw inside it becomes an inline "this part
 * couldn't load" card with a Retry, while everything around it keeps rendering.
 *
 * Three deliberate choices:
 *
 *  - It is a CLASS component. `componentDidCatch` has no hook equivalent;
 *    react-error-boundary is not a dependency here and this is ~60 lines.
 *  - Retry remounts the subtree by bumping a key, and ALSO calls the optional
 *    `onRetry` so a caller can refetch the query whose bad data caused the
 *    throw. Remounting alone would re-render the same cached payload and throw
 *    again, which is a Retry button that lies.
 *  - The error reaches the SAME reporter as a root crash. A contained failure
 *    that nobody is told about is a silent failure, and silent failures are
 *    what made "SDK/envelope response-shape drift" the dominant theme of this
 *    app's audit in the first place.
 */
import { Component, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { captureRootError } from "@/lib/sentry";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { type ThemeTokens } from "@/lib/theme";

export interface SectionBoundaryProps {
  /**
   * What this panel is, in the user's words ("Workspace", "Delivery health").
   * It is spoken and printed, so it must be a noun phrase, not a component
   * name — "OutboundWebhooksSection couldn't load" is not an error message.
   */
  label: string;
  /** Theme tokens, passed in so the boundary never depends on a provider. */
  t: ThemeTokens;
  /** Refetch whatever produced the bad data. Called alongside the remount. */
  onRetry?: (() => void) | undefined;
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Bumped on retry so the subtree genuinely remounts. */
  attempt: number;
}

export class SectionBoundary extends Component<SectionBoundaryProps, State> {
  override state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    captureRootError(error);
  }

  private readonly retry = (): void => {
    this.props.onRetry?.();
    this.setState((prev) => ({ error: null, attempt: prev.attempt + 1 }));
  };

  override render(): ReactNode {
    const { label, t, children } = this.props;
    if (!this.state.error) {
      return <View key={this.state.attempt}>{children}</View>;
    }
    return (
      <View
        accessibilityRole="alert"
        style={{
          marginHorizontal: 12,
          marginBottom: 24,
          padding: 16,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
          gap: 8,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.medium,
          }}
        >
          {label} couldn’t load
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          The rest of this screen still works. This part hit an unexpected
          response and has been reported.
        </Text>
        <Pressable
          onPress={this.retry}
          accessibilityRole="button"
          accessibilityLabel={`Retry loading ${label}`}
          style={{
            alignSelf: "flex-start",
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 16,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: t.border,
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.accent,
              ...typeStyle("callout"),
              fontFamily: FONT.medium,
            }}
          >
            Try again
          </Text>
        </Pressable>
      </View>
    );
  }
}
