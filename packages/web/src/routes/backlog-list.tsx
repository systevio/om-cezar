import { ArchiveIcon, PlayIcon, Trash2Icon } from 'lucide-react'
import type { BacklogItem } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { shortAge } from '@/lib/format'

/**
 * The Backlog tab (spec `.ai/specs/2026-09-19-task-backlog.md`): a flat list of saved-but-
 * undispatched task drafts — title, relative created-at, runner/model chips, "▶ Start" and
 * delete. Deliberately NOT `taskTreeRows`/the Active-Archived table: a backlog item is not a
 * `RunRecord` and has no worktree/diff/cost/steps yet (spec Q4) — those columns render only once
 * Start turns it into a real run.
 */
export function BacklogList({
  items,
  onStart,
  onDelete,
  startingIds,
  now = Date.now(),
}: {
  /** `undefined` while `GET /api/backlog` has not answered yet — the list renders nothing rather
   *  than a false empty state. */
  items: BacklogItem[] | undefined
  onStart: (id: string) => void
  onDelete: (id: string) => void
  /**
   * Every item currently mid-Start — a SET, not a single id, so starting item B while item A's
   * request is still in flight cannot re-enable A's row (a scalar "the one starting id" would:
   * setting it to B un-disables A even though A's own request hasn't settled, and a quick second
   * click on A would race the server's own documented double-Start window).
   */
  startingIds?: ReadonlySet<string>
  now?: number
}) {
  if (items === undefined) return null
  if (items.length === 0) {
    return (
      <div data-slot="backlog-empty" className="flex flex-1 flex-col">
        <CenteredState
          heading="h2"
          icon={<ArchiveIcon />}
          tone="neutral"
          title="Nothing backlogged yet"
          subtitle="Save a task from the composer to come back to it later — it costs no worktree or slot until you start it."
        />
      </div>
    )
  }
  return (
    <ul data-slot="backlog-list" className="flex flex-col gap-1.5">
      {items.map((item) => {
        const busy = startingIds?.has(item.id) ?? false
        return (
          <li
            key={item.id}
            data-slot="backlog-row"
            className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-medium text-foreground">{item.title}</p>
              <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-soft-foreground">
                <span>{shortAge(item.createdAt, now)}</span>
                {item.input.runner ? <BacklogChip>{item.input.runner}</BacklogChip> : null}
                {item.input.model ? <BacklogChip>{item.input.model}</BacklogChip> : null}
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-slot="backlog-start"
              disabled={busy}
              onClick={() => onStart(item.id)}
              className="h-8 gap-1.5 px-2.5 text-xs font-medium"
            >
              <PlayIcon aria-hidden="true" className="size-3.5" />
              Start
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Delete"
              title="Delete"
              data-slot="backlog-delete"
              disabled={busy}
              onClick={() => onDelete(item.id)}
            >
              <Trash2Icon aria-hidden="true" className="size-3.5" />
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

/** A `BranchChip`-styled tag (`tasks-overview.tsx`) for a backlog row's runner/model — the same
 *  visual grammar the table already uses for a small monospace fact. */
function BacklogChip({ children }: { children: string }) {
  return (
    <span className="rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
      {children}
    </span>
  )
}
