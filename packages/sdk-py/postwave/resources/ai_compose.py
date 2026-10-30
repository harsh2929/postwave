"""AI compose resource — brief -> campaign draft + subject variants.

Both endpoints require the write:campaigns scope at the server.

    POST /api/v1/ai/compose/broadcast   compose_broadcast -> ComposeBroadcastOutput
    POST /api/v1/ai/compose/variants     compose_variants  -> ComposeVariantsOutput
"""

from __future__ import annotations

from typing import Any

from ._base import AsyncResource, SyncResource


class AIComposeResource(SyncResource):
    def compose_broadcast(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Generate a primary draft + subject variants from a brief.

        ``payload`` keys: ``brief`` (required), ``variant_count`` (0-4,
        default 2), ``tone``, ``audience``.
        """
        return self._client.request("POST", "/api/v1/ai/compose/broadcast", body=payload)

    def compose_variants(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Generate additional subject variants for an existing draft.

        ``payload`` keys: ``subject`` (required), ``body``,
        ``variant_count`` (1-5, default 3).
        """
        return self._client.request("POST", "/api/v1/ai/compose/variants", body=payload)


class AsyncAIComposeResource(AsyncResource):
    async def compose_broadcast(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request("POST", "/api/v1/ai/compose/broadcast", body=payload)

    async def compose_variants(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._client.request("POST", "/api/v1/ai/compose/variants", body=payload)
