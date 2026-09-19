import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { backlogItemSchema, type BacklogItem, type BacklogItemInput } from '@open-mercato/cezar-contract';

/**
 * The task backlog (spec `.ai/specs/2026-09-19-task-backlog.md`): `<dataDir>/backlog.json`, a
 * project-scoped array of saved-but-undispatched task drafts. A structural port of `todos.ts` —
 * the same per-entry-tolerant parsing, the same in-process lock, the same atomic tmp+rename write
 * — but populated by a human directly (the composer's "Save to backlog" button) rather than only
 * by an agent, and with no id-backfill: every entry here is always written by `addBacklogItem`
 * below, never appended raw by another process the way an agent writes `todos.json`.
 */

export function backlogPath(dataDir: string): string {
  return join(dataDir, 'backlog.json');
}

// ---- in-process lock (15-line port of janitor's storage.withLock, same as todos.ts) ---------

const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const next = new Promise<void>((r) => {
    release = r;
  });
  locks.set(key, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

// ---- read / write -----------------------------------------------------------------------------

/** Parse + validate the file. Broken JSON / non-array → []; a malformed entry is skipped with a
 *  warning rather than emptying the whole backlog. */
async function readRaw(dataDir: string): Promise<BacklogItem[]> {
  let raw: string;
  try {
    raw = await fs.readFile(backlogPath(dataDir), 'utf8');
  } catch {
    return []; // no file yet — empty backlog
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] backlog.json is not valid JSON — showing an empty backlog (${message})`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn('[cez] backlog.json is not a JSON array — showing an empty backlog');
    return [];
  }
  const items: BacklogItem[] = [];
  for (const entry of parsed) {
    const result = backlogItemSchema.safeParse(entry);
    if (!result.success) {
      console.warn(`[cez] skipped a malformed backlog.json entry: ${result.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    items.push(result.data);
  }
  return items;
}

async function writeAtomic(dataDir: string, items: BacklogItem[]): Promise<void> {
  const file = backlogPath(dataDir);
  const tmp = `${file}.tmp`;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** Every backlog item, file order — including already-started ones, so `POST …/start`'s
 *  double-start check (`markBacklogItemStarted`) can see them too. The route serving the Backlog
 *  tab (`GET /api/backlog`) is what filters out started items and sorts newest first. */
export async function readBacklog(dataDir: string): Promise<BacklogItem[]> {
  return withLock(dataDir, () => readRaw(dataDir));
}

/** Save a new item. `id`/`createdAt` are minted here — a caller never supplies them. */
export async function addBacklogItem(
  dataDir: string,
  entry: { title: string; input: BacklogItemInput },
): Promise<BacklogItem> {
  return withLock(dataDir, async () => {
    const items = await readRaw(dataDir);
    const item: BacklogItem = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      title: entry.title,
      input: entry.input,
    };
    items.push(item);
    await writeAtomic(dataDir, items);
    return item;
  });
}

/** Delete an item. False when the id isn't there. */
export async function removeBacklogItem(dataDir: string, id: string): Promise<boolean> {
  return withLock(dataDir, async () => {
    const items = await readRaw(dataDir);
    const next = items.filter((item) => item.id !== id);
    if (next.length === items.length) return false;
    await writeAtomic(dataDir, next);
    return true;
  });
}

/** Record that Start turned the entry into run `runId`. The entry stays in the file as
 *  provenance; the Backlog tab hides started entries. First start wins: an entry that already
 *  carries a `startedRunId` is left untouched and answers false, so two concurrent Start calls on
 *  the same id — sharing this lock — cannot both claim it. Mirrors `todos.ts`'s `markStarted`. */
export async function markBacklogItemStarted(dataDir: string, id: string, runId: string): Promise<boolean> {
  return withLock(dataDir, async () => {
    const items = await readRaw(dataDir);
    const item = items.find((entry) => entry.id === id);
    if (!item || item.startedRunId) return false;
    item.startedRunId = runId;
    await writeAtomic(dataDir, items);
    return true;
  });
}
