import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { access, constants, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SERVICE_NAME,
  type HealthResponse,
  type LogPolicySummary,
  type ProjectEventEnvelope,
} from '../shared/contracts.js';
import { REGISTRY_SCHEMA_VERSION, RegistryDatabase } from './db.js';
import {
  DEFAULT_LOG_MAX_FILE_SIZE_BYTES,
  DEFAULT_LOG_RETENTION_DAYS,
  RotatingLogStream,
} from './log-rotation.js';
import {
  DEFAULT_MONITOR_INTERVAL_MS,
  ProjectMonitorManager,
  type ProjectMonitorSignal,
} from './monitor.js';
import { ProjectReconciler, type ProjectReconcileSignal } from './project-reconcile.js';
import { EventHub, registerEventsRoute } from './routes/events.js';
import { registerProjectRoutes, type ProjectInitRunner } from './routes/projects.js';
import { registerSlackRoutes } from './routes/slack.js';
import {
  DEFAULT_SLACK_EVENT_TYPES,
  SlackNotifier,
  resolveSlackCommandConfig,
  resolveSlackNotifierConfig,
  type SlackNotifierFileConfig,
  type SlackNotifierConfig,
  type SlackNotificationSignal,
} from './slack.js';

export type RuntimeSignal =
  | {
      event: 'runtime_paths';
      runtimeDir: string;
      databasePath: string;
      clientDistDir: string;
      logFilePath: string | null;
      configFilePath: string;
    }
  | {
      event: 'database_open';
      databasePath: string;
      runtimeDir: string;
    }
  | {
      event: 'route_registration';
      method: 'GET' | 'POST' | 'DELETE';
      route: string;
    }
  | {
      event: 'project_event';
      eventId: string;
      eventType: string;
      projectId: string | null;
      trigger?: string;
      snapshotStatus?: string;
      warningCount?: number;
      monitorHealth?: string;
      previousHealth?: string;
      initStage?: string;
      initJobId?: string;
      refreshStatus?: string;
    }
  | ProjectMonitorSignal
  | ProjectReconcileSignal
  | SlackNotificationSignal
  | {
      event: 'service_start';
      address: string;
      host: string;
      port: number;
    };

export interface CreateAppOptions {
  runtimeDir?: string;
  databasePath?: string;
  clientDistDir?: string;
  logDir?: string;
  logFilePath?: string;
  logger?: boolean;
  logRetentionDays?: number;
  logMaxFileSizeBytes?: number;
  logSink?: (signal: RuntimeSignal) => void;
  snapshotTimeoutMs?: number;
  monitorIntervalMs?: number;
  watchersEnabled?: boolean;
  initRunner?: ProjectInitRunner;
  slack?: false | SlackNotifierConfig;
  config?: false | GsdWebConfig;
  configFilePath?: string;
}

export interface GsdWebConfig {
  publicUrl?: string;
  slack?: SlackNotifierFileConfig;
}

export interface ResolvedRuntimePaths {
  packageRoot: string;
  runtimeDir: string;
  dataDir: string;
  databasePath: string;
  clientDistDir: string;
  logDir: string;
  logFilePath: string;
  configFilePath: string;
}

export type GsdWebApp = FastifyInstance & {
  gsdWebPaths: ResolvedRuntimePaths & {
    activeLogFilePath: string | null;
    logPolicy: LogPolicySummary;
  };
};

export interface ResolveDefaultPathsOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

function resolveConfiguredPath(label: string, candidate: string): string {
  const trimmed = candidate.trim();

  if (trimmed.length === 0) {
    throw new Error(`${label} path is required`);
  }

  return path.resolve(trimmed);
}

function resolveOptionalEnvPath(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();

  return value ? path.resolve(value) : undefined;
}

function resolveOptionalEnvInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name]?.trim();

  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

function resolveOptionalEnvPositiveInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const parsed = resolveOptionalEnvInteger(env, name);

  if (parsed === undefined) {
    return undefined;
  }

  if (parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function resolveOptionalEnvBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = env[name]?.trim().toLowerCase();

  if (!value) {
    return undefined;
  }

  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }

  throw new Error(`${name} must be a boolean value`);
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

export function resolveDefaultPaths(
  fromMetaUrl: string = import.meta.url,
  options: ResolveDefaultPathsOptions = {},
): ResolvedRuntimePaths {
  const env = options.env ?? process.env;
  const packageRoot = resolveProjectRoot(fromMetaUrl);
  const runtimeDir =
    resolveOptionalEnvPath(env, 'GSD_WEB_HOME')
    ?? path.resolve(options.homeDirectory ?? homedir(), '.gsd-web');
  const dataDir = path.join(runtimeDir, 'data');
  const logDir = resolveOptionalEnvPath(env, 'GSD_WEB_LOG_DIR') ?? path.join(runtimeDir, 'logs');

  return {
    packageRoot,
    runtimeDir,
    dataDir,
    databasePath: resolveOptionalEnvPath(env, 'GSD_WEB_DATABASE_PATH') ?? path.join(dataDir, 'gsd-web.sqlite'),
    clientDistDir: resolveOptionalEnvPath(env, 'GSD_WEB_CLIENT_DIST_DIR') ?? path.join(packageRoot, 'dist', 'web'),
    logDir,
    logFilePath: resolveOptionalEnvPath(env, 'GSD_WEB_LOG_FILE') ?? path.join(logDir, 'gsd-web.log'),
    configFilePath: resolveOptionalEnvPath(env, 'GSD_WEB_CONFIG_PATH') ?? path.join(runtimeDir, 'config.json'),
  };
}

function createDefaultConfigFileContent() {
  return `${JSON.stringify(
    {
      publicUrl: '',
      slack: {
        enabled: false,
        webhookUrl: '',
        botToken: '',
        channelId: '',
        signingSecret: '',
        events: DEFAULT_SLACK_EVENT_TYPES,
        timeoutMs: 5000,
      },
    },
    null,
    2,
  )}\n`;
}

function parseOptionalConfigString(record: Record<string, unknown>, key: string) {
  const value = record[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`config.json ${key} must be a string.`);
  }

  return value;
}

function parseRuntimeConfig(rawConfig: string): GsdWebConfig {
  const parsed = JSON.parse(rawConfig) as unknown;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config.json must contain a JSON object.');
  }

  const record = parsed as Record<string, unknown>;
  const config: GsdWebConfig = {};
  const publicUrl = parseOptionalConfigString(record, 'publicUrl');

  if (publicUrl !== undefined) {
    config.publicUrl = publicUrl;
  }

  if (record.slack !== undefined && record.slack !== null) {
    if (typeof record.slack !== 'object' || Array.isArray(record.slack)) {
      throw new Error('config.json slack must be an object.');
    }

    const slackRecord = record.slack as Record<string, unknown>;
    const slack: SlackNotifierFileConfig = {};
    const enabled = slackRecord.enabled;

    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        throw new Error('config.json slack.enabled must be a boolean.');
      }

      slack.enabled = enabled;
    }

    for (const key of ['webhookUrl', 'botToken', 'channelId', 'signingSecret'] as const) {
      const value = parseOptionalConfigString(slackRecord, key);

      if (value !== undefined) {
        slack[key] = value;
      }
    }

    if (slackRecord.events !== undefined) {
      if (
        !Array.isArray(slackRecord.events)
        || slackRecord.events.some((eventType) => typeof eventType !== 'string')
      ) {
        throw new Error('config.json slack.events must be an array of event type strings.');
      }

      slack.events = slackRecord.events as NonNullable<SlackNotifierFileConfig['events']>;
    }

    if (slackRecord.timeoutMs !== undefined) {
      if (
        typeof slackRecord.timeoutMs !== 'number'
        || !Number.isInteger(slackRecord.timeoutMs)
        || slackRecord.timeoutMs <= 0
      ) {
        throw new Error('config.json slack.timeoutMs must be a positive integer.');
      }

      slack.timeoutMs = slackRecord.timeoutMs;
    }

    config.slack = slack;
  }

  return config;
}

async function readRuntimeConfig(configFilePath: string, options: { createIfMissing: boolean }): Promise<GsdWebConfig> {
  try {
    return parseRuntimeConfig(await readFile(configFilePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    if (!options.createIfMissing) {
      return {};
    }

    await mkdir(path.dirname(configFilePath), { recursive: true });
    await writeFile(configFilePath, createDefaultConfigFileContent(), { flag: 'wx' }).catch((writeError) => {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw writeError;
      }
    });

    return {};
  }
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

  if ('trigger' in event.payload) {
    signal.trigger = event.payload.trigger;
  }

  if ('snapshotStatus' in event.payload) {
    signal.snapshotStatus = event.payload.snapshotStatus;
  }

  if ('warningCount' in event.payload) {
    signal.warningCount = event.payload.warningCount;
  }

  if ('monitor' in event.payload) {
    signal.monitorHealth = event.payload.monitor.health;
  }

  if ('previousHealth' in event.payload && event.payload.previousHealth !== null) {
    signal.previousHealth = event.payload.previousHealth;
  }

  if ('job' in event.payload) {
    signal.initStage = event.payload.job.stage;
    signal.initJobId = event.payload.job.jobId;

    if (event.payload.job.refreshResult?.status) {
      signal.refreshStatus = event.payload.job.refreshResult.status;
    }
  }

  emitSignal(app, logSink, signal, 'Broadcasted project event');
}

function buildLogPolicySummary(
  enabled: boolean,
  retentionDays: number,
  maxFileSizeBytes: number,
): LogPolicySummary {
  return {
    enabled,
    rotateDaily: true,
    compression: 'gzip',
    retentionDays,
    maxFileSizeBytes,
  };
}

function buildHealthResponse(
  runtimeDir: string,
  databasePath: string,
  clientDistDir: string,
  logFilePath: string | null,
  logPolicy: LogPolicySummary,
  projectTotal: number,
): HealthResponse {
  return {
    service: SERVICE_NAME,
    status: 'ok',
    checkedAt: new Date().toISOString(),
    runtime: {
      directory: runtimeDir,
      logFile: logFilePath,
      logPolicy,
    },
    database: {
      connected: true,
      fileName: path.basename(databasePath),
      path: databasePath,
      schemaVersion: REGISTRY_SCHEMA_VERSION,
    },
    assets: {
      available: true,
      directoryName: path.basename(clientDistDir),
      path: clientDistDir,
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

export async function createApp(options: CreateAppOptions = {}): Promise<GsdWebApp> {
  const defaults = resolveDefaultPaths(import.meta.url);
  const runtimeDir = resolveConfiguredPath(
    'GSD web runtime directory',
    options.runtimeDir ?? defaults.runtimeDir,
  );
  const defaultDatabasePath = options.runtimeDir === undefined
    ? defaults.databasePath
    : path.join(runtimeDir, 'data', 'gsd-web.sqlite');
  const defaultLogDir = options.runtimeDir === undefined ? defaults.logDir : path.join(runtimeDir, 'logs');
  const databasePath = resolveConfiguredPath(
    'GSD web database',
    options.databasePath ?? defaultDatabasePath,
  );
  const clientDistDir = resolveConfiguredPath(
    'Client build directory',
    options.clientDistDir ?? defaults.clientDistDir,
  );
  const logDir = resolveConfiguredPath('GSD web log directory', options.logDir ?? defaultLogDir);
  const defaultLogFilePath = options.logDir === undefined && options.runtimeDir === undefined
    ? defaults.logFilePath
    : path.join(logDir, 'gsd-web.log');
  const logFilePath = resolveConfiguredPath('GSD web log file', options.logFilePath ?? defaultLogFilePath);
  const configFilePath = resolveConfiguredPath(
    'GSD web config file',
    options.configFilePath ?? (options.runtimeDir === undefined ? defaults.configFilePath : path.join(runtimeDir, 'config.json')),
  );
  const shouldCreateMissingConfig =
    options.configFilePath !== undefined
    || options.runtimeDir !== undefined
    || options.databasePath === undefined;
  const runtimeConfig = options.config === false
    ? {}
    : options.config ?? await readRuntimeConfig(configFilePath, { createIfMissing: shouldCreateMissingConfig });
  const activeLogFilePath = options.logger === false ? null : logFilePath;
  const logRetentionDays =
    options.logRetentionDays
    ?? resolveOptionalEnvInteger(process.env, 'GSD_WEB_LOG_RETENTION_DAYS')
    ?? DEFAULT_LOG_RETENTION_DAYS;
  const logMaxFileSizeBytes =
    options.logMaxFileSizeBytes
    ?? (
      resolveOptionalEnvPositiveInteger(process.env, 'GSD_WEB_LOG_MAX_SIZE_MB')
      ?? (DEFAULT_LOG_MAX_FILE_SIZE_BYTES / (1024 * 1024))
    ) * 1024 * 1024;
  const logPolicy = buildLogPolicySummary(activeLogFilePath !== null, logRetentionDays, logMaxFileSizeBytes);
  const indexHtmlPath = path.join(clientDistDir, 'index.html');

  await assertReadableFile(
    indexHtmlPath,
    `Client build directory is missing its shell index.html: ${indexHtmlPath}`,
  );
  await mkdir(path.dirname(databasePath), { recursive: true });
  const logStream = activeLogFilePath === null
    ? null
    : new RotatingLogStream({
        filePath: activeLogFilePath,
        retentionDays: logRetentionDays,
        maxFileSizeBytes: logMaxFileSizeBytes,
      });
  if (activeLogFilePath !== null) {
    await mkdir(path.dirname(activeLogFilePath), { recursive: true });
    await logStream!.initialize();
  }

  const loggerOptions = options.logger === false
    ? false
    : {
        level: process.env.GSD_WEB_LOG_LEVEL?.trim() || process.env.LOG_LEVEL?.trim() || 'info',
        stream: logStream!,
      };

  const app = Fastify({
    logger: loggerOptions,
    disableRequestLogging: !(resolveOptionalEnvBoolean(process.env, 'GSD_WEB_REQUEST_LOGS') ?? false),
    forceCloseConnections: true,
  }) as unknown as GsdWebApp;
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 16 * 1024 },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.gsdWebPaths = {
    ...defaults,
    runtimeDir,
    dataDir: path.dirname(databasePath),
    databasePath,
    clientDistDir,
    logDir,
    logFilePath,
    configFilePath,
    activeLogFilePath,
    logPolicy,
  };
  let registry: RegistryDatabase | undefined;
  let eventHub: EventHub | undefined;
  let monitorManager: ProjectMonitorManager | undefined;

  try {
    emitSignal(
      app,
      options.logSink,
      {
        event: 'runtime_paths',
        runtimeDir,
        databasePath,
        clientDistDir,
        logFilePath: activeLogFilePath,
        configFilePath,
      },
      'Resolved gsd-web runtime paths',
    );

    const registryInstance = new RegistryDatabase(databasePath);
    const eventHubInstance = new EventHub(registryInstance);
    const reconciler = new ProjectReconciler(registryInstance, eventHubInstance, {
      ...(options.snapshotTimeoutMs === undefined ? {} : { snapshotTimeoutMs: options.snapshotTimeoutMs }),
      log: app.log,
      ...(options.logSink === undefined ? {} : { signalSink: options.logSink }),
    });
    const monitorManagerInstance = new ProjectMonitorManager(registryInstance, reconciler, eventHubInstance, {
      intervalMs:
        options.monitorIntervalMs
        ?? resolveOptionalEnvInteger(process.env, 'GSD_WEB_MONITOR_INTERVAL_MS')
        ?? DEFAULT_MONITOR_INTERVAL_MS,
      ...(options.watchersEnabled === undefined ? {} : { watchersEnabled: options.watchersEnabled }),
      log: app.log,
      ...(options.logSink === undefined ? {} : { signalSink: options.logSink }),
    });
    registry = registryInstance;
    eventHub = eventHubInstance;
    monitorManager = monitorManagerInstance;
    const indexHtml = await readFile(indexHtmlPath, 'utf8');

    emitSignal(
      app,
      options.logSink,
      {
        event: 'database_open',
        databasePath,
        runtimeDir,
      },
      'Opened gsd-web SQLite database',
    );

    eventHubInstance.subscribe((event) => {
      emitProjectEvent(app, options.logSink, event);
    });
    const slackConfig = options.slack === false
      ? null
      : options.slack ?? resolveSlackNotifierConfig(process.env, runtimeConfig.slack ?? null, runtimeConfig.publicUrl);
    if (slackConfig) {
      const slackNotifier = new SlackNotifier(slackConfig, {
        ...(options.logSink === undefined ? {} : { signalSink: options.logSink }),
      });

      eventHubInstance.subscribe((event) => {
        void slackNotifier.notify(event);
      });
    }
    eventHubInstance.subscribe((event) => {
      const payloadProjectId =
        event.payload && typeof event.payload === 'object' && 'projectId' in event.payload
          && typeof event.payload.projectId === 'string'
          ? event.payload.projectId
          : null;
      const eventProjectId = event.projectId ?? payloadProjectId;

      if (
        eventProjectId
        && (event.type === 'project.registered'
          || event.type === 'project.refreshed'
          || event.type === 'project.monitor.updated'
          || event.type === 'project.relinked'
          || event.type === 'project.deleted')
      ) {
        void monitorManagerInstance.syncProject(eventProjectId);
      }

      if (event.projectId && event.type === 'project.relinked') {
        void reconciler
          .reconcileProject(event.projectId, {
            trigger: 'relink',
            emitRefreshEventOnNoChange: true,
          })
          .catch((error) => {
            app.log.warn(
              { err: error, projectId: event.projectId, trigger: 'relink' },
              'Relink follow-up reconcile failed',
            );
          });
      }
    });

    app.addHook('onClose', async () => {
      await monitorManagerInstance.stop();
      eventHubInstance.close();
      registryInstance.close();
      await logStream?.close();
    });

    await app.register(fastifyStatic, {
      root: clientDistDir,
      wildcard: false,
    });

    app.get('/api/health', async () =>
      buildHealthResponse(
        runtimeDir,
        databasePath,
        clientDistDir,
        activeLogFilePath,
        logPolicy,
        registryInstance.getProjectCount(),
      ),
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
      reconciler,
      ...(options.snapshotTimeoutMs === undefined ? {} : { snapshotTimeoutMs: options.snapshotTimeoutMs }),
      ...(options.initRunner === undefined ? {} : { initRunner: options.initRunner }),
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

    const slackRoutes = await registerSlackRoutes(app, {
      registry: registryInstance,
      commandConfig: resolveSlackCommandConfig(process.env, runtimeConfig.slack ?? null, runtimeConfig.publicUrl),
    });

    for (const route of slackRoutes) {
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

    await app.ready();
    monitorManagerInstance.start();

    return app;
  } catch (error) {
    await monitorManager?.stop().catch(() => undefined);
    eventHub?.close();
    registry?.close();
    throw error;
  }
}
