import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  buildSourceStateMap,
  type ProjectMutationResponse,
  type ProjectSnapshot,
  type ProjectSnapshotEventPayload,
  type ProjectsResponse,
  type RegisterProjectRequest,
} from '../../shared/contracts.js';
import { DuplicateProjectError, ProjectNotFoundError, type RegistryDatabase } from '../db.js';
import {
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  SnapshotTimeoutError,
  buildProjectSnapshot,
  canonicalizeProjectPath,
  isProjectPathValidationError,
  withSnapshotTimeout,
} from '../snapshots.js';
import type { EventHub } from './events.js';

function sendError(reply: FastifyReply, statusCode: number, message: string, code?: string) {
  return reply.code(statusCode).send({
    error: statusCode >= 500 ? 'Internal Server Error' : 'Bad Request',
    message,
    statusCode,
    code,
  });
}

function parseRegisterBody(body: unknown): RegisterProjectRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be a JSON object with a path field.');
  }

  const { path } = body as { path?: unknown };

  if (typeof path !== 'string') {
    throw new Error('Project path must be a string.');
  }

  return { path };
}

function normalizeSnapshot(snapshot: ProjectSnapshot) {
  const { checkedAt: _checkedAt, ...rest } = snapshot;
  return rest;
}

function buildProjectEventPayload(
  projectId: string,
  canonicalPath: string,
  snapshot: ProjectSnapshot,
  changed: boolean,
): ProjectSnapshotEventPayload {
  return {
    projectId,
    canonicalPath,
    snapshotStatus: snapshot.status,
    warningCount: snapshot.warnings.length,
    warnings: snapshot.warnings,
    sourceStates: buildSourceStateMap(snapshot),
    changed,
    checkedAt: snapshot.checkedAt,
  };
}

function isChangedSnapshot(previousSnapshot: ProjectSnapshot | null, nextSnapshot: ProjectSnapshot) {
  if (previousSnapshot === null) {
    return true;
  }

  return JSON.stringify(normalizeSnapshot(previousSnapshot)) !== JSON.stringify(normalizeSnapshot(nextSnapshot));
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

export async function registerProjectRoutes(
  app: FastifyInstance,
  options: {
    registry: RegistryDatabase;
    eventHub: EventHub;
    snapshotTimeoutMs?: number;
  },
) {
  const snapshotTimeoutMs = options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;

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

    return project;
  });

  app.post<{ Body: unknown }>('/api/projects/register', async (request, reply) => {
    let body: RegisterProjectRequest;

    try {
      body = parseRegisterBody(request.body);
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
      const payload = buildProjectEventPayload(projectId, canonicalPath.canonicalPath, snapshot, true);
      const result = options.registry.registerProject({
        projectId,
        registeredPath: canonicalPath.normalizedPath,
        canonicalPath: canonicalPath.canonicalPath,
        snapshot,
        eventPayload: payload,
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

      if (isDuplicateRegistration(error)) {
        return sendError(reply, 409, error.message, 'duplicate_path');
      }

      request.log.error({ err: error }, 'Failed to register project path');
      return sendError(reply, 500, 'Failed to register project path.', 'registry_write_failed');
    }
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/refresh', async (request, reply) => {
    const existingProject = options.registry.getProjectById(request.params.id);

    if (!existingProject) {
      return sendError(reply, 404, `Project ${request.params.id} was not found.`, 'project_not_found');
    }

    try {
      const snapshot = await withSnapshotTimeout(
        () => buildProjectSnapshot(existingProject.canonicalPath),
        snapshotTimeoutMs,
      );
      const changed = isChangedSnapshot(existingProject.snapshot, snapshot);
      const payload = buildProjectEventPayload(
        existingProject.projectId,
        existingProject.canonicalPath,
        snapshot,
        changed,
      );
      const result = options.registry.refreshProject({
        projectId: existingProject.projectId,
        snapshot,
        eventPayload: payload,
      });
      const response = toMutationResponse(result);

      options.eventHub.broadcast(response.event);

      return response;
    } catch (error) {
      if (isProjectPathValidationError(error)) {
        return sendError(reply, 409, error.message, error.responseCode);
      }

      if (isTimeoutError(error)) {
        return sendError(reply, error.statusCode, error.message, error.responseCode);
      }

      if (isNotFoundError(error)) {
        return sendError(reply, 404, error.message, 'project_not_found');
      }

      request.log.error({ err: error, projectId: existingProject.projectId }, 'Failed to refresh project snapshot');
      return sendError(reply, 500, 'Failed to refresh project snapshot.', 'snapshot_refresh_failed');
    }
  });

  return [
    {
      method: 'GET' as const,
      route: '/api/projects',
    },
    {
      method: 'GET' as const,
      route: '/api/projects/:id',
    },
    {
      method: 'POST' as const,
      route: '/api/projects/register',
    },
    {
      method: 'POST' as const,
      route: '/api/projects/:id/refresh',
    },
  ];
}
