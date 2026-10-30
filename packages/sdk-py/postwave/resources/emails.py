"""Transactional email — fire a single message (or a batch) from your app."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ._base import AsyncResource, SyncResource


def _build_body(
    *,
    to: str | list[str],
    subject: str,
    from_: str | None,
    html: str | None,
    text: str | None,
    cc: str | list[str] | None,
    bcc: str | list[str] | None,
    reply_to: str | list[str] | None,
    headers: dict[str, str] | None,
    tags: list[dict[str, str]] | None,
    attachments: list[dict[str, Any]] | None,
    scheduled_at: str | None,
) -> dict[str, Any]:
    if not html and not text:
        raise ValueError("send requires html or text")
    body: dict[str, Any] = {"to": to, "subject": subject}
    if from_ is not None:
        body["from"] = from_
    for key, val in (
        ("html", html), ("text", text), ("cc", cc), ("bcc", bcc),
        ("reply_to", reply_to), ("headers", headers), ("tags", tags),
        ("attachments", attachments), ("scheduled_at", scheduled_at),
    ):
        if val is not None:
            body[key] = val
    return body


class EmailsResource(SyncResource):
    def send(
        self,
        *,
        to: str | list[str],
        subject: str,
        from_: str | None = None,
        html: str | None = None,
        text: str | None = None,
        cc: str | list[str] | None = None,
        bcc: str | list[str] | None = None,
        reply_to: str | list[str] | None = None,
        headers: dict[str, str] | None = None,
        tags: list[dict[str, str]] | None = None,
        attachments: list[dict[str, Any]] | None = None,
        scheduled_at: str | None = None,
    ) -> dict[str, Any]:
        return self._client.request("POST", "/api/v1/emails", body=_build_body(
            to=to, subject=subject, from_=from_, html=html, text=text, cc=cc, bcc=bcc,
            reply_to=reply_to, headers=headers, tags=tags, attachments=attachments, scheduled_at=scheduled_at,
        ))

    def send_batch(self, emails: list[dict[str, Any]]) -> dict[str, Any]:
        return self._client.request("POST", "/api/v1/emails/batch", body={"emails": emails})

    def get(self, email_id: str) -> dict[str, Any]:
        return self._client.request("GET", f"/api/v1/emails/{quote(email_id, safe='')}")

    def list(self, *, limit: int | None = None) -> dict[str, Any]:
        return self._client.request("GET", "/api/v1/emails", query={"limit": limit} if limit else None)


class AsyncEmailsResource(AsyncResource):
    async def send(
        self,
        *,
        to: str | list[str],
        subject: str,
        from_: str | None = None,
        html: str | None = None,
        text: str | None = None,
        cc: str | list[str] | None = None,
        bcc: str | list[str] | None = None,
        reply_to: str | list[str] | None = None,
        headers: dict[str, str] | None = None,
        tags: list[dict[str, str]] | None = None,
        attachments: list[dict[str, Any]] | None = None,
        scheduled_at: str | None = None,
    ) -> dict[str, Any]:
        return await self._client.request("POST", "/api/v1/emails", body=_build_body(
            to=to, subject=subject, from_=from_, html=html, text=text, cc=cc, bcc=bcc,
            reply_to=reply_to, headers=headers, tags=tags, attachments=attachments, scheduled_at=scheduled_at,
        ))

    async def send_batch(self, emails: list[dict[str, Any]]) -> dict[str, Any]:
        return await self._client.request("POST", "/api/v1/emails/batch", body={"emails": emails})

    async def get(self, email_id: str) -> dict[str, Any]:
        return await self._client.request("GET", f"/api/v1/emails/{quote(email_id, safe='')}")

    async def list(self, *, limit: int | None = None) -> dict[str, Any]:
        return await self._client.request("GET", "/api/v1/emails", query={"limit": limit} if limit else None)
