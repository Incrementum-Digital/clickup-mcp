# Documents

## Sub-features
- `searchDocuments` across the workspace; `readDocument` with page navigation.
- `createDocumentOrPage`, `updateDocumentPage` (write mode).

## How to get to it (user POV)
"Find documents about job postings in the X space", "read the API doc in the development space", "update the meeting notes".

## Driving it with the CLI
With a token: `just cli searchDocuments query="api"` then `just cli readDocument doc_id=<id>`. Not part of the verify drive (no workspace-neutral document id).

## Gotchas
- Docs API is v3 while tasks are v2; a doc id is not a task id.
- Large pages are truncated to `MAX_RESPONSE_SIZE_MB`; read page by page.
