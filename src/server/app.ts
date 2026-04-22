import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { access, constants, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export type RuntimeSignal =
  | {
      event: 'database_open';
      databasePath: string;
    }
  | {
      event: 'route_registration';
      method: 'GET';
      route: string;
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

type HealthResponse = {
  service: 'gsd-web';
  status: 'ok';
  checkedAt: string;
  database: {
    connected: true;
    fileName: string;
    schemaVersion: string;
  };
  assets: {
    available: true;
    directoryName: string;
  };
  projects: {
    total: 0;
  };
};

type ProjectsResponse = {
  items: [];
  total: 0;
};

const SERVICE_NAME = 'gsd-web';
const SCHEMA_VERSION = '1';

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

function openDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);

  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS service_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const upsertMetadata = database.prepare(`
    INSERT INTO service_metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  upsertMetadata.run('schemaVersion', SCHEMA_VERSION);
  upsertMetadata.run('lastBootedAt', new Date().toISOString());

  return database;
}

function buildHealthResponse(databasePath: string, clientDistDir: string): HealthResponse {
  return {
    service: SERVICE_NAME,
    status: 'ok',
    checkedAt: new Date().toISOString(),
    database: {
      connected: true,
      fileName: path.basename(databasePath),
      schemaVersion: SCHEMA_VERSION,
    },
    assets: {
      available: true,
      directoryName: path.basename(clientDistDir),
    },
    projects: {
      total: 0,
    },
  };
}

function buildProjectsResponse(): ProjectsResponse {
  return {
    items: [],
    total: 0,
  };
}

function buildBootstrapEnvelope() {
  const emittedAt = new Date().toISOString();

  return {
    id: `service-ready:${emittedAt}`,
    type: 'service.ready',
    emittedAt,
    payload: {
      service: SERVICE_NAME,
      projects: {
        total: 0,
      },
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

  const app = Fastify({ logger: options.logger ?? true });
  let database: DatabaseSync | undefined;

  try {
    database = openDatabase(databasePath);
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
      database?.close();
    });

    await app.register(fastifyStatic, {
      root: clientDistDir,
      wildcard: false,
    });

    app.get('/api/health', async () => buildHealthResponse(databasePath, clientDistDir));
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

    app.get('/api/projects', async () => buildProjectsResponse());
    emitSignal(
      app,
      options.logSink,
      {
        event: 'route_registration',
        method: 'GET',
        route: '/api/projects',
      },
      'Registered route',
    );

    app.get('/api/events', async (_request, reply) => {
      const envelope = buildBootstrapEnvelope();
      const payload = [
        `id: ${envelope.id}`,
        `event: ${envelope.type}`,
        `data: ${JSON.stringify(envelope)}`,
        '',
        '',
      ].join('\n');

      reply.hijack();
      reply.raw.writeHead(200, {
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
      });
      reply.raw.end(payload);

      return reply;
    });
    emitSignal(
      app,
      options.logSink,
      {
        event: 'route_registration',
        method: 'GET',
        route: '/api/events',
      },
      'Registered route',
    );

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

    await app.ready();

    return app;
  } catch (error) {
    database?.close();
    throw error;
  }
}
