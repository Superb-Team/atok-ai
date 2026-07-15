# Implementation Plan: Reliable Long-Form Transcription and Note Processing

## Overview

The current pipeline already improves long recordings with three-minute audio chunks, bounded Whisper concurrency, overlap stitching, and a frontend map-reduce pass. It is still not length-safe because the note stage estimates tokens from JavaScript character counts and eventually collapses every section note into one large reduce request. A sufficiently long recording can exceed the model context, hit the output cap, silently fall back to raw text, or produce a final note that omits middle sections.

This plan changes the pipeline from "one final giant model response" into a bounded, checkpointed document pipeline. Every transcript segment remains recoverable, every model request is preflighted against a token budget, detailed section notes are assembled deterministically, and only bounded global summaries are reduced by the model.

## Goals and Reliability Contract

- No successful transcript chunk is silently dropped because a later AI request fails.
- No AI request is knowingly sent above its model input/output budget.
- A recording can be resumed after app restart, provider outage, or partial stage failure.
- The final note preserves detailed section output without requiring one unbounded completion.
- Every partial or failed stage is visible as a typed processing status, not hidden behind a raw-transcript fallback.
- Screenshot markers remain exactly once and in chronological order.
- The design behaves consistently for Indonesian, English, CJK, Arabic, and mixed-language transcripts.

## Non-Goals

- Replacing DeepInfra or Whisper.
- Speaker diarization.
- Rewriting the audio DSP/AEC chain, except where chunk delivery affects transcription reliability.
- Guaranteeing that an LLM never summarizes a detail incorrectly. The guarantee is that source transcript and section artifacts remain available and that no pipeline stage silently discards data.

## Verified Current-State Findings

### Existing strengths

- Linux emits standalone MP3 chunks every 180 seconds and transcribes them while recording continues.
- Adjacent live chunks carry five seconds of overlap and are stitched in order.
- Whisper uploads are limited to two concurrent requests and retry 429/model-busy responses.
- Oversized fallback MP3 uploads are capped at 20 MiB and normally split at MP3 frame boundaries.
- Long transcript enhancement splits around 10,000 characters and maps at concurrency three.
- `ai_chat` detects `finish_reason == "length"` and attempts up to two continuations.

### Root causes and failure modes

1. **Characters are treated as tokens.**
   `maxTokensFor()` uses `ceil(input.length / 2)` and all section thresholds are character-based. The ratio varies substantially by language and content, so it cannot guarantee a context-safe request.

2. **The reduce stage is still unbounded.**
   All mapped section notes are concatenated into `reviewSource`, then sent to one `mergeSectionNotes()` request. As recording duration grows, this eventually exceeds context even though each map request is small.

3. **One completion owns the complete final document.**
   The final detailed note is constrained by `maxTokensFor()` to 8,192 requested output tokens. DeepInfra documents a model-dependent output limit, commonly capped at 16,384 tokens. Continuations can extend output, but they also re-send the original large prompt and previous output, consuming the same total context window.

4. **Continuation is not a completeness guarantee.**
   Two continuations are arbitrary. A continuation can repeat content, lose markdown structure, exceed total context, or still end with `finish_reason == "length"`; the current command returns the combined partial result anyway.

5. **Map failures can inflate the reduce input.**
   A failed map request silently falls back to its raw transcript section. Several failures can make the reduce prompt much larger than expected, increasing the chance of a second failure.

6. **Enhancement failure is hidden.**
   The outer catch assigns `markedTranscript` to `enhancedText`. The note is then saved as if processing succeeded, so the UI cannot distinguish a completed enhanced note from a degraded fallback.

7. **The model response contract loses metadata.**
   Rust returns only a `String`, discarding `finish_reason`, prompt tokens, completion tokens, model name, request ID, and provider usage. The frontend cannot make a reliable retry/subdivide decision.

8. **The review pass can become another giant request.**
   It submits both the section-note source and full draft. For long jobs this duplicates most content within one context window.

9. **The current deterministic deduper is globally lossy.**
   `collapseRepeatedLines()` removes a content line after its second occurrence anywhere in the document. Repetition across separate meeting sections may be meaningful and should not be deleted from detailed chronological notes.

10. **Processing state is transient.**
    The transcript sidecar is deleted after reading, live jobs are held only in memory, and frontend orchestration lives in component state/localStorage. A crash can force expensive work to restart or leave an ambiguous state.

11. **Cross-platform live behavior is inconsistent.**
    Linux uses live chunk transcription. macOS explicitly drops `chunk_tx` and batch-loads the take. The Windows recorder currently has no chunk sender in its method signature, while `lib.rs` calls the shared API with one; this needs a platform compile check and a unified chunk contract.

## Provider Constraints Verified from Official Documentation

- The configured default model, `XiaomiMiMo/MiMo-V2.5`, is currently advertised with a 262,144-token context window.
- DeepInfra states that maximum conversation length is determined by the selected model's context size.
- DeepInfra states that most models have a hard maximum of 16,384 generated tokens per response.
- Response continuation cannot exceed the model's total context and returns HTTP 400 when total context is exceeded.
- DeepInfra's model-list API exposes `metadata.context_length` and `metadata.max_tokens`; limits should therefore be discovered from the configured model rather than hard-coded.
- DeepInfra exposes token counting through its Anthropic-compatible `messages/count_tokens` endpoint. If exact counting cannot be used for the configured model, the pipeline must use a conservative estimator with a large safety margin and validate against returned usage.

Official references:

- https://deepinfra.com/XiaomiMiMo/MiMo-V2.5/api
- https://docs.deepinfra.com/chat/overview
- https://docs.deepinfra.com/api-reference/models/openai-models
- https://docs.deepinfra.com/integrations/anthropic
- https://docs.deepinfra.com/chat/structured-outputs
- https://docs.deepinfra.com/chat/streaming

## Target Architecture

```text
recording/imported audio
        |
        v
durational audio chunks + stable chunk IDs
        |
        v
Whisper chunk artifacts (ordered, persisted, retryable)
        |
        v
canonical transcript segments
  - source range / timestamps
  - text / language
  - screenshot markers
  - status / attempts / error
        |
        v
token-aware section planner
        |
        +----> bounded section extraction jobs (structured output)
        |          |
        |          v
        |     validated section-note artifacts
        |          |
        |          +----> deterministic detailed document assembly
        |
        +----> bounded hierarchical global synthesis
                   - title
                   - overview
                   - key decisions
                   - action items
                   - topic index
                          |
                          v
              deterministic final Markdown composer
                          |
                          v
              PostgreSQL note + processing manifest
```

### Core architecture decisions

1. **Use tokens for budgets, never raw character thresholds.**
   Read context/output limits for `DEEPINFRA_MODEL`; reserve output, system-prompt, continuation, and safety budgets before dispatch.

2. **Bound every LLM call independently.**
   If a request does not fit, subdivide its source input before sending. Never rely on provider rejection as normal flow control.

3. **Do not use one LLM response as the detailed final note.**
   Each bounded section produces a detailed section note. The application concatenates those validated outputs chronologically. This removes the single-response maximum-character ceiling.

4. **Use hierarchical reduce only for global information.**
   Global overview, decisions, actions, and topics are compact enough to reduce through bounded batches. Detailed content never passes through a lossy global merge.

5. **Persist source and derived artifacts.**
   A processing manifest records stage, version, chunk hashes, attempts, token usage, and errors. Completed stages are reused on resume.

6. **Treat truncation as an incomplete stage.**
   `finish_reason == "length"`, malformed structured output, missing section ID, or missing required markers must never be marked complete.

7. **Prefer subdivide-and-retry over free-form continuation.**
   Continuation remains optional for bounded prose-only global summaries. Detailed section extraction subdivides its input because that is deterministic and independently verifiable.

## Data Contracts

### Processing manifest

```ts
interface ProcessingManifest {
  schemaVersion: 1;
  jobId: string;
  audioPath: string;
  audioFingerprint: string;
  language: string;
  pipelineVersion: string;
  status: "transcribing" | "extracting" | "synthesizing" | "saving" | "complete" | "partial" | "failed";
  chunks: TranscriptChunkArtifact[];
  sections: SectionArtifact[];
  globalSynthesis?: GlobalSynthesisArtifact;
  errors: ProcessingError[];
  createdAt: string;
  updatedAt: string;
}
```

### Transcript chunk artifact

```ts
interface TranscriptChunkArtifact {
  id: string;
  index: number;
  audioPath?: string;
  startMs: number;
  endMs: number;
  text: string;
  language: string;
  sha256: string;
  status: "pending" | "running" | "complete" | "failed";
  attempts: number;
  error?: string;
}
```

### Section extraction artifact

```ts
interface SectionArtifact {
  id: string;
  sourceChunkIds: string[];
  sourceStartMs: number;
  sourceEndMs: number;
  sourceHash: string;
  title: string;
  summary: string;
  details: string[];
  decisions: Array<{ text: string; evidence: string }>;
  actionItems: Array<{ text: string; owner?: string; due?: string; evidence: string }>;
  markers: string[];
  promptTokens: number;
  completionTokens: number;
  status: "pending" | "running" | "complete" | "failed";
}
```

Evidence fields are short source excerpts or segment references used for validation; they are not required in the rendered note.

### Backend chat result

```rust
struct ChatCompletionResult {
    content: String,
    finish_reason: String,
    model: String,
    prompt_tokens: u64,
    completion_tokens: u64,
    request_id: Option<String>,
}
```

## Token Budget Policy

The exact numbers are configuration, not scattered constants.

```text
context_limit       = provider model metadata
provider_output_cap = provider model metadata, capped by documented platform maximum
reserved_output     = min(stage output target, provider_output_cap)
prompt_overhead     = counted system prompt + message formatting
safety_margin       = max(8% of context, fixed minimum)
max_source_tokens   = context_limit - reserved_output - prompt_overhead - safety_margin
```

Recommended initial stage targets:

- Section extraction source: 8,000-12,000 tokens, with 2,000-4,000 output tokens reserved.
- Global leaf reduce: no more than 50-60% of available input budget.
- Global final synthesis: reserve at most 2,000-4,000 output tokens because it contains overview/index rather than detailed transcript reproduction.
- Any count uncertainty: use a conservative fallback estimate and 20% additional margin.

## Task Plan

### Phase 1: Make limits and failures explicit

#### Task 1: Introduce typed chat completion results

**Description:** Preserve finish reason, usage, model, and request metadata from DeepInfra instead of returning only content.

**Acceptance criteria:**

- `ai_chat` callers can distinguish `stop`, `length`, provider error, and malformed response.
- Prompt/completion usage is available to the processing pipeline.
- Existing agent chat behavior remains compatible through a thin content-only adapter if needed.

**Verification:**

- Rust unit tests cover `stop`, `length`, missing choice, and missing usage fixtures.
- `cargo test --manifest-path src-tauri/Cargo.toml` passes.

**Dependencies:** None.

**Files likely touched:**

- `src-tauri/src/agent.rs`
- `src/services/agent.service.ts`
- `src/services/audio-processor.service.ts`

**Estimated scope:** Medium.

#### Task 2: Add model-limit discovery and token-budget service

**Description:** Resolve the configured model's context/output metadata, expose a token-count operation, cache model metadata, and provide a conservative offline fallback.

**Acceptance criteria:**

- Limits come from the configured `DEEPINFRA_MODEL`, not a hard-coded MiMo assumption.
- The planner rejects or subdivides requests before they exceed the calculated budget.
- Indonesian, English, CJK, Arabic, emoji, and markdown fixtures all remain within budget.

**Verification:**

- Unit tests use mocked metadata/count responses and offline fallback cases.
- Logs show calculated input, reserved output, and safety budget without logging transcript text.

**Dependencies:** Task 1.

**Files likely touched:**

- `src-tauri/src/agent.rs`
- `src/services/audio-processor.service.ts`
- a new focused token-budget module/service

**Estimated scope:** Medium.

### Checkpoint A

- All existing 94 Rust tests still pass.
- New response/limit tests pass without a live provider key.
- No application workflow depends on JavaScript character count for correctness.

### Phase 2: Persist and resume transcription work

#### Task 3: Add a versioned processing manifest

**Description:** Persist job, transcript chunk, section, stage, attempt, and error state under app data using atomic write-then-rename semantics.

**Acceptance criteria:**

- A killed process can reopen a job and identify exactly which chunks/sections are complete.
- Manifest corruption produces a recoverable error and preserves the previous valid copy.
- Pipeline-version or source-hash changes invalidate only affected derived artifacts.

**Verification:**

- Tests cover atomic save/load, interrupted temp write, schema mismatch, and hash invalidation.

**Dependencies:** None.

**Files likely touched:**

- new Rust processing-manifest module
- `src-tauri/src/lib.rs`
- `src-tauri/src/agent.rs`

**Estimated scope:** Medium.

#### Task 4: Make Whisper chunk processing resumable and fully classified

**Description:** Persist each ordered Whisper result before stitching, use stable chunk IDs, and classify retryable/permanent failures.

**Acceptance criteria:**

- Completed Whisper chunks are not re-uploaded after restart.
- 408, 429, transport timeout, and 5xx use bounded exponential backoff with jitter and `Retry-After` support.
- A permanently failed chunk yields `partial`, not a false `complete`, while successful text remains accessible.

**Verification:**

- Mocked tests cover out-of-order completion, retry exhaustion, restart/resume, duplicate delivery, and one failed middle chunk.

**Dependencies:** Task 3.

**Files likely touched:**

- `src-tauri/src/agent.rs`
- processing-manifest module
- recorder-to-transcriber chunk contract

**Estimated scope:** Medium.

### Checkpoint B

- A synthetic multi-chunk job survives forced termination and resumes without duplicate provider calls.
- A partial transcript can be inspected and retried.
- The raw/canonical transcript is never deleted merely because enhancement starts.

### Phase 3: Replace character map-reduce with bounded section extraction

#### Task 5: Build a marker-safe token-aware section planner

**Description:** Segment canonical transcript text at paragraph/sentence boundaries under a token budget while keeping asset markers intact and attaching source ranges.

**Acceptance criteria:**

- Every source character belongs to exactly one section, excluding intentional overlap metadata.
- Markers are never split, duplicated, reordered, or dropped.
- No planned section exceeds its model input budget.

**Verification:**

- Property-style tests run against 10k, 100k, and 1M-character synthetic transcripts.
- Fixtures include single oversized lines, missing punctuation, CJK text, RTL text, markdown, and hundreds of asset markers.

**Dependencies:** Task 2 and Task 3.

**Files likely touched:**

- new frontend or Rust section-planner module
- `src/services/audio-processor.service.ts`
- section-planner tests

**Estimated scope:** Medium.

#### Task 6: Produce validated structured section artifacts

**Description:** Replace free-form section summaries with bounded structured extraction containing detailed notes, decisions, actions, evidence, and marker inventory.

**Acceptance criteria:**

- `finish_reason == "length"` or invalid schema triggers subdivision/retry, never completion.
- Every output artifact references its source section and passes marker validation.
- A failed section remains independently retryable; successful neighbors are retained.

**Verification:**

- Tests cover truncated JSON, hallucinated markers, missing markers, duplicate markers, provider timeout, and subdivision convergence.

**Dependencies:** Task 1, Task 2, and Task 5.

**Files likely touched:**

- `src-tauri/src/agent.rs`
- `src/services/audio-processor.service.ts`
- processing-manifest module

**Estimated scope:** Medium.

### Checkpoint C

- A 1M-character transcript can be planned and processed with a mock provider without any over-budget request.
- Failure of any one section does not discard other completed sections.
- Re-running the same source reuses valid artifacts.

### Phase 4: Assemble unlimited detailed notes safely

#### Task 7: Add deterministic detailed-note composition

**Description:** Render section artifacts directly into chronological Markdown sections so detailed output length is limited by storage/UI, not one model completion.

**Acceptance criteria:**

- Every completed section appears exactly once in chronological order.
- Screenshot markers render exactly once at the correct section.
- A partial section is represented by a clear local placeholder and retry status, not hidden.

**Verification:**

- Snapshot/invariant tests cover hundreds of sections and markers.
- Generated Markdown remains renderable by the existing `MarkdownRenderer`.

**Dependencies:** Task 6.

**Files likely touched:**

- new document-composer module
- `src/services/audio-processor.service.ts`
- `src/components/MarkdownRenderer.tsx` only if pagination/lazy rendering is required

**Estimated scope:** Medium.

#### Task 8: Add bounded hierarchical global synthesis

**Description:** Generate only the document title, overview, topic index, global decisions, and global action items through a tree of bounded reductions.

**Acceptance criteria:**

- Every reduce node is token-budgeted before dispatch.
- Global outputs retain evidence/source references internally for validation.
- The final global synthesis fits a fixed compact output budget and never owns detailed section content.

**Verification:**

- Tests cover 1, 10, 100, and 1,000 section artifacts.
- Tests prove no reduce request exceeds the mocked context limit.
- Repeated decisions are deduplicated globally without removing chronological detail.

**Dependencies:** Task 2, Task 6, and Task 7.

**Files likely touched:**

- new hierarchical-reducer module
- `src-tauri/src/agent.rs`
- `src/services/audio-processor.service.ts`

**Estimated scope:** Medium.

### Checkpoint D

- Final detailed document size scales linearly with section count without increasing maximum single-request size.
- Global overview stays bounded.
- No free-form continuation is required to preserve detailed content.

### Phase 5: Surface progress, retry, and degraded outcomes

#### Task 9: Move processing status from transient UI state to job state

**Description:** Expose manifest-backed stage progress and errors to the frontend and replace title-keyed loading state/localStorage-only handoff.

**Acceptance criteria:**

- UI distinguishes running, partial, failed, retrying, and complete jobs.
- Restarting the app resumes or offers retry for unfinished jobs.
- Multiple recordings with identical titles cannot collide.

**Verification:**

- Component/service tests cover restart hydration, duplicate titles, partial jobs, and retry.

**Dependencies:** Task 3, Task 4, Task 6, and Task 8.

**Files likely touched:**

- `src/components/HomePage.tsx`
- `src/components/RecordingPopupApp.tsx`
- `src/services/audio-processor.service.ts`
- `src-tauri/src/lib.rs`

**Estimated scope:** Medium.

#### Task 10: Add stage telemetry and privacy-safe diagnostics

**Description:** Record duration, attempts, token usage, chunk/section counts, provider status, and truncation events without logging transcript content or credentials.

**Acceptance criteria:**

- A production failure identifies the exact job stage and artifact ID.
- Token usage and cost-driving calls can be audited per job.
- Logs never contain transcript bodies, API keys, or screenshot data URIs.

**Verification:**

- Tests/assertions inspect representative logs for required fields and forbidden sensitive content.

**Dependencies:** Task 1 and Task 3.

**Files likely touched:**

- `src-tauri/src/agent.rs`
- processing-manifest module
- `src/services/audio-processor.service.ts`

**Estimated scope:** Small/Medium.

### Phase 6: Cross-platform convergence and stress qualification

#### Task 11: Unify the recorder chunk-delivery contract across OSes

**Description:** Make Linux, Windows, macOS, and imported audio produce the same stable durational chunk stream for transcription.

**Acceptance criteria:**

- The shared recorder API compiles on all target OS configurations.
- Windows accepts and emits the chunk sender contract.
- macOS no longer requires loading a complete long take into memory before transcription can begin.

**Verification:**

- Linux native tests pass.
- CI cross-checks Windows and macOS targets or platform machines run documented smoke tests.
- A two-hour synthetic capture keeps bounded memory.

**Dependencies:** Task 4.

**Files likely touched:**

- `src-tauri/src/lib.rs`
- `src-tauri/src/audio_recorder.rs`
- `src-tauri/src/windows_audio.rs`
- `src-tauri/swift/SystemAudio.swift`

**Estimated scope:** Break into separate OS-specific medium tasks during implementation.

#### Task 12: Add end-to-end long-form qualification tests

**Description:** Establish a reproducible test matrix for size, language, failures, recovery, markers, and resource bounds.

**Acceptance criteria:**

- 10-minute, 2-hour, 8-hour, and synthetic 1M-character cases have expected invariants.
- Provider mocks cover 400 context overflow, 408, 429, 500/503, malformed response, `length`, connection loss, and restart.
- Test report records maximum request tokens, peak memory, provider call count, and final section coverage.

**Verification:**

- `pnpm build` passes.
- Frontend unit tests pass.
- `cargo test --manifest-path src-tauri/Cargo.toml` passes.
- Platform smoke-test checklist passes before release.

**Dependencies:** Tasks 1-11.

**Files likely touched:**

- Rust integration-test fixtures
- frontend test fixtures/configuration
- CI configuration if cross-platform runners are added

**Estimated scope:** Medium per test layer.

### Final Checkpoint

- No character-based threshold is used as a correctness boundary.
- No detailed-note stage depends on one unbounded model response.
- All artifacts are resumable and idempotent.
- Partial failures are visible and retryable.
- Synthetic 1M-character coverage reaches 100% of planned sections.
- Linux build/tests pass and Windows/macOS compilation is verified.

## Dependency Graph

```text
Task 1 typed responses ──> Task 2 token budgets ──> Task 5 planner ──> Task 6 extraction
          |                       |                                      |
          |                       +──────────────────────────────> Task 8 global reduce
          |                                                              |
Task 3 manifest ──> Task 4 resumable Whisper ──> Task 11 OS chunks       |
     |                 |                                                 |
     +─────────────────+──────────────> Task 9 UI progress               |
     +───────────────────────────────> Task 6 extraction ──> Task 7 compose

Tasks 1 + 3 ──> Task 10 telemetry
Tasks 1-11 ──> Task 12 qualification
```

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Provider metadata changes or is unavailable | High | Cache last-known metadata, use conservative fallback, and refuse an unsafe giant request |
| Exact token count differs across API protocols | Medium | Apply safety margin and calibrate estimates against returned OpenAI usage |
| Structured output truncates into invalid JSON | High | Validate finish reason before parse; subdivide and retry; never mark complete |
| Hierarchical summary loses detail | High | Keep detailed section artifacts out of the reduce path and compose them deterministically |
| Excessive provider cost on resume/retry | High | Hash/idempotency keys, persisted completed artifacts, bounded attempts, usage telemetry |
| One failed section blocks the whole note | Medium | Allow partial document assembly with explicit local failure and targeted retry |
| Very large Markdown hurts frontend rendering | Medium | Add section pagination/virtualization only after profiling; storage pipeline remains independent |
| Hundreds of screenshots inflate prompts | Medium | Attach each description only to its local section; global synthesis receives compact marker metadata |
| Cross-platform recorder drift | High | One chunk interface, target compilation, and OS-specific smoke tests |

## Recommended Implementation Order

Start with Tasks 1-2 because they expose the actual truncation and context behavior. Then implement Tasks 3-6 so work becomes resumable and bounded. Tasks 7-8 remove the final-output ceiling. Only after those guarantees exist should UI progress, telemetry, and cross-platform live chunking be expanded.

The first production-safe milestone is Tasks 1-8. Tasks 9-12 complete operational reliability and cross-platform parity.

## Open Decisions Before Implementation

1. Whether processing manifests should remain local files only or also be represented in PostgreSQL for cross-device visibility. Recommendation: local atomic manifests first; store only final note/job summary in PostgreSQL.
2. Whether a partial job should automatically create a note. Recommendation: create a clearly labelled partial note only when at least one section succeeded, and keep a retry action.
3. Whether the final detailed note should be one PostgreSQL row or a parent note with child sections. Recommendation: keep one row initially, then add section virtualization if real data shows rendering problems.
4. Whether Windows/macOS live chunk parity is required in the first milestone. Recommendation: fix the Windows compile contract immediately, but schedule full native chunk emission after the length-safe note pipeline is green.
