# Import fixtures

These files are the exact shapes Squawk, oasdiff and `buf breaking` write. JSON
and JSON Lines cannot carry comments without breaking the parsers, so each
fixture is described here instead.

| File | Tool | What it represents |
|---|---|---|
| `squawk-ban-drop-column.json` | Squawk | One `Warning` (`ban-drop-column`) at 0-based line 0 in `migrations/0002.sql`. |
| `squawk-two-drops.json` | Squawk | Two `Warning` items for the same rule, at 0-based lines 0 and 1. |
| `oasdiff-api-path-removed.json` | oasdiff | Level 3 (ERR) `api-path-removed-without-deprecation`, `GET /users`, `baseSource` `openapi.yaml:12`. |
| `oasdiff-warn.json` | oasdiff | Level 2 (WARN) `request-property-type-changed`, `POST /items`, `baseSource` `openapi.yaml:42`. |
| `oasdiff-info.json` | oasdiff | Level 1 (INFO) `description-changed`, `GET /users`, `baseSource` `openapi.yaml:10`. |
| `buf-field-same-type.jsonl` | buf | `FIELD_SAME_TYPE` at `proto/user.proto:8`, then `FILE_NO_DELETE` with no `path`. |
| `buf-file-no-delete.jsonl` | buf | One `FILE_NO_DELETE` annotation with no `path` (reported as file `unknown`). |
| `buf-empty.jsonl` | buf | Empty file: buf writes nothing when there are no findings. |

The shapes follow `_brief/adapter-formats.md`: Squawk and oasdiff write a JSON
array, buf writes one JSON object per line.
