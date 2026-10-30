"""Error hierarchy for the Moosewave SDK.

Mirrors packages/sdk-ts/src/errors.ts. Every method on the client raises a
subclass of :class:`PostwaveError` so callers can do precise ``except``
matching::

    try:
        pw.subscribers.get(sub_id)
    except postwave.NotFoundError as e:
        ...
"""

from __future__ import annotations

from typing import Any


class PostwaveError(Exception):
    """Base class for every error raised by the SDK."""

    def __init__(
        self,
        message: str,
        *,
        status: int,
        code: str,
        request_id: str | None = None,
        payload: Any | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id
        self.payload = payload

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"{self.__class__.__name__}(status={self.status}, code={self.code!r}, message={str(self)!r})"


class AuthError(PostwaveError):
    """401 — missing or invalid credentials."""


class ForbiddenError(PostwaveError):
    """403 — authenticated but not authorized."""


class NotFoundError(PostwaveError):
    """404 / 410 — resource missing or gone."""


class ConflictError(PostwaveError):
    """409 — state conflict (e.g. slug taken)."""


class ValidationError(PostwaveError):
    """422 — body shape OK but failed validation."""

    def __init__(
        self,
        message: str,
        *,
        status: int = 422,
        code: str,
        request_id: str | None = None,
        payload: Any | None = None,
        fields: list[dict[str, str]] | None = None,
    ) -> None:
        super().__init__(message, status=status, code=code, request_id=request_id, payload=payload)
        self.fields = fields or []


class RateLimitError(PostwaveError):
    """429 — too many requests."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        request_id: str | None = None,
        payload: Any | None = None,
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message, status=429, code=code, request_id=request_id, payload=payload)
        self.retry_after_seconds = retry_after_seconds


class ServerError(PostwaveError):
    """5xx — the server failed to handle the request."""


class AgencyReleaseHeldError(PostwaveError):
    """A structurally unavailable Agency capability; retrying cannot enable it."""

    retryable = False
    committed = False

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message, status=503, code=code)


class NetworkError(PostwaveError):
    """The request never reached (or never got a response from) the API.

    Status is ``0`` because there is no HTTP response — connection refused,
    DNS failure, TLS handshake error, dropped socket, etc.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str = "network_error",
        request_id: str | None = None,
        payload: Any | None = None,
    ) -> None:
        super().__init__(message, status=0, code=code, request_id=request_id, payload=payload)


class TimeoutError(NetworkError):
    """The request exceeded its deadline before a response arrived.

    Subclasses :class:`NetworkError` (status ``0``) so it is catchable via the
    PostwaveError hierarchy — unlike the builtin ``TimeoutError``, which is an
    ``OSError`` and would slip past ``except PostwaveError``.
    """

    def __init__(
        self,
        message: str = "Request timed out",
        *,
        payload: Any | None = None,
    ) -> None:
        super().__init__(message, code="request_timeout", payload=payload)


class RequestAbortedError(NetworkError):
    """The request was cancelled by the caller before it completed."""

    def __init__(
        self,
        message: str = "Request was cancelled",
        *,
        payload: Any | None = None,
    ) -> None:
        super().__init__(message, code="request_aborted", payload=payload)


class AmbiguousConversionIngestSecretIssueError(PostwaveError):
    """A reveal-once issuance may have committed but its response was lost."""

    recovery = (
        "list signing-key metadata, identify any newly issued key ID, revoke it, "
        "then issue a replacement; never retry issuance blindly"
    )

    def __init__(self, message: str, *, payload: Any | None = None) -> None:
        super().__init__(
            message,
            status=0,
            code="ambiguous_conversion_ingest_secret_issue",
            payload=payload,
        )


class ParseError(PostwaveError):
    """The API returned a body that could not be parsed as JSON."""

    def __init__(
        self,
        message: str = "API returned invalid JSON. Please refresh and try again.",
        *,
        status: int = 0,
        request_id: str | None = None,
        payload: Any | None = None,
    ) -> None:
        super().__init__(message, status=status, code="invalid_json", request_id=request_id, payload=payload)


class WrongRegionError(PostwaveError):
    """421 — the tenant's data lives in a different region than the host we hit.

    Carries the canonical SDK host for the tenant's region so callers can
    immediately re-point their client::

        try:
            pw.subscribers.list()
        except postwave.WrongRegionError as e:
            eu = Moosewave(api_key=..., base_url=e.correct_endpoint)
            return eu.subscribers.list()
    """

    def __init__(
        self,
        message: str,
        *,
        code: str,
        correct_endpoint: str = "",
        region: str = "",
        request_id: str | None = None,
        payload: Any | None = None,
    ) -> None:
        super().__init__(message, status=421, code=code, request_id=request_id, payload=payload)
        #: SDK host for the tenant's region, e.g. "https://eu-central-1.api.moosewave.com".
        self.correct_endpoint = correct_endpoint
        #: Tenant's pinned region, e.g. "eu-central-1".
        self.region = region


def map_error(
    status: int,
    body: Any,
    request_id: str | None = None,
    headers: dict[str, str] | None = None,
) -> PostwaveError:
    """Translate an HTTP response into the right SDK error subclass."""
    env = _parse_envelope(body)
    code, message, fields, retry_after = env.code, env.message, env.fields, env.retry_after
    msg = message or f"HTTP {status}"
    cd = code or f"http_{status}"
    req_id = request_id or env.request_id
    common = dict(code=cd, request_id=req_id, payload=body)

    if status == 401:
        return AuthError(msg, status=401, **common)
    if status == 403:
        return ForbiddenError(msg, status=403, **common)
    if status in (404, 410):
        return NotFoundError(msg, status=status, **common)
    if status == 409:
        return ConflictError(msg, status=409, **common)
    if status == 421:
        hdrs = _normalize_headers(headers)
        correct_endpoint = hdrs.get("location") or env.correct_endpoint or ""
        region = hdrs.get("x-postwave-region") or env.region or ""
        return WrongRegionError(
            msg,
            code=cd,
            correct_endpoint=correct_endpoint,
            region=region,
            request_id=req_id,
            payload=body,
        )
    if status == 422:
        return ValidationError(msg, code=cd, request_id=req_id, payload=body, fields=fields)
    if status == 429:
        return RateLimitError(msg, code=cd, request_id=req_id, payload=body, retry_after_seconds=retry_after)
    if status >= 500:
        return ServerError(msg, status=status, **common)
    return PostwaveError(msg, status=status, **common)


class _Envelope:
    __slots__ = ("code", "message", "fields", "retry_after", "request_id", "correct_endpoint", "region")

    def __init__(self) -> None:
        self.code: str | None = None
        self.message: str | None = None
        self.fields: list[dict[str, str]] | None = None
        self.retry_after: float | None = None
        self.request_id: str | None = None
        self.correct_endpoint: str | None = None
        self.region: str | None = None


def _parse_envelope(body: Any) -> _Envelope:
    env = _Envelope()
    if not isinstance(body, dict):
        return env
    err = body.get("error")
    if isinstance(err, str):
        message = body.get("message")
        if isinstance(message, str):
            env.code = err
            env.message = message
        else:
            env.message = err
        return env
    if isinstance(err, dict):
        env.code = err.get("code")
        env.message = err.get("message")
        env.fields = err.get("fields") if isinstance(err.get("fields"), list) else None
        rid = err.get("request_id") or err.get("requestId")
        env.request_id = rid if isinstance(rid, str) else None
        ra = err.get("retry_after_seconds")
        env.retry_after = ra if isinstance(ra, (int, float)) else None
        ce = err.get("correct_endpoint")
        env.correct_endpoint = ce if isinstance(ce, str) else None
        rg = err.get("region")
        env.region = rg if isinstance(rg, str) else None
    return env


def _normalize_headers(headers: dict[str, str] | None) -> dict[str, str]:
    if not headers:
        return {}
    return {str(k).lower(): v for k, v in headers.items()}
