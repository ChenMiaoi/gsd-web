import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';

import type { FastifyInstance, FastifyReply } from 'fastify';

import type {
  FilesystemDirectoryEntry,
  FilesystemDirectoryResponse,
  ProjectDetailResponse,
  ProjectInitJobStage,
  ProjectInitRefreshResult,
  ProjectMutationResponse,
  ProjectRecord,
  ProjectTimelineResponse,
  ProjectsResponse,
  RegisterProjectRequest,
  RelinkProjectRequest,
} from '../../shared/contracts.js';
import { createTrackedProjectContinuitySummary } from '../../shared/contracts.js';
import {
  ActiveInitJobError,
  DuplicateProjectError,
  ProjectNotFoundError,
  type RegistryDatabase,
} from '../db.js';
import {
  buildProjectRegistrationState,
  ProjectReconciler,
} from '../project-reconcile.js';
import {
  runOfficialGsdInit,
  type InitRunResult,
  type InitJobStage as OfficialInitStage,
  type RunOfficialInitOptions,
} from '../init-jobs.js';
import {
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  SnapshotTimeoutError,
  buildProjectSnapshot,
  canonicalizeProjectPath,
  isProjectPathValidationError,
  isProjectSnapshotReadError,
  withSnapshotTimeout,
} from '../snapshots.js';
import type { EventHub } from './events.js';

export type ProjectInitRunner = (
  projectRoot: string,
  options?: RunOfficialInitOptions,
) => Promise<InitRunResult>;

const DIRECTORY_BROWSER_ENTRY_LIMIT = 250;

class DirectoryBrowserError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = 'DirectoryBrowserError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendError(reply: FastifyReply, statusCode: number, message: string, code?: string) {
  return reply.code(statusCode).send({
    error: statusCode >= 500 ? 'Internal Server Error' : 'Bad Request',
    message,
    statusCode,
    code,
  });
}

function toDirectoryBrowserError(error: unknown): DirectoryBrowserError {
  if (error instanceof DirectoryBrowserError) {
    return error;
  }

  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code);

    if (code === 'ENOENT') {
      return new DirectoryBrowserError('Directory does not exist.', 404, 'directory_not_found');
    }

    if (code === 'ENOTDIR') {
      return new DirectoryBrowserError('Path is not a directory.', 400, 'not_a_directory');
    }

    if (code === 'EACCES' || code === 'EPERM') {
      return new DirectoryBrowserError('Directory is not readable by the service process.', 403, 'directory_unreadable');
    }
  }

  return new DirectoryBrowserError('Directory could not be read.', 500, 'directory_read_failed');
}

function pickDirectoryBrowserPath(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return homedir();
  }

  return value;
}

async function toDirectoryEntry(parentPath: string, name: string): Promise<FilesystemDirectoryEntry | null> {
  const entryPath = path.join(parentPath, name);

  try {
    const entryStat = await stat(entryPath);

    if (!entryStat.isDirectory()) {
      return null;
    }

    return {
      name,
      path: entryPath,
      hidden: name.startsWith('.'),
    };
  } catch {
    return null;
  }
}

async function readDirectoryBrowserPath(candidatePath: string): Promise<FilesystemDirectoryResponse> {
  const resolvedPath = path.resolve(candidatePath);
  const canonicalPath = await realpath(resolvedPath);
  const directoryStat = await stat(canonicalPath);

  if (!directoryStat.isDirectory()) {
    throw new DirectoryBrowserError('Path is not a directory.', 400, 'not_a_directory');
  }

  const names = await readdir(canonicalPath);
  const entries: FilesystemDirectoryEntry[] = [];

  for (const name of names) {
    if (entries.length >= DIRECTORY_BROWSER_ENTRY_LIMIT) {
      break;
    }

    const entry = await toDirectoryEntry(canonicalPath, name);

    if (entry) {
      entries.push(entry);
    }
  }

  entries.sort((first, second) => {
    if (first.hidden !== second.hidden) {
      return first.hidden ? 1 : -1;
    }

    return first.name.localeCompare(second.name, undefined, { sensitivity: 'base' });
  });

  const parentPath = path.dirname(canonicalPath);

  return {
    path: canonicalPath,
    parentPath: parentPath === canonicalPath ? null : parentPath,
    entries,
    truncated: names.length > DIRECTORY_BROWSER_ENTRY_LIMIT,
  };
}

function parsePathBody(body: unknown): RegisterProjectRequest | RelinkProjectRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be a JSON object with a path field.');
  }

  const { path } = body as { path?: unknown };

  if (typeof path !== 'string') {
    throw new Error('Project path must be a string.');
  }

  return { path };
}

function isDuplicateRegistration(error: unknown): error is DuplicateProjectError {
  return error instanceof DuplicateProjectError;
}

function isNotFoundError(error: unknown): error is ProjectNotFoundError {
  return error instanceof ProjectNotFoundError;
}

function isTimeoutError(error: unknown): error is SnapshotTimeoutError {
  return error instanceof SnapshotTimeoutError;
}

function isActiveInitJobError(error: unknown): error is ActiveInitJobError {
  return error instanceof ActiveInitJobError;
}

function toMutationResponse(
  payload: {
    project: ReturnType<RegistryDatabase['getProjectById']> extends infer TResult
      ? Exclude<TResult, null>
      : never;
    event: ProjectMutationResponse['event'];
  },
): ProjectMutationResponse {
  return {
    project: payload.project,
    event: payload.event,
  };
}

function mapOfficialInitStage(stage: OfficialInitStage): ProjectInitJobStage | null {
  switch (stage) {
    case 'queued':
      return 'queued';
    case 'starting':
      return 'starting';
    case 'project_setup':
    case 'workflow_mode':
    case 'git_settings':
    case 'project_instructions':
    case 'advanced_settings':
    case 'essential_skills':
    case 'review_preferences':
    case 'verifying_bootstrap':
      return 'initializing';
    case 'completed':
      return null;
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'timed_out';
    default:
      throw new Error(`Unsupported init adapter stage: ${String(stage)}`);
  }
}

function buildRefreshFailureResult(
  detail: string,
  checkedAt: string,
  snapshotStatus: ProjectRecord['snapshot']['status'] | null,
  warningCount: number | null,
): ProjectInitRefreshResult {
  return {
    status: 'failed',
    checkedAt,
    detail,
    snapshotStatus,
    warningCount,
    changed: null,
    eventId: null,
  };
}

function persistInitUpdate(
  registry: RegistryDatabase,
  eventHub: EventHub,
  input: Parameters<RegistryDatabase['appendInitJobUpdate']>[0],
) {
  const result = registry.appendInitJobUpdate(input);
  eventHub.broadcast(result.event);
  return result;
}

function buildProjectDetailResponse(
  project: ProjectRecord,
  timeline: ReturnType<RegistryDatabase['getProjectTimeline']>,
): ProjectDetailResponse {
  return {
    ...project,
    timeline: timeline.items,
  };
}

function sendReconcileFailure(reply: FastifyReply, error: Error, fallbackCode: string) {
  if (isTimeoutError(error)) {
    return sendError(reply, error.statusCode, error.message, error.responseCode);
  }

  if (isProjectSnapshotReadError(error)) {
    return sendError(reply, error.statusCode, error.message, error.responseCode);
  }

  if (isNotFoundError(error)) {
    return sendError(reply, 404, error.message, 'project_not_found');
  }

  return sendError(reply, 500, error.message, fallbackCode);
}

async function executeInitJob(options: {
  registry: RegistryDatabase;
  eventHub: EventHub;
  initRunner: ProjectInitRunner;
  reconciler: ProjectReconciler;
  projectId: string;
  jobId: string;
  canonicalPath: string;
  log: FastifyInstance['log'];
}) {
  let latestOutputExcerpt: string | null = null;

  try {
    const initResult = await options.initRunner(options.canonicalPath, {
      onStage: (update) => {
        latestOutputExcerpt = update.excerpt;
        const mappedStage = mapOfficialInitStage(update.stage);

        if (mappedStage === null) {
          return;
        }

        persistInitUpdate(options.registry, options.eventHub, {
          projectId: options.projectId,
          jobId: options.jobId,
          stage: mappedStage,
          detail: update.detail,
          outputExcerpt: update.excerpt,
          emittedAt: update.emittedAt,
        });
      },
    });

    latestOutputExcerpt = initResult.outputExcerpt;

    if (initResult.outcome !== 'completed') {
      const detail = initResult.errorDetail ?? 'Project initialization failed.';

      persistInitUpdate(options.registry, options.eventHub, {
        projectId: options.projectId,
        jobId: options.jobId,
        stage: initResult.outcome === 'timed_out' ? 'timed_out' : 'failed',
        detail,
        outputExcerpt: initResult.outputExcerpt,
        lastErrorDetail: detail,
        emittedAt: new Date().toISOString(),
      });
      return;
    }

    persistInitUpdate(options.registry, options.eventHub, {
      projectId: options.projectId,
      jobId: options.jobId,
      stage: 'refreshing',
      detail: 'Bootstrap completeness was proven; refreshing the monitored project snapshot.',
      outputExcerpt: initResult.outputExcerpt,
      emittedAt: new Date().toISOString(),
    });

    const refreshResult = await options.reconciler.reconcileProject(options.projectId, {
      trigger: 'init_refresh',
      emitRefreshEventOnNoChange: true,
    });

    if (refreshResult.status === 'failed') {
      const detail = refreshResult.error.message;

      persistInitUpdate(options.registry, options.eventHub, {
        projectId: options.projectId,
        jobId: options.jobId,
        stage: 'failed',
        detail,
        outputExcerpt: initResult.outputExcerpt,
        lastErrorDetail: detail,
        refreshResult: buildRefreshFailureResult(
          detail,
          refreshResult.project.monitor.lastAttemptedAt ?? new Date().toISOString(),
          refreshResult.project.snapshot.status,
          refreshResult.project.snapshot.warnings.length,
        ),
        emittedAt: new Date().toISOString(),
      });
      return;
    }

    if (refreshResult.project.snapshot.status === 'uninitialized') {
      const detail = 'Post-init refresh still reported the project as uninitialized.';

      persistInitUpdate(options.registry, options.eventHub, {
        projectId: options.projectId,
        jobId: options.jobId,
        stage: 'failed',
        detail,
        outputExcerpt: initResult.outputExcerpt,
        lastErrorDetail: detail,
        refreshResult: buildRefreshFailureResult(
          detail,
          refreshResult.project.monitor.lastAttemptedAt ?? new Date().toISOString(),
          refreshResult.project.snapshot.status,
          refreshResult.project.snapshot.warnings.length,
        ),
        emittedAt: new Date().toISOString(),
      });
      return;
    }

    const detail = `Initialization completed and refresh observed a truthful ${refreshResult.project.snapshot.status} snapshot.`;

    persistInitUpdate(options.registry, options.eventHub, {
      projectId: options.projectId,
      jobId: options.jobId,
      stage: 'succeeded',
      detail,
      outputExcerpt: initResult.outputExcerpt,
      refreshResult: {
        status: 'succeeded',
        checkedAt: refreshResult.project.snapshot.checkedAt,
        detail,
        snapshotStatus: refreshResult.project.snapshot.status,
        warningCount: refreshResult.project.snapshot.warnings.length,
        changed: refreshResult.changed,
        eventId: refreshResult.event?.id ?? null,
      },
      emittedAt: new Date().toISOString(),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Project initialization failed unexpectedly.';

    options.log.error({ err: error, projectId: options.projectId, jobId: options.jobId }, 'Project init job failed');

    try {
      persistInitUpdate(options.registry, options.eventHub, {
        projectId: options.projectId,
        jobId: options.jobId,
        stage: 'failed',
        detail,
        outputExcerpt: latestOutputExcerpt,
        lastErrorDetail: detail,
        emittedAt: new Date().toISOString(),
      });
    } catch (persistError) {
      options.log.error(
        { err: persistError, projectId: options.projectId, jobId: options.jobId },
        'Failed to persist init job failure state',
      );
    }
  }
}

export async function registerProjectRoutes(
  app: FastifyInstance,
  options: {
    registry: RegistryDatabase;
    eventHub: EventHub;
    reconciler: ProjectReconciler;
    snapshotTimeoutMs?: number;
    initRunner?: ProjectInitRunner;
  },
) {
  const snapshotTimeoutMs = options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
  const initRunner = options.initRunner ?? runOfficialGsdInit;

  app.get<{ Querystring: { path?: string } }>('/api/filesystem/directories', async (request, reply) => {
    try {
      return await readDirectoryBrowserPath(pickDirectoryBrowserPath(request.query.path));
    } catch (error) {
      const browserError = toDirectoryBrowserError(error);

      return sendError(reply, browserError.statusCode, browserError.message, browserError.code);
    }
  });

  app.get('/api/projects', async (): Promise<ProjectsResponse> => {
    const items = options.registry.listProjects();

    return {
      items,
      total: items.length,
    };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const project = options.registry.getProjectById(request.params.id);

    if (!project) {
      return sendError(reply, 404, `Project ${request.params.id} was not found.`, 'project_not_found');
    }

    return buildProjectDetailResponse(project, options.registry.getProjectTimeline(project.projectId));
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/timeline', async (request, reply) => {
    const project = options.registry.getProjectById(request.params.id);

    if (!project) {
      return sendError(reply, 404, `Project ${request.params.id} was not found.`, 'project_not_found');
    }

    const timeline = options.registry.getProjectTimeline(project.projectId);

    return {
      items: timeline.items,
      total: timeline.total,
    } satisfies ProjectTimelineResponse;
  });

  app.post<{ Body: unknown }>('/api/projects/register', async (request, reply) => {
    let body: RegisterProjectRequest;

    try {
      body = parsePathBody(request.body) as RegisterProjectRequest;
    } catch (error) {
      return sendError(
        reply,
        400,
        error instanceof Error ? error.message : 'Project path is required.',
        'invalid_path',
      );
    }

    try {
      const canonicalPath = await canonicalizeProjectPath(body.path);
      const snapshot = await withSnapshotTimeout(
        () => buildProjectSnapshot(canonicalPath.canonicalPath),
        snapshotTimeoutMs,
      );
      const projectId = `prj_${randomUUID()}`;
      const registrationState = buildProjectRegistrationState(projectId, canonicalPath.canonicalPath, snapshot);
      const continuity = createTrackedProjectContinuitySummary(snapshot.checkedAt);
      const result = options.registry.registerProject({
        projectId,
        registeredPath: canonicalPath.normalizedPath,
        canonicalPath: canonicalPath.canonicalPath,
        snapshot,
        monitor: registrationState.monitor,
        continuity,
        eventPayload: {
          ...registrationState.eventPayload,
          continuity,
        },
        timelineEntry: registrationState.timelineEntry,
      });
      const response = toMutationResponse(result);

      options.eventHub.broadcast(response.event);

      return reply.code(201).send(response);
    } catch (error) {
      if (isProjectPathValidationError(error)) {
        return sendError(reply, error.statusCode, error.message, error.responseCode);
      }

      if (isTimeoutError(error)) {
        return sendError(reply, error.statusCode, error.message, error.responseCode);
      }

      if (isProjectSnapshotReadError(error)) {
        return sendError(reply, error.statusCode, error.message, error.responseCode);
      }

      if (isDuplicateRegistration(error)) {
        return sendError(reply, 409, error.message, 'duplicate_path');
      }

      request.log.error({ err: error }, 'Failed to register project path');
      return sendError(reply, 500, 'Failed to register project path.', 'registry_write_failed');
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/projects/:id/relink', async (request, reply) => {
    const existingProject = options.registry.getProjectById(request.params.id);

    if (!existingProject) {
      return sendError(reply, 404, `Project ${request.params.id} was not found.`, 'project_not_found');
    }

    let body: RelinkProjectRequest;

    try {
      body = parsePathBody(request.body) as RelinkProjectRequest;
    } catch (error) {
      return sendError(
        reply,
        400,
        error instanceof Error ? error.message : 'Project path is required.',
        'invalid_path',
      );
    }

    try {
      const canonicalPath = await canonicalizeProjectPath(body.path);
      const emittedAt = new Date().toISOString();
      const continuity = createTrackedProjectContinuitySummary(emittedAt, {
        lastRelinkedAt: emittedAt,
        previousRegisteredPath: existingProject.registeredPath,
        previousCanonicalPath: existingProject.canonicalPath,
      });
      const result = options.registry.relinkProject({
        projectId: existingProject.projectId,
        registeredPath: canonicalPath.normalizedPath,
        canonicalPath: canonicalPath.canonicalPath,
        emittedAt,
        continuity,
        eventPayload: {
          projectId: existingProject.projectId,
          registeredPath: canonicalPath.normalizedPath,
          canonicalPath: canonicalPath.canonicalPath,
          previousRegisteredPath: existingProject.registeredPath,
          previousCanonicalPath: existingProject.canonicalPath,
          snapshotStatus: existingProject.snapshot.status,
          warningCount: existingProject.snapshot.warnings.length,
          emittedAt,
          continuity,
          monitor: existingProject.monitor,
        },
        timelineEntry: {
          type: 'relinked',
          emittedAt,
          trigger: 'relink',
          snapshotStatus: existingProject.snapshot.status,
          monitorHealth: existingProject.monitor.health,
          warningCount: existingProject.snapshot.warnings.length,
          changed: false,
          detail: `Relinked project continuity from ${existingProject.canonicalPath} to ${canonicalPath.canonicalPath} without creating a new project id.`,
          error: null,
        },
      });
      const response = toMutationResponse(result);

      options.eventHub.broadcast(response.event);

      return reply.code(200).send(response);
    } catch (error) {
      if (isProjectPathValidationError(error)) {
        return sendError(reply, error.statusCode, error.message, error.responseCode);
      }

      if (isDuplicateRegistration(error)) {
        return sendError(reply, 409, error.message, 'duplicate_path');
      }

      if (isNotFoundError(error)) {
        return sendError(reply, 404, error.message, 'project_not_found');
      }

      request.log.error({ err: error, projectId: existingProject.projectId }, 'Failed to relink project path');
      return sendError(reply, 500, 'Failed to relink project path.', 'project_relink_failed');
    }
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/refresh', async (request, reply) => {
    const existingProject = options.registry.getProjectById(request.params.id);

    if (!existingProject) {
      return sendError(reply, 404, `Project ${request.params.id} was not found.`, 'project_not_found');
    }

    try {
      const result = await options.reconciler.reconcileProject(existingProject.projectId, {
        trigger: 'manual_refresh',
        emitRefreshEventOnNoChange: true,
      });

      if (result.status === 'failed') {
        return sendReconcileFailure(reply, result.error, 'snapshot_refresh_failed');
      }

      if (!result.event || result.event.type === 'project.monitor.updated') {
        throw new Error(`Expected a snapshot refresh event for project ${existingProject.projectId}.`);
      }

      return toMutationResponse({
        project: result.project,
        event: result.event,
      });
    } catch (error) {
      if (error instanceof Error) {
        return sendReconcileFailure(reply, error, 'snapshot_refresh_failed');
      }

      request.log.error({ err: error, projectId: existingProject.projectId }, 'Failed to refresh project snapshot');
      return sendError(reply, 500, 'Failed to refresh project snapshot.', 'snapshot_refresh_failed');
    }
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/init', async (request, reply) => {
    const existingProject = options.registry.getProjectById(request.params.id);

    if (!existingProject) {
      return sendError(reply, 404, `Project ${request.params.id} was not found.`, 'project_not_found');
    }

    if (existingProject.snapshot.status !== 'uninitialized') {
      return sendError(
        reply,
        409,
        `Project ${request.params.id} is not eligible for initialization because its current snapshot is ${existingProject.snapshot.status}.`,
        'project_ineligible',
      );
    }

    try {
      const startResult = options.registry.startInitJob({
        projectId: existingProject.projectId,
        detail: 'Initialization request accepted and queued.',
      });
      const response = toMutationResponse(startResult);

      options.eventHub.broadcast(response.event);

      const jobId = response.project.latestInitJob?.jobId;

      if (!jobId) {
        throw new Error(`Expected project ${existingProject.projectId} to include the queued init job.`);
      }

      void executeInitJob({
        registry: options.registry,
        eventHub: options.eventHub,
        initRunner,
        reconciler: options.reconciler,
        projectId: existingProject.projectId,
        jobId,
        canonicalPath: existingProject.canonicalPath,
        log: request.log,
      });

      return reply.code(202).send(response);
    } catch (error) {
      if (isActiveInitJobError(error)) {
        return sendError(reply, 409, error.message, 'init_job_active');
      }

      if (isNotFoundError(error)) {
        return sendError(reply, 404, error.message, 'project_not_found');
      }

      request.log.error({ err: error, projectId: existingProject.projectId }, 'Failed to start project init job');
      return sendError(reply, 500, 'Failed to start project initialization.', 'init_job_start_failed');
    }
  });

  return [
    {
      method: 'GET' as const,
      route: '/api/filesystem/directories',
    },
    {
      method: 'GET' as const,
      route: '/api/projects',
    },
    {
      method: 'GET' as const,
      route: '/api/projects/:id',
    },
    {
      method: 'GET' as const,
      route: '/api/projects/:id/timeline',
    },
    {
      method: 'POST' as const,
      route: '/api/projects/register',
    },
    {
      method: 'POST' as const,
      route: '/api/projects/:id/relink',
    },
    {
      method: 'POST' as const,
      route: '/api/projects/:id/refresh',
    },
    {
      method: 'POST' as const,
      route: '/api/projects/:id/init',
    },
  ];
}
