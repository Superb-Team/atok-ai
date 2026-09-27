# Atok.ai

## Frontend structure

```
src/
  app/            entry points (main window, recording popup) and App shell
  features/       one folder per domain
    <feature>/
      components/ React pages and components for this feature
      api/        thin wrappers around Tauri `invoke` commands
      lib/        pure logic, unit-tested with `*.test.ts` beside it
      pipeline/   stages of a multi-step flow (note-generation only)
      types.ts    types shared inside the feature
  components/     components shared across features (shadcn `ui/`, MarkdownRenderer)
  lib/            app-wide helpers (utils, theme)
  styles/         global stylesheet used by both windows
```

Features: `auth`, `notes` (pages, editor, note API), `recording` (popup, audio
import, capture policies), `note-generation` (transcript-to-note AI pipeline,
entry point `audio-processor.service.ts`), `tasks`, `extensions` (MCP),
`settings`, `search-ai`.

Conventions:

- App code imports through the `@/` alias, e.g. `@/features/notes/api/note.service`.
- `pnpm test` runs `node --test` directly on TypeScript without Vite, so the
  alias does not resolve there. Any module reachable from a `*.test.ts` file
  must import its dependencies with relative paths ending in `.ts`.
- Shared UI goes in `src/components`; only move something there once a second
  feature needs it.
