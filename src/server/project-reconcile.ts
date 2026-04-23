import type { FastifyBaseLogger } from 'fastify';

import {
  buildSourceStateMap,
  createTrackedProjectContinuitySummary,
  deriveMonitorHealthFromSnapshot,
  type ProjectContinuityState,
  type ProjectContinuitySummary,
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

export const WATCHER_MONITOR_ERROR_PREFIX = '[watcher] ';

export interface ReconcileHint {
  source: 'watcher';
  event: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';
  relativePath: string;
}

export interface ProjectReconcileSignal {
  event: 'project_reconcile';
  phase: 'started' | 'queued' | 'completed';
  projectId: string;
  trigger: ProjectReconcileTrigger;
  activeTrigger?: ProjectReconcileTrigger | null;
  queuedTrigger?: ProjectReconcileTrigger | null;
  reason?: string | null;
  status?: 'success' | 'failed';
  changed?: boolean;
  healthChanged?: boolean;
  emittedEventType?: string | null;
}

export interface ProjectRegistrationState {
  monitor: ProjectMonitorSummary;
  eventPayload: ProjectSnapshotEventPayload;
  timelineEntry: TimelineEntryInput;
}

export interface ReconcileProjectOptions {
  trigger: ProjectReconcileTrigger;
  emitRefreshEventOnNoChange?: boolean;
  hint?: ReconcileHint;
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

interface ReconcileWaiter {
  resolve: (result: ReconcileProjectResult) => void;
  reject: (error: unknown) => void;
}

interface ProjectReconcileQueueState {
  active: {
    options: ReconcileProjectOptions;
    promise: Promise<ReconcileProjectResult>;
  } | null;
  queued: {
    options: ReconcileProjectOptions;
    waiters: ReconcileWaiter[];
  } | null;
}

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

function triggerPriority(trigger: ProjectReconcileTrigger) {
  switch (trigger) {
    case 'relink':
      return 6;
    case 'init_refresh':
      return 5;
    case 'manual_refresh':
      return 4;
    case 'watcher':
      return 3;
    case 'monitor_boot':
      return 2;
    case 'monitor_interval':
      return 1;
    case 'register':
      return 0;
    default:
      return 0;
  }
}

function describeReconcileReason(options: ReconcileProjectOptions) {
  if (options.hint?.source === 'watcher') {
    return `${options.hint.event}:${options.hint.relativePath}`;
  }

  return null;
}

function mergeQueuedOptions(
  current: ReconcileProjectOptions,
  next: ReconcileProjectOptions,
): ReconcileProjectOptions {
  const preferred =
    triggerPriority(next.trigger) >= triggerPriority(current.trigger)
      ? next
      : current;

  return {
    trigger: preferred.trigger,
    emitRefreshEventOnNoChange:
      Boolean(current.emitRefreshEventOnNoChange) || Boolean(next.emitRefreshEventOnNoChange),
    ...(preferred.hint ?? current.hint ?? next.hint ? { hint: preferred.hint ?? next.hint ?? current.hint } : {}),
  };
}

function isWatcherMonitorError(error: ProjectMonitorError | null | undefined) {
  return error?.message.startsWith(WATCHER_MONITOR_ERROR_PREFIX) ?? false;
}

function buildSuccessfulMonitorSummary(
  snapshot: ProjectSnapshot,
  trigger: ProjectReconcileTrigger,
  previousMonitor: ProjectMonitorSummary,
): ProjectMonitorSummary {
  const carriedWatcherError =
    trigger === 'watcher' || !isWatcherMonitorError(previousMonitor.lastError)
      ? null
      : previousMonitor.lastError;

  return {
    health: deriveMonitorHealthFromSnapshot(snapshot.status),
    lastAttemptedAt: snapshot.checkedAt,
    lastSuccessfulAt: snapshot.checkedAt,
    lastTrigger: trigger,
    lastError: carriedWatcherError,
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

function isMissingProjectRootError(error: Error) {
  return (
    error instanceof ProjectSnapshotReadError
    && error.scope === 'projectRoot'
    && /no longer available|no longer resolves to a directory/i.test(error.message)
  );
}

function buildTrackedContinuitySummary(project: ProjectRecord, checkedAt: string): ProjectContinuitySummary {
  return createTrackedProjectContinuitySummary(checkedAt, {
    state: 'tracked',
    pathLostAt: null,
    lastRelinkedAt: project.continuity?.lastRelinkedAt ?? null,
    previousRegisteredPath: project.continuity?.previousRegisteredPath ?? null,
    previousCanonicalPath: project.continuity?.previousCanonicalPath ?? null,
  });
}

function buildPathLostContinuitySummary(project: ProjectRecord, checkedAt: string): ProjectContinuitySummary {
  return createTrackedProjectContinuitySummary(checkedAt, {
    state: 'path_lost',
    pathLostAt: project.continuity?.pathLostAt ?? checkedAt,
    lastRelinkedAt: project.continuity?.lastRelinkedAt ?? null,
    previousRegisteredPath: project.continuity?.previousRegisteredPath ?? project.registeredPath,
    previousCanonicalPath: project.continuity?.previousCanonicalPath ?? project.canonicalPath,
  });
}

function buildProjectSnapshotEventPayload(
  projectId: string,
  canonicalPath: string,
  snapshot: ProjectSnapshot,
  changed: boolean,
  trigger: ProjectReconcileTrigger,
  monitor: ProjectMonitorSummary,
  continuity: ProjectContinuitySummary,
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
    continuity,
  };
}

function buildProjectMonitorEventPayload(
  project: Pick<ProjectRecord, 'projectId' | 'canonicalPath' | 'snapshot'>,
  monitor: ProjectMonitorSummary,
  previousHealth: ProjectMonitorHealth,
  trigger: ProjectReconcileTrigger,
  continuity: ProjectContinuitySummary,
): ProjectMonitorEventPayload {
  return {
    projectId: project.projectId,
    canonicalPath: project.canonicalPath,
    snapshotStatus: project.snapshot.status,
    warningCount: summarizeWarningCount(project.snapshot),
    trigger,
    previousHealth,
    monitor,
    continuity,
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
  previousContinuityState: ProjectContinuityState | undefined;
  trigger: ProjectReconcileTrigger;
  snapshot: ProjectSnapshot;
  monitor: ProjectMonitorSummary;
  changed: boolean;
}): TimelineEntryInput | null {
  const { previousHealth, previousContinuityState, trigger, snapshot, monitor, changed } = options;
  const recoveredFromPathLost = previousContinuityState === 'path_lost';

  if (monitor.health !== previousHealth || recoveredFromPathLost) {
    if (monitor.health === 'healthy' && (previousHealth !== 'healthy' || recoveredFromPathLost)) {
      return {
        type: 'monitor_recovered',
        emittedAt: snapshot.checkedAt,
        trigger,
        snapshotStatus: snapshot.status,
        monitorHealth: monitor.health,
        warningCount: summarizeWarningCount(snapshot),
        changed,
        detail: recoveredFromPathLost
          ? `Project continuity recovered from a path-lost state via ${summarizeTrigger(trigger)}; snapshot is now ${snapshot.status}.`
          : `Monitor recovered via ${summarizeTrigger(trigger)}; snapshot is now ${snapshot.status}.`,
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

function buildPathLostTimelineEntry(options: {
  trigger: ProjectReconcileTrigger;
  snapshot: ProjectSnapshot;
  monitor: ProjectMonitorSummary;
}): TimelineEntryInput {
  return {
    type: 'path_lost',
    emittedAt: options.monitor.lastAttemptedAt ?? new Date().toISOString(),
    trigger: options.trigger,
    snapshotStatus: options.snapshot.status,
    monitorHealth: options.monitor.health,
    warningCount: summarizeWarningCount(options.snapshot),
    changed: false,
    detail: `Project root is unavailable via ${summarizeTrigger(options.trigger)}; preserving the last known ${options.snapshot.status} snapshot until relink or recovery.`,
    error: options.monitor.lastError,
  };
}

export function createWatcherMonitorError(message: string, attemptedAt: string): ProjectMonitorError {
  const normalized = message.startsWith(WATCHER_MONITOR_ERROR_PREFIX)
    ? message
    : `${WATCHER_MONITOR_ERROR_PREFIX}${message}`;

  return {
    scope: 'projectRoot',
    message: normalized,
    at: attemptedAt,
  };
}

export function buildProjectRegistrationState(
  projectId: string,
  canonicalPath: string,
  snapshot: ProjectSnapshot,
): ProjectRegistrationState {
  const monitor = buildSuccessfulMonitorSummary(snapshot, 'register', {
    health: 'stale',
    lastAttemptedAt: null,
    lastSuccessfulAt: null,
    lastTrigger: null,
    lastError: null,
  });
  const continuity = createTrackedProjectContinuitySummary(snapshot.checkedAt);

  return {
    monitor,
    eventPayload: buildProjectSnapshotEventPayload(
      projectId,
      canonicalPath,
      snapshot,
      true,
      'register',
      monitor,
      continuity,
    ),
    timelineEntry: buildRegistrationTimelineEntry(snapshot, monitor),
  };
}

export class ProjectReconciler {
  private readonly queues = new Map<string, ProjectReconcileQueueState>();

  constructor(
    private readonly registry: RegistryDatabase,
    private readonly eventHub: EventHub,
    private readonly options: {
      snapshotTimeoutMs?: number;
      log?: Pick<FastifyBaseLogger, 'error' | 'warn' | 'info'>;
      signalSink?: (signal: ProjectReconcileSignal) => void;
    } = {},
  ) {}

  reconcileProject(projectId: string, options: ReconcileProjectOptions): Promise<ReconcileProjectResult> {
    const state = this.getQueueState(projectId);

    if (!state.active) {
      return this.launchActive(projectId, state, options);
    }

    return new Promise<ReconcileProjectResult>((resolve, reject) => {
      const queuedOptions = state.queued ? mergeQueuedOptions(state.queued.options, options) : options;
      const previousQueuedTrigger = state.queued?.options.trigger ?? null;

      if (state.queued) {
        state.queued.options = queuedOptions;
        state.queued.waiters.push({ resolve, reject });
      } else {
        state.queued = {
          options: queuedOptions,
          waiters: [{ resolve, reject }],
        };
      }

      const reason = describeReconcileReason(options);

      this.options.signalSink?.({
        event: 'project_reconcile',
        phase: 'queued',
        projectId,
        trigger: options.trigger,
        activeTrigger: state.active?.options.trigger ?? null,
        queuedTrigger: state.queued.options.trigger,
        reason,
      });
      this.options.log?.info?.(
        {
          event: 'project-reconcile-queued',
          projectId,
          trigger: options.trigger,
          activeTrigger: state.active?.options.trigger ?? null,
          previousQueuedTrigger,
          queuedTrigger: state.queued.options.trigger,
          reason,
        },
        'Queued project reconcile follow-up',
      );
    });
  }

  private getQueueState(projectId: string): ProjectReconcileQueueState {
    const existing = this.queues.get(projectId);

    if (existing) {
      return existing;
    }

    const created: ProjectReconcileQueueState = {
      active: null,
      queued: null,
    };

    this.queues.set(projectId, created);

    return created;
  }

  private launchActive(
    projectId: string,
    state: ProjectReconcileQueueState,
    options: ReconcileProjectOptions,
  ): Promise<ReconcileProjectResult> {
    const reason = describeReconcileReason(options);

    this.options.signalSink?.({
      event: 'project_reconcile',
      phase: 'started',
      projectId,
      trigger: options.trigger,
      queuedTrigger: state.queued?.options.trigger ?? null,
      reason,
    });
    this.options.log?.info?.(
      {
        event: 'project-reconcile-started',
        projectId,
        trigger: options.trigger,
        reason,
        emitRefreshEventOnNoChange: Boolean(options.emitRefreshEventOnNoChange),
        queuedTrigger: state.queued?.options.trigger ?? null,
      },
      'Started project reconcile',
    );

    const promise = this.performReconcile(projectId, options);
    state.active = {
      options,
      promise,
    };

    promise
      .then((result) => {
        this.options.signalSink?.({
          event: 'project_reconcile',
          phase: 'completed',
          projectId,
          trigger: options.trigger,
          reason,
          status: result.status,
          changed: result.status === 'success' ? result.changed : false,
          healthChanged: result.healthChanged,
          emittedEventType: result.event?.type ?? null,
        });
        this.options.log?.info?.(
          {
            event: 'project-reconcile-completed',
            projectId,
            trigger: options.trigger,
            reason,
            status: result.status,
            changed: result.status === 'success' ? result.changed : false,
            healthChanged: result.healthChanged,
            emittedEventType: result.event?.type ?? null,
          },
          'Completed project reconcile',
        );
      })
      .catch((error) => {
        this.options.log?.error?.(
          {
            err: error,
            event: 'project-reconcile-crashed',
            projectId,
            trigger: options.trigger,
            reason,
          },
          'Project reconcile crashed unexpectedly',
        );
      })
      .finally(() => {
        if (state.active?.promise === promise) {
          state.active = null;
        }

        const queued = state.queued;

        if (queued) {
          state.queued = null;
          const queuedPromise = this.launchActive(projectId, state, queued.options);
          queuedPromise.then(
            (result) => {
              for (const waiter of queued.waiters) {
                waiter.resolve(result);
              }
            },
            (error) => {
              for (const waiter of queued.waiters) {
                waiter.reject(error);
              }
            },
          );
          return;
        }

        if (!state.active && !state.queued) {
          this.queues.delete(projectId);
        }
      });

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
      const monitor = buildSuccessfulMonitorSummary(snapshot, options.trigger, project.monitor);
      const continuity = buildTrackedContinuitySummary(project, snapshot.checkedAt);
      const changed = isChangedSnapshot(project.snapshot, snapshot);
      const healthChanged = monitor.health !== project.monitor.health;
      const continuityRecovered = project.continuity?.state === 'path_lost' && continuity.state === 'tracked';
      const timelineEntry = buildSuccessTimelineEntry({
        previousHealth: project.monitor.health,
        previousContinuityState: project.continuity?.state,
        trigger: options.trigger,
        snapshot: snapshot,
        monitor,
        changed,
      });

      if (changed || options.emitRefreshEventOnNoChange) {
        const input: RefreshProjectInput = {
          projectId: project.projectId,
          snapshot,
          monitor,
          continuity,
          eventPayload: buildProjectSnapshotEventPayload(
            project.projectId,
            project.canonicalPath,
            snapshot,
            changed,
            options.trigger,
            monitor,
            continuity,
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

      if (healthChanged || continuityRecovered) {
        const result = this.registry.updateProjectMonitor({
          projectId: project.projectId,
          monitor,
          continuity,
          emittedAt: snapshot.checkedAt,
          eventPayload: buildProjectMonitorEventPayload(
            project,
            monitor,
            project.monitor.health,
            options.trigger,
            continuity,
          ),
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
        continuity,
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
      const continuity = isMissingProjectRootError(failure)
        ? buildPathLostContinuitySummary(project, attemptedAt)
        : createTrackedProjectContinuitySummary(attemptedAt, {
            state: project.continuity?.state ?? 'tracked',
            pathLostAt: project.continuity?.pathLostAt ?? null,
            lastRelinkedAt: project.continuity?.lastRelinkedAt ?? null,
            previousRegisteredPath: project.continuity?.previousRegisteredPath ?? null,
            previousCanonicalPath: project.continuity?.previousCanonicalPath ?? null,
          });
      const healthChanged = monitor.health !== project.monitor.health;
      const continuityChanged =
        continuity.state !== (project.continuity?.state ?? 'tracked')
        || continuity.pathLostAt !== (project.continuity?.pathLostAt ?? null);
      const timelineEntry = isMissingProjectRootError(failure)
        ? (continuityChanged
          ? buildPathLostTimelineEntry({
              trigger: options.trigger,
              snapshot: project.snapshot,
              monitor,
            })
          : null)
        : (healthChanged
          ? buildFailureTimelineEntry({
              trigger: options.trigger,
              snapshot: project.snapshot,
              monitor,
            })
          : null);

      try {
        const result = this.registry.updateProjectMonitor({
          projectId: project.projectId,
          monitor,
          continuity,
          emittedAt: attemptedAt,
          ...(healthChanged || continuityChanged
            ? {
                eventPayload: buildProjectMonitorEventPayload(
                  project,
                  monitor,
                  project.monitor.health,
                  options.trigger,
                  continuity,
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
