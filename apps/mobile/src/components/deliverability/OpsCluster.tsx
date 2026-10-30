/**
 * OpsCluster — the recovery / evidence / policy cards added in the 2026-08
 * desktop-parity pass, composed in incident order below HubDiagnostics:
 *
 *   1. Is the bad news still arriving?      WebhookErrorsCard
 *   2. What is containment doing?           AutoSuppressCard, SpamTrapGuardCard,
 *                                           SoftBounceRecoveryCard, IntelligentRetryCard
 *   3. Evidence lookups (press-driven)      AuthChecksCard, CampaignPlacementCard,
 *                                           FeedbackTrailCard, EqScoreCard, BotOpensCard
 *   4. Configuration & education            ProvidersCard, VerificationPolicyCard,
 *                                           ControlPanelCard, HygienePlaybooksCard
 *
 * Each card owns its read, its role gate and its failure copy; the cluster
 * only fixes the order so the screen file stays inside its source budget.
 */
import { View } from "react-native";

import { AuthChecksCard } from "@/components/deliverability/AuthChecksCard";
import { AutoSuppressCard } from "@/components/deliverability/AutoSuppressCard";
import { BotOpensCard } from "@/components/deliverability/BotOpensCard";
import { CampaignPlacementCard } from "@/components/deliverability/CampaignPlacementCard";
import { ControlPanelCard } from "@/components/deliverability/ControlPanelCard";
import { EqScoreCard } from "@/components/deliverability/EqScoreCard";
import { FeedbackTrailCard } from "@/components/deliverability/FeedbackTrailCard";
import { HygienePlaybooksCard } from "@/components/deliverability/HygienePlaybooksCard";
import { IntelligentRetryCard } from "@/components/deliverability/IntelligentRetryCard";
import { ProvidersCard } from "@/components/deliverability/ProvidersCard";
import { SpamTrapGuardCard } from "@/components/deliverability/SpamTrapGuardCard";
import { SoftBounceRecoveryCard } from "@/components/deliverability/SoftBounceRecoveryCard";
import { VerificationPolicyCard } from "@/components/deliverability/VerificationPolicyCard";
import { WebhookErrorsCard } from "@/components/deliverability/WebhookErrorsCard";

export function OpsCluster() {
  return (
    <View>
      <WebhookErrorsCard />
      <AutoSuppressCard />
      <SpamTrapGuardCard />
      <SoftBounceRecoveryCard />
      <IntelligentRetryCard />
      <AuthChecksCard />
      <CampaignPlacementCard />
      <FeedbackTrailCard />
      <EqScoreCard />
      <BotOpensCard />
      <ProvidersCard />
      <VerificationPolicyCard />
      <ControlPanelCard />
      <HygienePlaybooksCard />
    </View>
  );
}
