# ADO work-item import — implementation plan

Design: `docs/spec/2026-10-22-ado-work-item-import-design.md`. Branch `feat/ado-work-item-import`. Each step is test-first (RED, then GREEN), one Conventional Commit per step.

1. **docs** — this plan and the design.
2. **core: settings + pure helpers** — `src/adoSync.ts`: `adoSyncSettingsSchema` (zod, defaults, `requiredTag ≠ markerTag`, `/`→`\` paths), `buildInboundWiql` (ports all 6 `Test-InboundWiql` cases + multi-type + `@Me`), `htmlToText` (ports `Convert-HtmlToText`), `AB_PREFIX`, `parseAdoSyncSettings` (corrupt → null). Export from `index.ts`.
3. **core: storage** — migration #27 `workspace.ado_sync TEXT` (table_info-guarded), `WorkspaceRow.ado_sync`, `toWorkspace().adoSync`, `updateWorkspaceFields` writes JSON / null, `UpdateWorkspaceInput.adoSync`, `updateWorkspaceSchema` + refine. Bump `user_version` 26→27 assertions.
4. **core: importTask** — split `createTaskWithinTransaction` out of `createTask`; `ops/importTask.ts` (dedup by prefix → `{task, created}`; `ado-import/v1` comment; optional queue as human). Bind in `createCore`, add to `HttpCore`.
5. **web server** — `workspaceUpdateBody.adoSync`; `GET /api/workspaces` adds `remote` + `adoSyncWiql`; PATCH rejects enabling on a non-ADO origin (400); `POST /api/agent/import-task` (`requireSupervisor`). Contract + route tests.
6. **web client** — `WorkspacesModal` "Azure DevOps work items" section (ADO origin only), api body type, component test.
7. **watcher** — `FetchJson` PATCH + caller content-type; shared azdo `guard`; `providers/azdoWorkItems.ts`; `adoSync.ts` inbound/outbound; `syncWorkItems` config; tick wiring; fake-fetch tests.
8. **docs** — CLAUDE.md watcher bullet, README setup + config mapping; ado-bridge README note (separate repo commit).
9. **verify** — `npm run build && npm test && npm -w packages/web run typecheck:client`; live read-only WIQL check against a real ADO workspace (no PATCH without the user's go-ahead).
