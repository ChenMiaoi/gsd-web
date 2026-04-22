import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { TextDecoder } from 'node:util';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import type {
  ProjectDetailResponse,
  ProjectEventEnvelope,
  ProjectMutationResponse,
  ProjectTimelineResponse,
} from '../../src/shared/contracts.js';
import { startServer } from '../../src/server/index.js';
import {
  createInitializedProject,
  createTempWorkspace,
  writeClientShell,
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

async function bootService(options: { monitorIntervalMs?: number; watchersEnabled?: boolean } = {}) {
  const workspace = await createTempWorkspace('gsd-web-monitor-reconcile-');
  const clientDistDir = await writeClientShell(workspace.root, 'GSD Web Monitor Reconcile Test Shell');
  const databasePath = path.join(workspace.root, 'data', 'gsd-web.sqlite');
  const app = await startServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    clientDistDir,
    logger: false,
    ...(options.monitorIntervalMs === undefined ? {} : { monitorIntervalMs: options.monitorIntervalMs }),
    ...(options.watchersEnabled === undefined ? {} : { watchersEnabled: options.watchersEnabled }),
  });

  cleanupTasks.push(async () => {
    await app.close();
  });
  cleanupTasks.push(workspace.cleanup);

  return {
    workspace,
    app,
    baseUrl: getBaseUrl(app),
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

async function getTimeline(baseUrl: string, projectId: string): Promise<ProjectTimelineResponse> {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/timeline`);

  if (!response.ok) {
    throw new Error(`Expected project timeline ${projectId}, got ${response.status}`);
  }

  return (await response.json()) as ProjectTimelineResponse;
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

async function openEventStream(url: string) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/event-stream',
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
    response,
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

function lockDatabase(dbPath: string) {
  const database = new DatabaseSync(dbPath);
  let released = false;

  database.exec('BEGIN EXCLUSIVE');

  return {
    release: async () => {
      if (released) {
        return;
      }

      released = true;
      database.exec('ROLLBACK');
      database.close();
    },
  };
}

describe('project monitor reconcile loop', () => {
  test('shares manual and periodic reconcile truth, persists timeline, and preserves the last good snapshot on read failure', async () => {
    const service = await bootService({ monitorIntervalMs: 50, watchersEnabled: false });
    const events = await openEventStream(`${service.baseUrl}/api/events`);
    const readyEvent = await events.next();

    expect(readyEvent.type).toBe('service.ready');

    const projectRoot = await createInitializedProject(service.workspace.root, 'monitor-project');
    const registerResponse = await postJson(`${service.baseUrl}/api/projects/register`, { path: projectRoot });

    expect(registerResponse.status).toBe(201);

    const registerMutation = (await registerResponse.json()) as ProjectMutationResponse;
    const projectId = registerMutation.project.projectId;

    expect(registerMutation.project.monitor).toMatchObject({
      health: 'healthy',
      lastTrigger: 'register',
    });
    expect(registerMutation.event.payload).toMatchObject({
      trigger: 'register',
      monitor: {
        health: 'healthy',
      },
    });

    const registerTimeline = await getTimeline(service.baseUrl, projectId);
    expect(registerTimeline.total).toBe(1);
    expect(registerTimeline.items[0]).toMatchObject({
      type: 'registered',
      trigger: 'register',
      monitorHealth: 'healthy',
    });

    const manualRefreshResponse = await postJson(`${service.baseUrl}/api/projects/${projectId}/refresh`);
    expect(manualRefreshResponse.status).toBe(200);

    const manualRefresh = (await manualRefreshResponse.json()) as ProjectMutationResponse;
    expect(manualRefresh.event.type).toBe('project.refreshed');
    expect(manualRefresh.event.payload).toMatchObject({
      trigger: 'manual_refresh',
      changed: false,
      monitor: {
        health: 'healthy',
      },
    });
    expect(manualRefresh.project.monitor.lastTrigger).toBe('manual_refresh');

    const repoMetaPath = path.join(projectRoot, '.gsd', 'repo-meta.json');
    await writeFile(repoMetaPath, '{"currentBranch":');

    const degradedProject = await waitForProject(
      service.baseUrl,
      projectId,
      (project) => project.snapshot.status === 'degraded' && project.monitor.health === 'degraded',
    );

    expect(degradedProject.monitor.lastTrigger).toBe('monitor_interval');
    expect(degradedProject.snapshot.sources.repoMeta.state).toBe('malformed');

    const degradedEvent = await waitForEvent(
      events,
      (event) =>
        event.projectId === projectId
        && event.type === 'project.refreshed'
        && (event.payload as Record<string, unknown>).trigger === 'monitor_interval'
        && (event.payload as Record<string, unknown>).snapshotStatus === 'degraded',
    );
    expect(degradedEvent.type).toBe('project.refreshed');

    const degradedTimeline = await getTimeline(service.baseUrl, projectId);
    expect(
      degradedTimeline.items.some(
        (entry) => entry.type === 'monitor_degraded' && entry.trigger === 'monitor_interval',
      ),
    ).toBe(true);

    await writeFile(
      repoMetaPath,
      `${JSON.stringify(
        {
          projectName: 'monitor-project',
          currentBranch: 'main',
          headSha: 'feedbeef1234567',
          repoFingerprint: 'monitor-project-fingerprint',
          dirty: false,
        },
        null,
        2,
      )}\n`,
    );

    const recoveredProject = await waitForProject(
      service.baseUrl,
      projectId,
      (project) => project.snapshot.status === 'initialized' && project.monitor.health === 'healthy',
    );
    const snapshotCheckedAtBeforeFailure = recoveredProject.snapshot.checkedAt;
    const lastSuccessfulAtBeforeFailure = recoveredProject.monitor.lastSuccessfulAt;

    expect(recoveredProject.monitor.lastError).toBeNull();

    const recoveredTimeline = await getTimeline(service.baseUrl, projectId);
    expect(
      recoveredTimeline.items.some(
        (entry) => entry.type === 'monitor_recovered' && entry.trigger === 'monitor_interval',
      ),
    ).toBe(true);

    const dbLock = lockDatabase(path.join(projectRoot, '.gsd', 'gsd.db'));
    cleanupTasks.push(dbLock.release);

    const failedProject = await waitForProject(
      service.baseUrl,
      projectId,
      (project) => project.monitor.health === 'read_failed' && project.monitor.lastError?.scope === 'gsdDb',
    );

    expect(failedProject.snapshot.status).toBe('initialized');
    expect(failedProject.snapshot.checkedAt).toBe(snapshotCheckedAtBeforeFailure);
    expect(failedProject.monitor.lastSuccessfulAt).toBe(lastSuccessfulAtBeforeFailure);
    expect(failedProject.monitor.lastError?.message).toMatch(/gsd\.db/i);

    const failedEvent = await waitForEvent(
      events,
      (event) =>
        event.projectId === projectId
        && event.type === 'project.monitor.updated'
        && (event.payload as Record<string, unknown>).trigger === 'monitor_interval'
        && (event.payload as { monitor?: { health?: string } }).monitor?.health === 'read_failed',
    );
    expect(failedEvent.type).toBe('project.monitor.updated');

    const failedTimeline = await getTimeline(service.baseUrl, projectId);
    expect(
      failedTimeline.items.some(
        (entry) =>
          entry.type === 'monitor_degraded'
          && entry.monitorHealth === 'read_failed'
          && entry.error?.scope === 'gsdDb',
      ),
    ).toBe(true);

    await dbLock.release();

    const recoveredFromFailure = await waitForProject(
      service.baseUrl,
      projectId,
      (project) =>
        project.monitor.health === 'healthy'
        && project.monitor.lastError === null
        && project.monitor.lastSuccessfulAt !== lastSuccessfulAtBeforeFailure,
    );

    expect(recoveredFromFailure.snapshot.checkedAt).toBe(snapshotCheckedAtBeforeFailure);

    const recoveredMonitorEvent = await waitForEvent(
      events,
      (event) =>
        event.projectId === projectId
        && event.type === 'project.monitor.updated'
        && (event.payload as Record<string, unknown>).trigger === 'monitor_interval'
        && (event.payload as { previousHealth?: string | null }).previousHealth === 'read_failed'
        && (event.payload as { monitor?: { health?: string } }).monitor?.health === 'healthy',
    );
    expect(recoveredMonitorEvent.type).toBe('project.monitor.updated');

    const recoveredFailureTimeline = await getTimeline(service.baseUrl, projectId);
    expect(
      recoveredFailureTimeline.items.some(
        (entry) => entry.type === 'monitor_recovered' && entry.trigger === 'monitor_interval',
      ),
    ).toBe(true);

    await events.close();
  });
});
