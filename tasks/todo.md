# Lossless Recording Reliability Checklist

> **Execution order:** This checklist is the implementation ledger for the
> authoritative roadmap in `tasks/plan.md`. Do not begin a later checkpoint
> until the preceding checkpoint's acceptance criteria have been demonstrated on
> real artifacts, not only unit tests.

## Next production-release sequence

- [x] Inventory local corpus: 35 canonical recordings / 28.17 hours; preserve it as local-only baseline evidence
- [ ] Add human reference ranges, consent/retention metadata, and critical-entity labels before using the corpus for accuracy claims
- [ ] Define the canonical global state plus per-stage status model; remove divergent frontend/Rust/manifest state vocabularies
- [ ] Define source/derivative codecs, owner-only permission policy, egress policy, disk reserve, queue capacity, retry budget, and circuit-breaker policy
- [x] Resolve source deletion on ASR setup failure and MP3 file sync before rename
- [ ] Separate raw, normalized, and accepted transcript revisions so heuristic cleaning never silently erases evidence
- [ ] Split "Fix format" into deterministic formatting, evidence-backed regeneration, and explicit artifact review; remove draft-as-ground-truth validation
- [ ] Phase 0: approve qualification corpus, scorecard, and initial audio-level policy
- [ ] Phase 1: wire the V2 UUID coordinator and fencing into runtime
- [ ] Checkpoint 1: prove one backend-owned recording identity across restart/remount
- [ ] Phase 2: make source capture spool durable; add preflight calibration
- [ ] Checkpoint 2: prove a 65-minute source capture survives restart intact
- [ ] Phase 3: ship resumable per-chunk ASR and absolute timestamp mapping
- [ ] Checkpoint 3: prove a 125-minute ASR run resumes without duplicate completed uploads
- [ ] Phase 4: ship raw/candidate/accepted transcript revisions and claim evidence
- [ ] Phase 5: ship explicit retry/review/regenerate/publication UX
- [ ] Phase 6: qualify on real hardware, canary, rollback drill, then release

## Existing safety slices — evidence only, not a production claim

- [x] Add Rust-generated recording UUID and versioned V2 manifest contracts (contract/tests; not wired into runtime)
- [ ] Add managed/legacy recording resolver without moving existing files
- [x] Add semantic stage keys and dependency invalidation contracts
- [x] Fix mic-only sample-rate normalization with regression coverage
- [x] Persist provider segments, any provider-supplied word timestamps, and immutable ASR-attempt provenance; record when word timestamps are unavailable
- [x] Preserve capture-quality windows instead of console-only clipping warnings
- [x] Add cross-track arbitration before transcript merge
- [x] Add accepted transcript revisions and stable evidence spans (backend contract/command)
- [x] Gate final note and RAG publication on supported claims
