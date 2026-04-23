import { execFile } from 'node:child_process';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { test as base, expect } from '@playwright/test';
import type { FastifyInstance } from 'fastify';

import { startServer } from '../../src/server/index.js';
import type { ProjectMutationResponse, ProjectRecord, ProjectsResponse } from '../../src/shared/contracts.js';
import {
  createInitializedProject,
  createTempWorkspace,
  writeRepoMeta,
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
    `Timed out waiting for project ${canonicalPath}. Last state: ${JSON.stringify(lastProject?.monitor ?? null)}`,
  );
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

type Harness = {
  app: FastifyInstance;
  baseUrl: string;
  workspace: TestWorkspace;
};

const test = base.extend<{ harness: Harness }>({
  harness: async ({}, use) => {
    await ensureClientBuilt();

    const workspace = await createTempWorkspace('gsd-web-monitor-browser-');
    const app = await startServer({
      host: '127.0.0.1',
      port: 0,
      logger: false,
      clientDistDir: CLIENT_DIST_DIR,
      databasePath: path.join(workspace.root, 'data', 'gsd-web.sqlite'),
      monitorIntervalMs: 75,
      watchersEnabled: false,
    });

    try {
      await use({
        app,
        baseUrl: getBaseUrl(app),
        workspace,
      });
    } finally {
      await app.close().catch(() => undefined);
      await workspace.cleanup();
    }
  },
});

test.describe('project monitoring dashboard flow', () => {
  test('renders snapshot status separately from monitor health, updates live, and keeps persisted timeline entries after reload', async ({
    page,
    harness,
  }) => {
    const projectPath = await createInitializedProject(harness.workspace.root, 'browser-monitor-health');
    const healthyRepoMeta = {
      projectName: 'browser-monitor-health',
      currentBranch: 'main',
      headSha: 'feedbeef1234567',
      repoFingerprint: 'browser-monitor-health-fingerprint',
      dirty: false,
    };

    const registration = await registerProject(harness.baseUrl, projectPath);

    await page.goto(`${harness.baseUrl}/lazy/${registration.project.projectId}`);

    await expect(page.getByTestId('detail-status')).toContainText('Initialized');
    await expect(page.getByTestId('detail-monitor-health')).toContainText('Healthy');
    await expect(page.getByTestId('project-event-total')).toContainText('1 entry');
    await expect(page.getByTestId('project-event-list')).toContainText('Registered');

    await writeRepoMeta(projectPath, '{"currentBranch":');

    await expect(page.getByTestId('detail-status')).toContainText('Degraded');
    await expect(page.getByTestId('detail-monitor-health')).toContainText('Degraded');
    await expect(page.getByTestId('project-event-list')).toContainText('Monitor observed a degraded snapshot');

    await writeRepoMeta(projectPath, `${JSON.stringify(healthyRepoMeta, null, 2)}\n`);

    await expect(page.getByTestId('detail-status')).toContainText('Initialized');
    await expect(page.getByTestId('detail-monitor-health')).toContainText('Healthy');
    await expect(page.getByTestId('project-event-list')).toContainText('Monitor recovered');

    const dbLock = lockDatabase(path.join(projectPath, '.gsd', 'gsd.db'));

    try {
      await expect(page.getByTestId('detail-status')).toContainText('Initialized');
      await expect(page.getByTestId('detail-monitor-health')).toContainText('Read failed');
      await expect(page.getByTestId('monitor-last-error')).toContainText('gsdDb');
      await expect(page.getByTestId('project-event-list')).toContainText('Monitor could not read current project truth');
    } finally {
      await dbLock.release();
    }

    await waitForProject(
      harness.baseUrl,
      projectPath,
      (project) => project.monitor.health === 'healthy' && project.monitor.lastError === null,
    );

    await expect(page.getByTestId('detail-status')).toContainText('Initialized');
    await expect(page.getByTestId('detail-monitor-health')).toContainText('Healthy');
    await expect(page.getByTestId('project-event-list')).toContainText('Monitor recovered');

    await page.reload();

    await expect(page.getByTestId('detail-status')).toContainText('Initialized');
    await expect(page.getByTestId('detail-monitor-health')).toContainText('Healthy');
    await expect(page.getByTestId('project-event-list')).toContainText('Monitor could not read current project truth');
    await expect(page.getByTestId('project-event-list')).toContainText('Monitor recovered');
  });

  test('resyncs inventory, detail, and timeline after EventSource reconnect without manual refresh', async ({ page, harness }) => {
    const projectPath = await createInitializedProject(harness.workspace.root, 'browser-monitor-reconnect');

    const registration = await registerProject(harness.baseUrl, projectPath);

    await page.goto(`${harness.baseUrl}/lazy/${registration.project.projectId}`);

    const project = await getProjectByCanonicalPath(harness.baseUrl, projectPath);

    await expect(page.getByTestId('detail-status')).toContainText('Initialized');
    await expect(page.getByTestId('detail-monitor-health')).toContainText('Healthy');
    await expect(page.getByTestId('project-event-total')).toContainText('1 entry');

    const port = Number.parseInt(new URL(harness.baseUrl).port, 10);

    await harness.app.close();
    await expect(page.getByTestId('stream-status')).toContainText('Disconnected');

    await writeRepoMeta(
      projectPath,
      `${JSON.stringify(
        {
          projectName: 'browser-monitor-renamed',
          currentBranch: 'offline-branch',
          headSha: 'feedbeef1234567',
          repoFingerprint: 'browser-monitor-reconnect-fingerprint',
          dirty: false,
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(projectPath, '.gsd', 'PROJECT.md'),
      '# Browser Monitor Renamed\n\nUpdated while the stream was disconnected.\n',
    );

    const reconnectResponses = Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/projects' && response.request().method() === 'GET',
      ),
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/projects/${project.projectId}`
          && response.request().method() === 'GET',
      ),
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/projects/${project.projectId}/timeline`
          && response.request().method() === 'GET',
      ),
    ]);

    const restartedApp = await startServer({
      host: '127.0.0.1',
      port,
      logger: false,
      clientDistDir: CLIENT_DIST_DIR,
      databasePath: path.join(harness.workspace.root, 'data', 'gsd-web.sqlite'),
      monitorIntervalMs: 75,
      watchersEnabled: false,
    });

    try {
      await waitForProject(
        harness.baseUrl,
        projectPath,
        (candidate) =>
          candidate.snapshot.sources.repoMeta.value?.currentBranch === 'offline-branch'
          && candidate.snapshot.sources.projectMd.value?.title === 'Browser Monitor Renamed',
      );

      await reconnectResponses;

      await expect(page.getByTestId('stream-status')).toContainText('Connected');
      await expect(page.getByTestId('stream-resync-status')).toContainText('resynced inventory, detail, and timeline');
      await expect(page.getByTestId('app-topbar-marquee-heading')).toContainText('Browser Monitor Renamed');
      await expect(page.getByTestId('repo-meta-section')).toContainText('offline-branch');
      await expect(page.getByTestId('project-event-total')).toContainText('2 entries');
      await expect(page.getByTestId('project-event-list')).toContainText('Refreshed');
    } finally {
      await restartedApp.close().catch(() => undefined);
    }
  });
});
