# Task backlog — save a task without dispatching it

Source doc: .ai/specs/2026-09-19-task-backlog.md

## Goal

Let a human save a task's composer choices without dispatching it — no worktree, no queue slot,
no `RunRecord` — until a later "▶ Start" hands it, unmodified, to the same `RunManager.startRun()`
path a task takes today.

## Scope

Full Phase 1 of the spec: `packages/cezar/src/backlog.ts`, the four `/api/backlog/*` routes, the
composer's "Save to backlog" action, and the Backlog tab on the Tasks page. The spec's own
Phase 1/Phase 2 split is the scope boundary here too — variants, dispatch-tree roots, inline
editing before Start, and any dependency-between-tasks modeling are explicitly out.

### Non-goals

- Any change to `runs.json`, `RunRecord`, `RunStatus`, `RunManager.startRun()`/`pump()`, or
  worktree allocation — the spec's whole point is that a backlog item never reaches any of them
  before Start.
- Persisting pasted-attachment bytes to a stable URL at SAVE time. The spec's Data Model section
  says so, reusing `persistPastedAttachments`, but that routine is keyed to an EXISTING run's own
  id and the image-serving route (`GET /runs/:id/images/:file`) 404s without a matching
  `RunRecord` — neither exists for a backlog item before Start. Resolved default: keep pasted
  attachments as the same base64 `attachmentInputSchema` blocks `POST /runs` already accepts, and
  persist them only at Start — exactly when `manager.startRun()` already persists a fresh run's
  initial images today. Functionally equivalent (attachments survive save→start exactly as long as
  any other saved attachment does), reversible, and named here rather than silently deviating.

## Implementation Plan

### Phase 1: Backend — module, routes, shared helper

1. `packages/contract/src/backlog.ts` — `backlogItemSchema` (`createRunInputBaseSchema` minus
   `variants`/`dispatch`), the `POST /api/backlog` wire schema, response types; exported from the
   contract package index.
2. `packages/cezar/src/backlog.ts` — `backlogPath`, load/save with per-entry-tolerant parsing and
   atomic tmp+rename (structural port of `todos.ts`), `addBacklogItem`/`removeBacklogItem`/
   `markBacklogItemStarted`. Unit tests: round-trip, malformed-entry skip, concurrent-write
   serialization under the shared lock.
3. `GET/POST /api/backlog`, `DELETE /api/backlog/:id`, `POST /api/backlog/:id/start` on the
   per-project router, next to `/api/todos/*`. `start` shares two helpers extracted from the
   `POST /runs` handler (`resolveStartWorkflow`, `buildStartRunInput`) so the two routes cannot
   silently drift on what "unknown workflow" means or what a "task" is allowed to carry.
   Route tests: create validates workflow XOR steps; list excludes started items, newest first;
   delete is idempotent; start reuses the same 400/404 `POST /runs` gives, 409s a double Start,
   and produces a `RunRecord` indistinguishable from a direct `POST /runs`.
4. `BACKWARD_COMPATIBILITY.md` §2/§3 entries and `data-gitignore.ts` (`backlog.json` alongside
   `todos.json`) — the new routes and the new state file are both protected/data surfaces that
   need the same documentation the rest of `/api/v1/*` and `.ai/cezar/*` already carry.

### Phase 2: Web — client, composer

5. `createBacklogItem`/`getBacklog`/`removeBacklogItem`/`startBacklogItem` in
   `packages/web/src/api/client.ts`, `useBacklog` + `queryKeys.backlog` in `api/queries.ts`,
   `buildBacklogItemBody` in `new-task-form.ts` (the `buildCreateRunBody` twin, minus
   `variants`/`dispatch`/`todoId`).
6. The composer's "Save to backlog" button (`components/composer/composer.tsx`): an additive
   `onSaveToBacklog` prop sharing the existing optimistic-clear/restore-on-error contract
   `onSubmit` already has, rendered only when a host passes it. `new-task.tsx` wires it, persists
   pasted attachments the same way `submit()` does, and navigates to `/?view=backlog` on success.

### Phase 3: Web — Backlog tab

7. `packages/web/src/routes/backlog-list.tsx` — the `BacklogList` component: title, relative
   created-at, runner/model chips, ▶ Start, delete, empty state.
8. `tasks-overview.tsx` gains a third header tab, layered on top of (never folded into) the
   shared `ListView` the sidebar quick-list also reads, so Active/Archived behavior is unchanged
   whether or not this tab is selected. `TasksOverviewRoute` wires `useBacklog()` plus Start/Delete
   mutations, seeded from the composer's `?view=backlog` redirect.

### Phase 4: Verification and handoff

9. Run the full validation gate (`npm run typecheck`, `npm test`, `npm run build`,
   `npm run test:package`).
10. Open the PR, run the authoritative review pass, apply labels and the summary comment.

## Risks

- **HTTP API surface grows** (`risk-high` per `SDLC.md`'s explicit list) — four new routes, each a
  thin read/write/delegate over `backlog.ts`; `start` is the one genuinely new code path, and it
  is built from the same two helpers `POST /runs` now uses, so it cannot silently diverge from
  what a direct launch does.
- **The attachment-persistence deviation above** (Non-goals) changes the spec's literal Data Model
  line. Flagged explicitly rather than silently narrowed; behavior is equivalent from a user's
  point of view.
- **`ListView` widening temptation.** The Backlog tab is deliberately NOT a third `ListView` value
  (that type is shared with the sidebar quick-list's `groupRuns`/`bucketOf`, which know nothing
  about `BacklogItem`s) — it is a local, orthogonal boolean layered on top in `tasks-overview.tsx`
  only, so the existing Active/Archived row/column logic is provably unchanged.

## Progress

PR: #6

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Backend — module, routes, shared helper

- [x] 1.1 `packages/contract/src/backlog.ts` — schemas and response types — 5ce3a14c
- [x] 1.2 `packages/cezar/src/backlog.ts` + unit tests — 5ce3a14c
- [x] 1.3 `/api/backlog/*` routes + shared `POST /runs` helpers + route tests — 5ce3a14c
- [x] 1.4 `BACKWARD_COMPATIBILITY.md` + `data-gitignore.ts` — 5ce3a14c

### Phase 2: Web — client, composer

- [x] 2.1 `client.ts`/`queries.ts`/`buildBacklogItemBody` — 92d338eb
- [x] 2.2 Composer "Save to backlog" button + `new-task.tsx` wiring + tests — 92d338eb

### Phase 3: Web — Backlog tab

- [x] 3.1 `backlog-list.tsx` — a2a2e797
- [x] 3.2 `tasks-overview.tsx` third tab + `TasksOverviewRoute` wiring + tests — a2a2e797

### Phase 4: Verification and handoff

- [x] 4.1 Full validation gate
- [x] 4.2 PR, review pass, labels, summary comment — review found 4 findings (todoId dropped on
      backlog save, Save-to-backlog offered in Plan-first mode, a single-scalar starting-id race,
      one doc inaccuracy), all fixed — 7f1d8cfa
