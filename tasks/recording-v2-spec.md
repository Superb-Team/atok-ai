# Spec: Auditable Recording V2

## Objective

Reduce false meeting entities without silently promoting uncertain speech into factual notes. Recording V2 preserves auditable capture evidence, records ASR provenance, supports revisioned corrections, and binds published claims to an accepted transcript revision while retaining read-only compatibility with legacy flat MP3 recordings.

## Implemented Slice

The current runtime now persists separate compressed pre-AEC mic/system chunk evidence on the chunked recorder, SHA-256 hashes, quality windows, immutable provider attempts, conservative mixed-vs-mic entity arbitration, transcript revision/evidence reports, deterministic numeric/acronym claim checks, a fail-closed note/RAG gate, and an OS-level ownership lock for legacy-path processing jobs. The V2 managed UUID bundle, fencing/generation tokens, retention UI, and long-duration hardware/fault qualification remain rollout work and are intentionally not represented as complete runtime guarantees.

## Target Architecture

- Rust/Tauri backend will own recording identity, capture state, durable artifacts, ASR scheduling, and recovery once the managed V2 coordinator is wired into runtime.
- React/TypeScript frontend observes backend state and provides quality/review UI.
- DeepInfra Whisper remains the initial ASR provider behind a capability adapter.
- Local managed recording bundles are the target durable source; PostgreSQL remains the note publication store. The legacy flat resolver remains read-only compatible until migration is explicitly requested.

## Commands

- Frontend tests: `pnpm test`
- Frontend build: `pnpm build`
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- Rust format check: `cargo fmt --manifest-path src-tauri/Cargo.toml --check`

## Project Structure

- `src-tauri/src/recording_artifacts.rs`: V2 identity, manifest, stage keys, and managed paths.
- `src-tauri/src/audio_recorder.rs`: platform capture and immutable source chunks.
- `src-tauri/src/agent.rs`: provider adapter, immutable ASR attempts, and transcription assembly.
- `src/services/`: frontend contracts, transcript revisions, quality gates, and note extraction.
- `tasks/`: specification, dependency plan, and implementation checklist.

## Core Contracts

1. When V2 runtime is enabled, recording identity is a Rust-generated UUID, never a caller-selected path or content hash.
2. Legacy MP3/sidecar discovery remains read-only compatible.
3. Capture source is immutable; AEC, drift correction, denoise, and playback mixing create versioned derivatives.
4. Provider responses are immutable attempts. Normalization, merge, correction, and acceptance are separate revisions.
5. Cross-track overlap is arbitrated; timestamps alone never imply distinct speakers.
6. No quality gate depends solely on provider confidence. DeepInfra timestamp capabilities are recorded per attempt.
7. Note evidence binds recording ID, accepted transcript revision, utterance ID, character span, and audio range.
8. Changed upstream artifacts invalidate dependent merge, transcript, note, and RAG artifacts.
9. Partial, suspicious, conflicting, and missing ranges cannot publish as clean facts.
10. Durable state changes are atomic, generation-checked, fenced by their current owner, and recoverable after restart.
11. One canonical global recording state and per-stage work status are shared by Rust, manifests, database publication, and the UI. Frontend wording is derived, never independently persisted state.
12. Source mic/system artifacts are the evidence source. Playback mix and mono ASR input are versioned derivatives; source class never implies speaker identity.
13. New source artifacts use owner-only filesystem access where supported. Audio egress is restricted to the configured ASR derivative/provider and recorded in provenance.

## Canonical State and Work Model

This section is the sole normative state contract. Backend code, manifests,
database publication, frontend labels, and tests derive from it; no subsystem
may persist a competing vocabulary.

Global recording state:

```text
created -> capturing -> finalizing -> processing
processing -> needs_review | ready_to_publish | failed_retryable | failed_terminal
failed_retryable -> processing                 (retry after a transient failure)
failed_terminal -> processing                  (explicit operator recovery only)
needs_review -> ready_to_publish | processing  (accept or explicitly regenerate/retry)
ready_to_publish -> published
published -> processing                         (explicit new revision; prior publication stays immutable)
any non-deleted state -> deleting -> deleted
```

The manifest owns stage records for `capture`, `playback_derivative`, `asr`,
`transcript`, `note`, and `publication`. A stage is exactly one of `pending`,
`running`, `succeeded`, `review_required`, `failed_retryable`, or
`failed_terminal`.

`degraded` is not a second lifecycle state. It is a durable non-empty
`degradedReasons[]` condition on the recording and/or affected stage, such as a
partial ASR result, capture-quality warning, or a non-blocking provider issue.
A degradation condition prevents clean publication and normally routes the
recording to `needs_review`; it is visible alongside the lifecycle state.

Global state is produced by a deterministic reducer over durable stage records
and is never guessed from a button, file path, or in-memory task. Its terminal
selection order after finalization is: deletion in progress; active required
work; blocking terminal failure; retryable failure with no usable result;
review-required or degradation condition; ready-to-publish supported result;
then published outbox completion. Every transition records the owner
generation/fencing token, expected generation, transition reason, and timestamp.
Only an active owner may transition a recording. `deleting` is an explicit
audited operation; ordinary failure handling must preserve source evidence.

## Testing Strategy

- Unit tests for identifiers, stage keys, state transitions, timeline mapping, entity suspicion, claim validation, permissions, and queue/backpressure policy.
- Filesystem integration tests for atomic commits, corrupt manifests, partial chunks, and legacy resolution.
- Provider parsing tests use recorded JSON fixtures and never require network access.
- Fault-injection tests cover restart, disk-full boundaries, missing devices, failed chunks, and stale writers.
- Qualification corpus contains 0.5–5 representative human-labeled hours and measures WER, entity error rate, false correction rate, critical fact error rate, latency, request count, and storage growth.

## Boundaries

- Always: preserve raw attempts and legacy compatibility; validate external responses; use additive schemas; fail closed for publication and fail open for source preservation.
- Ask first: add native dependencies, change retention defaults, enable at-rest encryption by default, or migrate existing recording files.
- Never: expose secrets, silently overwrite transcripts, infer recording identity from paths, delete source evidence during ordinary note deletion, or treat an unsupported provider capability as available.

## Success Criteria

- Quality thresholds are selected after the labeled baseline, with confidence intervals and an explicit owner approval; unmeasured improvement percentages are not release criteria.
- False automatic entity correction is measured and must not worsen versus the approved baseline; the release threshold is set at Checkpoint 0.
- Every final decision/action claim has evidence against the accepted transcript revision.
- No unsupported or conflicting claim enters a clean note or RAG document.
- Stop-to-transcript latency, including queue/backlog, is measured on target hardware. The approved P95 target is set after a healthy one-hour baseline rather than guessed in the spec.
- A crash loses no finalized source chunk and recovery creates no duplicate note/provider job.
- Legacy recordings still open and process through the legacy resolver.

## Rollout

1. Foundation: UUID, V2 manifest, managed resolver, durable coordinator, legacy adapter.
2. Capture: immutable source chunks, interval diagnostics, timeline observations, derived playback.
3. ASR: capability adapter, structured attempts, adaptive segmentation, cross-track arbitration, targeted retry.
4. Transcript: revisioned acceptance, entity review, scoped glossary, quality gates.
5. Notes: structured claims, stable evidence, publication/RAG invalidation.
