from __future__ import annotations

from ._base import AsyncResource, SyncResource
from ._generic import q
from ..types.forms import Form, FormCreateInput, FormListItem, FormUpdateInput, Submission


class FormsResource(SyncResource):
    def list(self) -> list[FormListItem]:
        return [FormListItem.model_validate(p) for p in self._client.request("GET", "/api/v1/forms")]

    def get(self, form_id: str) -> Form:
        return Form.model_validate(self._client.request("GET", f"/api/v1/forms/{q(form_id)}"))

    def create(self, payload: FormCreateInput | dict) -> Form:
        body = payload.model_dump(by_alias=True, exclude_none=True) if isinstance(payload, FormCreateInput) else payload
        return Form.model_validate(self._client.request("POST", "/api/v1/forms", body=body))

    def update(self, form_id: str, patch: FormUpdateInput | dict) -> Form:
        body = patch.model_dump(by_alias=True, exclude_none=True) if isinstance(patch, FormUpdateInput) else patch
        return Form.model_validate(self._client.request("PATCH", f"/api/v1/forms/{q(form_id)}", body=body))

    def delete(self, form_id: str) -> dict:
        return self._client.request("DELETE", f"/api/v1/forms/{q(form_id)}")

    def list_submissions(self, form_id: str) -> list[Submission]:
        return [Submission.model_validate(p) for p in self._client.request("GET", f"/api/v1/forms/{q(form_id)}/submissions")]

    def export_submissions_csv(self, form_id: str) -> str:
        # request() returns text when content-type is not JSON.
        return self._client.request(
            "GET", f"/api/v1/forms/{q(form_id)}/submissions.csv",
            headers={"Accept": "text/csv"},
        )


class AsyncFormsResource(AsyncResource):
    async def list(self) -> list[FormListItem]:
        rows = await self._client.request("GET", "/api/v1/forms")
        return [FormListItem.model_validate(p) for p in rows]

    async def get(self, form_id: str) -> Form:
        return Form.model_validate(await self._client.request("GET", f"/api/v1/forms/{q(form_id)}"))

    async def create(self, payload: FormCreateInput | dict) -> Form:
        body = payload.model_dump(by_alias=True, exclude_none=True) if isinstance(payload, FormCreateInput) else payload
        return Form.model_validate(await self._client.request("POST", "/api/v1/forms", body=body))

    async def update(self, form_id: str, patch: FormUpdateInput | dict) -> Form:
        body = patch.model_dump(by_alias=True, exclude_none=True) if isinstance(patch, FormUpdateInput) else patch
        return Form.model_validate(await self._client.request("PATCH", f"/api/v1/forms/{q(form_id)}", body=body))

    async def delete(self, form_id: str) -> dict:
        return await self._client.request("DELETE", f"/api/v1/forms/{q(form_id)}")

    async def list_submissions(self, form_id: str) -> list[Submission]:
        rows = await self._client.request("GET", f"/api/v1/forms/{q(form_id)}/submissions")
        return [Submission.model_validate(p) for p in rows]

    async def export_submissions_csv(self, form_id: str) -> str:
        return await self._client.request(
            "GET", f"/api/v1/forms/{q(form_id)}/submissions.csv",
            headers={"Accept": "text/csv"},
        )
