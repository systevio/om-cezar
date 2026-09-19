import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import type { BacklogItem } from '@open-mercato/cezar-contract';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * `/api/v1/backlog/*` (spec `.ai/specs/2026-09-19-task-backlog.md`): saved-but-undispatched task
 * drafts. `POST …/:id/start` must reconstruct the identical `StartRunInput` `POST /runs` would
 * build and hand it to the same `manager.startRun()` — captured here with the
 * `todos-start.test.ts` stub pattern — and never touch `runs.json`/`RunRecord` before that.
 */
describe('/api/v1/backlog', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  let captured: { workflow: WorkflowDef; input: StartRunInput } | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-backlog-api-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    captured = undefined;
    const manager = {
      startRun: (workflow: WorkflowDef, input: StartRunInput) => {
        captured = { workflow, input };
        return store.createRun({ title: 't', workflow: workflow.name, task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const create = (body: unknown) =>
    apiRequest(app, '/api/v1/backlog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const list = () => apiRequest(app, '/api/v1/backlog');
  const remove = (id: string) =>
    apiRequest(app, `/api/v1/backlog/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const start = (id: string) =>
    apiRequest(app, `/api/v1/backlog/${encodeURIComponent(id)}/start`, { method: 'POST' });

  // ---- POST /backlog ---------------------------------------------------------------------------

  it('saves an item and defaults its title from the task text', async () => {
    const res = await create({ task: 'Fix the login bug', workflow: 'quick-task' });
    expect(res.status).toBe(201);
    const item = (await res.json()) as BacklogItem;
    expect(item.id).toBeTruthy();
    expect(item.title).toBe('Fix the login bug');
    expect(item.input).toMatchObject({ task: 'Fix the login bug', workflow: 'quick-task' });
    expect(item.startedRunId).toBeUndefined();
    expect(captured).toBeUndefined(); // saving never dispatches
  });

  it('keeps an explicit title over the default heuristic', async () => {
    const res = await create({ task: 'Fix the login bug', workflow: 'quick-task', title: 'My title' });
    const item = (await res.json()) as BacklogItem;
    expect(item.title).toBe('My title');
  });

  it('400s a body naming neither workflow nor steps', async () => {
    const res = await create({ task: 'no source' });
    expect(res.status).toBe(400);
  });

  it('400s a body naming both workflow and steps', async () => {
    const res = await create({
      task: 'both',
      workflow: 'quick-task',
      steps: [{ id: 'task', name: 'task', skill: 'x', prompt: '{{task}}' }],
    });
    expect(res.status).toBe(400);
  });

  it('never touches runs.json — saving stays off the queue', async () => {
    await create({ task: 'quiet task', workflow: 'quick-task' });
    expect(() => readFileSync(join(dataDir, 'runs.json'), 'utf8')).toThrow();
  });

  // ---- GET /backlog -----------------------------------------------------------------------------

  it('lists saved items newest first and excludes started ones', async () => {
    const first = (await (await create({ task: 'first', workflow: 'quick-task' })).json()) as BacklogItem;
    const second = (await (await create({ task: 'second', workflow: 'quick-task' })).json()) as BacklogItem;
    await start(second.id);

    const res = await list();
    const items = (await res.json()) as BacklogItem[];
    expect(items.map((i) => i.id)).toEqual([first.id]);
  });

  // ---- DELETE /backlog/:id -----------------------------------------------------------------------

  it('deletes an item; a second delete 404s', async () => {
    const item = (await (await create({ task: 'to delete', workflow: 'quick-task' })).json()) as BacklogItem;
    const res = await remove(item.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    expect((await remove(item.id)).status).toBe(404);
  });

  it('404s deleting an unknown id', async () => {
    expect((await remove('nope')).status).toBe(404);
  });

  // ---- POST /backlog/:id/start -------------------------------------------------------------------

  it('404s starting an unknown id', async () => {
    expect((await start('nope')).status).toBe(404);
    expect(captured).toBeUndefined();
  });

  it('reuses the same 400 POST /runs gives for a workflow that no longer resolves', async () => {
    const item = (await (await create({ task: 'renamed later', workflow: 'quick-task' })).json()) as BacklogItem;
    // Rewrite the stored item's workflow name to one that will not resolve at Start time — the
    // edge case the spec names explicitly ("Workflow no longer resolves at Start time").
    const raw = JSON.parse(readFileSync(join(dataDir, 'backlog.json'), 'utf8')) as BacklogItem[];
    raw[0]!.input.workflow = 'deleted-workflow';
    await import('node:fs/promises').then((fsp) =>
      fsp.writeFile(join(dataDir, 'backlog.json'), JSON.stringify(raw, null, 2), 'utf8'),
    );

    const res = await start(item.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown workflow: deleted-workflow' });
    expect(captured).toBeUndefined();
  });

  it('starts an item: creates a run indistinguishable from a direct POST /runs, stamps startedRunId', async () => {
    const item = (await (await create({
      task: 'ship it',
      workflow: 'quick-task',
      model: 'sonnet',
    })).json()) as BacklogItem;

    const res = await start(item.id);
    expect(res.status).toBe(201);
    const run = (await res.json()) as { id: string; task: string };
    expect(run.task).toBe('ship it');
    expect(captured?.workflow.name).toBe('quick-task');
    expect(captured?.input).toMatchObject({ task: 'ship it', model: 'sonnet' });

    // The item leaves the Backlog tab's list once started.
    expect((await (await list()).json()) as BacklogItem[]).toEqual([]);
  });

  it('409s a double Start — the run is not created twice', async () => {
    const item = (await (await create({ task: 'once only', workflow: 'quick-task' })).json()) as BacklogItem;
    const first = await start(item.id);
    expect(first.status).toBe(201);
    captured = undefined;

    const second = await start(item.id);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'already started' });
    expect(captured).toBeUndefined();
  });
});
