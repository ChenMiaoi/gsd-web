import path from 'node:path';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import type {
  ProjectMutationResponse,
  ProjectRecord,
  ProjectTimelineResponse,
} from '../../src/shared/contracts.js';
import { startServer } from '../../src/server/index.js';
import type { InitRunResult, RunOfficialInitOptions } from '../../src/server/init-jobs.js';
import type { ProjectInitRunner } from '../../src/server/routes/projects.js';
import { BOOTSTRAP_REQUIRED_ENTRIES } from '../../src/server/snapshots.js';
import {
  createEmptyProject,
  createInitializedProject,
  createSnapshotCompleteBootstrap,
  createTempWorkspace,
  moveProjectRoot,
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

async function bootService(options: { initRunner?: ProjectInitRunner; monitorIntervalMs?: number } = {}) {
  const workspace = await createTempWorkspace('gsd-web-continuity-routes-');
  const clientDistDir = await writeClientShell(workspace.root, 'GSD Web Continuity Route Test Shell');
  const databasePath = path.join(workspace.root, 'data', 'gsd-web.sqlite');
  const app = await startServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    clientDistDir,
    logger: false,
    ...(options.initRunner === undefined ? {} : { initRunner: options.initRunner }),
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
  };
}

async function postJson(url: string, body?: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function getProject(baseUrl: string, projectId: string): Promise<ProjectRecord> {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}`);

  if (!response.ok) {
    throw new Error(`Expected project detail ${projectId}, got ${response.status}`);
  }

  return (await response.json()) as ProjectRecord;
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
  predicate: (project: ProjectRecord) => boolean,
  timeoutMs: number = 5_000,
): Promise<ProjectRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastProject: ProjectRecord | null = null;

  while (Date.now() < deadline) {
    lastProject = await getProject(baseUrl, projectId);

    if (predicate(lastProject)) {
      return lastProject;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `Timed out waiting for project ${projectId}. Last state: ${JSON.stringify(lastProject?.continuity ?? null)}`,
  );
}

async function materializeInitializedBootstrap(projectRoot: string) {
  await createSnapshotCompleteBootstrap(projectRoot);
}

function emitStage(
  options: RunOfficialInitOptions | undefined,
  update: Parameters<NonNullable<RunOfficialInitOptions['onStage']>>[0],
) {
  options?.onStage?.(update);
}

function buildCompletedResult(projectRoot: string): InitRunResult {
  return {
    outcome: 'completed',
    stage: 'completed',
    bootstrap: {
      state: 'complete',
      projectRoot,
      gsdRootPath: path.join(projectRoot, '.gsd'),
      detail: 'Project-owned .gsd contains the required bootstrap surfaces.',
      presentEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
      missingEntries: [],
      requiredEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
    },
    promptHistory: [],
    lastMatchedPrompt: null,
    outputExcerpt: 'Official init completed through the supported dashboard path.',
    errorDetail: null,
    exitCode: 0,
    signal: null,
  };
}

function createSuccessfulInitRunner(): ProjectInitRunner {
  return async (projectRoot, options) => {
    emitStage(options, {
      stage: 'starting',
      matchedPrompt: null,
      excerpt: 'Launching init',
      detail: 'Launching the official init wizard.',
      emittedAt: new Date().toISOString(),
    });
    emitStage(options, {
      stage: 'project_setup',
      matchedPrompt: null,
      excerpt: 'Project Setup',
      detail: 'Accepted the supported Project Setup step.',
      emittedAt: new Date().toISOString(),
    });

    await materializeInitializedBootstrap(projectRoot);

    emitStage(options, {
      stage: 'verifying_bootstrap',
      matchedPrompt: null,
      excerpt: 'Verifying bootstrap',
      detail: 'Verified the bootstrap-complete .gsd surface.',
      emittedAt: new Date().toISOString(),
    });

    return buildCompletedResult(projectRoot);
  };
}

describe('project continuity routes', () => {
  test('relinks the existing project id after path loss and retains init history and continuity timeline', async () => {
    const service = await bootService({
      initRunner: createSuccessfulInitRunner(),
      monitorIntervalMs: 50,
    });
    const projectRoot = await createEmptyProject(service.workspace.root, 'continuity-route-source');

    const registerResponse = await postJson(`${service.baseUrl}/api/projects/register`, { path: projectRoot });
    expect(registerResponse.status).toBe(201);

    const registerMutation = (await registerResponse.json()) as ProjectMutationResponse;
    const projectId = registerMutation.project.projectId;

    const initResponse = await postJson(`${service.baseUrl}/api/projects/${projectId}/init`);
    expect(initResponse.status).toBe(202);

    const initializedProject = await waitForProject(
      service.baseUrl,
      projectId,
      (project) => project.latestInitJob?.stage === 'succeeded' && project.snapshot.status === 'initialized',
    );

    expect(initializedProject.latestInitJob?.history.at(-1)?.stage).toBe('succeeded');

    const movedProjectRoot = path.join(service.workspace.root, 'continuity-route-moved');
    await moveProjectRoot(projectRoot, movedProjectRoot);

    const pathLostProject = await waitForProject(
      service.baseUrl,
      projectId,
      (project) => project.continuity?.state === 'path_lost' && project.monitor.health === 'read_failed',
    );

    expect(pathLostProject.snapshot.status).toBe('initialized');
    expect(pathLostProject.latestInitJob?.stage).toBe('succeeded');
    expect(pathLostProject.continuity?.pathLostAt).toBeTruthy();

    const relinkResponse = await postJson(`${service.baseUrl}/api/projects/${projectId}/relink`, {
      path: movedProjectRoot,
    });
    expect(relinkResponse.status).toBe(200);

    const relinkMutation = (await relinkResponse.json()) as ProjectMutationResponse;
    expect(relinkMutation.project.projectId).toBe(projectId);
    expect(relinkMutation.event).toMatchObject({
      type: 'project.relinked',
      payload: {
        projectId,
        canonicalPath: movedProjectRoot,
        previousCanonicalPath: projectRoot,
      },
    });

    const recoveredProject = await waitForProject(
      service.baseUrl,
      projectId,
      (project) =>
        project.canonicalPath === movedProjectRoot
        && project.continuity?.state === 'tracked'
        && project.continuity?.lastRelinkedAt !== null
        && project.monitor.health === 'healthy',
    );

    expect(recoveredProject.latestInitJob?.stage).toBe('succeeded');
    expect(recoveredProject.continuity).toMatchObject({
      state: 'tracked',
      previousCanonicalPath: projectRoot,
    });
    expect(['relink', 'monitor_interval']).toContain(recoveredProject.monitor.lastTrigger);

    const timeline = await getTimeline(service.baseUrl, projectId);
    expect(timeline.items.some((entry) => entry.type === 'path_lost')).toBe(true);
    expect(timeline.items.some((entry) => entry.type === 'relinked')).toBe(true);
    expect(
      timeline.items.some((entry) => entry.type === 'monitor_recovered' && entry.trigger === 'relink'),
    ).toBe(true);
  });

  test('rejects relink attempts to a canonical path already owned by another project', async () => {
    const service = await bootService();
    const firstProjectRoot = await createInitializedProject(service.workspace.root, 'continuity-route-first');
    const secondProjectRoot = await createInitializedProject(service.workspace.root, 'continuity-route-second');

    const firstRegisterResponse = await postJson(`${service.baseUrl}/api/projects/register`, { path: firstProjectRoot });
    expect(firstRegisterResponse.status).toBe(201);
    const firstProject = (await firstRegisterResponse.json()) as ProjectMutationResponse;

    const secondRegisterResponse = await postJson(`${service.baseUrl}/api/projects/register`, { path: secondProjectRoot });
    expect(secondRegisterResponse.status).toBe(201);

    const duplicateRelinkResponse = await postJson(
      `${service.baseUrl}/api/projects/${firstProject.project.projectId}/relink`,
      { path: secondProjectRoot },
    );

    expect(duplicateRelinkResponse.status).toBe(409);
    expect(await duplicateRelinkResponse.json()).toMatchObject({
      code: 'duplicate_path',
      statusCode: 409,
    });
  });
});
