# Implementation Plan: Lossless and Trustworthy Recording Pipeline

## Objective

Make a 1–2 hour recording durable, single-processing, resumable, and auditable. A UI remount, duplicate event, app crash, provider outage, malformed AI response, or retry must never delete the MP3, silently discard transcript sections, create duplicate notes, or publish hallucinated/runaway text as a successful note.

## Reliability Contract

1. The finalized MP3 is the source of truth and is immutable until the user explicitly deletes it.
2. Exactly one active processing owner exists for each canonical audio path; duplicate starts return the existing job.
3. Every completed transcription chunk and note section is persisted atomically and reused after restart.
4. A failed or suspicious stage is marked `partial`/`needs_review`; it is never presented as clean success.
5. Raw transcript and generated note are separate artifacts. AI enhancement cannot overwrite the transcript.
6. A note is published only after deterministic quality gates pass.
7. Automatic cleanup may remove disposable temp files, but never the MP3, canonical transcript, or committed chunk artifacts.

## Verified Current Failures

- `HomePage` registers `recording-started` asynchronously. Cleanup can run while `unlisten` is still unresolved, leaving a stale listener after Strict Mode/HMR/remount.
- Deduplication lives in component-local refs, so stale component instances do not share the same active-job set.
- Event, localStorage polling, and manifest recovery can all initiate the same job.
- The manifest writer uses a shared `.backup` name and an `exists -> rename` sequence without a per-path lock or generation check.
- Live transcription ownership is destructive (`take_live_job` removes the handle). Concurrent callers fall through to duplicate full-file uploads.
- The live transcript sidecar is deleted on first read, preventing safe reuse by retries.
- Failed Whisper chunks are inserted into transcript text as bracketed prose, allowing downstream AI to treat infrastructure errors as meeting content.
- AI output validation checks truncation and exact repeated lines, but not a single long runaway paragraph with changing words. The supplied July 15 note is a regression example of this failure.
- The review pass is best-effort and returns the original draft when review fails, even if that draft is precisely the suspicious artifact.
- Existing manifest tests cover only a single writer; they cannot detect the observed race.

## Implemented Safety Slice (2026-07-19)

- Frontend async listener cleanup is cancellation-safe and covered by a delayed-registration test.
- Frontend processing is single-flight per audio path, and Rust rejects concurrent claims from duplicate webview listeners.
- Manifest access is serialized in-process; a 32-writer regression test covers the observed backup race.
- Transcript requests are single-flight in-process, canonical transcript sidecars are durable/non-consuming, and failed chunks are no longer injected as meeting prose.
- Screenshot manifests are non-consuming so restart/retry retains the same assets.
- Runaway/truncated AI output is rejected before save; rejected notes fall back to the preserved transcript, receive `needs-review`, and are excluded from RAG indexing.
- Recording note insertion is idempotent across processes through a PostgreSQL transaction advisory lock and persisted internal job marker.

This slice closes the reported same-process incident. The remaining tasks below are still required for cross-process OS fencing, managed artifact storage, chunk-level resume, explicit deletion semantics, and full two-hour qualification.

## Target Flow

```text
Popup/import
   -> finalize and fsync immutable MP3
   -> enqueue_or_get_job(canonical audio identity)
   -> durable job manifest
   -> one leased processing owner
   -> persisted Whisper chunk artifacts
   -> canonical transcript (never consumed/deleted)
   -> bounded section-note artifacts
   -> deterministic quality gates
   -> publish clean note OR publish review-required fallback
   -> retain MP3 + transcript + audit metadata
```

## Architecture Decisions

### One backend authority for job identity and ownership

Assign a random recording UUID at capture/import; identical bytes imported twice remain distinct user recordings. Copy/finalize source media into a managed app-data artifact directory and use the UUID—not path or a short content hash—as identity. A Rust command acquires a cross-process OS file lock for that UUID and returns either `claimed`, `already_running`, or `resumable`. Every durable mutation also carries a monotonically increasing fencing token checked under the same lock. Automatic lease expiry alone must never create a second owner while an older process is alive or suspended.

### Layered idempotency

- UI layer: one lifecycle-safe listener and no polling/event double execution.
- Coordinator layer: process-wide single-flight keyed by recording UUID.
- Ownership layer: cross-process OS lock; process death releases ownership without wall-clock assumptions.
- Persistence layer: generation/fencing token prevents stale writers from mutating chunks, synthesis, manifests, or notes.
- Note layer: PostgreSQL serialization plus a user-scoped durable idempotency key prevents duplicate notes.

### Explicit state and publication model

The job state machine has legal compare-and-swap transitions only: `capturing -> finalizing -> queued -> transcribing -> transcript_partial|transcript_ready -> enhancing -> needs_review|ready_to_publish -> complete`, plus `failed_recoverable`, `cancelled`, and `deleting`. Generated drafts, quality decisions, and final Markdown are separate immutable artifacts referenced by hash. A note persists `processingStatus`, `sourceJobId`, and provenance; search, RAG, export, and normal note views may treat only `complete` as clean.

### Deletion is a fenced state transition

Deleting a note does not delete recording evidence. “Delete recording data” is a separate explicit operation: write a durable tombstone, fence/cancel the owner, prevent all later publication, remove derived artifacts, then remove source media last. Recovery resumes the deletion transaction rather than resuming processing.

### Fail closed for generated prose, fail open for source preservation

If enhancement is suspicious, preserve and expose the canonical transcript, mark the note `needs_review`, and retain retry controls. Never discard source data; never label unvalidated prose as complete.

### Quality checks must be deterministic first

An LLM review can improve prose but cannot be the only validator. Local checks detect runaway length, abnormal lexical chains, excessive repetition, unsupported entity/number growth, malformed structure, missing source coverage, and suspicious completion metadata before saving.

## Implementation Tasks

### Task 1: Add regression fixtures and failure-injection harness

**Description:** Preserve sanitized fixtures for the observed duplicate-start race and the July 15 runaway note. Add controllable delays/failures around listener setup, manifest commit, chunk upload, enhancement, and note save.

**Acceptance criteria:**

- A test reproduces multiple starts for one `audioPath` without relying on real network calls.
- A fixture shaped like the supplied long one-line word cascade is classified as suspicious.
- Tests can simulate app restart after every durable stage.

**Verification:** `pnpm test` and targeted Rust tests fail before the fixes.

**Dependencies:** None.

**Likely files:** `src/services/*.test.ts`, `src-tauri/src/processing_jobs.rs`, new test fixtures under `src/test-fixtures/`.

**Scope:** Medium.

### Task 2: Make frontend handoff lifecycle-safe

**Description:** Replace the fire-and-forget async listener setup with cancellation-aware registration. If cleanup occurs before `listen()` resolves, immediately invoke the returned unlisten function. Route event, import, and recovery through one application-level coordinator rather than component-local refs.

**Acceptance criteria:**

- Strict Mode setup/cleanup/setup leaves exactly one live listener.
- Ten simulated HMR/remount cycles still produce one enqueue request.
- Navigation and `key={refreshNotes}` remounts cannot start a second pipeline.

**Verification:** frontend lifecycle test with delayed `listen()`; manual dev-mode HMR test.

**Dependencies:** Task 1.

**Likely files:** `src/components/HomePage.tsx`, new `src/services/recording-job-coordinator.ts`, coordinator tests.

**Scope:** Medium.

### Task 3: Add atomic backend job claim and lease

**Description:** Introduce `enqueue_or_claim_processing_job` keyed by the persisted recording UUID. Hold a cross-process OS lock for the run lifetime and issue a monotonically increasing fencing token. Thread that token through every chunk, synthesis, manifest, RAG, and note mutation. Heartbeats are diagnostic; wall-clock lease expiry never overrides a live OS lock.

**Acceptance criteria:**

- 100 concurrent claim attempts yield one owner and one `jobId`.
- Duplicate requests return existing status without retranscribing.
- Restart recovery can claim after process death but cannot steal from a live or suspended process.
- Two independent app processes cannot both perform provider calls or durable writes for one recording.

**Verification:** Tokio concurrency tests plus two-process, suspend/resume, old-owner-survives-update, and fencing tests.

**Dependencies:** Task 1.

**Likely files:** `src-tauri/src/processing_jobs.rs`, `src-tauri/src/lib.rs`, `src/services/recording.service.ts`.

**Scope:** Medium.

### Task 4: Replace manifest persistence with serialized, crash-safe commits

**Description:** Serialize load/save per manifest path, use unique temp/backup files, validate schema before commit, fsync file and parent directory where supported, clean temps on every error path, and reject stale generations.

**Acceptance criteria:**

- Concurrent saves never produce `ENOENT`, corrupted JSON, or stale-state rollback.
- Killing the process before/after each rename recovers either the previous or next valid generation.
- Startup quarantines corrupt manifests and recovers the newest valid committed generation.

**Verification:** barrier-controlled multi-writer test, crash-point matrix, 1,000-save stress test.

**Dependencies:** Task 3.

**Likely files:** `src-tauri/src/processing_jobs.rs` and its tests.

**Scope:** Medium.

### Checkpoint A: duplicate processing eliminated

- One event produces one backend job under Strict Mode, HMR, remount, event+poll, and restart recovery.
- No duplicate Whisper or chat request appears in captured test telemetry.
- Manifest concurrency and crash tests pass.

### Task 5: Guarantee raw-audio durability

**Description:** Retain raw capture chunks until a managed app-data MP3 has been written, synced, verified, and indexed by recording UUID. Imported sources are copied into the managed store. Revalidate the stored content hash before each stage. No automatic retention policy may delete source audio; deletion follows the tombstoned protocol above.

**Acceptance criteria:**

- The MP3 survives transcription, enhancement, provider failures, app crashes, and note deletion.
- A corrupt/incomplete MP3 is reported before processing without deleting it.
- Only an explicit user deletion flow can remove source audio, with confirmation and a documented recovery consequence.
- Removable, read-only, replaced, symlinked, renamed, and same-bytes-imported-twice cases follow the defined UUID/copy semantics.

**Verification:** forced-stop tests at chunk boundaries and filesystem audit tests asserting source existence.

**Dependencies:** Task 3.

**Likely files:** `src-tauri/src/audio_recorder.rs`, `src-tauri/src/audio_import.rs`, `src/services/recording.service.ts`.

**Scope:** Medium.

### Task 6: Persist Whisper chunks and make transcription single-flight

**Description:** Replace destructive `take_live_job` with shared single-flight state. Persist each chunk result atomically with index, time range, hash, model, language, attempts, and error. Keep the canonical transcript sidecar; reading it must not consume it.

**Acceptance criteria:**

- Concurrent callers await or reuse the same transcription job.
- Restart retranscribes only missing/failed chunks.
- Chunk failures remain typed metadata and never appear as prose inside the transcript.

**Verification:** concurrent `transcribe_audio` test, sidecar reuse test, partial-chunk retry test.

**Dependencies:** Tasks 4 and 5.

**Likely files:** `src-tauri/src/agent.rs`, `src-tauri/src/lib.rs`, processing manifest schema/tests.

**Scope:** Medium.

### Task 7: Add transcript-level hallucination and integrity gates

**Description:** Validate each Whisper chunk before stitching. Use available segment/timestamp/no-speech metadata where supported, audio-energy context, repeated n-gram detection, language drift detection, implausible expansion ratio, and cross-chunk duplication checks. Suspicious chunks are retried conservatively or flagged—not silently deleted.

**Acceptance criteria:**

- Known silence/outro hallucinations and repetitive loops are flagged with a reason and source chunk.
- Real repeated meeting phrases are preserved unless the duplicate is proven to come from overlap.
- A partial transcript reports exact missing/suspicious time ranges.

**Verification:** Indonesian silence, noisy audio, mixed-language, repeated-real-speech, and overlap fixtures.

**Dependencies:** Task 6.

**Likely files:** `src-tauri/src/agent.rs`, transcript-quality module/tests.

**Scope:** Medium.

### Checkpoint B: source and transcript are recoverable

- A two-hour simulated job resumes after forced termination without redoing successful chunks.
- MP3 and canonical transcript remain readable after every injected failure.
- Partial ranges are visible and individually retryable.

### Task 8: Introduce deterministic generated-note quality scoring

**Description:** Validate every section and global synthesis before it becomes a committed artifact. Detect the supplied runaway cascade using paragraph length, sentence-boundary scarcity, unique-token chains, n-gram repetition, output/input expansion, completion saturation, malformed headings, and abnormal vocabulary drift.

**Acceptance criteria:**

- The supplied July 15 runaway pattern is rejected before save.
- Valid long technical notes are not rejected merely for length.
- Each rejection records machine-readable reasons and request metadata.

**Verification:** golden valid notes plus adversarial loop, word-salad, repeated-line, huge-paragraph, and truncated-output fixtures.

**Dependencies:** Task 1.

**Likely files:** new `src/services/note-quality.ts`, `src/services/audio-processor.service.ts`, tests.

**Scope:** Medium.

### Task 9: Ground generated sections against transcript evidence

**Description:** Keep an accepted transcript separate from raw Whisper hypotheses. Generate structured, preferably extractive section artifacts where every rendered claim carries an exact evidence span plus segment ID. Locally verify that spans occur in accepted segments, expose citations for audit, and use a second bounded verifier only as an additional signal—not proof. Unsupported or ambiguously supported prose forces `needs_review`. Do not ask a global model to recreate detailed content.

**Acceptance criteria:**

- Every rendered detailed section maps to persisted source segment IDs.
- Every factual sentence—not only names and numbers—has a verified source span or forces review.
- Missing section output falls back to that section's raw transcript and marks the note partial.

**Verification:** fabricated-name/number fixtures, missing-section test, source-coverage test.

**Dependencies:** Tasks 7 and 8.

**Likely files:** `src/services/audio-processor.service.ts`, `src/services/long-form-processing.ts`, manifest types/tests.

**Scope:** Medium.

### Task 10: Remove unsafe continuation and review fallback behavior

**Description:** For detailed notes, replace free-form continuation with subdivide-and-retry. A failed quality review must not return an already-suspicious draft as success. Global synthesis remains bounded and optional; deterministic section content remains authoritative.

**Acceptance criteria:**

- `finish_reason=length`, max-token saturation, or quality failure can never be marked complete.
- Review failure results in `needs_review` or source-backed fallback, not silent acceptance.
- No model request is responsible for reproducing the entire two-hour note.

**Verification:** forced truncation, continuation loop, review timeout, and malformed-output tests.

**Dependencies:** Tasks 8 and 9.

**Likely files:** `src-tauri/src/agent.rs`, `src/services/audio-processor.service.ts`.

**Scope:** Medium.

### Checkpoint C: hallucinated notes cannot publish as clean

- The supplied runaway example is blocked deterministically.
- Unsupported names/numbers/actions are rejected or traceably removed.
- Clean fixtures remain accepted and preserve all source sections.

### Task 11: Make note saving idempotent and transactional

**Description:** Persist a user-scoped recording UUID idempotency key and processing status with the note. Enforce uniqueness in PostgreSQL and use an upsert/CAS contract. Treat filesystem manifest + PostgreSQL as a recoverable saga: after an unknown commit outcome, query by the unique key before retrying. Never resurrect a user-deleted note automatically.

**Acceptance criteria:**

- Replaying a completed job cannot create a duplicate note.
- Crash between note save and manifest save recovers the original note.
- A clean note cannot be overwritten by a stale or degraded attempt.
- Search, RAG, export, and note lists cannot treat `needs_review`/partial artifacts as clean.

**Verification:** crash-between-writes integration tests and repeated-resume test.

**Dependencies:** Tasks 4, 9, and 10.

**Likely files:** notes persistence layer, `src/services/audio-processor.service.ts`, manifest schema/tests.

**Scope:** Medium.

### Task 12: Add recovery and review UX

**Description:** Display durable stages (`recording saved`, `transcribing n/m`, `enhancing n/m`, `needs review`, `complete`), preserve the processing card across navigation, and expose fenced retry only for failed stages. Provide direct access to raw audio, raw hypotheses, accepted transcript, evidence citations, and quality reasons. Persist status with the note so every downstream consumer honors it.

**Acceptance criteria:**

- Closing/reopening the app shows the same job and resumes safely.
- Users can distinguish transcript failure, enhancement failure, partial completion, and suspicious-output rejection.
- Retry cannot create another job or duplicate note.

**Verification:** real Tauri lifecycle test and manual recovery walkthrough.

**Dependencies:** Tasks 3, 6, 10, and 11.

**Likely files:** `src/components/HomePage.tsx`, recording/job services, status components.

**Scope:** Medium.

### Task 13: Add privacy-safe observability and retention controls

**Description:** Log job IDs, fencing tokens, stage transitions, request IDs, durations, chunk indexes, retry counts, and quality reasons without logging transcript/audio content. Add storage warnings and explicit export/delete controls. “Retention” is informational only; it never authorizes automatic deletion of canonical artifacts.

**Acceptance criteria:**

- Duplicate starts and quality rejections are diagnosable without exposing meeting text.
- Storage pressure never triggers silent deletion.
- Users can explicitly export or delete audio/transcript artifacts.

**Verification:** log-redaction test, low-disk test, retention-policy test.

**Dependencies:** Tasks 5, 6, and 12.

**Likely files:** processing services, settings UI, logging helpers.

**Scope:** Medium.

### Task 14: Two-hour qualification and release gate

**Description:** Run deterministic short fixtures plus real/synthetic 10-minute, 1-hour, and 2-hour recordings under normal operation, HMR/remount, offline periods, rate limits, and forced process termination.

**Acceptance criteria:**

- No source artifact is lost in the complete fault matrix.
- Exactly one job and one note exist per recording.
- Every source chunk is accounted for as complete, suspicious, or failed—never missing silently.
- No known runaway/hallucination fixture is published as clean.

**Verification:** full frontend tests, full Rust tests, production build, runtime Tauri smoke test, and artifact audit.

**Dependencies:** All prior tasks.

**Likely files:** integration/e2e harness, fixture documentation, release checklist.

**Scope:** Medium.

## Fault Matrix Required Before Release

| Injection point | Required result |
|---|---|
| Popup closes during recording | Finalize recoverably or clearly retain incomplete source; never pretend success |
| Duplicate event/poll/recovery | One job owner; duplicates return existing job |
| HMR/Strict Mode/remount | One listener and one enqueue |
| Crash during manifest commit | Previous or next valid generation loads |
| Crash after chunk transcription | Completed chunks reused |
| Provider timeout/rate limit | Bounded retry; durable partial status |
| One Whisper chunk fails | Exact time range marked; no error prose injected |
| AI truncates/loops/word-salads | Artifact rejected; transcript preserved |
| Crash after note creation | Existing note recovered; no duplicate |
| Low disk space | Processing pauses with warning; source is not deleted |
| Two app processes / overlapping update | OS lock admits one owner; stale fencing token rejects every side effect |
| OS suspend or wall-clock jump | Ownership does not expire while the process still holds the OS lock |
| Source file replaced after finalize | Hash mismatch blocks processing; managed immutable copy remains available |
| Delete during processing | Tombstone fences owner; recovery completes deletion and never publishes |
| DB commit timeout with unknown outcome | Lookup by unique recording key resolves outcome before retry |
| App/schema upgrade or downgrade | Versioned reader migrates forward; rollback never writes a newer schema |
| Read-only/removable import source | Managed copy completes before source is considered finalized |

## Rollout Strategy

1. Land Tasks 1–4 behind a `reliable_job_coordinator` flag. New recordings use exactly one path; rollback disables new processing but never re-routes them into the unsafe path.
2. Enable durable audio/chunk handling from Tasks 5–7 and migrate existing manifests without deleting legacy artifacts.
3. Calibrate quality gates against a versioned, human-labeled Indonesian/mixed-language corpus. Shadow mode may create diagnostics only; would-reject output is never indexed or presented as clean.
4. Switch quality gates to enforcement only after false-positive review.
5. Enable idempotent save and recovery UX, then complete the two-hour qualification matrix.
6. Remove the old orchestration path only after at least one release cycle with no duplicate starts or unrecoverable jobs. Rollback is fail-closed: preserve/enqueue recording data and pause processing.

## Definition of Done

- Task-specific acceptance criteria pass at runtime, not only at compile time.
- New regression tests fail without the corresponding fix and pass with it.
- `pnpm test`, `pnpm build`, and the complete Rust test suite pass.
- Tauri runtime is tested with Strict Mode, HMR, restart, and forced failures.
- No logs contain transcript text, API keys, or raw audio content.
- Architecture and recovery behavior are documented.
- Rollback path remains available through staged rollout.
- Human review approves quality-gate thresholds using real valid and invalid recordings.

## Explicit Non-Guarantee

No speech-recognition or language model can guarantee perfect wording. This plan guarantees preservation, traceability, bounded retries, evidence-backed note construction, and rejection of known suspicious output classes. When confidence is insufficient, the product must say so and preserve the source instead of fabricating certainty.
