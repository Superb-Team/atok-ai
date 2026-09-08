# Implementation Plan: Lossless and Trustworthy Recording Pipeline

> Recording V2 extends this reliability plan. Its current contract is defined in
> `tasks/recording-v2-spec.md`. New work must preserve completed safety slices and
> remain compatible with legacy flat MP3/sidecar recordings.

## Authoritative production-readiness roadmap

### Decision and scope

Atok.ai recording is a deterministic, durable workflow—not an autonomous agent.
The model may transcribe, extract, or format text, but it must never choose the
recording state, silently replace source artifacts, or publish an uncertain note.

This roadmap applies to meetings of one to two hours and is intentionally
additive:

- Existing flat MP3 recordings, sidecars, notes, and screenshots remain readable.
- Existing recording files are neither moved nor deleted as part of this work.
- DeepInfra Whisper remains the initial ASR provider behind an adapter; changing
  provider is a separately measured decision, not a hidden fallback.
- Linux/PipeWire is qualified first. macOS and Windows must not claim equivalent
  reliability until they pass the same qualification suite.
- Audio retention stays explicit: source audio remains until the user performs a
  dedicated recording-data deletion flow.
- “Production-ready” means the release gate below passes on target hardware. It
  never means word-perfect ASR or zero model uncertainty.

### Non-negotiable invariants

1. The backend assigns a UUID before capture. A frontend timestamp or file path
   is presentation metadata, never the recording identity.
2. Every source chunk is durably committed before it can be uploaded, mixed,
   removed from a spool, or considered complete.
3. A recording has at most one active owner. Every durable write carries the
   owner's current generation/fencing token and stale writers fail.
4. Raw provider output, normalized transcript, accepted transcript, generated
   draft, and published note are distinct immutable revisions.
5. A fallback preserves source and records a durable degradation condition. It
   must not pretend to be a successful AI result.
6. No claim becomes a clean note or RAG document without evidence pointing to an
   accepted transcript revision and an absolute audio range.
7. Audio, transcript, and note work must be recoverable after an app kill,
   provider 500/429, network loss, full disk, device disappearance, or UI remount.
8. New source artifacts use owner-only filesystem permissions where the platform
   supports them. Existing legacy files are never chmodded, moved, or deleted
   implicitly.
9. Audio leaves the device only through an explicitly configured ASR provider
   and only as an ASR derivative. Logs, traces, note drafts, and diagnostics do
   not contain raw audio or transcript text.

### Target runtime topology

```text
Rust recording UUID + ownership lock
  -> managed bundle/<recordingId>/manifest.v2.json (CAS/fencing)
  -> source/mic + source/system chunks (immutable, hashed, fsynced)
  -> derivatives/playback-mix + derivatives/asr-input
  -> ASR chunk attempts (durable status, retry schedule, provider provenance)
  -> raw transcript -> normalized candidate -> accepted revision
  -> evidence-backed note draft -> needs-review OR ready
  -> transactional note/RAG publication outbox
```

The UI observes state from the backend. It may request start, stop, retry,
format, regenerate, or accept a revision, but it never owns job identity or
recovery.

### Dependency order

```text
Recording UUID + V2 coordinator
  -> durable capture spool + fencing
    -> resumable ASR + absolute timeline
      -> transcript revisions + evidence
        -> note/RAG publication and review UX
          -> long-duration fault qualification and staged release
```

No downstream phase may be marked complete while its upstream source of truth is
still path-based or process-local.

### Canonical state and work model

The single normative definition is
[`Canonical State and Work Model`](recording-v2-spec.md#canonical-state-and-work-model)
in `tasks/recording-v2-spec.md`. The plan intentionally does not restate state
names: frontend labels, manifests, jobs, database publication, and tests must
derive from that one contract.

## Phase 0 — Freeze the baseline and define the scorecard

### Empirical baseline — local recordings corpus (2026-08-14)

The following measurements were produced locally from recording metadata and
sidecars only. No meeting audio or transcript was sent to an external service
for this audit. They validate that this roadmap must qualify long meetings, but
they do **not** establish word accuracy: that requires a human reference
transcript for the sampled ranges.

| Measurement | Observed baseline | Engineering consequence |
| --- | ---: | --- |
| Canonical recordings | 35 MP3s / 28.17 hours | The corpus is sufficient for duration, recovery, and audio-level qualification. |
| Long recordings | 21 over 30 minutes; 10 over 60 minutes; longest 187.7 minutes | The release path must exercise 65-, 125-, and 180-minute runs. |
| Artifact coverage | 12 transcripts and processing manifests; 4 quality and integrity reports; 4 recordings with the complete observed artifact set | Legacy artifacts are useful evidence, but cannot prove new V2 runtime behavior. |
| Quality telemetry | 34 measured windows: 10 have mic/system delta over 12 dB; 11 have mic clipping at or above 0.5% | Add preflight calibration. Treat 6 dB as warning and 12 dB as review/recalibration candidate pending human-corpus calibration. |
| ASR provenance | 100 stored successful responses; all have sentence segments, none have word timestamps; 87 lack a run ID | Do not claim word-level evidence. V2 needs fenced run IDs, absolute chunk timing, and capability-aware evidence. |
| Durable-state residue | 3 partial processing manifests and 4 stale processing temp files (about 614 hours old) | Recovery must be manifest-owned and idempotent; cleanup must be an explicit, audited action—not a startup deletion. |

The legacy quality reports use schema versions 1–2 while the current code
declares version 4. Consequently the corpus is a baseline and regression input,
not evidence that the current unqualified implementation has passed its tests.

### Blocking audit findings to resolve before qualification

1. **Resolved — source deletion on ASR setup failure.** The live transcription
   drain now removes only disposable mixed upload files; persisted microphone
   source artifacts remain available for recovery and review.
2. **Resolved — final audio durability.** MP3 finalization flushes the buffered
   writer and calls `sync_all` before rename, then synchronizes the parent
   directory after the atomic commit.
3. **Critical — accepted transcript is destructively cleaned.**
   `clean_transcript` removes heuristic "outro" and duplicate text directly
   before committing the canonical sidecar. Raw provider responses survive in
   attempt artifacts, but the accepted transcript is not a named revision with
   an explicit review decision. Keep raw, normalized candidate, and accepted
   revisions distinct; a heuristic can flag or propose a candidate, never erase
   evidence silently.
4. **Required — formatting treats generated draft text as ground truth.** The
   current `Fix format` validator preserves every number/acronym in an existing
   draft. If an upstream model emitted a prompt echo such as `Rp 500` or a
   malformed `URL-`, removing it correctly fails as "removed factual anchor".
   Split this UX and contract into: deterministic Markdown normalization,
   evidence-backed draft regeneration, and an explicit reviewable artifact
   cleanup. A formatting command must not silently become semantic repair.
5. **Required — V2 contracts are not yet runtime authority.** V2 artifact types
   are currently test-gated and the active flow still uses path identity,
   temporary live chunks, an unbounded receiver, and per-process ownership.
   Wire the coordinator before adding another fallback or model.

### Decision: workflows, not a recording "agent"

Capture, mixing, ASR retry, validation, publication, and Markdown-only
normalization have predictable inputs and explicit failure states. They remain
deterministic workflow steps. The model is permitted only to produce an ASR
candidate, an evidence-backed note draft, or a bounded review proposal. It may
not decide whether to delete source data, replace a transcript, or report a
  degraded condition as successful. This keeps model failures visible and makes a
one-to-two-hour meeting resumable.

**External design references (decision support, not runtime dependencies):**

- Anthropic distinguishes predictable, code-orchestrated workflows from
  model-directed agents and recommends the simplest composable approach that
  meets the task: https://www.anthropic.com/engineering/building-effective-agents
- DeepInfra documents sentence timestamps for ordinary Whisper and word
  timestamps only for the timestamped model variant:
  https://docs.deepinfra.com/tutorials/whisper
- Rust documents that close errors are ignored and `File::sync_all` is the API
  for explicitly handling durable write errors:
  https://doc.rust-lang.org/stable/std/fs/struct.File.html#method.sync_all

### Task 0.1: Build a sanitized qualification corpus

**Description:** Create a local-only manifest of representative Indonesian
meetings: clean headset audio, quiet system audio, overlapping speakers, domain
names/acronyms, screen-share terminology, and known bad recordings. Store human
reference transcripts separately from production recordings.

**Acceptance criteria:**

- [ ] The human-labeled evaluation subset contains 0.5–5 representative hours,
  including 10-minute, 65-minute, and 125-minute captures. It is stratified by
  headset/device, quiet vs. low-system-audio, crosstalk, Indonesian/English
  terminology, and known-bad recordings.
- [ ] Each sample has consent/retention classification and a human reference for
  critical names, numbers, decisions, action items, and a defined annotation
  guide for uncertainty, overlap, and unintelligible speech.
- [ ] Baseline metrics are recorded: WER, critical-entity error rate,
  decision/action error rate, false-clean-note rate, chunk retry rate,
  completion latency, and storage growth.

**Verification:** A corpus manifest validator rejects missing duration,
reference, or consent fields. No production recording is copied automatically.

**Dependencies:** None. **Scope:** M.

### Task 0.2: Specify quality and release thresholds

**Description:** Turn "sounds good" and "accurate" into measured gates. The
initial 6 dB warning and 12 dB review/recalibration candidates apply only to
short speech-active windows, not a whole three-minute chunk containing silence
or turn-taking. The corpus determines whether the candidates become release
thresholds.

**Acceptance criteria:**

- [ ] Thresholds distinguish warning, review-required, and hard capture failure.
- [ ] Every threshold has a corpus measurement and an owner-approved rationale.
- [ ] Mic preflight tests clipping, signal presence, and noise; it does not
  claim to know remote/system balance while nobody is speaking. System-balance
  warnings use a controlled loopback check or live speech-active observation.
- [ ] Release SLOs are defined: zero loss of committed chunks, zero duplicate
  note publication, and no clean publication after an integrity failure.

**Verification:** Fixture tests cover each threshold boundary and preserve raw
measurements for later recalibration.

**Dependencies:** Task 0.1. **Scope:** S.

### Task 0.3: Define audio data, capacity, and privacy contract

**Description:** Specify the source codec, derivative codecs, storage budget,
filesystem access policy, provider egress policy, and disk-pressure behavior
before V2 writes any managed bundle. Source mic/system chunks are immutable
evidence; playback MP3 and mono ASR input are versioned derivatives.

**Acceptance criteria:**

- [ ] New POSIX recording directories/files are created owner-only (`0700` and
  `0600`); equivalent platform-native access controls are documented and tested.
- [ ] The manifest records source/derivative codec, hash, byte count, retention
  class, and configured ASR provider for every outbound derivative.
- [ ] Capacity tests calculate storage for 65-, 125-, and 180-minute recordings;
  a configurable warning and hard-stop reserve prevent source loss on full disk.
- [ ] Legacy recordings remain read-only compatible. Permission hardening and
  encryption migration for old files require a separate user-approved flow.

**Verification:** Permission tests, egress allowlist test, low-disk simulation,
and storage-budget report.

**Dependencies:** Task 0.1. **Scope:** S.

### Checkpoint 0 — baseline approved

- [ ] The team approves the corpus and the initial scorecard.
- [ ] No production-readiness claim is made from unit tests alone.

## Phase 1 — Make Recording V2 the runtime authority

### Task 1.1: Add a managed V2 recording coordinator

**Description:** Wire the existing UUID/state-machine contract into runtime.
Create `<recording-root>/.recording-v2/<uuid>/manifest.v2.json` before capture;
the legacy MP3 remains where it is during migration.

**Acceptance criteria:**

- [ ] `start_desktop_recording` returns `{ recordingId, audioPath }` generated by
  Rust, not a caller-selected identity.
- [ ] Runtime uses the canonical recording/stage state model in
  `recording-v2-spec.md`; obsolete
  `RecordingState` names and frontend-only status strings are removed or mapped
  explicitly during the same migration.
- [ ] Legacy audio resolves read-only without receiving an invented UUID until it
  is explicitly imported/adopted.

**Verification:** State-transition, restart, and legacy-resolution tests;
manual capture confirms a V2 manifest exists before audio arrives.

**Dependencies:** Checkpoint 0. **Scope:** M.

### Task 1.2: Fence every owner and artifact mutation

**Description:** Extend the existing OS lock and manifest generation check into
the V2 coordinator. Chunk, transcript, note, and publication mutations must
verify the same owner generation.

**Acceptance criteria:**

- [ ] 100 concurrent starts yield exactly one owner and one `recordingId`.
- [ ] A stale owner cannot write after a new owner recovers a dead process.
- [ ] UI handoff becomes an event convenience only; recovery comes from backend
  manifests, never `localStorage` alone.

**Verification:** Two-process lock test, stale-writer test, app-remount test,
and forced process-death recovery test.

**Dependencies:** Task 1.1. **Scope:** M.

### Checkpoint 1 — identity and ownership

- [ ] Every new recording is UUID-owned and backend-recoverable.
- [ ] Existing recordings still open unchanged.
- [ ] Duplicate provider calls cannot be induced by double click, HMR, or restart.

## Phase 2 — Make capture durable and measurable

### Task 2.1: Commit source chunks before processing

**Description:** Replace temporary live-ASR-only chunk handling with a managed
spool. Each mic/system chunk is fsynced, hashed, described in the manifest, and
only then eligible for mix/ASR.

**Acceptance criteria:**

- [ ] Killing the app at every capture boundary loses no committed source chunk.
- [ ] Final MP3 and derivative chunks call file sync before rename; parent
  directories are synced where supported.
- [ ] Temporary cleanup cannot remove source evidence or an unacknowledged ASR
  work item.

**Verification:** Crash-point matrix, disk-full simulation, and source-hash audit.

**Dependencies:** Checkpoint 1. **Scope:** M.

### Task 2.2: Separate playback mixing from ASR preparation

**Description:** Keep mic and system tracks as sources. Produce a balanced
playback mix and a separately versioned ASR derivative. Do not turn source
classes into participant identities or use dual-ASR by default.

**Acceptance criteria:**

- [ ] The quality report includes pre- and post-DSP loudness, clipping, source
  presence, and mic/system delta for every interval.
- [ ] Preflight records 10–15 seconds for mic health only. A loopback test or
  later speech-active monitor evaluates system balance; a silent remote track
  cannot be treated as an imbalance.
- [ ] The ASR derivative is deliberately mono with a recorded mix policy;
  playback may remain stereo. A second source-only ASR pass is opt-in,
  capability-recorded, and never silently arbitrates speaker identity.
- [ ] V2 disables AEC by default for headset input unless acoustic echo is
  actually detected/required; the selected setting and its rationale are
  recorded for the capture.

**Verification:** Replay fixtures with quiet system, hot mic, clipping, silence,
and overlapping speech; manual preflight on PipeWire.

**Dependencies:** Task 2.1. **Scope:** M.

### Checkpoint 2 — trustworthy audio source

- [ ] A 65-minute recording survives stop/restart with all source chunks present.
- [ ] A user sees an actionable calibration warning before—not after—a bad meeting.

## Phase 3 — Resumable ASR with an absolute timeline

### Task 3.1: Introduce an ASR capability adapter

**Description:** Encapsulate provider request format, timestamp granularity,
language, glossary, retry policy, model version, and response parsing. Unsupported
features are represented as unavailable, never assumed.

**Acceptance criteria:**

- [ ] Every ASR attempt stores provider/model/request ID, audio hash, request
  parameters, response, and capability version.
- [ ] Provider/model fallback is explicit in the manifest and UI, not silent.
- [ ] Initial release uses one configured provider/model. Any provider fallback
  is a separately approved capability with its own egress, retention, and
  evaluation policy.
- [ ] Provider fixtures validate current DeepInfra response shapes offline.

**Verification:** Adapter fixture tests and a controlled 429/500 retry test.

**Dependencies:** Checkpoint 2. **Scope:** M.

### Task 3.2: Persist a per-chunk ASR work ledger

**Description:** Give each durable source chunk a `pending`, `leased`,
`succeeded`, or `failed-retryable` work state. Resume only unfinished chunks;
bounded concurrency and backoff protect the provider.

**Acceptance criteria:**

- [ ] Restart after chunk N never uploads chunks 0..N-1 again.
- [ ] A failed chunk produces a reviewable partial result, never a clean
  canonical transcript.
- [ ] The queue is bounded and backpressure is observable.
- [ ] Queue capacity, maximum in-flight bytes, retry-attempt/time budget,
  cancellation behavior, and provider circuit-breaker policy are persisted and
  tested rather than inferred from semaphore defaults.

**Verification:** Offline mid-run restart; injected 500/429; provider-call count
assertion; queue-saturation test.

**Dependencies:** Task 3.1. **Scope:** M.

### Task 3.3: Normalize timestamps to recording time

**Description:** Convert provider-local timestamps to absolute recording offsets
using recorded chunk capture start/end, pause intervals, overlap, and drift
observations—not `chunkIndex × nominalChunkDuration`. Record every correction;
never infer a speaker merely from mic/system source class.

**Acceptance criteria:**

- [ ] Each evidence range maps to one absolute `[startMs, endMs]` in the source
  recording.
- [ ] Overlap stitching preserves speech at seams and records any discarded text.
- [ ] Missing timestamps force review rather than fabricated evidence.
- [ ] Sentence-level evidence is the initial supported granularity. Word-level
  evidence is unavailable unless the provider attempt explicitly records a
  word-timestamp capability and response.

**Verification:** Synthetic multi-chunk timeline fixtures, seam tests, and a
manual seek-from-note-to-audio check.

**Dependencies:** Task 3.2. **Scope:** M.

### Checkpoint 3 — resumable transcription

- [ ] A 125-minute capture survives provider failure and app restart without
  duplicate completed uploads.
- [ ] Every accepted transcript range can seek to the correct point in audio.

## Phase 4 — Transcript revisions and evidence-backed notes

### Task 4.1: Separate raw, normalized, and accepted transcript revisions

**Description:** Keep raw ASR output immutable. Noise cleanup creates a candidate
revision with a transformation report; a user/system acceptance creates the only
revision eligible for note publication.

**Acceptance criteria:**

- [ ] Heuristics never overwrite raw ASR text.
- [ ] Any deleted/replaced candidate phrase is explainable and reversible.
- [ ] The accepted revision references all contributing ASR attempts.

**Verification:** Regression fixtures for outro hallucinations, genuine “terima
kasih”, names, decimals, and manually corrected text.

**Dependencies:** Checkpoint 3. **Scope:** M.

### Task 4.2: Bind generated claims to evidence

**Description:** Generate structured claims for decisions, actions, owners,
dates, and quantities. Each claim must cite accepted-revision character spans and
absolute audio ranges.

**Acceptance criteria:**

- [ ] A note cannot label a proposal as a decision without an evidence span.
- [ ] Named entities and negation/uncertainty are checked, not only numbers and
  acronyms.
- [ ] Failed evidence validation produces `needs-review`.
- [ ] Claim artifacts persist a claim ID, claim type, rendered text, support
  status, accepted revision ID, source attempt/chunk ID, character span, and
  absolute audio range. Rendering only assembles accepted claim artifacts.

**Verification:** Adversarial fixtures for “belum/sudah”, proposed/approved,
owner ambiguity, names, URLs, and numeric facts.

**Dependencies:** Task 4.1. **Scope:** M.

### Checkpoint 4 — truthful transcript-to-note boundary

- [ ] A reviewer can inspect every high-impact note claim against audio/text.
- [ ] No heuristic cleanup or model output silently becomes ground truth.

## Phase 5 — Clear user recovery and publication behavior

### Task 5.1: Replace ambiguous fallback UI

**Description:** Present explicit processing states: `recording saved`,
`transcribing`, `partial`, `needs review`, `ready`, and `failed retryable`.
Fallback notes remain readable but cannot masquerade as an AI-complete note.

**Acceptance criteria:**

- [ ] User sees failure reason, completed chunk count, and safe retry action.
- [ ] “Fix format” means lossless Markdown-only formatting and may no-op.
- [ ] “Fix format” is deterministic Markdown normalization and never calls a
  free-form model. “Review artifact” and “Regenerate draft from accepted
  transcript” are separate versioned actions with an explicit diff.
- [ ] “Regenerate draft” is a separate explicit action that preserves the prior
  note and shows a diff before replacement.

**Verification:** UI states for offline, provider error, partial ASR, formatter
rejection, manual transcript edit, and successful recovery.

**Dependencies:** Checkpoint 4. **Scope:** M.

### Task 5.2: Add a fenced publication outbox

**Description:** Publish note and RAG state through an idempotent durable outbox
keyed by `recordingId + acceptedRevisionId`. RAG is optional and never blocks
source preservation.

**Acceptance criteria:**

- [ ] No duplicate note/RAG document after a crash between database and RAG call.
- [ ] Review-required or manually edited notes stay out of automatic RAG.
- [ ] Publication status is durable and visible.

**Verification:** Crash after every outbox transition and duplicate-delivery test.

**Dependencies:** Task 5.1. **Scope:** M.

### Checkpoint 5 — safe product behavior

- [ ] A user can distinguish formatting, regeneration, retry, and review.
- [ ] Degraded output is never presented as clean success.

## Phase 6 — Operability, qualification, and staged release

### Task 6.1: Add recording-scoped observability

**Description:** Emit structured events with `recordingId`, job generation,
stage, chunk index, attempt, provider/model, latency, queue wait, and sanitized
failure class. Correlate logs, metrics, and traces with the same recording/job
context. Do not log source transcript, audio paths, tokens, or secrets.

**Acceptance criteria:**

- [ ] One recording can be traced from start through publication/review.
- [ ] Dashboards expose success rate, chunk retries, queue age, p95 completion,
  quality-warning rate, and duplicate-owner rejections.
- [ ] Alerts are symptom-based with a short runbook.

**Verification:** Inject an ASR failure and diagnose it from telemetry alone.

**Dependencies:** Tasks 1.1–5.2; instrumentation may be added alongside them.
**Scope:** M.

### Task 6.2: Run the qualification matrix and staged rollout

**Description:** Test real Linux hardware before enabling the new coordinator for
all recordings. Keep a kill switch to create legacy-compatible recordings during
the pilot.

**Acceptance criteria:**

- [ ] Pass 10-minute calibration, 65-minute, and 125-minute tests on target
  headset/system audio devices.
- [ ] Pass app-kill, restart, network loss, 429/500, device loss, disk-full,
  duplicate-click, and manual-review scenarios.
- [ ] The corpus scorecard meets team-approved accuracy and reliability targets.

**Verification:** Signed qualification report; canary rollout; rollback drill.

**Dependencies:** Checkpoint 5 and Task 6.1. **Scope:** M.

### Production release gate

The system is not production-ready until all of these are true:

- [ ] New recordings use runtime UUID manifests and fenced ownership.
- [ ] Source chunks and ASR ledger resume after restart without duplicate work.
- [ ] Controlled loopback and speech-active tests detect a known mic/system
  imbalance and emit an actionable warning before recording.
- [ ] Evidence timestamps are absolute and claim-level evidence is inspectable.
- [ ] Formatter, regeneration, fallback, retry, and review have distinct UI paths.
- [ ] The one-hour and two-hour qualification matrix passes on real hardware.
- [ ] New recordings enforce owner-only artifact permissions and stop safely
  before disk pressure can overwrite or delete committed source evidence.
- [ ] Telemetry and a rollback/kill switch are verified.

### Parallel work rules

- Sequential: Phase 1 → 2 → 3 → 4; they share the recording identity and source
  contract.
- Safe in parallel after the relevant contract is frozen: corpus/threshold work,
  UI copy/state mockups, provider fixtures, and observability schemas.
- Ask before: adding a new native dependency, migrating/deleting recordings,
  changing default retention, enabling cloud upload beyond the existing provider,
  or changing the database schema.

### Key risks and mitigations

| Risk | Mitigation |
|---|---|
| Audio imbalance is only discovered after the meeting | Preflight calibration and interval-level post-DSP diagnostics. |
| A provider outage triggers duplicate costs/work | Durable per-chunk ledger, bounded queue, idempotency, and backoff. |
| A model makes a plausible but false note | Accepted transcript revisions, claim/evidence validation, review state. |
| V2 migration breaks old recordings | Additive resolver; legacy files remain read-only and untouched. |
| Large refactor becomes unreviewable | Ship each task as a small vertical slice with its tests and checkpoint. |
| Team cannot diagnose a failure | Recording-scoped structured telemetry plus a runbook. |
