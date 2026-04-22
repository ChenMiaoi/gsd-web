import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import { createApp, type RuntimeSignal } from '../../src/server/app.js';
import { startServer } from '../../src/server/index.js';

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const cleanup = cleanupTasks.pop();

    if (cleanup) {
      await cleanup();
    }
  }
});

async function createTempWorkspace() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'gsd-web-shell-'));

  cleanupTasks.push(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  return workspace;
}

async function writeClientShell(workspace: string) {
  const clientDistDir = path.join(workspace, 'web-dist');

  await mkdir(path.join(clientDistDir, 'assets'), { recursive: true });
  await writeFile(
    path.join(clientDistDir, 'index.html'),
    [
      '<!doctype html>',
      '<html lang="en">',
      '  <head><meta charset="utf-8" /><title>GSD Web Test Shell</title></head>',
      '  <body>',
      '    <div id="root">GSD Web Test Shell</div>',
      '  </body>',
      '</html>',
    ].join('\n'),
  );
  await writeFile(path.join(clientDistDir, 'assets', 'main.js'), 'console.log("gsd-web shell");\n');

  return clientDistDir;
}

function getBaseUrl(app: FastifyInstance) {
  const address = app.server.address() as AddressInfo | null;

  if (!address || typeof address === 'string') {
    throw new Error('Expected the Fastify app to listen on a TCP port');
  }

  return `http://127.0.0.1:${address.port}`;
}

describe('service shell bootstrap', () => {
  test('rejects an empty database path', async () => {
    const workspace = await createTempWorkspace();
    const clientDistDir = await writeClientShell(workspace);

    await expect(
      createApp({
        databasePath: '   ',
        clientDistDir,
        logger: false,
      }),
    ).rejects.toThrow(/database path is required/i);
  });

  test('fails fast when the built shell is missing', async () => {
    const workspace = await createTempWorkspace();

    await expect(
      createApp({
        databasePath: path.join(workspace, 'data', 'gsd-web.sqlite'),
        clientDistDir: path.join(workspace, 'missing-web-dist'),
        logger: false,
      }),
    ).rejects.toThrow(/missing its shell index\.html/i);
  });

  test('serves health JSON, placeholder contracts, and SPA fallback from one process', async () => {
    const workspace = await createTempWorkspace();
    const clientDistDir = await writeClientShell(workspace);
    const databasePath = path.join(workspace, 'data', 'gsd-web.sqlite');
    const runtimeSignals: RuntimeSignal[] = [];

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
      database: {
        connected: true,
        fileName: 'gsd-web.sqlite',
        schemaVersion: '1',
      },
      assets: {
        available: true,
        directoryName: 'web-dist',
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

    const eventsResponse = await fetch(`${baseUrl}/api/events`);
    expect(eventsResponse.status).toBe(200);
    expect(eventsResponse.headers.get('content-type')).toContain('text/event-stream');

    const eventStream = await eventsResponse.text();
    expect(eventStream).toContain('event: service.ready');
    const dataLine = eventStream
      .split('\n')
      .find((line) => line.startsWith('data: '));
    expect(dataLine).toBeDefined();
    expect(JSON.parse(dataLine!.slice(6))).toMatchObject({
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
      ]),
    );
    expect(
      runtimeSignals.filter((signal) => signal.event === 'route_registration'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'GET', route: '/api/health' }),
        expect.objectContaining({ method: 'GET', route: '/api/projects' }),
        expect.objectContaining({ method: 'GET', route: '/api/events' }),
        expect.objectContaining({ method: 'GET', route: '/*' }),
      ]),
    );
  });
});
