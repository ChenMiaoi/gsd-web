import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import type { ProjectDetailResponse, ProjectMutationResponse, ProjectTimelineResponse } from '../../src/shared/contracts.js';
import { startServer } from '../../src/server/index.js';
import type { InitRunResult, RunOfficialInitOptions } from '../../src/server/init-jobs.js';
import type { ProjectInitRunner } from '../../src/server/routes/projects.js';
import { BOOTSTRAP_REQUIRED_ENTRIES } from '../../src/server/snapshots.js';
import {
  createBootstrapCompleteGsdDirectory,
  createEmptyProject,
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
    `Timed out waiting for project ${projectId}. Last state: ${JSON.stringify(lastProject?.continuity ?? null)}`,
  );
}

async function materializeInitializedBootstrap(projectRoot: string) {
  const projectName = path.basename(projectRoot);

  await createBootstrapCompleteGsdDirectory(projectRoot);
  await writeFile(path.join(projectRoot, '.gsd-id'), `gsd-${projectName}\n`);
  await writeFile(
    path.join(projectRoot, '.gsd', 'PROJECT.md'),
    '# Initialized Project\n\nBootstrapped by the continuity monitor integration fixture.\n',
  );
  await writeFile(
    path.join(projectRoot, '.gsd', 'repo-meta.json'),
    `${JSON.stringify(
      {
        projectName,
        currentBranch: 'main',
        headSha: 'feedbeef1234567',
        repoFingerprint: `${projectName}-fingerprint`,
        dirty: false,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(projectRoot, '.gsd', 'auto.lock'),
    `${JSON.stringify(
      {
        status: 'idle',
        pid: 4242,
        startedAt: '2026-04-22T10:00:00.000Z',
        updatedAt: '2026-04-22T10:05:00.000Z',
      },
      null,
      2,
    )}\n`,
  );
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
    outputExcerpt: 'Official init completed through the supported continuity monitor path.',
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

async function startContinuityService(options: {
  workspaceRoot: string;
  clientDistDir: string;
  databasePath: string;
  port?: number;
  initRunner?: ProjectInitRunner;
}) {
  const app = await startServer({
    host: '127.0.0.1',
    port: options.port ?? 0,
    databasePath: options.databasePath,
    clientDistDir: options.clientDistDir,
    logger: false,
    monitorIntervalMs: 50,
    watchersEnabled: false,
    ...(options.initRunner === undefined ? {} : { initRunner: options.initRunner }),
  });

  cleanupTasks.push(async () => {
    await app.close().catch(() => undefined);
  });

  return {
    app,
    baseUrl: getBaseUrl(app),
  };
}

describe('project continuity monitor recovery', () => {
  test('hydrates persisted path-lost continuity after restart and recovers the same project id after relink', async () => {
    const workspace = await createTempWorkspace('gsd-web-continuity-monitor-');
    cleanupTasks.push(workspace.cleanup);

    const clientDistDir = await writeClientShell(workspace.root, 'GSD Web Continuity Monitor Test Shell');
    const databasePath = path.join(workspace.root, 'data', 'gsd-web.sqlite');
    const initRunner = createSuccessfulInitRunner();

    let service = await startContinuityService({
      workspaceRoot: workspace.root,
      clientDistDir,
      databasePath,
      initRunner,
    });

    const projectRoot = await createEmptyProject(workspace.root, 'continuity-monitor-source');
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

    const movedProjectRoot = path.join(workspace.root, 'continuity-monitor-moved');
    await moveProjectRoot(projectRoot, movedProjectRoot);

    const pathLostProject = await waitForProject(
      service.baseUrl,
      projectId,
      (project) => project.continuity?.state === 'path_lost' && project.monitor.health === 'read_failed',
    );

    expect(pathLostProject.projectId).toBe(projectId);
    expect(pathLostProject.snapshot.status).toBe('initialized');
    expect(pathLostProject.latestInitJob?.stage).toBe('succeeded');
    expect(pathLostProject.continuity?.pathLostAt).toBeTruthy();

    const originalPort = Number.parseInt(new URL(service.baseUrl).port, 10);
    await service.app.close();

    service = await startContinuityService({
      workspaceRoot: workspace.root,
      clientDistDir,
      databasePath,
      port: originalPort,
      initRunner,
    });

    const restartedProject = await waitForProject(
      service.baseUrl,
      projectId,
      (project) => project.continuity?.state === 'path_lost' && project.latestInitJob?.stage === 'succeeded',
    );

    expect(restartedProject.projectId).toBe(projectId);
    expect(restartedProject.snapshot.status).toBe('initialized');
    expect(restartedProject.monitor.health).toBe('read_failed');
    expect(restartedProject.continuity?.previousCanonicalPath).toBe(projectRoot);

    const restartedTimeline = await getTimeline(service.baseUrl, projectId);
    expect(restartedTimeline.items.some((entry) => entry.type === 'path_lost')).toBe(true);

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
        project.projectId === projectId
        && project.canonicalPath === movedProjectRoot
        && project.continuity?.state === 'tracked'
        && project.continuity?.lastRelinkedAt !== null
        && project.monitor.lastTrigger === 'relink',
    );

    expect(recoveredProject.latestInitJob?.stage).toBe('succeeded');
    expect(recoveredProject.continuity).toMatchObject({
      state: 'tracked',
      previousCanonicalPath: projectRoot,
    });

    const recoveredTimeline = await getTimeline(service.baseUrl, projectId);
    expect(recoveredTimeline.items.some((entry) => entry.type === 'path_lost')).toBe(true);
    expect(recoveredTimeline.items.some((entry) => entry.type === 'relinked')).toBe(true);
    expect(
      recoveredTimeline.items.some(
        (entry) => entry.type === 'monitor_recovered' && entry.trigger === 'relink',
      ),
    ).toBe(true);
  });
});
