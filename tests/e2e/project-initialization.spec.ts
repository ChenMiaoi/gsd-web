import { execFile } from 'node:child_process';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';
import type { FastifyInstance } from 'fastify';

import { startServer } from '../../src/server/index.js';
import type { InitRunResult, RunOfficialInitOptions } from '../../src/server/init-jobs.js';
import type { ProjectInitRunner } from '../../src/server/routes/projects.js';
import { BOOTSTRAP_REQUIRED_ENTRIES } from '../../src/server/snapshots.js';
import type { ProjectMutationResponse, ProjectRecord, ProjectsResponse } from '../../src/shared/contracts.js';
import {
  createEmptyProject,
  createSnapshotCompleteBootstrap,
  createTempWorkspace,
  type TestWorkspace,
} from '../helpers/project-fixtures.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = process.cwd();
const CLIENT_DIST_DIR = path.join(PROJECT_ROOT, 'dist', 'web');

let buildPromise: Promise<void> | null = null;

async function ensureClientBuilt() {
  buildPromise ??= execFileAsync('npm', ['run', 'build:web'], {
    cwd: PROJECT_ROOT,
    timeout: 120_000,
  }).then(() => undefined);

  return buildPromise;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBaseUrl(app: FastifyInstance) {
  const address = app.server.address() as AddressInfo | null;

  if (!address || typeof address === 'string') {
    throw new Error('Expected the Fastify app to listen on a TCP port');
  }

  return `http://127.0.0.1:${address.port}`;
}

async function fetchProjects(baseUrl: string): Promise<ProjectsResponse> {
  const response = await fetch(`${baseUrl}/api/projects`);

  if (!response.ok) {
    throw new Error(`Expected project inventory to load, got ${response.status}`);
  }

  return (await response.json()) as ProjectsResponse;
}

async function getProjectByCanonicalPath(baseUrl: string, canonicalPath: string): Promise<ProjectRecord> {
  const inventory = await fetchProjects(baseUrl);
  const match = inventory.items.find((project) => project.canonicalPath === canonicalPath);

  if (!match) {
    throw new Error(`Could not find project for ${canonicalPath}`);
  }

  return match;
}

async function registerProject(baseUrl: string, projectPath: string): Promise<ProjectMutationResponse> {
  const response = await fetch(`${baseUrl}/api/projects/register`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      path: projectPath,
    }),
  });

  if (!response.ok) {
    throw new Error(`Expected project registration to succeed, got ${response.status}`);
  }

  return (await response.json()) as ProjectMutationResponse;
}

async function waitForProject(
  baseUrl: string,
  canonicalPath: string,
  predicate: (project: ProjectRecord) => boolean,
  timeoutMs: number = 5_000,
): Promise<ProjectRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastProject: ProjectRecord | null = null;

  while (Date.now() < deadline) {
    lastProject = await getProjectByCanonicalPath(baseUrl, canonicalPath);

    if (predicate(lastProject)) {
      return lastProject;
    }

    await sleep(50);
  }

  throw new Error(
    `Timed out waiting for project ${canonicalPath}. Last state: ${JSON.stringify(lastProject?.latestInitJob ?? null)}`,
  );
}

type Harness = {
  app: FastifyInstance;
  baseUrl: string;
  workspace: TestWorkspace;
  cleanup: () => Promise<void>;
};

async function createHarness(initRunner?: ProjectInitRunner): Promise<Harness> {
  await ensureClientBuilt();

  const workspace = await createTempWorkspace('gsd-web-init-browser-');
  const app = await startServer({
    host: '127.0.0.1',
    port: 0,
    logger: false,
    clientDistDir: CLIENT_DIST_DIR,
    databasePath: path.join(workspace.root, 'data', 'gsd-web.sqlite'),
    ...(initRunner === undefined ? {} : { initRunner }),
  });

  return {
    app,
    baseUrl: getBaseUrl(app),
    workspace,
    cleanup: async () => {
      await app.close();
      await workspace.cleanup();
    },
  };
}

function emitStage(
  options: RunOfficialInitOptions | undefined,
  update: Parameters<NonNullable<RunOfficialInitOptions['onStage']>>[0],
) {
  options?.onStage?.(update);
}

async function materializeInitializedBootstrap(projectRoot: string) {
  await createSnapshotCompleteBootstrap(projectRoot);
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

function buildTimedOutResult(projectRoot: string): InitRunResult {
  return {
    outcome: 'timed_out',
    stage: 'timed_out',
    bootstrap: {
      state: 'absent',
      projectRoot,
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
}

function createSteppedSuccessfulInitRunner(): ProjectInitRunner {
  return async (projectRoot, options) => {
    emitStage(options, {
      stage: 'starting',
      matchedPrompt: null,
      excerpt: 'Launching init',
      detail: 'Launching the official init wizard.',
      emittedAt: new Date().toISOString(),
    });
    await sleep(80);

    emitStage(options, {
      stage: 'project_setup',
      matchedPrompt: null,
      excerpt: 'Project Setup',
      detail: 'Accepted the supported Project Setup step.',
      emittedAt: new Date().toISOString(),
    });
    await sleep(80);

    await materializeInitializedBootstrap(projectRoot);

    emitStage(options, {
      stage: 'verifying_bootstrap',
      matchedPrompt: null,
      excerpt: 'Verifying bootstrap',
      detail: 'Verified the bootstrap-complete .gsd surface.',
      emittedAt: new Date().toISOString(),
    });
    await sleep(80);

    return buildCompletedResult(projectRoot);
  };
}

function createTimedOutInitRunner(): ProjectInitRunner {
  return async (projectRoot, options) => {
    emitStage(options, {
      stage: 'starting',
      matchedPrompt: null,
      excerpt: 'Launching init',
      detail: 'Launching the official init wizard.',
      emittedAt: new Date().toISOString(),
    });
    await sleep(120);

    return buildTimedOutResult(projectRoot);
  };
}

test.describe('project initialization dashboard flow', () => {
  test('keeps the same project visible through queued-to-succeeded init progress and refreshes into initialized detail', async ({
    page,
  }) => {
    const harness = await createHarness(createSteppedSuccessfulInitRunner());
    const projectPath = await createEmptyProject(harness.workspace.root, 'browser-init-success');

    try {
      const registration = await registerProject(harness.baseUrl, projectPath);
      await page.goto(`${harness.baseUrl}/lazy/employee-${registration.project.projectId}`);

      await expect(page.getByTestId('detail-status')).toContainText('Uninitialized');
      await expect(page.getByTestId('detail-canonical-path')).toHaveText(projectPath);
      await expect(page.getByTestId('init-action')).toContainText('Initialize project');

      await page.getByTestId('init-action').click();

      await expect(page.getByTestId('detail-canonical-path')).toHaveText(projectPath);
      await expect(page.getByTestId('init-stage-banner')).toContainText('Queued');

      if ((await page.getByTestId('init-action').count()) > 0) {
        await expect(page.getByTestId('init-action')).toBeDisabled();
      }

      await expect(page.getByTestId('init-history')).toContainText('Queued');
      await expect(page.getByTestId('init-history')).toContainText('Starting');
      await expect(page.getByTestId('init-history')).toContainText('Initializing');
      await expect(page.getByTestId('init-history')).toContainText('Refreshing');
      await expect(page.getByTestId('init-history')).toContainText('Succeeded');
      await expect(page.getByTestId('init-stage-banner')).toContainText('Succeeded');
      await expect(page.getByTestId('init-refresh-result')).toContainText('initialized');
      await expect(page.getByTestId('detail-status')).toContainText('Initialized');
      await expect(page.getByTestId('detail-gsd-id')).toContainText('gsd-browser-init-success');
      await expect(page.getByTestId('init-action')).toHaveCount(0);
    } finally {
      await harness.cleanup();
    }
  });

  test('falls back to persisted job truth when SSE disconnects and keeps the same project retryable after failure', async ({
    page,
  }) => {
    const harness = await createHarness(createTimedOutInitRunner());
    const projectPath = await createEmptyProject(harness.workspace.root, 'browser-init-timeout');

    try {
      await page.route('**/api/events', async (route) => {
        await route.abort('failed');
      });

      await page.goto(`${harness.baseUrl}/lazy/boss`);
      await expect(page.getByTestId('stream-status')).toContainText('Disconnected');

      const registration = await registerProject(harness.baseUrl, projectPath);
      await page.goto(`${harness.baseUrl}/lazy/employee-${registration.project.projectId}`);

      await expect(page.getByTestId('detail-status')).toContainText('Uninitialized');
      await expect(page.getByTestId('detail-canonical-path')).toHaveText(projectPath);

      await page.getByTestId('init-action').click();

      await expect(page.getByTestId('init-stage-banner')).toContainText('Queued');
      await expect(page.getByTestId('init-stream-note')).toContainText('Reload detail');
      await expect(page.getByTestId('init-action')).toBeDisabled();

      const timedOutProject = await waitForProject(
        harness.baseUrl,
        projectPath,
        (project) => project.latestInitJob?.stage === 'timed_out',
      );

      expect(timedOutProject.latestInitJob?.lastErrorDetail).toContain('configured timeout');

      await page.getByRole('button', { name: 'Reload detail' }).click();

      await expect(page.getByTestId('detail-status')).toContainText('Uninitialized');
      await expect(page.getByTestId('detail-canonical-path')).toHaveText(projectPath);
      await expect(page.getByTestId('init-stage-banner')).toContainText('Timed out');
      await expect(page.getByTestId('init-failure-detail')).toContainText('configured timeout');
      await expect(page.getByTestId('init-history')).toContainText('Timed out');
      await expect(page.getByTestId('init-action')).toContainText('Retry initialization');
      await expect(page.getByTestId('init-action')).toBeEnabled();
    } finally {
      await harness.cleanup();
    }
  });

  test('preserves the last good detail when the post-success detail refresh is malformed, then recovers on retry', async ({
    page,
  }) => {
    const harness = await createHarness(createSteppedSuccessfulInitRunner());
    const projectPath = await createEmptyProject(harness.workspace.root, 'browser-init-malformed');

    try {
      const registration = await registerProject(harness.baseUrl, projectPath);
      await page.goto(`${harness.baseUrl}/lazy/employee-${registration.project.projectId}`);

      await expect(page.getByTestId('detail-status')).toContainText('Uninitialized');
      await expect(page.getByTestId('detail-canonical-path')).toHaveText(projectPath);

      const project = await getProjectByCanonicalPath(harness.baseUrl, projectPath);
      let interceptedDetailLoads = 0;

      await page.route(
        `**/api/projects/${project.projectId}*`,
        async (route) => {
          interceptedDetailLoads += 1;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              projectId: project.projectId,
              registeredPath: project.registeredPath,
              canonicalPath: project.canonicalPath,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              lastEventId: project.lastEventId,
              latestInitJob: project.latestInitJob,
            }),
          });
        },
        { times: 1 },
      );

      await page.getByTestId('init-action').click();

      await waitForProject(harness.baseUrl, projectPath, (candidate) => candidate.snapshot.status === 'initialized');
      await expect.poll(() => interceptedDetailLoads).toBe(1);

      await expect(page.getByTestId('detail-error')).toContainText('project detail.snapshot');
      await expect(page.getByTestId('detail-status')).toContainText('Uninitialized');
      await expect(page.getByTestId('detail-canonical-path')).toHaveText(projectPath);
      await expect(page.getByTestId('init-stage-banner')).toContainText('Succeeded');
      await expect(page.getByTestId('init-refresh-result')).toContainText('initialized');

      await page.getByRole('button', { name: 'Reload detail' }).click();

      await expect(page.getByTestId('detail-status')).toContainText('Initialized');
      await expect(page.getByTestId('detail-error')).toHaveCount(0);
      await expect(page.getByTestId('detail-gsd-id')).toContainText('gsd-browser-init-malformed');
    } finally {
      await harness.cleanup();
    }
  });
});
