import { z } from 'zod';
import { createRunInputBaseSchema, runRecordSchema } from './runs.ts';

/**
 * The task backlog (spec `.ai/specs/2026-09-19-task-backlog.md`): a project-scoped list of saved
 * task drafts that never enter `RunManager`'s queue/pump path — no worktree, no concurrency slot,
 * no `RunRecord` — until a human clicks "▶ Start". Persisted in a separate `backlog.json`,
 * modeled on `todos.json` (`./skills.ts`'s `todoItemSchema`) rather than a new `RunStatus` value,
 * for the reason that file's own history documents: `runs.json`'s whole-array parse means one
 * status literal an older reader doesn't recognize would silently drop every run in the file.
 */

/**
 * Everything `startRun()` needs, reusing the wire shape `POST /runs` already validates minus
 * `variants`/`dispatch` — Phase 2 (parallel variants / dispatch-tree roots from a backlog item),
 * not in this spec. A backlogged task always starts as one ordinary run.
 */
export const backlogItemInputSchema = createRunInputBaseSchema.omit({ variants: true, dispatch: true });
export type BacklogItemInput = z.infer<typeof backlogItemInputSchema>;

/** One entry of `backlog.json`. `startedRunId` mirrors `todoItemSchema.startedTaskId`: set once
 *  Start turns the item into a run, the entry stays as provenance rather than being deleted, and
 *  the Backlog tab hides it (`GET /api/backlog` excludes started items). */
export const backlogItemSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string(),
  title: z.string().min(1).max(200),
  input: backlogItemInputSchema,
  startedRunId: z.string().optional(),
});
export type BacklogItem = z.infer<typeof backlogItemSchema>;

// ---- wire (`POST /api/backlog`) ------------------------------------------------------------

/**
 * `POST /api/backlog` body — the input shape plus an optional `title` (server defaults it to the
 * same heuristic `makeRunTitle` uses, since the composer's "Save to backlog" button has no title
 * field of its own). The `workflow`/`steps` XOR is enforced here, exactly like `createRunInputSchema`
 * enforces it for `POST /runs` — a backlog item without a resolvable shape could never Start.
 */
export const createBacklogItemSchema = backlogItemInputSchema
  .extend({ title: z.string().trim().min(1).max(200).optional() })
  .refine((b) => Boolean(b.workflow) !== Boolean(b.steps), {
    message: 'provide either "workflow" or "steps", not both',
  });
export type CreateBacklogItemInput = z.input<typeof createBacklogItemSchema>;

// ---- responses -----------------------------------------------------------------------------

/** `GET /api/backlog` — items without `startedRunId`, newest first. */
export type ListBacklogResponse = BacklogItem[];

/** `POST /api/backlog` (201) — the saved item. */
export type CreateBacklogItemResponse = BacklogItem;

/** `DELETE /api/backlog/:id` — the literal `true`; a miss is a 404 `{ error }`, never `{ removed: false }`. */
export const removeBacklogItemResponseSchema = z.object({
  removed: z.literal(true),
});
export type RemoveBacklogItemResponse = z.infer<typeof removeBacklogItemResponseSchema>;

/**
 * `POST /api/backlog/:id/start` (201) — the new `RunRecord`, same shape `POST /runs` answers for
 * a single (non-variant) run: a backlog Start is indistinguishable from a composer Start once it
 * has happened.
 */
export type StartBacklogItemResponse = z.infer<typeof runRecordSchema>;
