# Windows service management review

Fixed point: `6fcedc9dd5e5e52e029c6ed29c9eec9d7a3833a4`
Reviewed tip: `7f208720e39506e7c19c1dc4a68a52c6a4a42588`
Command: `git diff 6fcedc9dd5e5e52e029c6ed29c9eec9d7a3833a4...7f208720e39506e7c19c1dc4a68a52c6a4a42588`

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

Status: in-progress. One implementer owns all review fixes; original failure evidence is retained and targeted regressions are added before fixes. Re-review and final verification are pending.
