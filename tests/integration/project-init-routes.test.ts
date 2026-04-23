import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import type {
  ProjectEventEnvelope,
  ProjectInitEventPayload,
  ProjectMutationResponse,
  ProjectRecord,
} from '../../src/shared/contracts.js';
import { startServer } from '../../src/server/index.js';
import type { ProjectInitRunner } from '../../src/server/routes/projects.js';
import { BOOTSTRAP_REQUIRED_ENTRIES } from '../../src/server/snapshots.js';
import type { InitRunResult, RunOfficialInitOptions } from '../../src/server/init-jobs.js';
import {
  createEmptyProject,
  createInitializedProject,
  createSnapshotCompleteBootstrap,
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

async function bootService(options: { initRunner?: ProjectInitRunner } = {}) {
  const workspace = await createTempWorkspace('gsd-web-init-routes-');
  const clientDistDir = await writeClientShell(workspace.root, 'GSD Web Init Route Test Shell');
  const databasePath = path.join(workspace.root, 'data', 'gsd-web.sqlite');
  const app = await startServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    clientDistDir,
    logger: false,
    ...(options.initRunner === undefined ? {} : { initRunner: options.initRunner }),
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

async function getProject(baseUrl: string, projectId: string): Promise<ProjectRecord> {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}`);

  if (!response.ok) {
    throw new Error(`Expected project detail ${projectId}, got ${response.status}`);
  }

  return (await response.json()) as ProjectRecord;
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
    `Timed out waiting for project ${projectId}. Last state: ${JSON.stringify(lastProject?.latestInitJob ?? null)}`,
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

function createBlockingTimedOutRunner(): {
  runner: ProjectInitRunner;
  release: () => void;
} {
  let release!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    runner: async (_projectRoot, options) => {
      emitStage(options, {
        stage: 'starting',
        matchedPrompt: null,
        excerpt: 'Launching init',
        detail: 'Launching the official init wizard.',
        emittedAt: new Date().toISOString(),
      });

      await releasePromise;

      return {
        outcome: 'timed_out',
        stage: 'timed_out',
        bootstrap: {
          state: 'absent',
          projectRoot: _projectRoot,
          gsdRootPath: null,
          detail: 'No project-owned .gsd directory exists yet.',
          presentEntries: [],
          missingEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
          requiredEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
        },
        promptHistory: [],
        lastMatchedPrompt: null,
        outputExcerpt: 'Timed out while waiting for the wizard to finish.',
        errorDetail: 'Init wizard exceeded the configured timeout.',
        exitCode: null,
        signal: null,
      };
    },
    release,
  };
}

function createMalformedStageRunner(): ProjectInitRunner {
  return async (_projectRoot, options) => {
    emitStage(options, {
      stage: 'unexpected_stage' as never,
      matchedPrompt: null,
      excerpt: 'Unexpected stage',
      detail: 'The adapter emitted a stage that the API cannot map.',
      emittedAt: new Date().toISOString(),
    });

    throw new Error('Unreachable after malformed stage emission.');
  };
}

function createRefreshMismatchRunner(): ProjectInitRunner {
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

    return buildCompletedResult(projectRoot);
  };
}

function isInitUpdateEvent(
  event: ProjectEventEnvelope,
): event is ProjectEventEnvelope<ProjectInitEventPayload> {
  return event.type === 'project.init.updated';
}

describe('project init routes and SSE contract', () => {
  test('persists init job history, replays progress events, and refreshes snapshot after success', async () => {
    const service = await bootService({ initRunner: createSuccessfulInitRunner() });
    const events = await openEventStream(`${service.baseUrl}/api/events`);
    const readyEvent = await events.next();
    expect(readyEvent.type).toBe('service.ready');

    const projectPath = await createEmptyProject(service.workspace.root, 'init-success-project');
    const registerResponse = await postJson(`${service.baseUrl}/api/projects/register`, { path: projectPath });
    expect(registerResponse.status).toBe(201);
    const registerMutation = (await registerResponse.json()) as ProjectMutationResponse;

    const registeredEvent = await events.next();
    expect(registeredEvent.id).toBe(registerMutation.event.id);

    const initResponse = await postJson(
      `${service.baseUrl}/api/projects/${registerMutation.project.projectId}/init`,
    );
    expect(initResponse.status).toBe(202);

    const initMutation = (await initResponse.json()) as ProjectMutationResponse;
    expect(initMutation.project.latestInitJob?.stage).toBe('queued');
    expect(initMutation.project.latestInitJob?.history.map((entry) => entry.stage)).toEqual(['queued']);

    const seenStages: string[] = [];
    const seenEvents: ProjectEventEnvelope[] = [];

    while (true) {
      const event = await events.next(4_000);
      seenEvents.push(event);

      if (isInitUpdateEvent(event)) {
        seenStages.push(event.payload.historyEntry.stage);

        if (event.payload.job.stage === 'succeeded') {
          break;
        }
      }
    }

    expect(seenStages).toEqual(expect.arrayContaining(['queued', 'starting', 'initializing', 'refreshing', 'succeeded']));
    expect(seenEvents.some((event) => event.type === 'project.refreshed')).toBe(true);

    const succeededProject = await waitForProject(
      service.baseUrl,
      registerMutation.project.projectId,
      (project) => project.latestInitJob?.stage === 'succeeded',
    );

    expect(succeededProject.snapshot.status).toBe('initialized');
    expect(succeededProject.latestInitJob?.refreshResult).toMatchObject({
      status: 'succeeded',
      snapshotStatus: 'initialized',
    });
    expect(succeededProject.latestInitJob?.history.map((entry) => entry.stage)).toEqual(
      expect.arrayContaining(['queued', 'starting', 'initializing', 'refreshing', 'succeeded']),
    );

    const replayStartEvent = seenEvents.find(
      (event) => isInitUpdateEvent(event) && event.payload.historyEntry.stage === 'queued',
    );
    expect(replayStartEvent).toBeDefined();

    const replay = await openEventStream(
      `${service.baseUrl}/api/events?lastEventId=${encodeURIComponent(replayStartEvent!.id)}`,
    );
    const replayedStages: string[] = [];

    while (true) {
      const event = await replay.next(2_000);

      if (!isInitUpdateEvent(event)) {
        continue;
      }

      replayedStages.push(event.payload.historyEntry.stage);

      if (event.payload.job.stage === 'succeeded') {
        break;
      }
    }

    expect(replayedStages).toEqual(expect.arrayContaining(['starting', 'initializing', 'refreshing', 'succeeded']));

    await replay.close();
    await events.close();
  });

  test('refuses ineligible projects and blocks duplicate in-flight init starts', async () => {
    const blockingRunner = createBlockingTimedOutRunner();
    const service = await bootService({ initRunner: blockingRunner.runner });

    const initializedProjectPath = await createInitializedProject(service.workspace.root, 'already-ready-project');
    const ineligibleRegister = await postJson(`${service.baseUrl}/api/projects/register`, {
      path: initializedProjectPath,
    });
    expect(ineligibleRegister.status).toBe(201);
    const ineligibleProject = (await ineligibleRegister.json()) as ProjectMutationResponse;
    expect(ineligibleProject.project.snapshot.status).toBe('initialized');

    const ineligibleInitResponse = await postJson(
      `${service.baseUrl}/api/projects/${ineligibleProject.project.projectId}/init`,
    );
    expect(ineligibleInitResponse.status).toBe(409);
    expect(await ineligibleInitResponse.json()).toMatchObject({
      code: 'project_ineligible',
      statusCode: 409,
    });

    const emptyProjectPath = await createEmptyProject(service.workspace.root, 'duplicate-init-project');
    const registerResponse = await postJson(`${service.baseUrl}/api/projects/register`, { path: emptyProjectPath });
    expect(registerResponse.status).toBe(201);
    const project = (await registerResponse.json()) as ProjectMutationResponse;

    const firstInitResponse = await postJson(`${service.baseUrl}/api/projects/${project.project.projectId}/init`);
    expect(firstInitResponse.status).toBe(202);

    const secondInitResponse = await postJson(`${service.baseUrl}/api/projects/${project.project.projectId}/init`);
    expect(secondInitResponse.status).toBe(409);
    expect(await secondInitResponse.json()).toMatchObject({
      code: 'init_job_active',
      statusCode: 409,
    });

    blockingRunner.release();

    const timedOutProject = await waitForProject(
      service.baseUrl,
      project.project.projectId,
      (candidate) => candidate.latestInitJob?.stage === 'timed_out',
    );

    expect(timedOutProject.snapshot.status).toBe('uninitialized');
    expect(timedOutProject.latestInitJob?.lastErrorDetail).toMatch(/timeout/i);
  });

  test('fails closed on malformed adapter stage mapping and keeps the project uninitialized', async () => {
    const service = await bootService({ initRunner: createMalformedStageRunner() });
    const projectPath = await createEmptyProject(service.workspace.root, 'malformed-stage-project');
    const registerResponse = await postJson(`${service.baseUrl}/api/projects/register`, { path: projectPath });
    expect(registerResponse.status).toBe(201);
    const project = (await registerResponse.json()) as ProjectMutationResponse;

    const initResponse = await postJson(`${service.baseUrl}/api/projects/${project.project.projectId}/init`);
    expect(initResponse.status).toBe(202);

    const failedProject = await waitForProject(
      service.baseUrl,
      project.project.projectId,
      (candidate) => candidate.latestInitJob?.stage === 'failed',
    );

    expect(failedProject.snapshot.status).toBe('uninitialized');
    expect(failedProject.latestInitJob?.lastErrorDetail).toMatch(/Unsupported init adapter stage/i);
    expect(failedProject.latestInitJob?.history.at(-1)?.stage).toBe('failed');
  });

  test('fails the job when refresh after a reported success still does not prove initialization', async () => {
    const service = await bootService({ initRunner: createRefreshMismatchRunner() });
    const projectPath = await createEmptyProject(service.workspace.root, 'refresh-mismatch-project');
    const registerResponse = await postJson(`${service.baseUrl}/api/projects/register`, { path: projectPath });
    expect(registerResponse.status).toBe(201);
    const project = (await registerResponse.json()) as ProjectMutationResponse;

    const initResponse = await postJson(`${service.baseUrl}/api/projects/${project.project.projectId}/init`);
    expect(initResponse.status).toBe(202);

    const failedProject = await waitForProject(
      service.baseUrl,
      project.project.projectId,
      (candidate) => candidate.latestInitJob?.stage === 'failed',
    );

    expect(failedProject.snapshot.status).toBe('uninitialized');
    expect(failedProject.latestInitJob?.refreshResult).toMatchObject({
      status: 'failed',
      snapshotStatus: 'uninitialized',
    });
    expect(failedProject.latestInitJob?.lastErrorDetail).toMatch(/still reported the project as uninitialized/i);
  });
});
