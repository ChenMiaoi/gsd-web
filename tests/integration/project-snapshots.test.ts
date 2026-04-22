import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import {
  type HealthResponse,
  type ProjectEventEnvelope,
  type ProjectMutationResponse,
  type ProjectsResponse,
} from '../../src/shared/contracts.js';
import { startServer } from '../../src/server/index.js';
import {
  createEmptyProject,
  createInitializedProject,
  createTempWorkspace,
  createUnreadableProject,
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

async function bootService() {
  const workspace = await createTempWorkspace('gsd-web-snapshots-');
  const clientDistDir = await writeClientShell(workspace.root, 'GSD Web Snapshot Test Shell');
  const databasePath = path.join(workspace.root, 'data', 'gsd-web.sqlite');
  const app = await startServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    clientDistDir,
    logger: false,
  });

  cleanupTasks.push(async () => {
    await app.close();
  });
  cleanupTasks.push(workspace.cleanup);

  return {
    workspace,
    clientDistDir,
    databasePath,
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

describe('project registry and snapshot contracts', () => {
  test('registers empty and initialized-like projects with truthful snapshots and event envelopes', async () => {
    const service = await bootService();
    const events = await openEventStream(`${service.baseUrl}/api/events`);

    expect(events.response.headers.get('content-type')).toContain('text/event-stream');

    const readyEvent = await events.next();
    expect(readyEvent).toMatchObject({
      type: 'service.ready',
      payload: {
        service: 'gsd-web',
        projects: {
          total: 0,
        },
      },
    });

    const emptyProjectPath = await createEmptyProject(service.workspace.root, 'empty-project');
    const emptyRegisterResponse = await postJson(`${service.baseUrl}/api/projects/register`, {
      path: emptyProjectPath,
    });

    expect(emptyRegisterResponse.status).toBe(201);

    const emptyMutation = (await emptyRegisterResponse.json()) as ProjectMutationResponse;
    expect(emptyMutation.project.projectId).toMatch(/^prj_/u);
    expect(emptyMutation.project.snapshot.status).toBe('uninitialized');
    expect(emptyMutation.project.snapshot.directory.isEmpty).toBe(true);
    expect(emptyMutation.project.snapshot.sources.gsdDirectory.state).toBe('missing');
    expect(emptyMutation.project.snapshot.warnings).toEqual([]);
    expect(emptyMutation.event).toMatchObject({
      type: 'project.registered',
      projectId: emptyMutation.project.projectId,
      payload: {
        projectId: emptyMutation.project.projectId,
        snapshotStatus: 'uninitialized',
        warningCount: 0,
        changed: true,
      },
    });

    const emptyStreamEvent = await events.next();
    expect(emptyStreamEvent.id).toBe(emptyMutation.event.id);
    expect(emptyStreamEvent.payload).toMatchObject({
      projectId: emptyMutation.project.projectId,
      snapshotStatus: 'uninitialized',
    });

    const partialProjectPath = await createInitializedProject(service.workspace.root, 'partial-project', {
      projectMdContent: null,
      repoMetaContent: '{"currentBranch":',
      stateMdContent: new Uint8Array([0xc3, 0x28]),
      gsdDbMode: 'corrupt',
    });
    const partialRegisterResponse = await postJson(`${service.baseUrl}/api/projects/register`, {
      path: partialProjectPath,
    });

    expect(partialRegisterResponse.status).toBe(201);

    const partialMutation = (await partialRegisterResponse.json()) as ProjectMutationResponse;
    expect(partialMutation.project.snapshot.status).toBe('degraded');
    expect(partialMutation.project.snapshot.identityHints.gsdId).toBe('gsd-partial-project');
    expect(partialMutation.project.snapshot.sources.gsdDirectory.state).toBe('ok');
    expect(partialMutation.project.snapshot.sources.gsdId.state).toBe('ok');
    expect(partialMutation.project.snapshot.sources.autoLock.state).toBe('ok');
    expect(partialMutation.project.snapshot.sources.projectMd.state).toBe('missing');
    expect(partialMutation.project.snapshot.sources.repoMeta.state).toBe('malformed');
    expect(partialMutation.project.snapshot.sources.stateMd.state).toBe('malformed');
    expect(partialMutation.project.snapshot.sources.gsdDb.state).toBe('malformed');
    expect(partialMutation.project.snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'projectMd', code: 'source_missing' }),
        expect.objectContaining({ source: 'repoMeta', code: 'source_malformed' }),
        expect.objectContaining({ source: 'stateMd', code: 'source_malformed' }),
        expect.objectContaining({ source: 'gsdDb', code: 'source_malformed' }),
      ]),
    );

    const partialStreamEvent = await events.next();
    expect(partialStreamEvent.id).toBe(partialMutation.event.id);
    expect(partialStreamEvent.payload).toMatchObject({
      projectId: partialMutation.project.projectId,
      snapshotStatus: 'degraded',
      warningCount: partialMutation.project.snapshot.warnings.length,
    });

    const listResponse = await fetch(`${service.baseUrl}/api/projects`);
    expect(listResponse.status).toBe(200);

    const projectsList = (await listResponse.json()) as ProjectsResponse;
    expect(projectsList.total).toBe(2);
    expect(projectsList.items.map((project) => project.projectId)).toEqual([
      emptyMutation.project.projectId,
      partialMutation.project.projectId,
    ]);

    const detailResponse = await fetch(`${service.baseUrl}/api/projects/${partialMutation.project.projectId}`);
    expect(detailResponse.status).toBe(200);

    const projectDetail = (await detailResponse.json()) as ProjectMutationResponse['project'];
    expect(projectDetail.lastEventId).toBe(partialMutation.event.id);
    expect(projectDetail.snapshot.status).toBe('degraded');

    const refreshResponse = await postJson(
      `${service.baseUrl}/api/projects/${partialMutation.project.projectId}/refresh`,
    );
    expect(refreshResponse.status).toBe(200);

    const refreshMutation = (await refreshResponse.json()) as ProjectMutationResponse;
    expect(refreshMutation.project.projectId).toBe(partialMutation.project.projectId);
    expect(refreshMutation.project.snapshot.status).toBe('degraded');
    expect(refreshMutation.event).toMatchObject({
      type: 'project.refreshed',
      projectId: partialMutation.project.projectId,
      payload: {
        projectId: partialMutation.project.projectId,
        snapshotStatus: 'degraded',
        changed: false,
      },
    });

    const refreshStreamEvent = await events.next();
    expect(refreshStreamEvent.id).toBe(refreshMutation.event.id);
    expect(refreshStreamEvent.payload).toMatchObject({
      projectId: partialMutation.project.projectId,
      changed: false,
    });

    const healthResponse = await fetch(`${service.baseUrl}/api/health`);
    expect(healthResponse.status).toBe(200);

    const health = (await healthResponse.json()) as HealthResponse;
    expect(health.projects.total).toBe(2);

    await events.close();
  });

  test('rejects malformed registrations and keeps the registry stable', async () => {
    const service = await bootService();
    const validProjectPath = await createEmptyProject(service.workspace.root, 'registered-project');

    const initialRegisterResponse = await postJson(`${service.baseUrl}/api/projects/register`, {
      path: validProjectPath,
    });
    expect(initialRegisterResponse.status).toBe(201);

    const blankPathResponse = await postJson(`${service.baseUrl}/api/projects/register`, {
      path: '   ',
    });
    expect(blankPathResponse.status).toBe(400);
    expect(await blankPathResponse.json()).toMatchObject({
      code: 'invalid_path',
      statusCode: 400,
    });

    const duplicateResponse = await postJson(`${service.baseUrl}/api/projects/register`, {
      path: validProjectPath,
    });
    expect(duplicateResponse.status).toBe(409);
    expect(await duplicateResponse.json()).toMatchObject({
      code: 'duplicate_path',
      statusCode: 409,
    });

    const unreadable = await createUnreadableProject(service.workspace.root, 'unreadable-project');
    cleanupTasks.push(async () => {
      await unreadable.restore();
    });

    const unreadableResponse = await postJson(`${service.baseUrl}/api/projects/register`, {
      path: unreadable.projectRoot,
    });
    expect(unreadableResponse.status).toBe(400);
    expect(await unreadableResponse.json()).toMatchObject({
      code: 'invalid_path',
      statusCode: 400,
    });

    await unreadable.restore();

    const unknownRefreshResponse = await postJson(`${service.baseUrl}/api/projects/does-not-exist/refresh`);
    expect(unknownRefreshResponse.status).toBe(404);
    expect(await unknownRefreshResponse.json()).toMatchObject({
      code: 'project_not_found',
      statusCode: 404,
    });

    const projectsResponse = await fetch(`${service.baseUrl}/api/projects`);
    const projectsList = (await projectsResponse.json()) as ProjectsResponse;
    expect(projectsList.total).toBe(1);
    expect(projectsList.items).toHaveLength(1);
  });
});
