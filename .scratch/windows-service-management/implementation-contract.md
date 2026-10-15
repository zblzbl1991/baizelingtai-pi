# Windows service management implementation coordination

This is the implementation interface agreement, derived from the six resolved decision tickets. Production scope is the whole confirmed spec, not the HTML prototype. Baseline/worktree paths will be supplied by the orchestrator. Do not edit the original user checkout.

## Ownership

- Backend implementer: server/pi-agent-routes.js, server.js, server/pi-maintenance-client.js, backend stop projection/transaction modules and their tests; scheduling gates/worker lifecycle hooks needed for correct semantics. No ManagedLauncher or tray edits.
- Desktop runtime implementer: server/pivane-desktop-launcher.js, server/pi-managed-launcher.js, scripts/start-desktop.cjs, public/desktop-startup.*, server/pivane-desktop-startup.js, their Node/browser tests. No server.js or native/tray edits.
- Native implementer: scripts/desktop-tray.ps1, native/pivane-desktop-launcher.cs, executable/build manifest and required build/source-discovery changes, native fixture tests. No backend/runtime JS edits.
- Orchestrator: task graph, integration, consumer fixes, docs, full regression and review. Communicate interface changes before changing this agreement.

## Backend private IPC (runtime to server.js)

Request: `{type:'desktop-request', nonce, id, method:'snapshot'|'review'|'execute', input:{...}}`.
Response: `{type:'desktop-response', nonce, id, result}` or `{type:'desktop-response', nonce, id, error:{code,message}}`.
The existing ManagedLauncher nonce and actual child identity are required. No HTTP mutation endpoint.

Snapshot result: `{complete:boolean, revision:string, blockers:[{type,count,label,cwd?,sessionId?}], scheduled:{futureCount,latestCount}}`. Missing/unknown sources fail closed. Output is bounded and redacted; no conversation bodies.
Review input: `{action:'stop'|'exit'}`; result is snapshot plus `ticket` (only when complete/idle) and `expiresAt`.
Execute input: `{ticket, draftsSaved:true, externalWritersStopped:true}`; result `{accepted:true, operationId}` after atomic recheck, gate reservation and single-use acceptance. Backend does not shut itself down before replying; runtime then invokes the existing single asynchronous ManagedLauncher close path. Duplicate execute must return the same accepted operation, never replay. Unknown transport completion is not cancellation.
Backend shares projection with maintenance idle, keeps existing skip/latest/deferred semantics and uses reversible in-memory gates, not pauseAll().

## Native tray to short-lived controlled runner

New invocation: `node scripts/start-desktop.cjs --controlled --generation <UUID>`. Preserve legacy invocation for current CLI/integration fixtures.
Input LF JSON: `{type:'snapshot'|'review-stop'|'execute-stop',generation,id,...}`. Review includes `action:'stop'|'exit'`; execute includes `ticket,draftsSaved:true,externalWritersStopped:true`.
Output LF JSON: every controlled event has `generation`; responses echo `id`.
- `{type:'starting',generation,logFile}`
- `{type:'ready',generation,url,logFile}` (after existing IPC and HTTP readiness)
- `{type:'snapshot',generation,id,...snapshot}`
- `{type:'stop-review',generation,id,...review}` (no ticket when blocked)
- `{type:'stop-accepted',generation,id,operationId}` (then runtime orderly closes)
- `{type:'stopped',generation,operationId?,clean:true}` only after service/worker cleanup; runner must actually exit too before tray considers stopped.
- `{type:'error',generation,id?,message,code?,clean?}` preserves uncertainty; error is never proof of cleanup by itself.
During startup, no business prompt is accepted yet; explicit stop/exit can request that generation's orderly shutdown (support `{type:'stop',generation,id,action}` for this path only). No legacy unconditional stop bypass once controlled service is ready.
Transport EOF still triggers one graceful shutdown. UI hiding does not close pipes. The tray owns a new runner per explicit start; old callbacks cannot mutate the current generation.

## Stable waiting entry

Tray owns a loopback-only read-only HTTP host for the lifetime of the tray, implemented within the existing .NET/native boundary (not a second long-lived Node service controller). Prefer a public helper in the existing executable, loaded by the PowerShell tray, so source/executable/build-manifest remain consistent. Supports fixed static startup assets and GET/HEAD /status only, strict Host/Origin, bounded headers/connections and response bodies, no credentials or control routes. Must work as a normal Windows user.
Controlled runner does not create/retire its own HTTP waiting server. Native state projection to /status: `{state:'starting'|'ready'|'error'|'stopped'|'stopping'|'unknown',instance:<tray UUID>,generation:<runner UUID>,url?,message?}`. Successful readiness is from the current runner only. Stable address belongs to tray instance; no promised cross-tray recovery.
Embed a `meta[name=startup-instance]` marker with the tray instance UUID into startup HTML; client verifies /status instance against it. No port discovery or adoption of unknown listeners.
Client transient read errors retry with backoff and a reconnecting message; only authoritative current-instance error is a terminal startup failure. It may continue bounded-interval status polling in error/stopped so an explicit new generation in the same tray can recover. Never creates/replays service operations.
Desktop overall start budget defaults to 180000ms, with a validated bounded desktop-specific configuration; worker/other launcher timeouts retain their own semantics. Slow hint is separate from per-request timeout.

## Native UI

Use chosen A compact native window, default hidden. Double-click tray restores it; right-click offers service management and workspace. Close/minimize hides, preserves tray. EXE double-click means open workspace or explicit start when stopped. During stopping it restores progress without queuing another start. Separate stop-service from exit-app.
Window presents state, safe local address/root, bounded blockers and log summary; logs are redacted existing run files (no secret text). Final confirmation remains separate from snapshot; checkbox for saved drafts/external writers. Accepted shutdown is not cancelled by hiding. Unknown cleanup disables starting. Every requested UI action is one in-flight request at a time.

## Validation seams already accepted in the wayfinder

TDD through private protocol and public service interfaces, actual isolated waiting-page HTTP and browser JS, plus independent synthetic Windows tray/runner fixtures. Tests run via npm test or npm run test:browser, never against the real service. Full shared regression follows integration. No dependency upgrade, user data migration, real service restart or publishing.
