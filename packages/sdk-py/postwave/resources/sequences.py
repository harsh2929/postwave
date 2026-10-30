from __future__ import annotations

import asyncio
import time
from typing import Any
from urllib.parse import quote

from ._base import AsyncResource, SyncResource
from ..errors import TimeoutError as PostwaveTimeoutError
from ..types.voice import GeneratedEmail, GenerateRequest, RegenerateRequest, Sequence


def sequence_position_path(position: int) -> str:
    if isinstance(position, bool) or not isinstance(position, int) or position < 1:
        raise ValueError("Sequence email position must be a positive integer")
    return str(position)


def sequence_if_match(expected_version: int) -> str:
    """Return the canonical strong ETag for a confirmed sequence revision."""
    if (
        isinstance(expected_version, bool)
        or not isinstance(expected_version, int)
        or expected_version < 1
    ):
        raise ValueError("Sequence expected_version must be a positive integer")
    return f'"{expected_version}"'


class SequencesResource(SyncResource):
    def list(self) -> list[Sequence]:
        return [Sequence.model_validate(p) for p in self._client.request("GET", "/api/v1/voice/sequences")]

    def get(self, sequence_id: str) -> Sequence:
        return Sequence.model_validate(
            self._client.request("GET", f"/api/v1/voice/sequences/{quote(sequence_id, safe='')}")
        )

    def generate(self, req: GenerateRequest | dict) -> Sequence:
        body = req.model_dump(exclude_none=True) if isinstance(req, GenerateRequest) else req
        return Sequence.model_validate(self._client.request("POST", "/api/v1/voice/sequences", body=body))

    def regenerate(self, sequence_id: str, position: int, req: RegenerateRequest | dict | None = None) -> GeneratedEmail:
        body: dict
        if req is None:
            body = {}
        elif isinstance(req, RegenerateRequest):
            body = req.model_dump(exclude_none=True)
        else:
            body = req
        return GeneratedEmail.model_validate(
            self._client.request(
                "POST",
                f"/api/v1/voice/sequences/{quote(sequence_id, safe='')}/regenerate/{sequence_position_path(position)}",
                body=body,
            )
        )

    def update(
        self,
        sequence_id: str,
        payload: dict[str, Any],
        *,
        expected_version: int,
    ) -> Sequence:
        return Sequence.model_validate(
            self._client.request(
                "PATCH",
                f"/api/v1/voice/sequences/{quote(sequence_id, safe='')}",
                body=payload,
                headers={"If-Match": sequence_if_match(expected_version)},
            )
        )

    def delete(self, sequence_id: str, *, expected_version: int) -> None:
        self._client.request(
            "DELETE",
            f"/api/v1/voice/sequences/{quote(sequence_id, safe='')}",
            headers={"If-Match": sequence_if_match(expected_version)},
        )
        return None

    def get_job(self, job_id: str) -> dict[str, Any]:
        """Poll a sequence-generation job (async-mode response from generate())."""
        return self._client.request("GET", f"/api/v1/voice/sequences/jobs/{quote(job_id, safe='')}")

    def wait_for_job(self, job_id: str, *, interval_s: float = 2.0, timeout_s: float = 300.0) -> dict[str, Any]:
        """Block until the job hits a terminal state (succeeded / failed)
        or timeout_s elapses. Constant interval; matches the TS SDK's
        waitForJob shape.
        """
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            job = self.get_job(job_id)
            if job.get("status") in ("succeeded", "failed"):
                return job
            time.sleep(interval_s)
        raise PostwaveTimeoutError(f"sequences.wait_for_job({job_id}): timed out after {timeout_s}s")


class AsyncSequencesResource(AsyncResource):
    async def list(self) -> list[Sequence]:
        rows = await self._client.request("GET", "/api/v1/voice/sequences")
        return [Sequence.model_validate(p) for p in rows]

    async def get(self, sequence_id: str) -> Sequence:
        return Sequence.model_validate(
            await self._client.request("GET", f"/api/v1/voice/sequences/{quote(sequence_id, safe='')}")
        )

    async def generate(self, req: GenerateRequest | dict) -> Sequence:
        body = req.model_dump(exclude_none=True) if isinstance(req, GenerateRequest) else req
        return Sequence.model_validate(await self._client.request("POST", "/api/v1/voice/sequences", body=body))

    async def regenerate(self, sequence_id: str, position: int, req: RegenerateRequest | dict | None = None) -> GeneratedEmail:
        body: dict
        if req is None:
            body = {}
        elif isinstance(req, RegenerateRequest):
            body = req.model_dump(exclude_none=True)
        else:
            body = req
        return GeneratedEmail.model_validate(
            await self._client.request(
                "POST",
                f"/api/v1/voice/sequences/{quote(sequence_id, safe='')}/regenerate/{sequence_position_path(position)}",
                body=body,
            )
        )

    async def update(
        self,
        sequence_id: str,
        payload: dict[str, Any],
        *,
        expected_version: int,
    ) -> Sequence:
        return Sequence.model_validate(
            await self._client.request(
                "PATCH",
                f"/api/v1/voice/sequences/{quote(sequence_id, safe='')}",
                body=payload,
                headers={"If-Match": sequence_if_match(expected_version)},
            )
        )

    async def delete(self, sequence_id: str, *, expected_version: int) -> None:
        await self._client.request(
            "DELETE",
            f"/api/v1/voice/sequences/{quote(sequence_id, safe='')}",
            headers={"If-Match": sequence_if_match(expected_version)},
        )
        return None

    async def get_job(self, job_id: str) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/voice/sequences/jobs/{quote(job_id, safe='')}")

    async def wait_for_job(self, job_id: str, *, interval_s: float = 2.0, timeout_s: float = 300.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            job = await self.get_job(job_id)
            if job.get("status") in ("succeeded", "failed"):
                return job
            await asyncio.sleep(interval_s)
        raise PostwaveTimeoutError(f"sequences.wait_for_job({job_id}): timed out after {timeout_s}s")
