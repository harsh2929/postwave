import type { RemoteLoadResult } from "../../hooks/useRemoteResource";
import { api, apiRetentionOffers, winbackSettingsApi } from "../api-client";
import {
  decodeRetentionFunnel,
  decodeRetentionOffers,
  decodeRetentionTiers,
  decodeRetentionWinbackSettings,
  type RetentionContractFailureReason,
  type RetentionFunnelCollection,
  type RetentionOfferCollection,
  type RetentionTierCollection,
  type RetentionWinbackSettings,
} from "../retention-offers-contract";

function contractMessage(
  resource: string,
  reason: RetentionContractFailureReason,
): string {
  switch (reason) {
    case "too-many-records":
      return `${resource} exceeded the verified local record ceiling.`;
    case "count-mismatch":
      return `${resource} reported a count that did not match its records.`;
    case "duplicate-identity":
      return `${resource} contained duplicate record identities.`;
    case "tenant-mismatch":
      return `${resource} contained a record from another workspace.`;
    case "invalid-record":
      return `${resource} contained a record that failed validation.`;
    case "invalid-envelope":
    default:
      return `${resource} did not match the expected response contract.`;
  }
}

function parseFailure(
  resource: string,
  reason: RetentionContractFailureReason,
): RemoteLoadResult<never> {
  return {
    error: {
      kind: "parse",
      code: reason,
      message: contractMessage(resource, reason),
    },
  };
}

export async function loadRetentionOffers(
  expectedTenantId: string,
): Promise<RemoteLoadResult<RetentionOfferCollection>> {
  const response = await apiRetentionOffers.listRetentionOffers();
  if (response.error) return { error: response.error };
  const decoded = decodeRetentionOffers(response.data, {
    expectedTenantId,
  });
  if (!decoded.ok) {
    return parseFailure("Retention offer history", decoded.reason);
  }
  return { data: decoded.data };
}

export async function loadRetentionFunnel(): Promise<
  RemoteLoadResult<RetentionFunnelCollection>
> {
  const response = await apiRetentionOffers.getRetentionOfferFunnel();
  if (response.error) return { error: response.error };
  const decoded = decodeRetentionFunnel(response.data);
  if (!decoded.ok) {
    return parseFailure("Retention funnel history", decoded.reason);
  }
  return { data: decoded.data };
}

export async function loadRetentionTiers(): Promise<
  RemoteLoadResult<RetentionTierCollection>
> {
  const response = await api.listPaywallTiers();
  if (response.error) return { error: response.error };
  const decoded = decodeRetentionTiers(response.data);
  if (!decoded.ok) {
    return parseFailure("Paywall tier names", decoded.reason);
  }
  return { data: decoded.data };
}

export async function loadRetentionWinbackSettings(): Promise<
  RemoteLoadResult<RetentionWinbackSettings>
> {
  const response = await winbackSettingsApi.get();
  if (response.error) return { error: response.error };
  const decoded = decodeRetentionWinbackSettings(response.data);
  if (!decoded.ok) {
    return parseFailure("Stored win-back settings", decoded.reason);
  }
  return { data: decoded.data };
}
