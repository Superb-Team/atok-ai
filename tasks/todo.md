# Lossless Recording Reliability Checklist

## Phase A — Reproduce and stop duplicate jobs

- [x] Task 1a: Add duplicate-start and runaway-output regression fixtures
- [x] Task 2a: Make Tauri event listener setup cancellation-safe across Strict Mode/HMR
- [x] Task 3a: Add same-process backend atomic job claim and owner-checked release
- [x] Task 4a: Serialize same-process manifest writes and clean failed temp files
- [ ] Task 3b: Add recording UUID, cross-process OS ownership lock, and fencing token
- [ ] Task 4b: Add generation CAS and power-loss recovery across all durable artifacts
- [ ] Checkpoint A: one recording produces exactly one active job under all start paths

## Phase B — Preserve source and transcript

- [ ] Task 5: Make finalized MP3 immutable, verified, and explicitly retained
- [x] Task 6a: Implement same-process single-flight transcription and durable canonical sidecar
- [ ] Task 6b: Persist independently retryable Whisper chunk artifacts with accepted/suspicious ranges
- [ ] Task 7: Add transcript hallucination/integrity gates with typed suspicious ranges
- [ ] Checkpoint B: forced restart of a two-hour job loses no completed work or source data

## Phase C — Block AI hallucination and runaway notes

- [x] Task 8a: Reject truncated, runaway-paragraph, and extreme-expansion output
- [ ] Task 8b: Calibrate multilingual quality corpus and versioned thresholds
- [ ] Task 9: Ground section notes in source segment/evidence IDs
- [ ] Task 10: Replace unsafe continuation and suspicious-draft fallback behavior
- [ ] Checkpoint C: no truncated, looping, word-salad, or unsupported note publishes as clean

## Phase D — Idempotent delivery and recovery

- [x] Task 11a: Serialize recording-note creation in PostgreSQL and hide internal idempotency tags
- [ ] Task 11b: Add schema-level user+recording UUID uniqueness and persisted publication status
- [ ] Task 12: Add persistent recovery, partial-status, raw-audio, transcript, and retry UX
- [ ] Task 13: Add privacy-safe diagnostics, storage warnings, and explicit retention controls

## Phase E — Qualification

- [ ] Task 14: Pass 10-minute, 1-hour, and 2-hour fault-injection qualification
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
- [ ] Full Rust test suite passes
- [ ] Tauri runtime smoke test passes under Strict Mode, HMR, restart, offline, and rate limiting
- [ ] Artifact audit confirms MP3, transcript chunks, canonical transcript, manifest, and note identity
- [ ] Human review approves quality thresholds and release rollout
