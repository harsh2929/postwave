from __future__ import annotations

from typing import Any, Literal

from ._base import AsyncResource, SyncResource

# What a person decided about an onboarding step.
#
# Whether a step is DONE stays derived server-side by
# GET /api/v1/onboarding-progress, because a stored copy drifts the moment
# someone deletes the thing that completed it. This resource carries the other
# half: what a query cannot recover, because a human decided it.
#
# The five states are a closed vocabulary, enforced again by a CHECK constraint
# in the schema. `skipped` is worth distinguishing from `dismissed` for a reason
# that shows up in the product: one means "not now" and the other means "not
# us", and only the second should stay gone.
OnboardingStepState = Literal["dismissed", "snoozed", "skipped", "inapplicable", "delegated"]


class OnboardingResource(SyncResource):
    """Onboarding decisions, shared across a person's devices.

    These lived in per-device keys, so a user dismissed the checklist on
    desktop, opened the web app, and it was back. Scoped to
    (tenant, user, step) — per-user rather than per-tenant, because one admin
    dismissing a checklist must not hide it from a colleague who has not seen
    it.
    """

    def list_step_decisions(self) -> dict[str, Any]:
        """Every decision this user has recorded, across all their devices.

        An absent step key means no decision was recorded — which is different
        from a decision to dismiss, and callers must not conflate them.
        """
        return self._client.request("GET", "/api/v1/onboarding/steps")

    def set_step_decision(
        self,
        step_key: str,
        state: OnboardingStepState,
        reason: str | None = None,
    ) -> dict[str, Any]:
        """Record one decision.

        Idempotent — deciding the same thing twice is not an error, so a client
        retrying on a flaky connection does not have to care.
        """
        body: dict[str, Any] = {"step_key": step_key, "state": state}
        if reason:
            body["reason"] = reason
        return self._client.request("PUT", "/api/v1/onboarding/steps", body=body)


class AsyncOnboardingResource(AsyncResource):
    """Async mirror of :class:`OnboardingResource`."""

    async def list_step_decisions(self) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/onboarding/steps")

    async def set_step_decision(
        self,
        step_key: str,
        state: OnboardingStepState,
        reason: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"step_key": step_key, "state": state}
        if reason:
            body["reason"] = reason
        return await self._client.request("PUT", "/api/v1/onboarding/steps", body=body)
