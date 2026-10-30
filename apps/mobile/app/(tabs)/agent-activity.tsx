/**
 * Agent activity — advisory, best-effort recorder observations.
 *
 * A MONITOR, NOT A CONSOLE. The desktop's `apps/desktop/src/pages/MCP.tsx` is
 * three tabs: Setup (client config plus scoped API-key minting), Tools (the
 * bundled catalogue) and History. Setup must never port — it renders a
 * plaintext credential whose only destination is a config file on a developer
 * machine — and the catalogue is a static document. History is the part with an
 * operations question in it. This mobile view can surface retained failures
 * for investigation, but it cannot establish complete traffic or verified MCP
 * origin from the recorder's caller-controlled labels.
 *
 * ROLE. Owner/admin, read off the HANDLER rather than the manifest, because
 * here the two disagree. `MountAPIKeyCallRoutes`
 * (apps/api/internal/server/identity_api.go:111-120) applies
 * `apikeys.RequireScope(apikeys.ScopeAdmin)` to every /api/v1/mcp/* route,
 * including the three reads this screen makes; `ScopeAdmin` is not in
 * `readOnlyScopes` (apps/api/internal/apikeys/middleware.go:332-337), so the
 * session path lands in `sessionRoleAllowsScopes` (:300-318) and admits owner
 * and admin only. The generated routeauth manifest lists the same paths as
 * `session_minimum_role: viewer`, but every one of those rows carries
 * `policy_source: safe-default:read` with `review_status: fail_closed_default`
 * — auto-generated from the HTTP verb and never checked against the handler.
 * The handler's own file comment agrees (apikeycalls/handlers.go:10-12). Both
 * guards run; the stricter one decides, and it is the handler.
 */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { McpActivityScreen } from "@/components/mcp/McpActivityScreen";

/**
 * Route-scoped boundary. The execution log renders whatever `path`, `toolName`
 * and `errorCode` the recorder captured from a third-party agent, so a render
 * crash on an unexpected shape must cost this tab and not the app shell.
 */
export { AppErrorBoundary as ErrorBoundary };

export default function AgentActivity() {
  return <McpActivityScreen />;
}
