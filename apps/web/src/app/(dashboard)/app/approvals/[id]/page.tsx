// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from "next/navigation";

import { isSafeResourceId } from "@postwave/route-map";
import { ApprovalDetailClient } from "./approval-detail-client";

export default async function ApprovalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isSafeResourceId(id)) redirect("/app/approvals");
  return <ApprovalDetailClient id={id} />;
}
