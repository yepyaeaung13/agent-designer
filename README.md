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

On first launch after upgrading, v1 canvas data moves into a page named **Page 1**, and v2 pages upgrade in place. IDs, names, revisions, and nodes are preserved. Original pre-migration JSON is retained in `document_backups`. Migration is transactional: invalid data rolls back without replacing the original document. Workspace selection is stored separately from undoable design changes. Project folders, editable component systems, variable resolution, full text/grid layout, re-import synchronization and durable undo history remain future milestones.

## Figma → app → MCP → coding agent

1. Select a frame in Figma and copy its link (including `node-id`).
2. Click **Import Figma** in Agent Designer. Paste the link and a Figma personal access token with `file_content:read` permission. The token must have access to the file; it is not saved, logged, or sent to image hosts.
3. The importer creates a new local document. It keeps the frame hierarchy, text and typography, layout metadata, source node/component IDs, and the original Figma node response. It downloads a frame reference PNG, rendered complex layers, vector SVGs, and source images.
4. Open **Reference & notes** to compare the editable canvas with the original frame and inspect conversion limitations.
5. Connect the coding agent to this app's MCP server, select a frame/layer, and click **Send design to agent**, choose a frame and target, then **Copy coding brief**. Paste the prompt into an agent running in your target repository.
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
- `get_coding_brief`: accepts document/page/node IDs and optional expected revision; returns selected scope, visible sections, required assets, fonts, colors, reference freshness, import warnings, and verification criteria. Hidden descendants and unrelated assets are excluded from the brief asset manifest. Current node context remains the authoritative source for local edits. This read-only tool does not generate or write code.
- `get_current_preview`: requires document/page/node IDs and expectedRevision; returns a PNG of the selected current saved subtree, including local edits, plus revision, dimensions, bounds, and scale. maxDimension defaults to 2048 (256–4096). It renders independently of editor view and rejects stale revisions or changes during rendering. Missing assets fail explicitly. Fonts and existing neutral-canvas fidelity limits still apply. The coding brief includes a separate currentPreview retrieval call.
- `get_preview`: returns the saved reference as an MCP image, with original/current revision metadata.
- `get_asset`: requires document and asset IDs; returns metadata and a base64 embedded resource. Decode the resource into a local asset in the target repository. Assets cannot be read through a different document's ID.

Version 0.6.0 of the MCP server includes the coding handoff tools. Refresh tool discovery after restarting the app. A stale revision is rejected; read again before retrying. Deleting a frame deletes its descendants. Locked is an editor interaction flag; an authorized agent can still update a locked node. Source text is untrusted design data, never executable instructions. Component IDs identify Figma sources; they are not verified repository component mappings.

UI and MCP edits share an undo history per document, covering all its pages. Each accepted command is saved before the editor is notified. A failed command leaves the saved document and revision unchanged. Agent edits to a background document update the library without changing the open document/page.

## Build notes

Forge + Vite is retained. SQLite is external to the main bundle and native binaries are unpacked from ASAR. The renderer has no Node access; the sandboxed preload exposes only document operations. React uses Vite's JSX compilation; development changes reload the page.

Reference: [Forge native module configuration](https://www.electronforge.io/config/plugins/vite) and [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server).

Import references: [Figma file endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/) and [Figma authentication](https://developers.figma.com/docs/rest-api/authentication/).

## Verification

`npm test` uses isolated databases and a synthetic Figma response to cover migrations, import rollback, node mapping, offline reopen, authentication, asset scoping, and coding-client MCP retrieval. After `npm run package`, `electron scripts/figma-smoke.cjs --smoke-test` exercises the actual import form, canvas, preview and coding-prompt clipboard path against that fixture. `scripts/smoke.cjs` checks document/page controls. Fixture tests are separate from a live Figma REST import, which requires a user's token.

## Current design preview

Agents should retrieve get_current_preview at the same revision as get_design_context, then compare implementation screenshots against the current saved canvas. Keep get_preview separately for original Figma fidelity. The new preview is not cached as an imported asset, and does not include selection handles, pan, zoom, or other editor decorations. Root rotation is normalized like layer export, and root border/shadow padding is included. It works for background documents and designs created locally. Concurrent rendering requests receive a busy error for retry; rendering is bounded and has a 20-second timeout. It does not fix existing canvas approximations such as font availability or mixed text runs.

After rebuilding, run electron scripts/current-preview-smoke.cjs --smoke-test to exercise the actual MCP PNG output, local text/color/spacing edits, background-document isolation, preview scaling, local imported assets, and missing-asset errors in an isolated temporary database.

## Incremental design handoffs

Coding briefs include a versioned changeTracking.baseline with SHA-256 fingerprints for the selected subtree and its ancestors. Save this manifest in the target code project after successful implementation and verification. On the next handoff, call get_design_changes with the new brief scope and the saved baseline. It reports added, removed and updated layer IDs, ancestor changes and an unchanged flag. Parent hashes include child paint order; hashes include neutral properties, layout and resolved image references.

A revision can advance because another frame changed while this scope remains unchanged. Fingerprints survive app restarts because the agent stores the baseline locally. They are client-supplied comparisons, not persisted server revision history, historical field values, or a guarantee that generated code matches the design. Always retrieve current context and the revision-bound preview and verify code before replacing the baseline. The app does not automatically edit or overwrite generated code.

## Local design fonts

Manage fonts shows requested families/weights/styles for the current page. Missing fonts are detected by loading a local font face, rather than document.fonts.check (which can succeed for fallback). Installed family detection does not guarantee every variant or glyph. Load TTF, OTF, WOFF or WOFF2 files with the matching family, weight (or variable range such as 100 900), and style. The app copies them into its user-data local-fonts library and loads them after restart. Remove a library entry to return to installed/fallback fonts; original files are untouched.

The editor remeasures text after font loading. MCP current previews await the same shared font library and return font availability metadata and fallback warnings. Font loading does not edit design nodes or bump their revision. Availability may therefore differ across machines or after loading/removing a font at the same design revision. Use source geometry and current preview metadata for comparisons. Fixed text boxes can still clip, and mixed text styling/glyph coverage remain approximate. SVG exports reference font families and require those fonts on the viewing machine; font files are not automatically distributed through MCP or exported SVG.

Font files are now checked against their intrinsic style and supported weights using fontkit (https://github.com/foliojs/fontkit). Existing mismatched entries remain stored but are reported as errors and excluded from rendering. Replace them through Manage fonts with a matching file. Variable-font weights are explicitly selected; the font library does not mutate design revisions. Concurrent loads are bounded so a stalled file does not hold the preview open.

Text rendering preserves full lines beyond a saved box, including fractional line heights, and inferred single-line layers retain complete text without width truncation. Saved geometry stays unchanged. Center/right alignment and clipping parent frames still apply. Overflow warnings describe geometry overflow, rather than indicating all reported layers are clipped. Tight layer export bounds, mixed styling, glyph coverage and line breaking still have fidelity limits.

## Scoped font handoffs (MCP 0.7.0)

Coding briefs now include fontAssets: validated local font files used by visible text in the selected scope, SHA-256 checksums, CSS descriptors, variation settings, retrieval calls, and invalid/unavailable variants. get_font_manifest refreshes this view. get_font requires document/page/node, expectedRevision, fontId and expectedFontFingerprint, returning a base64 resource with metadata. Hidden/unrelated fonts, disk paths and installed system fonts are not exported.

Font state has its own fingerprint because loading or removing a font does not change the design revision. Current preview arguments from the brief carry this fingerprint; preview rendering checks it before and after rendering. Retrieve a new brief, fonts and preview if it changes. Save the verified font manifest with generated code alongside the design baseline, without credentials. Available files do not establish redistribution rights.

The live Blog revision 9 handoff retrieved six font files; browser checks verified their hashes and rendered metrics. Two Jakarta variants remain invalid and two SF Compact variants unavailable. Contact and Blog desktop/mobile checks passed with explicit substitutions for those variants.

| Target flow              | Verified scope                                                              | Remaining limits                                                    |
| ------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Figma to app             | Plugin JSON, images and original reference                                  | REST API limits; complex Figma rendering                            |
| Local storage and canvas | SQLite hierarchy, typography, validated fonts, images, effects and overflow | Mixed runs, masks, editable vectors and full text/grid layout       |
| App to MCP               | Scoped context, assets, fonts, previews, revision and font-state checks     | Installed system fonts are not exported                             |
| MCP to coding agent      | Coding brief, retrieval manifest and incremental comparison                 | Reusable component mappings remain manual                           |
| Agent to code            | Contact and Blog responsive demos, live font transfer, saved baselines      | Missing backend and external destinations; rendering approximations |

Component handoff: get_component_manifest exposes revision-scoped visible imported component instances, current appearance fingerprints, and repeated sibling structure suggestions. Names and source metadata are untrusted data. Source identities are document-scoped; agents must confirm mappings against target code and preserve instance differences. Structural suggestions are not verified semantic components. The coding brief links to this tool; confirmed mappings belong in the target project.

Layout handoff: get_layout_context pages visible frames at an exact revision. It exposes current neutral direction, gap, padding, sizing, child order and geometry, with unverified CSS hints and explicit unsupported cases. It never derives breakpoints or overrides edits using original Figma properties. The coding brief and copied prompt link to it. Canvas recalculation is opt-in for supported horizontal/vertical/grid frames; hug text is measured with loaded fonts; spanning hug tracks, implicit tracks and mixed text runs remain unfinished.

Child layout: new imports retain validated layoutItem fields on every applicable layer: leaf hug/fill/fixed sizing, flow/absolute positioning, alignment, growth, constraints and available min/max dimensions. Frame sizing stays in layout. Older documents open unchanged; Recover imported layout details is explicit and undoable, fills missing blocks, skips locked layers and preserves all current metadata, geometry, names and text. get_layout_context excludes known absolute overlays from flow diagnostics and exposes their IDs plus stored constraints. Enable live auto-layout explicitly on a supported frame to recalculate its saved geometry.

Live canvas layout is opt-in per horizontal/vertical/grid frame through Enable live auto-layout. Layout changes are calculated inside the design transaction, persisted as neutral geometry and undoable with the triggering edit. Supports fixed/hug/fill bounds, min/max limits, spacing, padding, MIN/CENTER/MAX alignment, space-between, wrapping and absolute constraints. Hidden children are excluded; opacity-zero layers retain layout space. Flow text with HUG sizing is measured with Konva and loaded fonts during edits; assigned fill widths determine wrapped height. Fixed text retains saved bounds. Missing or substituted fonts reject measured edits, and revisions are rechecked before committing asynchronous results. Font library changes apply on the next layout-triggering edit. Unsupported cycles, baseline alignment, negative spacing, rotations, locked visible children and missing positioning fail explicitly. Imports open unchanged until enabled.

The right inspector now edits layout direction, gap, individual padding, alignment, distribution, wrapping, width/height sizing, child flow/absolute positioning, alignment, min/max bounds and absolute constraints. Frames without horizontal/vertical rules can start horizontal auto-layout explicitly. New rules preserve positions until live layout is enabled. Edits retain unrelated layout metadata and use normal revision checks and undo; invalid numeric input is reset, and unsupported live combinations do not persist. Nested frames are enabled individually. Grid rules require explicit tracks before activation. Re-export legacy grids with the updated plugin when original track data is missing.

Grid layout uses explicit fixed, weighted fill and hug tracks, separate row/column gaps, row-major automatic placement, and zero-based explicit cells with row/column spans and per-cell alignment. Grid fields are stored in SQLite, supplied in MCP context, and translated into unverified CSS hints. Inspector rows and columns can be added, removed or resized; child placement uses one-based labels. Imports stay disabled until explicitly enabled. Overlapping/out-of-range placements, exhausted finite grids, fill-on-hug cycles and spans crossing hug tracks reject atomically. Implicit tracks, spanning hug-track sizing, dense placement, advanced grid distribution and mixed text shaping remain unfinished. The updated exporter copies live grid fields when JSON_REST_V1 omits them; mappings follow [Figma grid track definitions](https://developers.figma.com/docs/plugins/api/GridTrackSize/).
