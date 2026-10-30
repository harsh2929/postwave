// SPDX-License-Identifier: AGPL-3.0-only
//
// Fail-closed affiliate workspace. The corresponding admin API is deliberately
// not mounted, so this route must remain a static status surface: no affiliate
// client imports, record reads, or operational controls.
import { AffiliateProgramUnavailable } from "./_components/affiliate-program-unavailable";

export default function AffiliatesPage() {
  return <AffiliateProgramUnavailable />;
}
