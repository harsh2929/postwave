// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";

import { PrivacyIncidentDetailClient } from "./privacy-incident-detail-client";

const INCIDENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export default async function PrivacyIncidentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!INCIDENT_ID.test(id)) redirect("/app/privacy-incidents");
  return <PrivacyIncidentDetailClient incidentId={id} />;
}
