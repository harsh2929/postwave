// SPDX-License-Identifier: AGPL-3.0-only
//
// The endpoint editor and the received-events viewer open on demand from an
// endpoint row. The page loads both through this one module, so they arrive
// as a single chunk the first time either opens.
export { InboundEndpointEditDialog } from "@/components/integrations/inbound-endpoint-edit-dialog";
export { InboundEventsDialog } from "@/components/integrations/inbound-events-dialog";
