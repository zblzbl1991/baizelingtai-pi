# Windows service management review

Fixed point: `6fcedc9dd5e5e52e029c6ed29c9eec9d7a3833a4`
Reviewed tip: `7f208720e39506e7c19c1dc4a68a52c6a4a42588`
Command: `git diff 6fcedc9dd5e5e52e029c6ed29c9eec9d7a3833a4...7f208720e39506e7c19c1dc4a68a52c6a4a42588`
Final re-reviewed runtime tip: `fad24f809205115dd79fce853ee031c6ae191596` (final executable source freeze `21b568c`, with shutdown documentation).

Independent Standards and Spec agents reviewed the same pinned diff. The concurrent OfficeCLI entry rename repair is recorded in `b11c0aa`, separate from the feature. Findings below are the original review; resolution evidence will be appended after the single implementer finishes.

## Standards

1. **P2 — Opened-file identity.** Native waiting assets used `FileInfo` then `File.ReadAllBytes`; ancestor junctions, replacement and growth could cross the path/budget check. AGENTS.md requires the opened HANDLE's kernel path, full identity, type, budget and before/after validation. Read and verify one opened object before caching its bytes.
2. **P3 — Owner readiness.** Gateway readiness reconstructs side-chat collections, usage writes and title state. MODULES.md requires related services to provide their state rather than duplicating owner fields in routes. Expose owner readiness and keep composition in the gateway. No missing blocker was established for this finding.
3. **Heuristic — Speculative Generality.** The tray's `recent` queue is created and cleared but never read or enqueued. Remove it. This is a judgment, not a correctness violation.

Worst within this axis: P2 opened-file boundary. Total: 2 documented issues and 1 heuristic.

## Spec

1. **P1 — Cleanup proof.** Issue 02 says not to infer cleanup from an arbitrary exit 0. ManagedLauncher accepted exit 0 without a current-child, nonce-bound completion ACK; the runner then emitted `clean:true`. Require proof after all cleanup plus actual exits, and retain uncertainty/ownership when proof is absent.
2. **P1 — Startup-stop race.** Issue 02 requires startup stopping to reserve cleanup before late readiness. A tray still displaying starting could send startup stop after the runner had emitted ready; the runner rejected it, while the tray ignored buffered readiness and became an error with a live service it could no longer stop. Recover through the normal review/confirmation transaction without a ready-service bypass.
3. **P2 — Scheduling warning.** Issue 04 requires explaining that stopped services cannot execute tasks and an explicitly configured latest task may catch up within its existing grace period. Counts and “keep existing policy” alone do not convey these consequences.
4. **P2 — Versions and maintenance entry.** Issue 01 requires version information and the existing independent maintenance entry without running upgrades. The native window lacked both.

Worst within this axis: P1 cleanup proof and startup-stop race. Total: 4 issues. No additional scope creep was found.

## Resolution

Status: resolved. One implementer owned all review fixes (`de204a3`, `49acdc0`), merged through `fad24f8`. Original failure evidence was retained, and the final independent re-reviews found no remaining actionable findings on either axis.

- Standards: opened-HANDLE path/full identity/budget/before-after checks are implemented; every readiness owner exposes its projection; unused queue removed. The final log reader has a fixed 16 KiB buffer on one stream. Final count: 0 remaining documented issues, 0 remaining heuristics.
- Spec: current-child nonce-bound completion plus actual exit are required; uncertain cleanup retains ownership; startup/ready stop handoff uses normal review; scheduling consequences, actual running versions and maintenance entry are present. Final count: 0 remaining issues.
- Additional P1 found during re-review: keeping the workbench WebSocket open prevented HTTP shutdown completion. Gateway now synchronously gates new connections, shares one disposal Promise, closes owned WebSockets with 1001 and bounds uncooperative transport cleanup. Workers still follow graceful cleanup, and completion proof still waits for gateway/RPC/HTTP. Actual controlled-service integration and Chromium now keep the workbench connection open through stop. The existing maintenance backup/restart test reproduced the failure in the pinned full run and passed after the fix.

The two reviewers re-read the final `49acdc0` delta against `f938d5c`. The Spec reviewer also ran the real gateway/controlled integration tests (4/4). Source review is complete; final verification and baseline-failure accounting are recorded by the integration ticket and ignored local validation receipts.

Final re-review: Standards 0 remaining (worst: none); Spec 0 remaining (worst: none).
