import { execFile } from 'node:child_process';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';
import type { FastifyInstance } from 'fastify';

import { startServer } from '../../src/server/index.js';
import type { InitRunResult, RunOfficialInitOptions } from '../../src/server/init-jobs.js';
import type { ProjectInitRunner } from '../../src/server/routes/projects.js';
import { BOOTSTRAP_REQUIRED_ENTRIES } from '../../src/server/snapshots.js';
import {
  createBootstrapCompleteGsdDirectory,
  createEmptyProject,
  createInitializedProject,
  createTempWorkspace,
  moveProjectRoot,
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

function emitStage(
  options: RunOfficialInitOptions | undefined,
  update: Parameters<NonNullable<RunOfficialInitOptions['onStage']>>[0],
) {
  options?.onStage?.(update);
}

async function materializeInitializedBootstrap(projectRoot: string) {
  const projectName = path.basename(projectRoot);

  await createBootstrapCompleteGsdDirectory(projectRoot);
  await writeFile(path.join(projectRoot, '.gsd-id'), `gsd-${projectName}\n`);
  await writeFile(
    path.join(projectRoot, '.gsd', 'PROJECT.md'),
    '# Initialized Project\n\nBootstrapped by the continuity browser fixture.\n',
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
    outputExcerpt: 'Official init completed through the supported continuity browser path.',
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

type Harness = {
  app: FastifyInstance;
  baseUrl: string;
  workspace: TestWorkspace;
  clientDistDir: string;
  databasePath: string;
  cleanup: (app: FastifyInstance | null) => Promise<void>;
};

async function createHarness(initRunner?: ProjectInitRunner): Promise<Harness> {
  await ensureClientBuilt();

  const workspace = await createTempWorkspace('gsd-web-continuity-browser-');
  const databasePath = path.join(workspace.root, 'data', 'gsd-web.sqlite');
  const app = await startServer({
    host: '127.0.0.1',
    port: 0,
    logger: false,
    clientDistDir: CLIENT_DIST_DIR,
    databasePath,
    monitorIntervalMs: 75,
    watchersEnabled: false,
    ...(initRunner === undefined ? {} : { initRunner }),
  });

  return {
    app,
    baseUrl: getBaseUrl(app),
    workspace,
    clientDistDir: CLIENT_DIST_DIR,
    databasePath,
    cleanup: async (activeApp) => {
      await activeApp?.close().catch(() => undefined);
      await workspace.cleanup();
    },
  };
}

test.describe('project continuity dashboard flow', () => {
  test('keeps the same project id and retained history visible through path loss, restart, and relink', async ({
    page,
  }) => {
    const initRunner = createSuccessfulInitRunner();
    const harness = await createHarness(initRunner);
    const sourceProjectPath = await createEmptyProject(harness.workspace.root, 'browser-continuity-source');
    const movedProjectPath = path.join(harness.workspace.root, 'browser-continuity-moved');
    let activeApp: FastifyInstance | null = harness.app;

    try {
      await page.goto(`${harness.baseUrl}/hello/all`);

      await page.getByLabel('Project path').fill(sourceProjectPath);
      await page.getByRole('button', { name: 'Register project' }).click();

      await expect(page.getByTestId('detail-status')).toContainText('Uninitialized');
      await page.getByTestId('init-action').click();

      await expect(page.getByTestId('init-stage-banner')).toContainText('Succeeded');
      await expect(page.getByTestId('detail-status')).toContainText('Initialized');

      const projectId = (await page.getByTestId('detail-project-id-value').textContent())?.trim();
      expect(projectId).toBeTruthy();

      await moveProjectRoot(sourceProjectPath, movedProjectPath);

      await expect(page.getByTestId('detail-continuity-state')).toContainText('Path lost');
      await expect(page.getByTestId('detail-monitor-health')).toContainText('Read failed');
      await expect(page.getByTestId('continuity-path-lost-alert')).toContainText('preserving the last good snapshot');
      await expect(page.getByTestId('detail-project-id-value')).toHaveText(projectId!);
      await expect(page.getByTestId('init-history')).toContainText('Succeeded');
      await expect(page.getByTestId('timeline-list')).toContainText('Path lost');

      const port = Number.parseInt(new URL(harness.baseUrl).port, 10);
      await activeApp.close();
      activeApp = null;
      await expect(page.getByTestId('stream-status')).toContainText('Disconnected');

      activeApp = await startServer({
        host: '127.0.0.1',
        port,
        logger: false,
        clientDistDir: harness.clientDistDir,
        databasePath: harness.databasePath,
        monitorIntervalMs: 75,
        watchersEnabled: false,
        initRunner,
      });

      await page.reload();

      await expect(page.getByTestId('detail-project-id-value')).toHaveText(projectId!);
      await expect(page.getByTestId('detail-continuity-state')).toContainText('Path lost');
      await expect(page.getByTestId('continuity-path-lost-alert')).toContainText('preserving the last good snapshot');
      await expect(page.getByTestId('init-stage-banner')).toContainText('Succeeded');
      await expect(page.getByTestId('timeline-list')).toContainText('Path lost');

      await page.getByTestId('relink-path-input').fill(movedProjectPath);
      await page.getByRole('button', { name: 'Relink project' }).click();

      await expect(page.getByTestId('relink-success')).toContainText(projectId!);
      await expect(page.getByTestId('detail-project-id-value')).toHaveText(projectId!);
      await expect(page.getByTestId('detail-canonical-path')).toHaveText(movedProjectPath);
      await expect(page.getByTestId('detail-continuity-state')).toContainText('Tracked');
      await expect(page.getByTestId('continuity-relinked-note')).toContainText(projectId!);
      await expect(page.getByTestId('init-history')).toContainText('Succeeded');
      await expect(page.getByTestId('timeline-list')).toContainText('Relinked');
      await expect(page.getByTestId('timeline-list')).toContainText('Recovered');
    } finally {
      await harness.cleanup(activeApp);
    }
  });

  test('surfaces relink validation failures without blanking the retained continuity view', async ({ page }) => {
    const harness = await createHarness();
    const projectPath = await createInitializedProject(harness.workspace.root, 'browser-continuity-invalid');
    const movedProjectPath = path.join(harness.workspace.root, 'browser-continuity-invalid-moved');
    const invalidRelinkPath = path.join(harness.workspace.root, 'missing-relink-target');
    let activeApp: FastifyInstance | null = harness.app;

    try {
      await page.goto(`${harness.baseUrl}/hello/all`);

      await page.getByLabel('Project path').fill(projectPath);
      await page.getByRole('button', { name: 'Register project' }).click();

      const projectId = (await page.getByTestId('detail-project-id-value').textContent())?.trim();
      expect(projectId).toBeTruthy();

      await moveProjectRoot(projectPath, movedProjectPath);

      await expect(page.getByTestId('detail-continuity-state')).toContainText('Path lost');
      await expect(page.getByTestId('detail-project-id-value')).toHaveText(projectId!);
      await expect(page.getByTestId('timeline-list')).toContainText('Path lost');

      await page.getByTestId('relink-path-input').fill(invalidRelinkPath);
      await page.getByRole('button', { name: 'Relink project' }).click();

      await expect(page.getByTestId('relink-error')).toContainText('Project path does not exist');
      await expect(page.getByTestId('detail-project-id-value')).toHaveText(projectId!);
      await expect(page.getByTestId('detail-continuity-state')).toContainText('Path lost');
      await expect(page.getByTestId('timeline-list')).toContainText('Path lost');
      await expect(page.getByTestId('timeline-list')).not.toContainText('Relinked');
    } finally {
      await harness.cleanup(activeApp);
    }
  });
});
