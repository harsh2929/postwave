"""sequences.wait_for_job timeout raises the SDK's TimeoutError (not the builtin).

The resource polls a generation job until it reaches a terminal state. On
timeout it must raise postwave.TimeoutError so callers can catch it via the
PostwaveError hierarchy (the builtin TimeoutError is an OSError and escapes
``except PostwaveError``).
"""

from __future__ import annotations

import pytest

from postwave import PostwaveError, TimeoutError
from postwave.resources.sequences import AsyncSequencesResource, SequencesResource


class _StubSyncClient:
    """Always returns a non-terminal job so wait_for_job times out."""

    def request(self, method, path, **kwargs):
        return {"status": "running"}


class _StubAsyncClient:
    async def request(self, method, path, **kwargs):
        return {"status": "running"}


def test_sync_wait_for_job_raises_sdk_timeout_error():
    res = SequencesResource(_StubSyncClient())
    with pytest.raises(TimeoutError) as exc:
        res.wait_for_job("job_1", interval_s=0.0, timeout_s=0.0)
    # Must be catchable as a PostwaveError, unlike the builtin TimeoutError.
    assert isinstance(exc.value, PostwaveError)
    assert "job_1" in str(exc.value)


async def test_async_wait_for_job_raises_sdk_timeout_error():
    res = AsyncSequencesResource(_StubAsyncClient())
    with pytest.raises(TimeoutError) as exc:
        await res.wait_for_job("job_2", interval_s=0.0, timeout_s=0.0)
    assert isinstance(exc.value, PostwaveError)
    assert "job_2" in str(exc.value)
