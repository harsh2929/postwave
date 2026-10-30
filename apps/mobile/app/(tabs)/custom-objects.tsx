/**
 * Custom objects — look up a record of a type this workspace defined.
 *
 * WHY THIS ROUTE IS `viewer`. Both reads behind it are viewer in the generated
 * policy manifest: `GET /api/v1/custom-objects/types` and
 * `GET /api/v1/custom-objects/types/{id}/records` are both
 * `session_minimum_role: viewer` / `read:reports`, `review_status: reviewed`,
 * and the mount sites agree (customobjects/handlers.go:47,58 use the `read...`
 * middleware chain). Nothing on this screen writes, so nothing on it needs a
 * higher floor.
 *
 * WHAT IS DELIBERATELY ABSENT. Creating, editing and deleting a TYPE are admin
 * routes and stay on the web admin, per the ledger's recorded reason: changing
 * a definition retypes data across everything that uses it. Record upsert and
 * delete are admin too. Filtering by a property value is absent for a different
 * reason again — the server refuses property filters in a URL because the
 * values are customer data (handlers.go:189-201) — so the phone reads one page
 * and says so.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { CustomObjectsScreen } from "@/components/customobjects/CustomObjectsScreen";

/**
 * Route-scoped boundary. Every value this screen renders came out of a
 * free-form `properties` map written by whatever integration or importer
 * produced the record, so it renders one of the least predictable payloads in
 * the app — a render throw here must cost this tab and not the whole shell.
 */
export { AppErrorBoundary as ErrorBoundary };

export default function CustomObjects() {
  return <CustomObjectsScreen />;
}
