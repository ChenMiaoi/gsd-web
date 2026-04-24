import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import type {
  ProjectDetailResponse,
  ProjectEventEnvelope,
  ProjectMutationResponse,
} from '../../src/shared/contracts.js';
import { startServer } from '../../src/server/index.js';
import type { RuntimeSignal } from '../../src/server/app.js';
import {
  applyProjectMutationsBurst,
  createInitializedProject,
  createTempWorkspace,
  writeClientShell,
  writeRepoMeta,
} from '../helpers/project-fixtures.js';

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const cleanup = cleanupTasks.pop();

    if (cleanup) {
      await cleanup();
    }
  }
});

function getBaseUrl(app: FastifyInstance) {
  const address = app.server.address() as AddressInfo | null;

  if (!address || typeof address === 'string') {
    throw new Error('Expected the Fastify app to listen on a TCP port');
  }

  return `http://127.0.0.1:${address.port}`;
}

async function bootService(options: { monitorIntervalMs?: number } = {}) {
  const workspace = await createTempWorkspace('gsd-web-monitor-watcher-');
  const clientDistDir = await writeClientShell(workspace.root, 'GSD Web Monitor Watcher Test Shell');
  const databasePath = path.join(workspace.root, 'data', 'gsd-web.sqlite');
  const runtimeSignals: RuntimeSignal[] = [];
  const app = await startServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    clientDistDir,
    logger: false,
    logSink: (signal) => {
      runtimeSignals.push(signal);
    },
    ...(options.monitorIntervalMs === undefined ? {} : { monitorIntervalMs: options.monitorIntervalMs }),
  });

  cleanupTasks.push(async () => {
    await app.close();
  });
  cleanupTasks.push(workspace.cleanup);

  return {
    workspace,
    app,
    baseUrl: getBaseUrl(app),
    runtimeSignals,
  };
}

async function postJson(url: string, body?: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function getProject(baseUrl: string, projectId: string): Promise<ProjectDetailResponse> {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}`);

  if (!response.ok) {
    throw new Error(`Expected project detail ${projectId}, got ${response.status}`);
  }

  return (await response.json()) as ProjectDetailResponse;
}

async function waitForProject(
  baseUrl: string,
  projectId: string,
  predicate: (project: ProjectDetailResponse) => boolean,
  timeoutMs: number = 5_000,
): Promise<ProjectDetailResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastProject: ProjectDetailResponse | null = null;

  while (Date.now() < deadline) {
    lastProject = await getProject(baseUrl, projectId);

    if (predicate(lastProject)) {
      return lastProject;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `Timed out waiting for project ${projectId}. Last state: ${JSON.stringify(lastProject?.monitor ?? null)}`,
  );
}

function normalizeSseBuffer(buffer: string) {
  return buffer.replace(/\r\n/g, '\n');
}

async function openEventStream(url: string, options: { lastEventId?: string } = {}) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/event-stream',
      ...(options.lastEventId ? { 'last-event-id': options.lastEventId } : {}),
    },
  });

  if (!response.ok || response.body === null) {
    throw new Error(`Failed to open event stream: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function next(timeoutMs: number = 2_000): Promise<ProjectEventEnvelope> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const separatorIndex = buffer.indexOf('\n\n');

      if (separatorIndex >= 0) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        if (rawEvent.startsWith(':')) {
          continue;
        }

        const dataLine = rawEvent
          .split('\n')
          .find((line) => line.startsWith('data: '));

        if (!dataLine) {
          continue;
        }

        return JSON.parse(dataLine.slice(6)) as ProjectEventEnvelope;
      }

      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        throw new Error('Timed out waiting for SSE event');
      }

      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Timed out waiting for SSE event')), remainingMs);
        }),
      ]);

      if (result.done) {
        throw new Error('Event stream closed before the next event was received');
      }

      buffer += normalizeSseBuffer(decoder.decode(result.value, { stream: true }));
    }
  }

  return {
    next,
    close: async () => {
      await reader.cancel();
    },
  };
}

async function waitForEvent(
  stream: Awaited<ReturnType<typeof openEventStream>>,
  predicate: (event: ProjectEventEnvelope) => boolean,
  timeoutMs: number = 5_000,
): Promise<ProjectEventEnvelope> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const event = await stream.next(deadline - Date.now());

    if (predicate(event)) {
      return event;
    }
  }

  throw new Error('Timed out waiting for matching SSE event');
}

async function expectNoEvent(
  stream: Awaited<ReturnType<typeof openEventStream>>,
  timeoutMs: number,
) {
  await expect(stream.next(timeoutMs)).rejects.toThrow(/Timed out waiting for SSE event/i);
}

async function waitForRuntimeSignal(
  runtimeSignals: RuntimeSignal[],
  predicate: (signal: RuntimeSignal) => boolean,
  timeoutMs: number = 5_000,
): Promise<RuntimeSignal> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const match = runtimeSignals.find(predicate);

    if (match) {
      return match;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('Timed out waiting for runtime signal');
}

describe('project monitor watcher scheduling', () => {
  test('reconciles watcher hints quickly, coalesces bursts, and replays sparse watcher events after reconnect', async () => {
    const service = await bootService({ monitorIntervalMs: 10_000 });
    const events = await openEventStream(`${service.baseUrl}/api/events`);
    const readyEvent = await events.next();

    expect(readyEvent.type).toBe('service.ready');

    const invalidReplayResponse = await fetch(`${service.baseUrl}/api/events?lastEventId=bad-replay-id`, {
      headers: {
        accept: 'text/event-stream',
      },
    });

    expect(invalidReplayResponse.status).toBe(400);
    expect(await invalidReplayResponse.json()).toMatchObject({
      code: 'invalid_last_event_id',
      statusCode: 400,
    });

    const projectRoot = await createInitializedProject(service.workspace.root, 'watcher-project');
    const registerResponse = await postJson(`${service.baseUrl}/api/projects/register`, { path: projectRoot });

    expect(registerResponse.status).toBe(201);

    const registerMutation = (await registerResponse.json()) as ProjectMutationResponse;
    const projectId = registerMutation.project.projectId;

    await waitForRuntimeSignal(
      service.runtimeSignals,
      (signal) =>
        signal.event === 'project_watcher'
        && signal.phase === 'attached'
        && signal.projectId === projectId,
    );

    const sqliteArtifactSignalStart = service.runtimeSignals.length;
    await writeFile(path.join(projectRoot, '.gsd', 'gsd.db-shm'), 'sqlite transient state\n');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      service.runtimeSignals
        .slice(sqliteArtifactSignalStart)
        .some(
          (signal) =>
            signal.event === 'project_watcher'
            && signal.phase === 'hint'
            && signal.projectId === projectId
            && signal.relativePath === '.gsd/gsd.db-shm',
        ),
    ).toBe(false);

    const degradedRepoMeta = '{"currentBranch":';
    await writeRepoMeta(projectRoot, degradedRepoMeta);

    const degradedProject = await waitForProject(
      service.baseUrl,
      projectId,
      (project) => project.snapshot.status === 'degraded' && project.monitor.lastTrigger === 'watcher',
    );

    expect(degradedProject.snapshot.sources.repoMeta.state).toBe('malformed');

    const degradedEvent = await waitForEvent(
      events,
      (event) =>
        event.projectId === projectId
        && event.type === 'project.refreshed'
        && (event.payload as Record<string, unknown>).trigger === 'watcher'
        && (event.payload as Record<string, unknown>).snapshotStatus === 'degraded',
    );

    expect(degradedEvent.payload).toMatchObject({
      changed: true,
      trigger: 'watcher',
    });

    expect(
      service.runtimeSignals.some(
        (signal) =>
          signal.event === 'project_watcher'
          && signal.phase === 'hint'
          && signal.projectId === projectId
          && signal.relativePath === '.gsd/repo-meta.json',
      ),
    ).toBe(true);

    const burstSignalStart = service.runtimeSignals.length;
    const recoveredRepoMeta = {
      projectName: 'watcher-project',
      currentBranch: 'burst-3',
      headSha: 'feedbeef1234567',
      repoFingerprint: 'watcher-project-fingerprint',
      dirty: false,
    };

    await applyProjectMutationsBurst(
      projectRoot,
      [
        {
          relativePath: '.gsd/repo-meta.json',
          content: `${JSON.stringify({ ...recoveredRepoMeta, currentBranch: 'burst-1' }, null, 2)}\n`,
        },
        {
          relativePath: '.gsd/repo-meta.json',
          content: `${JSON.stringify({ ...recoveredRepoMeta, currentBranch: 'burst-2' }, null, 2)}\n`,
        },
        {
          relativePath: '.gsd/repo-meta.json',
          content: `${JSON.stringify(recoveredRepoMeta, null, 2)}\n`,
        },
      ],
      { delayMs: 5 },
    );

    const recoveredProject = await waitForProject(
      service.baseUrl,
      projectId,
      (project) =>
        project.snapshot.status === 'initialized'
        && project.monitor.lastTrigger === 'watcher'
        && project.snapshot.sources.repoMeta.value?.currentBranch === 'burst-3',
    );

    const recoveredEvent = await waitForEvent(
      events,
      (event) =>
        event.projectId === projectId
        && event.type === 'project.refreshed'
        && (event.payload as Record<string, unknown>).trigger === 'watcher'
        && (event.payload as Record<string, unknown>).snapshotStatus === 'initialized',
    );

    expect(recoveredEvent.payload).toMatchObject({
      changed: true,
      trigger: 'watcher',
    });

    const burstSignals = service.runtimeSignals.slice(burstSignalStart);
    expect(
      burstSignals.filter(
        (signal) => signal.event === 'project_watcher' && signal.phase === 'hint' && signal.projectId === projectId,
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      burstSignals.filter(
        (signal) =>
          signal.event === 'project_reconcile'
          && signal.phase === 'completed'
          && signal.projectId === projectId
          && signal.trigger === 'watcher'
          && signal.emittedEventType === 'project.refreshed',
      ).length,
    ).toBe(1);

    const lastAttemptedAtBeforeNoOp = recoveredProject.monitor.lastAttemptedAt;
    await writeRepoMeta(projectRoot, `${JSON.stringify(recoveredRepoMeta, null, 2)}\n`);

    await waitForProject(
      service.baseUrl,
      projectId,
      (project) =>
        project.monitor.lastTrigger === 'watcher'
        && project.monitor.lastAttemptedAt !== null
        && project.monitor.lastAttemptedAt !== lastAttemptedAtBeforeNoOp,
    );

    await events.close();

    await writeRepoMeta(projectRoot, degradedRepoMeta);

    await waitForProject(
      service.baseUrl,
      projectId,
      (project) =>
        project.snapshot.status === 'degraded'
        && project.monitor.lastTrigger === 'watcher'
        && project.snapshot.checkedAt !== recoveredProject.snapshot.checkedAt,
    );

    const replay = await openEventStream(`${service.baseUrl}/api/events`, {
      lastEventId: recoveredEvent.id,
    });
    const replayedEvent = await replay.next();

    expect(replayedEvent).toMatchObject({
      projectId,
      type: 'project.refreshed',
      payload: {
        changed: true,
        trigger: 'watcher',
        snapshotStatus: 'degraded',
      },
    });

    await expectNoEvent(replay, 400);

    await replay.close();
  });
});
