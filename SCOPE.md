# Target workflow acceptance

Reviewed and verified on 2026-10-05. The local design-to-code MVP is implemented. This is completion of the agreed workflow, not complete Figma feature parity or automatic production-code generation.

| Target flow          | Current verified state                                                                                                                                                                    | Remaining limits                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Figma → app          | Token-free plugin export/import; local assets/reference; re-export update review with conflict choices, stable layer IDs and undo/redo. Isolated real UI checks passed.                   | Optional REST import has API limits. No native .fig parsing.                                                                                            |
| App stores design    | SQLite documents/pages, neutral nodes, typography and text runs, images, borders/shadows, layout/items/grid and source/component metadata. Offline reopen tested.                         | Complex masks, vectors, shaping and rendering remain approximate.                                                                                       |
| App → MCP            | Authenticated local briefs, full subtree/layout/components, scoped assets/fonts, current/original previews, revision and font guards, changes and commands. Actual preview smoke passed.  | App must stay open. Encrypted token and saved port survive restart; an explicit reset revokes old credentials.                                          |
| MCP → agent          | Copied local-only coding prompt; reusable retrieval now configurable, SDK-based, paginated and checksum verified. Revision/font drift restarts all retrieval; corrupted downloads reject. | Component mappings and responsive choices require target-code inspection.                                                                               |
| Agent → working code | Contact and Blog implementations demonstrated previously, including the real Grid re-export. Desktop/mobile evidence remains local, with reviewed baselines and component mappings.       | The agent must implement and verify each target; imported data does not itself generate code. Missing product backends/destinations cannot be invented. |
| Iteration            | Figma re-export merge preserves independent local edits; new current context/previews and saved target baselines support incremental coding updates.                                      | Generated code is not overwritten automatically. Baseline candidates become verified only after target checks and visual comparison.                    |

## Final checks

- Type checking and lint/format checks passed.
- All 85 isolated tests passed, including a real authenticated retrieval client after SQLite/font reopen with external networking blocked.
- Real Electron bundle import/update smoke passed: cancellation, conflict selection, independent local edits, stable IDs, added layers, undo/redo, stale review rejection and source confirmation.
- Real Electron current preview smoke passed: text/color/spacing edits, background isolation, bounded scaling, local assets and explicit missing-asset rejection.
- Windows package built successfully. Forge's normal Vite packaging filter ships compiled runtime files and required dependencies; local demos are excluded. Demos remain ignored in Git.
- This review used isolated fixture databases. It did not modify the user's design database, request Figma access or save connection credentials.

## Daily use

1. Export the selected frame with the Figma plugin; import its .agentdesign.json in Agent Designer.
2. Compare the reference and saved canvas. Load matching fonts; inspect missing images/fonts in the handoff panel.
3. Select the frame, open Connect agent and copy the current connection into your agent's MCP configuration.
4. Open Send design to agent and copy the coding brief to an agent working in the actual code project.
5. The agent retrieves current context, layout, instances, assets/fonts and preview, reuses project conventions, builds semantic responsive UI, runs project checks and compares desktop/mobile screenshots.
6. Save the target baseline and mappings only after verification. Re-export future Figma changes through Update from export, then repeat the handoff with the saved target baseline.

Run the app with npm start. Validate changes with npm run typecheck, npm run lint and npm test; build the Windows app with npm run package. README.md describes the optional npm run retrieve-design helper. Retrieval snapshots contain baseline-candidate.json, never an automatically promoted verified baseline.

## Outside the finished MVP

Full editable vector/component/variable systems, advanced grid/hug-span behavior, complex script shaping and exact Figma effects, durable undo across restarts, collaborative editing, backend generation, code deployment, automatic code synchronization and signed installer distribution are not completed. Missing or invalid font variants remain explicit limits. An unsigned local Windows package is not a signed production release.

Stable MCP settings were verified with real Windows encrypted storage across three isolated app launches, including the Reset connection button and immediate rejection of the old token. This update is packaged separately under out/stable-connection so the running older build is not overwritten.
