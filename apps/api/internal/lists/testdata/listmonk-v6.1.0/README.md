# Listmonk v6.1.0 list-catalogue responses

Recorded verbatim (response bodies, no edits) from an isolated
`listmonk/listmonk:v6.1.0@sha256:179d00d9553c371b6fe88c9b145095d651e275bdd66db46b2e0b79daff316b6f`
— the image digest staging runs — on an `--internal` Docker network, called
with the same basic-auth API user the gateway uses. `listmonk --version`
reported `v6.1.0 (1b5e8d38 2026-03-29T13:18:16Z)`.

| File | Request | Notes |
| --- | --- | --- |
| `fresh_install_lists_all.json` | `GET /api/lists?per_page=all` on a fresh install | Listmonk's own "Default list" (1) and "Opt-in list" (2), each with one install-time subscriber. No Moosewave identity exists for either. |
| `lists_all_24.json` | `GET /api/lists?per_page=all` after 22 creates | All 24 lists; `per_page` is reported as `0`. |
| `lists_default_page_24.json` | `GET /api/lists` (no `per_page`) with 24 lists | Only 20 rows (ids 20..1): the default page drops the four newest lists. |
| `lists_query_all.json` | `GET /api/lists?per_page=all&query=digest%2012` | Substring search; one row (id 14). |
| `create_list.json` | `POST /api/lists` | Create response (`data.id` = 3). |
| `delete_list.json` | `DELETE /api/lists/5` | `200 {"data":true}`. |
| `delete_missing_list.json` | `DELETE /api/lists/999` (no such list) | Also `200 {"data":true}`: Listmonk does not 404 a missing list on delete. |

Each row carries Listmonk's own `uuid`, a third identity that is neither the
engine id nor the Moosewave `postwave_uuid`.
