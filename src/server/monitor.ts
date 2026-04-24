import chokidar, { type FSWatcher } from 'chokidar';
import type { FastifyBaseLogger } from 'fastify';
import path from 'node:path';

import type { ProjectMonitorError, ProjectMonitorEventPayload } from '../shared/contracts.js';
import type { RegistryDatabase, TimelineEntryInput } from './db.js';
import {
  ProjectReconciler,
  createWatcherMonitorError,
  type ProjectReconcileSignal,
} from './project-reconcile.js';
import type { EventHub } from './routes/events.js';

export const DEFAULT_MONITOR_INTERVAL_MS = 10_000;
export const DEFAULT_WATCHER_DEBOUNCE_MS = 75;
export const DEFAULT_WATCHER_READY_TIMEOUT_MS = 1_000;

export interface ProjectMonitorSignal {
  event: 'project_watcher';
  phase: 'attached' | 'hint' | 'error' | 'closed';
  projectId: string;
  watchedPath?: string | null;
  relativePath?: string | null;
  watcherEvent?: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir' | null;
  detail?: string | null;
}

export interface ProjectMonitorManagerOptions {
  intervalMs?: number;
  watcherDebounceMs?: number;
  watcherReadyTimeoutMs?: number;
  watchersEnabled?: boolean;
  log?: Pick<FastifyBaseLogger, 'debug' | 'error' | 'warn' | 'info'>;
  signalSink?: (signal: ProjectMonitorSignal | ProjectReconcileSignal) => void;
}

interface ProjectWatcherState {
  watcher: FSWatcher | null;
  watchedPath: string | null;
  debounceTimer: NodeJS.Timeout | null;
  pendingHint: {
    event: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';
    relativePath: string;
  } | null;
}

function summarizeWarningCount(snapshot: { warnings: unknown[] }) {
  return snapshot.warnings.length;
}

function normalizeRelativePath(projectRoot: string, candidatePath: string) {
  const relativePath = path.relative(projectRoot, candidatePath);

  if (relativePath === '') {
    return '';
  }

  const normalized = relativePath.split(path.sep).join('/');

  if (normalized === '..' || normalized.startsWith('../')) {
    return null;
  }

  return normalized;
}

function isWatchedRelativePath(relativePath: string) {
  if (
    relativePath === '.gsd/gsd.db-shm'
    || relativePath === '.gsd/gsd.db-wal'
    || relativePath === '.gsd/gsd.db-journal'
  ) {
    return false;
  }

  return (
    relativePath === ''
    || relativePath === '.gsd-id'
    || relativePath === '.gsd'
    || relativePath.startsWith('.gsd/')
  );
}

function buildWatcherMonitorEventPayload(
  project: NonNullable<ReturnType<RegistryDatabase['getProjectById']>>,
  monitor: NonNullable<ReturnType<RegistryDatabase['getProjectById']>>['monitor'],
): ProjectMonitorEventPayload {
  return {
    projectId: project.projectId,
    canonicalPath: project.canonicalPath,
    snapshotStatus: project.snapshot.status,
    warningCount: summarizeWarningCount(project.snapshot),
    trigger: 'watcher',
    previousHealth: project.monitor.health,
    monitor,
  };
}

function buildWatcherTimelineEntry(
  project: NonNullable<ReturnType<RegistryDatabase['getProjectById']>>,
  emittedAt: string,
  detail: string,
  error: ProjectMonitorError | null,
): TimelineEntryInput {
  return {
    type: error ? 'monitor_degraded' : 'monitor_recovered',
    emittedAt,
    trigger: 'watcher',
    snapshotStatus: project.snapshot.status,
    monitorHealth: project.monitor.health,
    warningCount: summarizeWarningCount(project.snapshot),
    changed: false,
    detail,
    error,
  };
}

function sameWatcherDiagnostic(
  current: ProjectMonitorError | null,
  next: ProjectMonitorError | null,
) {
  return current?.scope === next?.scope && current?.message === next?.message;
}

function waitForWatcherReady(watcher: FSWatcher, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`Watcher did not become ready within ${timeoutMs}ms.`));
    }, timeoutMs);
    timeoutId.unref?.();

    const handleReady = () => {
      cleanup();
      resolve();
    };

    const handleError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error('Watcher failed before becoming ready.'));
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      watcher.off('ready', handleReady);
      watcher.off('error', handleError);
    };

    watcher.once('ready', handleReady);
    watcher.once('error', handleError);
  });
}

export class ProjectMonitorManager {
  private intervalId: NodeJS.Timeout | null = null;
  private runningSweep: Promise<void> | null = null;
  private closed = false;
  private readonly watchers = new Map<string, ProjectWatcherState>();

  constructor(
    private readonly registry: RegistryDatabase,
    private readonly reconciler: ProjectReconciler,
    private readonly eventHub: EventHub,
    private readonly options: ProjectMonitorManagerOptions = {},
  ) {}

  start() {
    if (this.closed || this.intervalId !== null) {
      return;
    }

    if (this.options.watchersEnabled ?? true) {
      void this.syncAllWatchers();
    }
    void this.reconcileAll('monitor_boot');

    const intervalMs = this.options.intervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;

    this.intervalId = setInterval(() => {
      void this.reconcileAll('monitor_interval');
    }, intervalMs);
    this.intervalId.unref?.();
  }

  async stop() {
    this.closed = true;

    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    for (const [projectId, state] of this.watchers.entries()) {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }

      await this.closeWatcher(projectId, state, 'monitor manager stopped');
    }

    this.watchers.clear();
    await this.runningSweep?.catch(() => undefined);
  }

  syncProject(projectId: string) {
    if (this.closed || !(this.options.watchersEnabled ?? true)) {
      return Promise.resolve();
    }

    const project = this.registry.getProjectById(projectId);

    if (!project) {
      return this.disposeProject(projectId, 'project no longer registered');
    }

    return this.ensureWatcher(project.projectId, project.canonicalPath);
  }

  private reconcileAll(trigger: 'monitor_boot' | 'monitor_interval') {
    if (this.closed) {
      return Promise.resolve();
    }

    if (this.runningSweep) {
      return this.runningSweep;
    }

    const promise = this.runSweep(trigger).finally(() => {
      if (this.runningSweep === promise) {
        this.runningSweep = null;
      }
    });

    this.runningSweep = promise;

    return promise;
  }

  private async runSweep(trigger: 'monitor_boot' | 'monitor_interval') {
    const projects = this.registry.listProjects();

    for (const project of projects) {
      if (this.closed) {
        return;
      }

      try {
        const result = await this.reconciler.reconcileProject(project.projectId, {
          trigger,
          emitRefreshEventOnNoChange: false,
        });

        if (result.status === 'failed') {
          this.options.log?.warn?.(
            {
              projectId: project.projectId,
              trigger,
              error: result.error.message,
            },
            'Project monitor reconcile recorded a degraded state',
          );
        }
      } catch (error) {
        this.options.log?.error?.(
          { err: error, projectId: project.projectId, trigger },
          'Project monitor reconcile sweep failed unexpectedly',
        );
      }
    }
  }

  private async syncAllWatchers() {
    const projects = this.registry.listProjects();
    const activeProjectIds = new Set(projects.map((project) => project.projectId));

    await Promise.all(projects.map((project) => this.ensureWatcher(project.projectId, project.canonicalPath)));

    await Promise.all(
      Array.from(this.watchers.keys())
        .filter((projectId) => !activeProjectIds.has(projectId))
        .map((projectId) => this.disposeProject(projectId, 'project removed during watcher sync')),
    );
  }

  private getWatcherState(projectId: string): ProjectWatcherState {
    const existing = this.watchers.get(projectId);

    if (existing) {
      return existing;
    }

    const created: ProjectWatcherState = {
      watcher: null,
      watchedPath: null,
      debounceTimer: null,
      pendingHint: null,
    };

    this.watchers.set(projectId, created);

    return created;
  }

  private async ensureWatcher(projectId: string, canonicalPath: string) {
    const state = this.getWatcherState(projectId);

    if (state.watcher && state.watchedPath === canonicalPath) {
      return;
    }

    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
      state.pendingHint = null;
    }

    await this.closeWatcher(projectId, state, 'replacing watcher subscription');

    let watcher: FSWatcher | null = null;

    try {
      watcher = chokidar.watch(canonicalPath, {
        persistent: true,
        ignoreInitial: true,
        ignorePermissionErrors: true,
        awaitWriteFinish: {
          stabilityThreshold: 50,
          pollInterval: 10,
        },
        ignored: (candidatePath) => {
          const normalized = normalizeRelativePath(canonicalPath, candidatePath);
          return normalized !== null && !isWatchedRelativePath(normalized);
        },
      });

      await waitForWatcherReady(watcher, this.options.watcherReadyTimeoutMs ?? DEFAULT_WATCHER_READY_TIMEOUT_MS);

      watcher.on('all', (watcherEvent, changedPath) => {
        if (
          watcherEvent !== 'add'
          && watcherEvent !== 'addDir'
          && watcherEvent !== 'change'
          && watcherEvent !== 'unlink'
          && watcherEvent !== 'unlinkDir'
        ) {
          return;
        }

        const relativePath = normalizeRelativePath(canonicalPath, changedPath);

        if (relativePath === null || !isWatchedRelativePath(relativePath) || relativePath === '') {
          return;
        }

        this.options.signalSink?.({
          event: 'project_watcher',
          phase: 'hint',
          projectId,
          watchedPath: canonicalPath,
          watcherEvent,
          relativePath,
          detail: 'Queued watcher-triggered reconcile hint',
        });
        this.options.log?.info?.(
          {
            event: 'project-watcher-hint',
            projectId,
            watchedPath: canonicalPath,
            watcherEvent,
            relativePath,
          },
          'Queued watcher-triggered reconcile hint',
        );

        this.scheduleWatcherHint(projectId, state, watcherEvent, relativePath);
      });

      watcher.on('error', (error) => {
        void this.handleWatcherError(projectId, state, canonicalPath, error);
      });

      state.watcher = watcher;
      state.watchedPath = canonicalPath;

      await this.updateWatcherDiagnostic(
        projectId,
        null,
        'Watcher subscription recovered and low-latency scheduling resumed.',
      );

      this.options.signalSink?.({
        event: 'project_watcher',
        phase: 'attached',
        projectId,
        watchedPath: canonicalPath,
        detail: 'Attached watcher subscription',
      });
      this.options.log?.info?.(
        {
          event: 'project-watcher-attached',
          projectId,
          watchedPath: canonicalPath,
        },
        'Attached project watcher',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Watcher startup failed unexpectedly.';

      await watcher?.close().catch(() => undefined);
      await this.updateWatcherDiagnostic(
        projectId,
        createWatcherMonitorError(
          `Watcher startup failed; relying on periodic reconcile backstop. ${message}`,
          new Date().toISOString(),
        ),
        'Watcher became unavailable; relying on periodic reconcile backstop.',
      );

      this.options.signalSink?.({
        event: 'project_watcher',
        phase: 'error',
        projectId,
        watchedPath: canonicalPath,
        detail: message,
      });
      this.options.log?.warn?.(
        {
          event: 'project-watcher-startup-failed',
          projectId,
          watchedPath: canonicalPath,
          error: message,
        },
        'Project watcher failed to start; periodic reconcile remains authoritative',
      );
    }
  }

  private scheduleWatcherHint(
    projectId: string,
    state: ProjectWatcherState,
    watcherEvent: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir',
    relativePath: string,
  ) {
    state.pendingHint = {
      event: watcherEvent,
      relativePath,
    };

    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      const pendingHint = state.pendingHint;
      state.pendingHint = null;

      if (!pendingHint || this.closed) {
        return;
      }

      void this.reconciler.reconcileProject(projectId, {
        trigger: 'watcher',
        hint: {
          source: 'watcher',
          event: pendingHint.event,
          relativePath: pendingHint.relativePath,
        },
      });
    }, this.options.watcherDebounceMs ?? DEFAULT_WATCHER_DEBOUNCE_MS);
    state.debounceTimer.unref?.();
  }

  private async handleWatcherError(
    projectId: string,
    state: ProjectWatcherState,
    canonicalPath: string,
    error: unknown,
  ) {
    const message = error instanceof Error ? error.message : 'Watcher runtime failed unexpectedly.';

    await this.closeWatcher(projectId, state, message);
    await this.updateWatcherDiagnostic(
      projectId,
      createWatcherMonitorError(
        `Watcher runtime failed; relying on periodic reconcile backstop. ${message}`,
        new Date().toISOString(),
      ),
      'Watcher became unavailable; relying on periodic reconcile backstop.',
    );

    this.options.signalSink?.({
      event: 'project_watcher',
      phase: 'error',
      projectId,
      watchedPath: canonicalPath,
      detail: message,
    });
    this.options.log?.warn?.(
      {
        event: 'project-watcher-runtime-failed',
        projectId,
        watchedPath: canonicalPath,
        error: message,
      },
      'Project watcher failed during runtime; periodic reconcile remains authoritative',
    );
  }

  private async updateWatcherDiagnostic(
    projectId: string,
    watcherError: ProjectMonitorError | null,
    detail: string,
  ) {
    const project = this.registry.getProjectById(projectId);

    if (!project) {
      return;
    }

    const currentWatcherError = project.monitor.lastError?.message.startsWith('[watcher] ')
      ? project.monitor.lastError
      : null;

    if (watcherError !== null && currentWatcherError === null && project.monitor.lastError !== null) {
      return;
    }

    if (sameWatcherDiagnostic(currentWatcherError, watcherError)) {
      return;
    }

    if (watcherError === null && currentWatcherError === null) {
      return;
    }

    const emittedAt = watcherError?.at ?? new Date().toISOString();
    const nextMonitor = {
      ...project.monitor,
      lastError: watcherError ?? null,
    };
    const result = this.registry.updateProjectMonitor({
      projectId,
      monitor: nextMonitor,
      emittedAt,
      eventPayload: buildWatcherMonitorEventPayload(project, nextMonitor),
      timelineEntry: buildWatcherTimelineEntry(project, emittedAt, detail, watcherError),
    });

    if (result.event) {
      this.eventHub.broadcast(result.event);
    }
  }

  private async closeWatcher(projectId: string, state: ProjectWatcherState, detail: string) {
    if (!state.watcher) {
      return;
    }

    const watcher = state.watcher;
    const watchedPath = state.watchedPath;

    state.watcher = null;
    state.watchedPath = null;

    try {
      await watcher.close();
    } finally {
      this.options.signalSink?.({
        event: 'project_watcher',
        phase: 'closed',
        projectId,
        watchedPath,
        detail,
      });
      this.options.log?.info?.(
        {
          event: 'project-watcher-closed',
          projectId,
          watchedPath,
          detail,
        },
        'Closed project watcher',
      );
    }
  }

  private async disposeProject(projectId: string, detail: string) {
    const state = this.watchers.get(projectId);

    if (!state) {
      return;
    }

    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
      state.pendingHint = null;
    }

    await this.closeWatcher(projectId, state, detail);
    this.watchers.delete(projectId);
  }
}
