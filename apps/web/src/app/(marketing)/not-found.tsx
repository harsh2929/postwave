// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { MarketingNotFoundContent } from "@/components/marketing/not-found-content";

export const metadata: Metadata = {
  title: "Page not found | Moosewave",
  robots: { index: false, follow: true },
};

// Rendered inside the marketing layout (header, banner, footer, cookie
// banner), so a notFound() thrown anywhere in the marketing tree stays in the
// marketing experience rather than falling through to the app 404.
export default function MarketingNotFound(): JSX.Element {
  return <MarketingNotFoundContent />;
}
