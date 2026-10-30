from __future__ import annotations

import json
from typing import Any, Iterator
from urllib.parse import urlencode

from .. import _http
from ._base import AsyncResource, SyncResource

EventRecord = dict[str, Any]
SubscribeInput = dict[str, Any]
SubscribeResponse = dict[str, Any]


class EventsResource(SyncResource):
    def subscribe(self, payload: SubscribeInput) -> SubscribeResponse:
        return self._client.request(
            "POST",
            "/api/v1/events/subscriptions",
            body=payload,
        )

    def stream_url(self, *, event_type: str | None = None, campaign: str | None = None) -> str:
        query = urlencode({k: v for k, v in {"event_type": event_type, "campaign": campaign}.items() if v})
        suffix = f"?{query}" if query else ""
        return f"{self._client.base_url}/api/v1/events/stream{suffix}"

    def stream(
        self,
        *,
        event_type: str | None = None,
        campaign: str | None = None,
        timeout: float | None = None,
    ) -> Iterator[EventRecord]:
        url, headers, params, _ = _http.build_request(
            method="GET",
            base_url=self._client.base_url,
            path="/api/v1/events/stream",
            api_key=self._client.api_key,
            tenant_id=self._client.tenant_id,
            body=None,
            query={"event_type": event_type, "campaign": campaign},
            extra_headers={"Accept": "text/event-stream"},
        )
        with self._client._http.stream("GET", url, headers=headers, params=params, timeout=timeout) as resp:
            _http.raise_for_response(resp)
            frame: list[str] = []
            for line in resp.iter_lines():
                if line == "":
                    event = _parse_sse_frame(frame)
                    frame = []
                    if event is not None:
                        yield event
                    continue
                frame.append(line)
            event = _parse_sse_frame(frame)
            if event is not None:
                yield event


class AsyncEventsResource(AsyncResource):
    async def subscribe(self, payload: SubscribeInput) -> SubscribeResponse:
        return await self._client.request(
            "POST",
            "/api/v1/events/subscriptions",
            body=payload,
        )

    def stream_url(self, *, event_type: str | None = None, campaign: str | None = None) -> str:
        query = urlencode({k: v for k, v in {"event_type": event_type, "campaign": campaign}.items() if v})
        suffix = f"?{query}" if query else ""
        return f"{self._client.base_url}/api/v1/events/stream{suffix}"

    async def stream(
        self,
        *,
        event_type: str | None = None,
        campaign: str | None = None,
        timeout: float | None = None,
    ):
        url, headers, params, _ = _http.build_request(
            method="GET",
            base_url=self._client.base_url,
            path="/api/v1/events/stream",
            api_key=self._client.api_key,
            tenant_id=self._client.tenant_id,
            body=None,
            query={"event_type": event_type, "campaign": campaign},
            extra_headers={"Accept": "text/event-stream"},
        )
        async with self._client._http.stream("GET", url, headers=headers, params=params, timeout=timeout) as resp:
            _http.raise_for_response(resp)
            frame: list[str] = []
            async for line in resp.aiter_lines():
                if line == "":
                    event = _parse_sse_frame(frame)
                    frame = []
                    if event is not None:
                        yield event
                    continue
                frame.append(line)
            event = _parse_sse_frame(frame)
            if event is not None:
                yield event


def _parse_sse_frame(lines: list[str]) -> EventRecord | None:
    data = []
    for raw in lines:
        line = raw.rstrip("\r")
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            data.append(line[5:].lstrip())
    if not data:
        return None
    try:
        parsed = json.loads("\n".join(data))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None
