// SPDX-License-Identifier: AGPL-3.0-only

import type { DiscoveryReport } from "@/lib/types";

export function hubSpotDiscoveryIdentitySummary(
  discovery: DiscoveryReport,
): Array<[string, number]> {
  return [
    [
      "Contacts without a valid primary email (not imported)",
      discovery.profiles_without_email_count ?? 0,
    ],
    [
      "Additional email identities (review only)",
      discovery.additional_email_identities_count ?? 0,
    ],
  ];
}
