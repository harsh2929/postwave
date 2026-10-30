"""Resource base classes.

Each resource file declares a sync class taking a :class:`Moosewave` and an
async class taking an :class:`AsyncPostwave`. We avoid a fancy generic
metaclass — two thin base classes are easier to read.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..client import AsyncPostwave, Moosewave


class SyncResource:
    def __init__(self, client: "Moosewave") -> None:
        self._client = client


class AsyncResource:
    def __init__(self, client: "AsyncPostwave") -> None:
        self._client = client
