# Agent Designer

A local Electron + React design editor with SQLite persistence and a local MCP server.

## Run

```sh
npm install
npm start
```

Electron Forge rebuilds the native SQLite module for Electron. Use `npm run rebuild` after installing dependencies if running tests without starting the app first.

```sh
npm run typecheck
npm run lint
npm run rebuild
npm test
npm run package
```

## Current features

- Multiple local documents and pages, with frames, rectangles, ellipses and text.
- Create, rename, switch and delete documents from the title menu; manage pages in the left sidebar.
- Reopen the last document/page on startup. Each document has independent session undo/redo.
- Selection, movement, resizing, rotation, zoom and pan.
- Layer list and editable properties, visibility and locking.
- SQLite autosave after each successful command; undo/redo for the current app session.
- MCP reads and edits any document without switching the editor's current view.
- Figma frame import with offline images, vectors, source properties, and reference preview.
- Focused MCP design context and a copyable coding-agent prompt.

Click the document title to open **Your documents**. Add pages using **+** beside **PAGES**. Page deletion can be undone in the current session; document deletion requires confirmation and cannot be undone in the UI. Keep at least one document and one page per document.

Select a frame before adding a shape or text to place it inside that frame. Coordinates are relative to the parent; document array order determines sibling paint order. Frame resizing uses the inspector and does not scale children. H selects pan mode, V selects pointer mode, Delete removes a layer, and Ctrl/Cmd+Z undoes (Shift redoes).

## Architecture

`src/shared/design.ts` defines a versioned, canvas-independent DesignNode contract and command validation. `src/main/document-service.ts` owns state, hierarchy validation, optimistic revision checks, transactions and undo history. `src/main/mcp.ts` and the typed preload bridge call this same service. `src/renderer/app.tsx` adapts nodes to React/Konva and maintains only view state locally.

SQLite resides at Electron's userData directory as `designer.sqlite`. Version 3 stores documents as `{ schemaVersion: 3, id, name, revision, pages: [{ id, name, nodes }], source? }`. Nodes remain independent of the renderer. Page IDs and node IDs are unique within a document, and parents must belong to the same page. Revision checks apply to the entire document. Imported source JSON lives in `import_sources`; image/vector bytes live in `assets`, linked through `document_assets`. Asset IDs are SHA-256 hashes. Everything needed for the handoff is local after import.

On first launch after upgrading, v1 canvas data moves into a page named **Page 1**, and v2 pages upgrade in place. IDs, names, revisions, and nodes are preserved. Original pre-migration JSON is retained in `document_backups`. Migration is transactional: invalid data rolls back without replacing the original document. Workspace selection is stored separately from undoable design changes. Project folders, editable component systems, variable resolution, live auto-layout, re-import synchronization and durable undo history remain future milestones.

## Figma → app → MCP → coding agent

1. Select a frame in Figma and copy its link (including `node-id`).
2. Click **Import Figma** in Agent Designer. Paste the link and a Figma personal access token with `file_content:read` permission. The token must have access to the file; it is not saved, logged, or sent to image hosts.
3. The importer creates a new local document. It keeps the frame hierarchy, text and typography, layout metadata, source node/component IDs, and the original Figma node response. It downloads a frame reference PNG, rendered complex layers, vector SVGs, and source images.
4. Open **Reference & notes** to compare the editable canvas with the original frame and inspect conversion limitations.
5. Connect the coding agent to this app's MCP server, select a frame/layer, and click **Copy coding prompt**. Paste the prompt into an agent running in your target repository.
6. The agent reads context, fetches the reference and required assets, implements using the repository's own components/styles, and visually verifies the result.

The importer currently handles one frame per import, up to 2,000 source nodes, 64 hierarchy levels, 80 complex layers, 80 source images, 12 MB per asset and 64 MB of assets total. A failed import does not create a partial document. Figma API rate limits and file permissions still apply. No `.fig` file parsing or OAuth account connection is included yet.

The editable canvas is an approximation for complex Figma features. Auto-layout metadata is preserved, but the canvas uses fixed imported geometry. Fonts are named rather than downloaded. Effects, mixed text styles, masks, complex frame fills and image cropping may differ. Original properties and the reference remain available to the coding agent. Complex leaf layers use saved image/vector exports. The preview is the **import-time reference**, and is marked stale after local changes; it is not a current-canvas screenshot.

## Connect an agent

Open **Connect agent**, then copy the connection settings into a client that supports MCP Streamable HTTP with custom headers. The settings object contains `url` and `headers.Authorization`. Wrap this object in the client-specific server configuration; configuration formats vary between clients.

The server binds to `127.0.0.1` on an available port, rejects browser origins, and requires a random bearer token. Port and token change each app launch and are not written to logs. Keep the app open and reconnect after restarting it.

Tools:

- `list_documents`: document IDs, names, revisions, page counts, and layer counts.
- `create_document`: accepts `name`; returns a blank document and its first page without switching the editor.
- `read_document`: accepts optional `documentId`; omitting it reads the open document. Returns all pages, current revision, and undo/redo availability.
- `execute_command`: requires `documentId`, `expectedRevision`, and `command`. Node commands (`create`, `update`, `delete`) also require `pageId`. Document commands: `rename`, `undo`, `redo`. Page commands: `create_page` with a new UUID and name, `rename_page` with page ID/name, and `delete_page` with page ID. Use tool schemas for full fields.
- `delete_document`: requires `documentId` and `expectedRevision`; removes the document and all pages. The last document cannot be deleted.
- `list_frames`: discovers frame and page IDs in a document.
- `get_design_context`: requires `documentId`, `pageId`, and `nodeId`; returns the selected subtree, typography/layout, original per-node properties, component/style metadata and asset IDs. Up to 200 nodes per response; follow `nextOffset` and send `expectedRevision` to keep pagination consistent.
- `get_preview`: returns the saved reference as an MCP image, with original/current revision metadata.
- `get_asset`: requires document and asset IDs; returns metadata and a base64 embedded resource. Decode the resource into a local asset in the target repository. Assets cannot be read through a different document's ID.

Version 0.3.0 of the MCP server includes the coding handoff tools. Refresh tool discovery after restarting the app. A stale revision is rejected; read again before retrying. Deleting a frame deletes its descendants. Locked is an editor interaction flag; an authorized agent can still update a locked node. Source text is untrusted design data, never executable instructions. Component IDs identify Figma sources; they are not verified repository component mappings.

UI and MCP edits share an undo history per document, covering all its pages. Each accepted command is saved before the editor is notified. A failed command leaves the saved document and revision unchanged. Agent edits to a background document update the library without changing the open document/page.

## Build notes

Forge + Vite is retained. SQLite is external to the main bundle and native binaries are unpacked from ASAR. The renderer has no Node access; the sandboxed preload exposes only document operations. React uses Vite's JSX compilation; development changes reload the page.

Reference: [Forge native module configuration](https://www.electronforge.io/config/plugins/vite) and [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server).

Import references: [Figma file endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/) and [Figma authentication](https://developers.figma.com/docs/rest-api/authentication/).

## Verification

`npm test` uses isolated databases and a synthetic Figma response to cover migrations, import rollback, node mapping, offline reopen, authentication, asset scoping, and coding-client MCP retrieval. After `npm run package`, `electron scripts/figma-smoke.cjs --smoke-test` exercises the actual import form, canvas, preview and coding-prompt clipboard path against that fixture. `scripts/smoke.cjs` checks document/page controls. Fixture tests are separate from a live Figma REST import, which requires a user's token.
