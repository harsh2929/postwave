// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Comparison review in progress | Moosewave",
  description:
    "Third-party comparison pages are unavailable until their dated claims pass publication review.",
  robots: { index: false, follow: false, nocache: true },
};

export default function UnreviewedComparisonLayout(): never {
  notFound();
}
