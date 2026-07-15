# Reliable Long-Form Transcription Checklist

## Phase 1: Explicit limits and outcomes

- [x] Task 1: Return typed chat completion metadata (`finish_reason`, usage, model, request ID)
- [x] Task 2: Discover configured model limits and add token-aware request budgets
- [ ] Checkpoint A: All requests are preflighted; existing Rust tests remain green

## Phase 2: Durable and resumable jobs

- [x] Task 3: Add atomic, versioned processing manifests
- [ ] Task 4: Persist and resume classified Whisper chunk jobs
- [ ] Checkpoint B: Forced-stop job resumes without retranscribing completed chunks

## Phase 3: Bounded section processing

- [x] Task 5: Replace character splitting with marker-safe token-aware planning
- [ ] Task 6: Extract validated structured section artifacts with subdivide-and-retry
- [ ] Checkpoint C: Mocked 1M-character transcript produces no over-budget requests

## Phase 4: Unlimited detailed output

- [x] Task 7: Compose detailed Markdown deterministically from section artifacts
- [x] Task 8: Add bounded hierarchical synthesis for overview/decisions/actions/index
- [ ] Checkpoint D: Final detail scales with section count while request size stays bounded

## Phase 5: Operational UX

- [ ] Task 9: Expose manifest-backed progress, partial status, and retry in the UI
- [ ] Task 10: Add privacy-safe stage/token/retry telemetry

## Phase 6: Cross-platform and qualification

- [ ] Task 11a: Fix and verify the Windows recorder chunk-sender API contract
- [ ] Task 11b: Add bounded live chunk emission on Windows
- [ ] Task 11c: Replace macOS whole-take batching with bounded chunk emission
- [ ] Task 11d: Route imported audio through the same stable chunk contract
- [ ] Task 12: Add end-to-end long-form stress and recovery tests

## Definition of Done

- [x] No character count is used as a correctness boundary
- [x] No detailed final note relies on one unbounded LLM completion
- [ ] `finish_reason == "length"` can never be marked complete
- [x] Every successful transcript/section artifact survives later-stage failure
- [x] Interrupted work resumes idempotently
- [ ] Partial failures are visible and individually retryable
- [ ] Screenshot markers remain exactly once and chronological
- [ ] Indonesian, English, CJK, Arabic, and mixed-language fixtures pass
- [ ] 10-minute, 2-hour, 8-hour, and 1M-character qualification cases pass
- [x] `pnpm build` passes
- [x] Frontend tests pass
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] Windows and macOS target compilation/smoke checks pass
