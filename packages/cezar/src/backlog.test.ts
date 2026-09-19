import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addBacklogItem,
  backlogPath,
  markBacklogItemStarted,
  readBacklog,
  removeBacklogItem,
} from './backlog.ts';
import type { BacklogItemInput } from '@open-mercato/cezar-contract';

// `systemPrompt` is a required-but-possibly-undefined key on this OUTPUT type (the transform
// behind `createRunInputBaseSchema.systemPrompt` widens `?:` to `string | undefined` rather than
// dropping the key) — present here so this literal matches what `backlogItemSchema.safeParse`
// actually produces.
const input: BacklogItemInput = {
  task: 'write the release notes',
  workflow: 'quick-task',
  systemPrompt: undefined,
};

describe('backlog.ts (spec 2026-09-19-task-backlog)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-backlog-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips a saved item', async () => {
    const saved = await addBacklogItem(dataDir, { title: 'Release notes', input });
    expect(saved.id).toBeTruthy();
    expect(saved.createdAt).toBeTruthy();
    expect(saved.startedRunId).toBeUndefined();

    const items = await readBacklog(dataDir);
    expect(items).toEqual([saved]);
  });

  it('skips a malformed entry instead of dropping the whole file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const good = await addBacklogItem(dataDir, { title: 'Keep me', input });
    const raw = JSON.parse(await fs.readFile(backlogPath(dataDir), 'utf8')) as unknown[];
    raw.push({ id: 'broken', createdAt: 'x' }); // missing required `title`/`input`
    await fs.writeFile(backlogPath(dataDir), JSON.stringify(raw, null, 2), 'utf8');

    const items = await readBacklog(dataDir);
    expect(items).toEqual([good]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed backlog.json entry'));
    warn.mockRestore();
  });

  it('degrades to an empty backlog on broken JSON rather than throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(backlogPath(dataDir), '{not json', 'utf8');
    await expect(readBacklog(dataDir)).resolves.toEqual([]);
    warn.mockRestore();
  });

  it('removeBacklogItem deletes an existing item and is idempotent on a second call', async () => {
    const saved = await addBacklogItem(dataDir, { title: 'Gone soon', input });
    await expect(removeBacklogItem(dataDir, saved.id)).resolves.toBe(true);
    await expect(readBacklog(dataDir)).resolves.toEqual([]);
    await expect(removeBacklogItem(dataDir, saved.id)).resolves.toBe(false);
  });

  it('removeBacklogItem answers false for an unknown id', async () => {
    await expect(removeBacklogItem(dataDir, 'nope')).resolves.toBe(false);
  });

  it('markBacklogItemStarted stamps the item once — first start wins', async () => {
    const saved = await addBacklogItem(dataDir, { title: 'Start me', input });
    await expect(markBacklogItemStarted(dataDir, saved.id, 'run-1')).resolves.toBe(true);
    const [after] = await readBacklog(dataDir);
    expect(after?.startedRunId).toBe('run-1');

    // A second start on the same id must not overwrite the first run's provenance.
    await expect(markBacklogItemStarted(dataDir, saved.id, 'run-2')).resolves.toBe(false);
    const [unchanged] = await readBacklog(dataDir);
    expect(unchanged?.startedRunId).toBe('run-1');
  });

  it('markBacklogItemStarted answers false for an unknown id', async () => {
    await expect(markBacklogItemStarted(dataDir, 'nope', 'run-1')).resolves.toBe(false);
  });

  it('serializes concurrent writes under the per-dataDir lock — no lost update', async () => {
    const saves = await Promise.all(
      Array.from({ length: 8 }, (_, i) => addBacklogItem(dataDir, { title: `Task ${i}`, input })),
    );
    expect(new Set(saves.map((s) => s.id)).size).toBe(8); // every id distinct
    const items = await readBacklog(dataDir);
    expect(items).toHaveLength(8);
  });
});
