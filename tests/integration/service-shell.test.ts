import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ProjectEventEnvelope } from '../../src/shared/contracts.js';
import { createApp, resolveDefaultPaths, type RuntimeSignal } from '../../src/server/app.js';
import { REGISTRY_SCHEMA_VERSION } from '../../src/server/db.js';
import { parseCliInvocation, runCli, startServer } from '../../src/server/index.js';
import { createTempWorkspace, writeClientShell } from '../helpers/project-fixtures.js';

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

async function readFirstSseEvent(url: string) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/event-stream',
    },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(response.body).not.toBeNull();

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const separatorIndex = buffer.indexOf('\n\n');

      if (separatorIndex >= 0) {
        const rawEvent = buffer.slice(0, separatorIndex);
        const dataLine = rawEvent
          .replace(/\r\n/g, '\n')
          .split('\n')
          .find((line) => line.startsWith('data: '));

        if (!dataLine) {
          throw new Error('Expected the SSE payload to include a data line');
        }

        return JSON.parse(dataLine.slice(6)) as ProjectEventEnvelope;
      }

      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Timed out waiting for the first SSE event')), 2_000);
        }),
      ]);

      if (result.done) {
        throw new Error('Event stream closed before the first event was received');
      }

      buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n');
    }
  } finally {
    await reader.cancel();
  }
}

describe('service shell bootstrap', () => {
  test('parses host and port CLI options for foreground and daemon commands', () => {
    expect(parseCliInvocation(['--host', '0.0.0.0', '--port', '3001'])).toEqual({
      command: 'start',
      daemonChild: false,
      listenOptions: {
        host: '0.0.0.0',
        port: 3001,
      },
    });

    expect(parseCliInvocation(['serve', '--host=127.0.0.1', '--port=0', '--daemon-child'])).toEqual({
      command: 'serve',
      daemonChild: true,
      listenOptions: {
        host: '127.0.0.1',
        port: 0,
      },
    });

    expect(parseCliInvocation(['reload', '--port', '65535'])).toEqual({
      command: 'reload',
      daemonChild: false,
      listenOptions: {
        port: 65535,
      },
    });
  });

  test('rejects malformed host and port CLI options', () => {
    expect(() => parseCliInvocation(['--host'])).toThrow(/missing value/i);
    expect(() => parseCliInvocation(['--host', '   '])).toThrow(/host must not be empty/i);
    expect(() => parseCliInvocation(['--port', '65536'])).toThrow(/invalid port/i);
    expect(() => parseCliInvocation(['--bogus'])).toThrow(/unknown option/i);
  });

  test('resolves npm runtime defaults under the user home directory', async () => {
    const workspace = await createTempWorkspace('gsd-web-runtime-');

    cleanupTasks.push(workspace.cleanup);

    const paths = resolveDefaultPaths(import.meta.url, {
      env: {},
      homeDirectory: workspace.root,
    });

    expect(paths.runtimeDir).toBe(path.join(workspace.root, '.gsd-web'));
    expect(paths.databasePath).toBe(path.join(workspace.root, '.gsd-web', 'data', 'gsd-web.sqlite'));
    expect(paths.logFilePath).toBe(path.join(workspace.root, '.gsd-web', 'logs', 'gsd-web.log'));
    expect(paths.configFilePath).toBe(path.join(workspace.root, '.gsd-web', 'config.json'));
    expect(paths.clientDistDir).toMatch(/dist[/\\]web$/);
  });

  test('rejects an empty database path', async () => {
    const workspace = await createTempWorkspace('gsd-web-shell-');
    const clientDistDir = await writeClientShell(workspace.root);

    cleanupTasks.push(workspace.cleanup);

    await expect(
      createApp({
        databasePath: '   ',
        clientDistDir,
        logger: false,
      }),
    ).rejects.toThrow(/database path is required/i);
  });

  test('fails fast when the built shell is missing', async () => {
    const workspace = await createTempWorkspace('gsd-web-shell-');

    cleanupTasks.push(workspace.cleanup);

    await expect(
      createApp({
        databasePath: path.join(workspace.root, 'data', 'gsd-web.sqlite'),
        clientDistDir: path.join(workspace.root, 'missing-web-dist'),
        logger: false,
      }),
    ).rejects.toThrow(/missing its shell index\.html/i);
  });

  test('creates runtime data and log files below the configured runtime directory', async () => {
    const workspace = await createTempWorkspace('gsd-web-runtime-');
    const clientDistDir = await writeClientShell(workspace.root);
    const runtimeDir = path.join(workspace.root, '.gsd-web');

    cleanupTasks.push(workspace.cleanup);

    const app = await createApp({
      runtimeDir,
      clientDistDir,
    });

    cleanupTasks.push(async () => {
      await app.close();
    });

    const paths = app.gsdWebPaths;

    expect(paths.databasePath).toBe(path.join(runtimeDir, 'data', 'gsd-web.sqlite'));
    expect(paths.activeLogFilePath).toBe(path.join(runtimeDir, 'logs', 'gsd-web.log'));
    expect(paths.configFilePath).toBe(path.join(runtimeDir, 'config.json'));
    expect(paths.logPolicy).toEqual({
      enabled: true,
      rotateDaily: true,
      compression: 'gzip',
      retentionDays: 7,
      maxFileSizeBytes: 20 * 1024 * 1024,
    });
    expect(await readFile(paths.databasePath)).toBeInstanceOf(Buffer);
    expect(JSON.parse(await readFile(paths.configFilePath, 'utf8'))).toMatchObject({
      publicUrl: '',
      slack: {
        enabled: false,
        events: expect.arrayContaining(['project.refreshed', 'project.init.updated']),
      },
    });

    await app.close();
    cleanupTasks.pop();

    const logText = await readFile(paths.activeLogFilePath!, 'utf8');
    expect(logText).toContain('"event":"runtime_paths"');
    expect(logText).toContain('"event":"database_open"');
  });

  test('serves health JSON, registry contracts, SSE backlog, and SPA fallback from one process', async () => {
    const workspace = await createTempWorkspace('gsd-web-shell-');
    const clientDistDir = await writeClientShell(workspace.root);
    const databasePath = path.join(workspace.root, 'data', 'gsd-web.sqlite');
    const runtimeSignals: RuntimeSignal[] = [];

    cleanupTasks.push(workspace.cleanup);

    const app = await startServer({
      host: '127.0.0.1',
      port: 0,
      databasePath,
      clientDistDir,
      logger: false,
      logSink: (signal) => {
        runtimeSignals.push(signal);
      },
    });

    cleanupTasks.push(async () => {
      await app.close();
    });

    const baseUrl = getBaseUrl(app);

    const healthResponse = await fetch(`${baseUrl}/api/health`);
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.headers.get('content-type')).toContain('application/json');
    expect(await healthResponse.json()).toMatchObject({
      service: 'gsd-web',
      status: 'ok',
      runtime: {
        directory: expect.stringMatching(/\.gsd-web$/),
        logFile: null,
        logPolicy: {
          enabled: false,
          rotateDaily: true,
          compression: 'gzip',
          retentionDays: 7,
          maxFileSizeBytes: 20 * 1024 * 1024,
        },
      },
      database: {
        connected: true,
        fileName: 'gsd-web.sqlite',
        path: databasePath,
        schemaVersion: REGISTRY_SCHEMA_VERSION,
      },
      assets: {
        available: true,
        directoryName: 'web-dist',
        path: clientDistDir,
      },
      projects: {
        total: 0,
      },
    });

    const projectsResponse = await fetch(`${baseUrl}/api/projects`);
    expect(projectsResponse.status).toBe(200);
    expect(await projectsResponse.json()).toEqual({
      items: [],
      total: 0,
    });

    const directoryResponse = await fetch(
      `${baseUrl}/api/filesystem/directories?path=${encodeURIComponent(workspace.root)}`,
    );
    expect(directoryResponse.status).toBe(200);
    expect(await directoryResponse.json()).toMatchObject({
      path: workspace.root,
      entries: expect.arrayContaining([
        expect.objectContaining({
          name: 'web-dist',
          path: clientDistDir,
          hidden: false,
        }),
      ]),
    });

    const readyEvent = await readFirstSseEvent(`${baseUrl}/api/events`);
    expect(readyEvent).toMatchObject({
      type: 'service.ready',
      payload: {
        service: 'gsd-web',
        projects: {
          total: 0,
        },
      },
    });

    const shellResponse = await fetch(`${baseUrl}/projects/demo`);
    expect(shellResponse.status).toBe(200);
    expect(shellResponse.headers.get('content-type')).toContain('text/html');
    expect(await shellResponse.text()).toContain('GSD Web Test Shell');

    const missingAssetResponse = await fetch(`${baseUrl}/assets/missing.js`);
    expect(missingAssetResponse.status).toBe(404);
    expect(await missingAssetResponse.json()).toMatchObject({
      error: 'Not Found',
      statusCode: 404,
    });

    expect(runtimeSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'database_open',
          databasePath,
        }),
        expect.objectContaining({
          event: 'service_start',
          host: '127.0.0.1',
          port: 0,
        }),
        expect.objectContaining({
          event: 'project_event',
          eventType: 'service.ready',
        }),
      ]),
    );
    expect(
      runtimeSignals.filter((signal) => signal.event === 'route_registration'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'GET', route: '/api/health' }),
        expect.objectContaining({ method: 'GET', route: '/api/filesystem/directories' }),
        expect.objectContaining({ method: 'GET', route: '/api/projects' }),
        expect.objectContaining({ method: 'GET', route: '/api/projects/:id' }),
        expect.objectContaining({ method: 'GET', route: '/api/projects/:id/timeline' }),
        expect.objectContaining({ method: 'POST', route: '/api/projects/register' }),
        expect.objectContaining({ method: 'POST', route: '/api/projects/:id/relink' }),
        expect.objectContaining({ method: 'DELETE', route: '/api/projects/:id' }),
        expect.objectContaining({ method: 'POST', route: '/api/projects/:id/refresh' }),
        expect.objectContaining({ method: 'POST', route: '/api/projects/:id/init' }),
        expect.objectContaining({ method: 'GET', route: '/api/events' }),
        expect.objectContaining({ method: 'GET', route: '/*' }),
      ]),
    );
  });

  test('prints log policy in CLI status output when daemon metadata is present', async () => {
    const workspace = await createTempWorkspace('gsd-web-status-');
    const runtimeDir = path.join(workspace.root, '.gsd-web');
    const pidFilePath = path.join(runtimeDir, 'gsd-web.pid');
    const previousHome = process.env.GSD_WEB_HOME;
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    cleanupTasks.push(workspace.cleanup);

    try {
      process.env.GSD_WEB_HOME = runtimeDir;
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(
        pidFilePath,
        `${JSON.stringify({
          pid: process.pid,
          address: 'http://127.0.0.1:3000',
          startedAt: '2026-04-24T12:00:00.000Z',
          runtimeDir,
          databasePath: path.join(runtimeDir, 'data', 'gsd-web.sqlite'),
          logFilePath: path.join(runtimeDir, 'logs', 'gsd-web.log'),
          logRetentionDays: 7,
          logMaxFileSizeBytes: 20 * 1024 * 1024,
        }, null, 2)}\n`,
        'utf8',
      );

      expect(await runCli(['status'])).toBe(0);
      expect(infoSpy.mock.calls).toEqual(
        expect.arrayContaining([
          [expect.stringContaining('gsd-web is running')],
          [expect.stringContaining(`logs: ${path.join(runtimeDir, 'logs', 'gsd-web.log')}`)],
          [expect.stringContaining('log policy: daily rotation, gzip archives, 7-day retention, 20 MiB max active file')],
        ]),
      );
    } finally {
      infoSpy.mockRestore();

      if (previousHome === undefined) {
        delete process.env.GSD_WEB_HOME;
      } else {
        process.env.GSD_WEB_HOME = previousHome;
      }
    }
  });
});
