// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

const ReferralsClient = dynamic(() => import("./page-client"), {
  ssr: false,
  loading: () => (
    <div
      role="status"
      aria-busy="true"
      className="mx-auto min-h-48 max-w-6xl p-6 text-sm text-muted-foreground"
    >
      Referrals — Loading the protected referral administration workspace…
    </div>
  ),
});

export default function ReferralsPage() {
  return <ReferralsClient />;
}
