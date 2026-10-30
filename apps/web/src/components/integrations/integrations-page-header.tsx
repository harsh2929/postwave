// SPDX-License-Identifier: AGPL-3.0-only
//
// One header treatment for every route in the integrations cluster (INTG-047):
// a lucide icon + editorial (font-display) title + muted description, with an
// optional right-hand actions slot. Replaces the four divergent hand-rolled
// headers so the cluster reads as one product.
import type { LucideIcon } from "lucide-react";

import { DashboardPageHeader } from "@/components/dashboard/page-header";

export function IntegrationsPageHeader({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <DashboardPageHeader
      eyebrow="Connected workspace"
      title={title}
      description={description}
      icon={<Icon className="size-5" />}
      actions={actions}
      tone="yellow"
    />
  );
}
