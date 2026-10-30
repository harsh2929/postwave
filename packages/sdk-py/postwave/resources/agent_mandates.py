"""Session-only agent mandate grant, review, and revocation operations.

These routes intentionally reject API keys. A mandate must trace to the
signed-in person who granted it; a key that could mint its own mandate would
not be a meaningful authority boundary. Use a ``Moosewave``/``AsyncPostwave``
client backed by an authenticated session cookie.
"""

from __future__ import annotations

from typing import TypedDict, cast
from urllib.parse import quote

from ._base import AsyncResource, SyncResource


class _AgentMandateSummaryOptional(TypedDict, total=False):
    last_used_at: str | None
    revoked_at: str | None


class AgentMandateSummary(_AgentMandateSummaryOptional):
    """Historical mandate metadata; the bearer token is never returned here."""

    id: str
    purpose: str
    actions: list[str]
    resources: list[str]
    uses_remaining: int
    expires_at: str


class AgentMandateList(TypedDict):
    data: list[AgentMandateSummary]


class AgentMandateGrant(TypedDict):
    purpose: str
    actions: list[str]
    resources: list[str]
    uses: int
    ttl_seconds: int


class AgentMandateMinted(TypedDict):
    """Reveal-once create response; ``token`` cannot be retrieved later."""

    id: str
    token: str
    expires_at: str
    uses: int
    notice: str


class AgentMandateRevocation(TypedDict):
    revoked: bool


def _mandate_path(mandate_id: str) -> str:
    if not isinstance(mandate_id, str) or not mandate_id:
        raise ValueError("agent mandate id is required")
    return f"/api/v1/agent-mandates/{quote(mandate_id, safe='')}"


class AgentMandatesResource(SyncResource):
    """The operator-facing, session-only agent authority register."""

    def list(self) -> AgentMandateList:
        """Return active, spent, expired, and revoked mandates newest first."""

        return cast(
            AgentMandateList,
            self._client.request("GET", "/api/v1/agent-mandates"),
        )

    def create(self, grant: AgentMandateGrant) -> AgentMandateMinted:
        """Mint a mandate; capture the returned bearer token immediately."""

        return cast(
            AgentMandateMinted,
            self._client.request("POST", "/api/v1/agent-mandates", body=grant),
        )

    def revoke(self, mandate_id: str) -> AgentMandateRevocation:
        """Ensure the mandate is unusable; already-off IDs also return success."""

        return cast(
            AgentMandateRevocation,
            self._client.request("DELETE", _mandate_path(mandate_id)),
        )


class AsyncAgentMandatesResource(AsyncResource):
    async def list(self) -> AgentMandateList:
        return cast(
            AgentMandateList,
            await self._client.request("GET", "/api/v1/agent-mandates"),
        )

    async def create(self, grant: AgentMandateGrant) -> AgentMandateMinted:
        return cast(
            AgentMandateMinted,
            await self._client.request(
                "POST",
                "/api/v1/agent-mandates",
                body=grant,
            ),
        )

    async def revoke(self, mandate_id: str) -> AgentMandateRevocation:
        return cast(
            AgentMandateRevocation,
            await self._client.request("DELETE", _mandate_path(mandate_id)),
        )
