/**
 * Warehouse syncs — did last night's run land, and if not, what broke.
 *
 * A MONITOR, NOT A CONSOLE, AND THAT IS THE WHOLE DESIGN. The desktop's
 * `apps/desktop/src/pages/DataPlatform.tsx` is five tabs of schema authoring:
 * connection credentials, a pre-save validator, import mappings, custom object
 * types and a CDP transform playground. None of that ports — it is long
 * strings, column pickers and JSON, and a phone is the wrong device for every
 * one of them. What does port is the nightly question, because the cost of a
 * 03:00 export failure is entirely the hours before somebody notices.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT OFFER: creating or editing a
 * connection, editing an import mapping, starting a run, or re-activating a
 * paused connection. The first three are authoring. The fourth is the honest
 * asymmetry of a safety control — the app can stop a broken pipeline from
 * running again tonight, and cannot restart one, because restarting is a
 * decision that wants the configuration in front of you.
 *
 * ROLE. Owner/admin only, and NOT because of the per-route scope. The
 * warehouse routes are mounted behind `apikeys.RequireScope(ScopeReadReports)`
 * (apps/api/internal/warehouse/warehouse.go:196-198), which admits any session
 * role — but the whole authenticated group also runs `routeauth.Middleware`
 * (apps/api/main.go:2247, warehouse mounted inside it at :3539), and every
 * `/api/v1/warehouse/*` row in `apps/api/internal/routeauth/manifest.json`
 * carries `"session_minimum_role": "admin"` with `"review_status":
 * "reviewed"`. `roleAllows` (routeauth/middleware.go:94) is a plain rank check
 * with no custom-role escape hatch, and `ValidateRouterExact` fails startup if
 * an authenticated route skips the middleware. Both guards run; the stricter
 * one wins.
 */
import { View } from "react-native";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { StreamingExportsDock } from "@/components/warehouse/StreamingExportsDock";
import { WarehouseRunsScreen } from "@/components/warehouse/WarehouseRunsScreen";

/**
 * Route-scoped boundary. Warehouse payloads are the widest-shaped in the
 * product — a `metrics` blob that carries per-provider manifests, Snowflake
 * job plans and storage artefacts — so a render crash on an unexpected shape
 * must cost this tab and not the app shell.
 */
export { AppErrorBoundary as ErrorBoundary };

/**
 * The streaming-export dock sits BESIDE the batch screen, not inside it: the
 * screen owns its ScrollView, and the dock renders nothing at all unless the
 * workspace has a `streaming_export` connection (P2.38 — the same "did it
 * land" question for windows shipped on a cadence rather than nightly).
 */
export default function WarehouseRuns() {
  return (
    <View style={{ flex: 1 }}>
      <WarehouseRunsScreen />
      <StreamingExportsDock />
    </View>
  );
}
