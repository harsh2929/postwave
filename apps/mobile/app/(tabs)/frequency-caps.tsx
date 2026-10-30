/**
 * Route boundary for the frequency-caps read + toggle surface.
 *
 * See src/components/frequency-caps/FrequencyCapsScreen.tsx for the behaviour
 * and src/lib/frequencyCaps.ts for which of the API's two parallel cap
 * surfaces this targets and why.
 */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { FrequencyCapsScreen } from "@/components/frequency-caps/FrequencyCapsScreen";

export { AppErrorBoundary as ErrorBoundary };

export default function FrequencyCaps() {
  return <FrequencyCapsScreen />;
}
