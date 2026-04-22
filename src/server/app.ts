import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { access, constants, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVICE_NAME, type HealthResponse, type ProjectEventEnvelope } from '../shared/contracts.js';
import { REGISTRY_SCHEMA_VERSION, RegistryDatabase } from './db.js';
import { EventHub, registerEventsRoute } from './routes/events.js';
import { registerProjectRoutes } from './routes/projects.js';

export type RuntimeSignal =
  | {
      event: 'database_open';
      databasePath: string;
    }
  | {
      event: 'route_registration';
      method: 'GET' | 'POST';
      route: string;
    }
  | {
      event: 'project_event';
      eventId: string;
      eventType: string;
      projectId: string | null;
      snapshotStatus?: string;
      warningCount?: number;
    }
  | {
      event: 'service_start';
      address: string;
      host: string;
      port: number;
    };

export interface CreateAppOptions {
  databasePath?: string;
  clientDistDir?: string;
  logger?: boolean;
  logSink?: (signal: RuntimeSignal) => void;
}

function resolveConfiguredPath(label: string, candidate: string): string {
  const trimmed = candidate.trim();

  if (trimmed.length === 0) {
    throw new Error(`${label} path is required`);
  }

  return path.resolve(trimmed);
}

async function assertReadableFile(filePath: string, message: string) {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(message);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveProjectRoot(fromMetaUrl: string = import.meta.url): string {
  let currentDirectory = path.dirname(fileURLToPath(fromMetaUrl));

  while (true) {
    if (existsSync(path.join(currentDirectory, 'package.json'))) {
      return currentDirectory;
    }

    const parentDirectory = path.dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      throw new Error(`Unable to locate project root from ${fromMetaUrl}`);
    }

    currentDirectory = parentDirectory;
  }
}

export function resolveDefaultPaths(fromMetaUrl: string = import.meta.url) {
  const projectRoot = resolveProjectRoot(fromMetaUrl);

  return {
    projectRoot,
    databasePath: path.join(projectRoot, 'data', 'gsd-web.sqlite'),
    clientDistDir: path.join(projectRoot, 'dist', 'web'),
  };
}

function emitSignal(
  app: FastifyInstance,
  logSink: CreateAppOptions['logSink'],
  signal: RuntimeSignal,
  message: string,
) {
  logSink?.(signal);
  app.log.info(signal, message);
}

function emitProjectEvent(
  app: FastifyInstance,
  logSink: CreateAppOptions['logSink'],
  event: ProjectEventEnvelope,
) {
  const signal: Extract<RuntimeSignal, { event: 'project_event' }> = {
    event: 'project_event',
    eventId: event.id,
    eventType: event.type,
    projectId: event.projectId,
  };

  if ('snapshotStatus' in event.payload) {
    signal.snapshotStatus = event.payload.snapshotStatus;
  }

  if ('warningCount' in event.payload) {
    signal.warningCount = event.payload.warningCount;
  }

  emitSignal(app, logSink, signal, 'Broadcasted project event');
}

function buildHealthResponse(
  databasePath: string,
  clientDistDir: string,
  projectTotal: number,
): HealthResponse {
  return {
    service: SERVICE_NAME,
    status: 'ok',
    checkedAt: new Date().toISOString(),
    database: {
      connected: true,
      fileName: path.basename(databasePath),
      schemaVersion: REGISTRY_SCHEMA_VERSION,
    },
    assets: {
      available: true,
      directoryName: path.basename(clientDistDir),
    },
    projects: {
      total: projectTotal,
    },
  };
}

function decodeRequestPath(requestUrl: string): string {
  const [pathname = '/'] = requestUrl.split('?');

  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function toSafeRelativePath(requestPath: string): string | null {
  const withoutLeadingSlash = requestPath.replace(/^\/+/, '');
  const candidate = withoutLeadingSlash.length === 0 ? 'index.html' : withoutLeadingSlash;
  const normalizedPath = path.posix.normalize(candidate);

  if (normalizedPath === '..' || normalizedPath.startsWith('../')) {
    return null;
  }

  return normalizedPath;
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const defaults = resolveDefaultPaths(import.meta.url);
  const databasePath = resolveConfiguredPath(
    'GSD web database',
    options.databasePath ?? defaults.databasePath,
  );
  const clientDistDir = resolveConfiguredPath(
    'Client build directory',
    options.clientDistDir ?? defaults.clientDistDir,
  );
  const indexHtmlPath = path.join(clientDistDir, 'index.html');

  await assertReadableFile(
    indexHtmlPath,
    `Client build directory is missing its shell index.html: ${indexHtmlPath}`,
  );
  await mkdir(path.dirname(databasePath), { recursive: true });

  const app = Fastify({
    logger: options.logger ?? true,
    forceCloseConnections: true,
  });
  let registry: RegistryDatabase | undefined;
  let eventHub: EventHub | undefined;

  try {
    const registryInstance = new RegistryDatabase(databasePath);
    const eventHubInstance = new EventHub(registryInstance);
    registry = registryInstance;
    eventHub = eventHubInstance;
    const indexHtml = await readFile(indexHtmlPath, 'utf8');

    emitSignal(
      app,
      options.logSink,
      {
        event: 'database_open',
        databasePath,
      },
      'Opened gsd-web SQLite database',
    );

    app.addHook('onClose', async () => {
      eventHubInstance.close();
      registryInstance.close();
    });

    await app.register(fastifyStatic, {
      root: clientDistDir,
      wildcard: false,
    });

    app.get('/api/health', async () =>
      buildHealthResponse(databasePath, clientDistDir, registryInstance.getProjectCount()),
    );
    emitSignal(
      app,
      options.logSink,
      {
        event: 'route_registration',
        method: 'GET',
        route: '/api/health',
      },
      'Registered route',
    );

    const projectRoutes = await registerProjectRoutes(app, {
      registry: registryInstance,
      eventHub: eventHubInstance,
    });

    for (const route of projectRoutes) {
      emitSignal(
        app,
        options.logSink,
        {
          event: 'route_registration',
          method: route.method,
          route: route.route,
        },
        'Registered route',
      );
    }

    const eventRoutes = await registerEventsRoute(app, {
      registry: registryInstance,
      eventHub: eventHubInstance,
    });

    for (const route of eventRoutes) {
      emitSignal(
        app,
        options.logSink,
        {
          event: 'route_registration',
          method: route.method,
          route: route.route,
        },
        'Registered route',
      );
    }

    app.get('/*', async (request, reply) => {
      const requestPath = decodeRequestPath(request.url);

      if (requestPath === '/api' || requestPath.startsWith('/api/')) {
        return reply.code(404).send({
          error: 'Not Found',
          message: `Route GET:${requestPath} not found`,
          statusCode: 404,
        });
      }

      const relativePath = toSafeRelativePath(requestPath);

      if (relativePath === null) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid asset path',
          statusCode: 400,
        });
      }

      const absolutePath = path.join(clientDistDir, relativePath);
      const isAssetRequest = path.extname(relativePath).length > 0;

      if (isAssetRequest) {
        if (await fileExists(absolutePath)) {
          return reply.sendFile(relativePath);
        }

        return reply.code(404).send({
          error: 'Not Found',
          message: `Static asset ${requestPath} was not found`,
          statusCode: 404,
        });
      }

      return reply.type('text/html; charset=utf-8').send(indexHtml);
    });
    emitSignal(
      app,
      options.logSink,
      {
        event: 'route_registration',
        method: 'GET',
        route: '/*',
      },
      'Registered route',
    );

    const serviceReadyEvent = registryInstance.appendServiceReadyEvent({
      service: SERVICE_NAME,
      projects: {
        total: registryInstance.getProjectCount(),
      },
    });
    eventHubInstance.broadcast(serviceReadyEvent);
    emitProjectEvent(app, options.logSink, serviceReadyEvent);

    await app.ready();

    return app;
  } catch (error) {
    eventHub?.close();
    registry?.close();
    throw error;
  }
}
