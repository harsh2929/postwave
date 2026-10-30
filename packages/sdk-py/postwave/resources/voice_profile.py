from __future__ import annotations

from ._base import AsyncResource, SyncResource
from ._generic import q
from ..types.voice import RegisterVoiceSource, VoiceProfile, VoiceSource


class VoiceProfileResource(SyncResource):
    def get(self) -> VoiceProfile:
        return VoiceProfile.model_validate(self._client.request("GET", "/api/v1/voice/profile"))

    def build(self) -> VoiceProfile:
        return VoiceProfile.model_validate(self._client.request("POST", "/api/v1/voice/profile/build"))

    def list_sources(self) -> list[VoiceSource]:
        return [VoiceSource.model_validate(p) for p in self._client.request("GET", "/api/v1/voice/sources")]

    def add_source(self, src: RegisterVoiceSource | dict) -> dict[str, str]:
        body = src.model_dump() if isinstance(src, RegisterVoiceSource) else src
        return self._client.request("POST", "/api/v1/voice/sources", body=body)

    def ingest_source(self, source_id: str) -> dict[str, str]:
        return self._client.request("POST", f"/api/v1/voice/sources/{q(source_id)}/ingest")

    def remove_source(self, source_id: str) -> None:
        self._client.request("DELETE", f"/api/v1/voice/sources/{q(source_id)}")


class AsyncVoiceProfileResource(AsyncResource):
    async def get(self) -> VoiceProfile:
        return VoiceProfile.model_validate(await self._client.request("GET", "/api/v1/voice/profile"))

    async def build(self) -> VoiceProfile:
        return VoiceProfile.model_validate(await self._client.request("POST", "/api/v1/voice/profile/build"))

    async def list_sources(self) -> list[VoiceSource]:
        rows = await self._client.request("GET", "/api/v1/voice/sources")
        return [VoiceSource.model_validate(p) for p in rows]

    async def add_source(self, src: RegisterVoiceSource | dict) -> dict[str, str]:
        body = src.model_dump() if isinstance(src, RegisterVoiceSource) else src
        return await self._client.request("POST", "/api/v1/voice/sources", body=body)

    async def ingest_source(self, source_id: str) -> dict[str, str]:
        return await self._client.request("POST", f"/api/v1/voice/sources/{q(source_id)}/ingest")

    async def remove_source(self, source_id: str) -> None:
        await self._client.request("DELETE", f"/api/v1/voice/sources/{q(source_id)}")
