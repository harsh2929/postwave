// SPDX-License-Identifier: AGPL-3.0-only
//
// One on-demand chunk for the AEO page's below-the-fold panels. Each panel is
// still loaded through next/dynamic, but importing them from a single module
// lets webpack emit one async chunk instead of four, which keeps the runtime's
// chunk map — paid by every dashboard route — from growing per panel.

export { BrandSetupCard } from "./brand-setup-card";
export { CompetitorBoard } from "./competitor-board";
export { PromptLibrary } from "./prompt-library";
export { ProbeAudit } from "./probe-audit";
