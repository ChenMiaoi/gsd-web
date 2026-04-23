import { execFile } from 'node:child_process';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

import { test as base, expect } from '@playwright/test';
import type { FastifyInstance } from 'fastify';

import {
  buildSourceStateMap,
  type ProjectMutationResponse,
  type ProjectRecord,
  type ProjectsResponse,
} from '../../src/shared/contracts.js';
import { startServer } from '../../src/server/index.js';
import {
  createEmptyProject,
  createInitializedProject,
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

function formatUsd(value: number) {
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value);
}

type Harness = {
  app: FastifyInstance;
  baseUrl: string;
  workspace: TestWorkspace;
};

const test = base.extend<{ harness: Harness }>({
  harness: async ({}, use) => {
    await ensureClientBuilt();

    const workspace = await createTempWorkspace('gsd-web-e2e-');
    const app = await startServer({
      host: '127.0.0.1',
      port: 0,
      logger: false,
      clientDistDir: CLIENT_DIST_DIR,
      databasePath: path.join(workspace.root, 'data', 'gsd-web.sqlite'),
    });

    try {
      await use({
        app,
        baseUrl: getBaseUrl(app),
        workspace,
      });
    } finally {
      await app.close();
      await workspace.cleanup();
    }
  },
});

test.describe('hosted dashboard inventory flow', () => {
  test('starts on the welcome page and routes into the overview', async ({ page, harness }) => {
    await page.goto(harness.baseUrl);

    await expect(page.getByTestId('welcome-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'gsd-web' })).toBeVisible();

    await page.getByRole('button', { name: /Enter overview|进入总览/ }).click();

    await expect(page).toHaveURL(`${harness.baseUrl}/hello/all`);
    await expect(page.getByRole('heading', { name: /Project overview|项目概览/ })).toBeVisible();
  });

  test('opens project detail through the overview route', async ({ page, harness }) => {
    const firstProjectPath = await createInitializedProject(harness.workspace.root, 'routed-project');
    const secondProjectPath = await createInitializedProject(harness.workspace.root, 'summary-project');
    const firstRegistration = await registerProject(harness.baseUrl, firstProjectPath);
    const secondRegistration = await registerProject(harness.baseUrl, secondProjectPath);
    const totalCost =
      (firstRegistration.project.snapshot.sources.metricsJson.value?.totals.cost ?? 0)
      + (secondRegistration.project.snapshot.sources.metricsJson.value?.totals.cost ?? 0);

    await page.goto(`${harness.baseUrl}/hello/all`);
    await expect(page.getByTestId('app-topbar-marquee-heading')).toContainText('2 projects');
    await expect(page.getByTestId('app-topbar-marquee-heading')).not.toContainText('routed-project');
    await expect(page.getByTestId('app-topbar-stage-value')).toContainText('2');
    await expect(page.getByTestId('app-topbar-total-cost')).toContainText(formatUsd(totalCost));

    await page.getByTestId(`overview-project-card-${firstRegistration.project.projectId}`).click();

    await expect(page).toHaveURL(`${harness.baseUrl}/hello/${firstRegistration.project.projectId}`);
    await expect(page.getByTestId('detail-project-id-value')).toContainText(firstRegistration.project.projectId);

    await page.goto(`${harness.baseUrl}/hello/all`);
    await expect(page.getByTestId('app-topbar-marquee-heading')).toContainText('2 projects');
    await expect(page.getByTestId('app-topbar-marquee-heading')).not.toContainText('routed-project');
  });

  test('registers empty and degraded projects, then refreshes live detail', async ({ page, harness }) => {
    const emptyProjectPath = await createEmptyProject(harness.workspace.root, 'empty-project');
    const partialProjectPath = await createInitializedProject(harness.workspace.root, 'partial-project', {
      projectMdContent: null,
      repoMetaContent: '{"currentBranch":',
      stateMdContent: new Uint8Array([0xc3, 0x28]),
      gsdDbMode: 'corrupt',
    });
    const emptyRegistration = await registerProject(harness.baseUrl, emptyProjectPath);
    const partialRegistration = await registerProject(harness.baseUrl, partialProjectPath);

    await page.goto(`${harness.baseUrl}/hello/all`);

    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible();
    await expect(page.getByTestId('inventory-count')).toContainText('2 projects');
    await expect(page.getByTestId('stream-status')).toContainText('Connected');

    await page.getByTestId(`overview-project-card-${emptyRegistration.project.projectId}`).click();
    await expect(page.getByTestId('detail-status')).toContainText('Uninitialized');
    await expect(page.getByTestId('detail-directory')).toContainText('directory is empty');
    await expect(page.getByTestId('warning-list')).toContainText('No degraded or missing-source warnings');

    await page.goto(`${harness.baseUrl}/hello/${partialRegistration.project.projectId}`);
    await expect(page.getByTestId('detail-status')).toContainText('Degraded');
    await expect(page.getByTestId('detail-gsd-id')).toContainText('gsd-partial-project');
    await expect(page.getByTestId('warning-list')).toContainText('PROJECT.md');
    await expect(page.getByTestId('warning-list')).toContainText('repo-meta.json');
    await expect(page.getByTestId('warning-list')).toContainText('STATE.md');
    await expect(page.getByTestId('warning-list')).toContainText('gsd.db');

    await writeFile(
      path.join(partialProjectPath, '.gsd', 'PROJECT.md'),
      '# Partial Project\n\nRecovered project summary after refresh.\n',
    );
    await writeFile(
      path.join(partialProjectPath, '.gsd', 'repo-meta.json'),
      `${JSON.stringify(
        {
          projectName: 'partial-project',
          currentBranch: 'main',
          headSha: 'feedbeef1234567',
          repoFingerprint: 'partial-project-fingerprint',
          dirty: false,
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(path.join(partialProjectPath, '.gsd', 'STATE.md'), '# State\n\nRecovered state text.\n');

    await page.getByRole('button', { name: 'Refresh selected project' }).click();

    await expect(page.getByTestId('detail-warning-count')).toContainText('1 warning');
    await expect(page.getByTestId('warning-list')).not.toContainText('PROJECT.md');
    await expect(page.getByTestId('warning-list')).not.toContainText('repo-meta.json');
    await expect(page.getByTestId('warning-list')).not.toContainText('STATE.md');
    await expect(page.getByTestId('warning-list')).toContainText('gsd.db');
    await expect(page.getByTestId('repo-meta-section')).toContainText('partial-project');
    await expect(page.getByTestId('repo-meta-section')).toContainText('feedbeef1234567');
    await expect(page.getByTestId('stream-last-event')).toContainText('project.refreshed');
  });

  test('uses a picker-only registration entrypoint on the overview', async ({ page, harness }) => {
    const registeredProjectPath = await createEmptyProject(harness.workspace.root, 'registered-project');
    const failingProjectPath = await createEmptyProject(harness.workspace.root, 'server-error-project');
    const workspaceRoot = harness.workspace.root;

    await page.route('**/api/filesystem/directories**', async (route) => {
      const url = new URL(route.request().url());
      const currentPath = url.searchParams.get('path');

      if (!currentPath || currentPath === workspaceRoot) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            path: workspaceRoot,
            parentPath: path.dirname(workspaceRoot),
            entries: [
              {
                name: 'registered-project',
                path: registeredProjectPath,
                hidden: false,
              },
              {
                name: 'server-error-project',
                path: failingProjectPath,
                hidden: false,
              },
            ],
            truncated: false,
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          path: currentPath,
          parentPath: workspaceRoot,
          entries: [],
          truncated: false,
        }),
      });
    });

    await page.goto(`${harness.baseUrl}/hello/all`);
    await expect(page.getByLabel('Project path')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh inventory' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Browse folders' })).toBeVisible();
    await expect(page.getByTestId('register-selected-path')).toContainText('Choose a folder');

    await page.getByRole('button', { name: 'Browse folders' }).click();
    await expect(page.getByTestId('directory-picker')).toBeVisible();
    await page.getByTestId('directory-picker').getByRole('button', { name: 'registered-project' }).click();
    await page.getByRole('button', { name: 'Register this folder' }).click();

    await expect(page.getByTestId('detail-status')).toContainText('Uninitialized');

    await page.goto(`${harness.baseUrl}/hello/all`);
    await page.getByRole('button', { name: 'Browse folders' }).click();
    await page.getByTestId('directory-picker').getByRole('button', { name: 'registered-project' }).click();
    await page.getByRole('button', { name: 'Register this folder' }).click();

    await expect(page.getByTestId('directory-register-error')).toContainText('already present in the inventory');
    await expect(page.getByTestId('inventory-count')).toContainText('1 project');

    await page.route(
      '**/api/projects/register',
      async (route) => {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Simulated register failure.',
            statusCode: 500,
          }),
        });
      },
      { times: 1 },
    );

    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Browse folders' }).click();
    await page.getByTestId('directory-picker').getByRole('button', { name: 'server-error-project' }).click();
    await page.getByRole('button', { name: 'Register this folder' }).click();

    await expect(page.getByTestId('directory-register-error')).toContainText('Simulated register failure');
    await expect(page.getByTestId('inventory-count')).toContainText('1 project');
  });

  test('switches each workflow tab to the matching panel', async ({ page, harness }) => {
    const initializedProjectPath = await createInitializedProject(harness.workspace.root, 'tabbed-project');
    const registration = await registerProject(harness.baseUrl, initializedProjectPath);
    const panels = [
      ['Progress', 'milestones-panel'],
      ['Dependencies', 'dependencies-panel'],
      ['Metrics', 'metrics-panel'],
      ['Task timeline', 'timeline-panel'],
      ['Agent', 'monitor-panel'],
      ['Changes', 'source-grid'],
      ['Export', 'export-panel'],
    ] as const;

    await page.goto(`${harness.baseUrl}/hello/${registration.project.projectId}`);

    await expect(page.getByTestId('detail-status')).toContainText('Initialized');

    for (const [tabName, panelTestId] of panels) {
      await page.getByRole('tab', { name: tabName }).click();
      await expect(page.getByRole('tab', { name: tabName })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId(panelTestId)).toBeVisible();

      if (panelTestId === 'timeline-panel') {
        await expect(page.getByTestId('timeline-list')).toContainText('M001/S01/T01');
        await expect(page.getByTestId('timeline-list')).toContainText('Completed task');
        await expect(page.getByTestId('timeline-list')).toContainText('Estimated remaining');
        await expect(page.getByTestId('project-event-list')).toContainText('Registered');
      }

      for (const [_otherTabName, otherPanelTestId] of panels) {
        if (otherPanelTestId !== panelTestId) {
          await expect(page.getByTestId(otherPanelTestId)).toBeHidden();
        }
      }
    }
  });

  test('surfaces disconnected SSE state, truncates oversized warnings, and fails fast on malformed refresh payloads', async ({
    page,
    harness,
  }) => {
    const initializedProjectPath = await createInitializedProject(harness.workspace.root, 'initialized-project');

    await page.route('**/api/events', async (route) => {
      await route.abort('failed');
    });

    await page.goto(`${harness.baseUrl}/hello/all`);

    await expect(page.getByTestId('stream-status')).toContainText('Disconnected');

    const registration = await registerProject(harness.baseUrl, initializedProjectPath);

    await expect(page.getByTestId('inventory-count')).toContainText('1 project', {
      timeout: 8_000,
    });
    await expect(page.getByRole('button', { name: 'Refresh inventory' })).toHaveCount(0);
    await page.getByTestId(`overview-project-card-${registration.project.projectId}`).click();

    const registeredProject = await getProjectByCanonicalPath(harness.baseUrl, initializedProjectPath);
    const oversizedWarningMessage = 'Oversized warning text '.repeat(40);
    const degradedProject = structuredClone(registeredProject);
    const degradedCheckedAt = new Date().toISOString();

    degradedProject.updatedAt = degradedCheckedAt;
    degradedProject.lastEventId = 'evt_999';
    degradedProject.snapshot.status = 'degraded';
    degradedProject.snapshot.checkedAt = degradedCheckedAt;
    degradedProject.monitor = {
      health: 'degraded',
      lastAttemptedAt: degradedCheckedAt,
      lastSuccessfulAt: degradedCheckedAt,
      lastTrigger: 'manual_refresh',
      lastError: null,
    };
    degradedProject.snapshot.warnings = [
      {
        source: 'stateMd',
        code: 'source_malformed',
        message: oversizedWarningMessage,
      },
    ];
    degradedProject.snapshot.sources.stateMd = {
      ...degradedProject.snapshot.sources.stateMd,
      state: 'malformed',
      detail: 'STATE.md became malformed during refresh.',
    };

    const oversizedWarningResponse: ProjectMutationResponse = {
      project: degradedProject,
      event: {
        id: 'evt_999',
        sequence: 999,
        type: 'project.refreshed',
        emittedAt: degradedCheckedAt,
        projectId: degradedProject.projectId,
        payload: {
          projectId: degradedProject.projectId,
          canonicalPath: degradedProject.canonicalPath,
          snapshotStatus: degradedProject.snapshot.status,
          warningCount: degradedProject.snapshot.warnings.length,
          warnings: degradedProject.snapshot.warnings,
          sourceStates: buildSourceStateMap(degradedProject.snapshot),
          changed: true,
          checkedAt: degradedProject.snapshot.checkedAt,
          trigger: 'manual_refresh',
          monitor: degradedProject.monitor,
        },
      },
    };

    await page.route(
      `**/api/projects/${registeredProject.projectId}/refresh`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(oversizedWarningResponse),
        });
      },
      { times: 1 },
    );

    let interceptedDetailRefreshes = 0;

    await page.route(
      new RegExp(`/api/projects/${registeredProject.projectId}$`),
      async (route) => {
        interceptedDetailRefreshes += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...degradedProject,
            timeline: [],
          }),
        });
      },
      { times: 1 },
    );

    await page.getByRole('button', { name: 'Refresh selected project' }).click();

    await expect.poll(() => interceptedDetailRefreshes).toBe(1);
    await expect(page.getByTestId('detail-status')).toContainText('Degraded');
    await expect(page.getByTestId('warning-list')).toContainText('STATE.md');

    const warningText = await page.getByTestId('warning-list').textContent();
    expect(warningText).toContain('…');
    expect(warningText?.length ?? 0).toBeLessThan(400);

    await page.route(
      `**/api/projects/${registeredProject.projectId}/refresh`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            project: {
              projectId: registeredProject.projectId,
              registeredPath: registeredProject.registeredPath,
              canonicalPath: registeredProject.canonicalPath,
              createdAt: registeredProject.createdAt,
              updatedAt: registeredProject.updatedAt,
              lastEventId: registeredProject.lastEventId,
            },
            event: {
              id: 'evt_1000',
              sequence: 1000,
              type: 'project.refreshed',
              emittedAt: degradedCheckedAt,
              projectId: registeredProject.projectId,
              payload: {
                projectId: registeredProject.projectId,
                canonicalPath: registeredProject.canonicalPath,
                snapshotStatus: 'degraded',
                warningCount: 1,
                warnings: degradedProject.snapshot.warnings,
                sourceStates: buildSourceStateMap(degradedProject.snapshot),
                changed: true,
                checkedAt: degradedCheckedAt,
                trigger: 'manual_refresh',
                monitor: degradedProject.monitor,
              },
            },
          }),
        });
      },
      { times: 1 },
    );

    await page.getByRole('button', { name: 'Refresh selected project' }).click();

    await expect(page.getByTestId('refresh-error')).toContainText('project mutation response.project.snapshot');
    await expect(page.getByTestId('detail-status')).toContainText('Degraded');
    await expect(page.getByTestId('warning-list')).toContainText('STATE.md');
  });
});
