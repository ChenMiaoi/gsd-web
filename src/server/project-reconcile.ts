import type { FastifyBaseLogger } from 'fastify';

import {
  buildSourceStateMap,
  deriveMonitorHealthFromSnapshot,
  type ProjectEventEnvelope,
  type ProjectMonitorError,
  type ProjectMonitorEventPayload,
  type ProjectMonitorHealth,
  type ProjectMonitorSummary,
  type ProjectRecord,
  type ProjectReconcileTrigger,
  type ProjectSnapshot,
  type ProjectSnapshotEventPayload,
} from '../shared/contracts.js';
import {
  type RefreshProjectInput,
  type RegistryDatabase,
  type TimelineEntryInput,
} from './db.js';
import {
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  ProjectSnapshotReadError,
  SnapshotTimeoutError,
  buildProjectSnapshot,
  withSnapshotTimeout,
} from './snapshots.js';
import type { EventHub } from './routes/events.js';

export interface ProjectRegistrationState {
  monitor: ProjectMonitorSummary;
  eventPayload: ProjectSnapshotEventPayload;
  timelineEntry: TimelineEntryInput;
}

export interface ReconcileProjectOptions {
  trigger: ProjectReconcileTrigger;
  emitRefreshEventOnNoChange?: boolean;
}

export interface SuccessfulReconcileResult {
  status: 'success';
  project: ProjectRecord;
  event: ProjectEventEnvelope<ProjectSnapshotEventPayload | ProjectMonitorEventPayload> | null;
  changed: boolean;
  healthChanged: boolean;
}

export interface FailedReconcileResult {
  status: 'failed';
  project: ProjectRecord;
  event: ProjectEventEnvelope<ProjectMonitorEventPayload> | null;
  error: Error;
  healthChanged: boolean;
}

export type ReconcileProjectResult = SuccessfulReconcileResult | FailedReconcileResult;

function normalizeSnapshot(snapshot: ProjectSnapshot) {
  const { checkedAt: _checkedAt, ...rest } = snapshot;
  return rest;
}

function isChangedSnapshot(previousSnapshot: ProjectSnapshot | null, nextSnapshot: ProjectSnapshot) {
  if (previousSnapshot === null) {
    return true;
  }

  return JSON.stringify(normalizeSnapshot(previousSnapshot)) !== JSON.stringify(normalizeSnapshot(nextSnapshot));
}

function summarizeTrigger(trigger: ProjectReconcileTrigger) {
  return trigger.replace(/_/g, ' ');
}

function summarizeWarningCount(snapshot: ProjectSnapshot) {
  return snapshot.warnings.length;
}

function buildSuccessfulMonitorSummary(
  snapshot: ProjectSnapshot,
  trigger: ProjectReconcileTrigger,
): ProjectMonitorSummary {
  return {
    health: deriveMonitorHealthFromSnapshot(snapshot.status),
    lastAttemptedAt: snapshot.checkedAt,
    lastSuccessfulAt: snapshot.checkedAt,
    lastTrigger: trigger,
    lastError: null,
  };
}

function buildMonitorError(error: Error, attemptedAt: string): ProjectMonitorError {
  if (error instanceof SnapshotTimeoutError) {
    return {
      scope: 'projectRoot',
      message: error.message,
      at: attemptedAt,
    };
  }

  if (error instanceof ProjectSnapshotReadError) {
    return {
      scope: error.scope,
      message: error.message,
      at: attemptedAt,
    };
  }

  return {
    scope: 'projectRoot',
    message: error.message,
    at: attemptedAt,
  };
}

function buildFailedMonitorSummary(
  previousMonitor: ProjectMonitorSummary,
  trigger: ProjectReconcileTrigger,
  attemptedAt: string,
  error: Error,
): ProjectMonitorSummary {
  return {
    health: 'read_failed',
    lastAttemptedAt: attemptedAt,
    lastSuccessfulAt: previousMonitor.lastSuccessfulAt,
    lastTrigger: trigger,
    lastError: buildMonitorError(error, attemptedAt),
  };
}

function buildProjectSnapshotEventPayload(
  projectId: string,
  canonicalPath: string,
  snapshot: ProjectSnapshot,
  changed: boolean,
  trigger: ProjectReconcileTrigger,
  monitor: ProjectMonitorSummary,
): ProjectSnapshotEventPayload {
  return {
    projectId,
    canonicalPath,
    snapshotStatus: snapshot.status,
    warningCount: summarizeWarningCount(snapshot),
    warnings: snapshot.warnings,
    sourceStates: buildSourceStateMap(snapshot),
    changed,
    checkedAt: snapshot.checkedAt,
    trigger,
    monitor,
  };
}

function buildProjectMonitorEventPayload(
  project: Pick<ProjectRecord, 'projectId' | 'canonicalPath' | 'snapshot'>,
  monitor: ProjectMonitorSummary,
  previousHealth: ProjectMonitorHealth,
  trigger: ProjectReconcileTrigger,
): ProjectMonitorEventPayload {
  return {
    projectId: project.projectId,
    canonicalPath: project.canonicalPath,
    snapshotStatus: project.snapshot.status,
    warningCount: summarizeWarningCount(project.snapshot),
    trigger,
    previousHealth,
    monitor,
  };
}

function buildRegistrationTimelineEntry(snapshot: ProjectSnapshot, monitor: ProjectMonitorSummary): TimelineEntryInput {
  return {
    type: 'registered',
    emittedAt: snapshot.checkedAt,
    trigger: 'register',
    snapshotStatus: snapshot.status,
    monitorHealth: monitor.health,
    warningCount: summarizeWarningCount(snapshot),
    changed: true,
    detail: `Registered project with a truthful ${snapshot.status} snapshot.`,
    error: null,
  };
}

function buildSuccessTimelineEntry(options: {
  previousHealth: ProjectMonitorHealth;
  trigger: ProjectReconcileTrigger;
  snapshot: ProjectSnapshot;
  monitor: ProjectMonitorSummary;
  changed: boolean;
}): TimelineEntryInput | null {
  const { previousHealth, trigger, snapshot, monitor, changed } = options;

  if (monitor.health !== previousHealth) {
    if (monitor.health === 'healthy' && previousHealth !== 'healthy') {
      return {
        type: 'monitor_recovered',
        emittedAt: snapshot.checkedAt,
        trigger,
        snapshotStatus: snapshot.status,
        monitorHealth: monitor.health,
        warningCount: summarizeWarningCount(snapshot),
        changed,
        detail: `Monitor recovered via ${summarizeTrigger(trigger)}; snapshot is now ${snapshot.status}.`,
        error: null,
      };
    }

    return {
      type: 'monitor_degraded',
      emittedAt: snapshot.checkedAt,
      trigger,
      snapshotStatus: snapshot.status,
      monitorHealth: monitor.health,
      warningCount: summarizeWarningCount(snapshot),
      changed,
      detail:
        monitor.health === 'degraded'
          ? `Monitor observed a degraded snapshot via ${summarizeTrigger(trigger)}.`
          : `Monitor health changed to ${monitor.health} via ${summarizeTrigger(trigger)}.`,
      error: monitor.lastError,
    };
  }

  if (!changed) {
    return null;
  }

  return {
    type: 'refreshed',
    emittedAt: snapshot.checkedAt,
    trigger,
    snapshotStatus: snapshot.status,
    monitorHealth: monitor.health,
    warningCount: summarizeWarningCount(snapshot),
    changed: true,
    detail: `Reconciled the project via ${summarizeTrigger(trigger)} and observed a ${snapshot.status} snapshot.`,
    error: null,
  };
}

function buildFailureTimelineEntry(options: {
  trigger: ProjectReconcileTrigger;
  snapshot: ProjectSnapshot;
  monitor: ProjectMonitorSummary;
}): TimelineEntryInput {
  return {
    type: 'monitor_degraded',
    emittedAt: options.monitor.lastAttemptedAt ?? new Date().toISOString(),
    trigger: options.trigger,
    snapshotStatus: options.snapshot.status,
    monitorHealth: options.monitor.health,
    warningCount: summarizeWarningCount(options.snapshot),
    changed: false,
    detail: `Monitor could not read current project truth via ${summarizeTrigger(options.trigger)}.`,
    error: options.monitor.lastError,
  };
}

export function buildProjectRegistrationState(
  projectId: string,
  canonicalPath: string,
  snapshot: ProjectSnapshot,
): ProjectRegistrationState {
  const monitor = buildSuccessfulMonitorSummary(snapshot, 'register');

  return {
    monitor,
    eventPayload: buildProjectSnapshotEventPayload(projectId, canonicalPath, snapshot, true, 'register', monitor),
    timelineEntry: buildRegistrationTimelineEntry(snapshot, monitor),
  };
}

export class ProjectReconciler {
  private readonly inFlight = new Map<string, Promise<ReconcileProjectResult>>();

  constructor(
    private readonly registry: RegistryDatabase,
    private readonly eventHub: EventHub,
    private readonly options: {
      snapshotTimeoutMs?: number;
      log?: Pick<FastifyBaseLogger, 'error' | 'warn' | 'info'>;
    } = {},
  ) {}

  reconcileProject(projectId: string, options: ReconcileProjectOptions): Promise<ReconcileProjectResult> {
    const existing = this.inFlight.get(projectId);

    if (existing) {
      return existing;
    }

    const promise = this.performReconcile(projectId, options).finally(() => {
      if (this.inFlight.get(projectId) === promise) {
        this.inFlight.delete(projectId);
      }
    });

    this.inFlight.set(projectId, promise);

    return promise;
  }

  private async performReconcile(
    projectId: string,
    options: ReconcileProjectOptions,
  ): Promise<ReconcileProjectResult> {
    const project = this.registry.getProjectById(projectId);

    if (!project) {
      throw new Error(`Cannot reconcile unknown project ${projectId}.`);
    }

    try {
      const snapshot = await withSnapshotTimeout(
        () => buildProjectSnapshot(project.canonicalPath),
        this.options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS,
      );
      const monitor = buildSuccessfulMonitorSummary(snapshot, options.trigger);
      const changed = isChangedSnapshot(project.snapshot, snapshot);
      const healthChanged = monitor.health !== project.monitor.health;
      const timelineEntry = buildSuccessTimelineEntry({
        previousHealth: project.monitor.health,
        trigger: options.trigger,
        snapshot,
        monitor,
        changed,
      });

      if (changed || options.emitRefreshEventOnNoChange) {
        const input: RefreshProjectInput = {
          projectId: project.projectId,
          snapshot,
          monitor,
          eventPayload: buildProjectSnapshotEventPayload(
            project.projectId,
            project.canonicalPath,
            snapshot,
            changed,
            options.trigger,
            monitor,
          ),
          timelineEntry,
        };
        const result = this.registry.refreshProject(input);

        this.eventHub.broadcast(result.event);

        return {
          status: 'success',
          project: result.project,
          event: result.event,
          changed,
          healthChanged,
        };
      }

      if (healthChanged) {
        const result = this.registry.updateProjectMonitor({
          projectId: project.projectId,
          monitor,
          emittedAt: snapshot.checkedAt,
          eventPayload: buildProjectMonitorEventPayload(project, monitor, project.monitor.health, options.trigger),
          timelineEntry,
        });

        if (result.event) {
          this.eventHub.broadcast(result.event);
        }

        return {
          status: 'success',
          project: result.project,
          event: result.event,
          changed,
          healthChanged,
        };
      }

      const result = this.registry.updateProjectMonitor({
        projectId: project.projectId,
        monitor,
        emittedAt: snapshot.checkedAt,
      });

      return {
        status: 'success',
        project: result.project,
        event: null,
        changed,
        healthChanged,
      };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Project reconcile failed.');
      const attemptedAt = new Date().toISOString();
      const monitor = buildFailedMonitorSummary(project.monitor, options.trigger, attemptedAt, failure);
      const healthChanged = monitor.health !== project.monitor.health;
      const timelineEntry = healthChanged
        ? buildFailureTimelineEntry({
            trigger: options.trigger,
            snapshot: project.snapshot,
            monitor,
          })
        : null;

      try {
        const result = this.registry.updateProjectMonitor({
          projectId: project.projectId,
          monitor,
          emittedAt: attemptedAt,
          ...(healthChanged
            ? {
                eventPayload: buildProjectMonitorEventPayload(
                  project,
                  monitor,
                  project.monitor.health,
                  options.trigger,
                ),
              }
            : {}),
          timelineEntry,
        });

        if (result.event) {
          this.eventHub.broadcast(result.event);
        }

        return {
          status: 'failed',
          project: result.project,
          event: result.event,
          error: failure,
          healthChanged,
        };
      } catch (persistError) {
        this.options.log?.error?.(
          { err: persistError, projectId: project.projectId, trigger: options.trigger },
          'Failed to persist reconcile monitor failure state',
        );

        throw failure;
      }
    }
  }
}
