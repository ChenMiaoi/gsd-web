import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import type { ProjectEventEnvelope } from '../../src/shared/contracts.js';
import { createApp, type RuntimeSignal } from '../../src/server/app.js';
import { startServer } from '../../src/server/index.js';
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
      database: {
        connected: true,
        fileName: 'gsd-web.sqlite',
        schemaVersion: '2',
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
        expect.objectContaining({ method: 'GET', route: '/api/projects' }),
        expect.objectContaining({ method: 'GET', route: '/api/projects/:id' }),
        expect.objectContaining({ method: 'POST', route: '/api/projects/register' }),
        expect.objectContaining({ method: 'POST', route: '/api/projects/:id/refresh' }),
        expect.objectContaining({ method: 'GET', route: '/api/events' }),
        expect.objectContaining({ method: 'GET', route: '/*' }),
      ]),
    );
  });
});
