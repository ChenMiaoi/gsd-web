import type { FastifyBaseLogger } from 'fastify';

import type { RegistryDatabase } from './db.js';
import { ProjectReconciler } from './project-reconcile.js';

export const DEFAULT_MONITOR_INTERVAL_MS = 1_000;

export interface ProjectMonitorManagerOptions {
  intervalMs?: number;
  log?: Pick<FastifyBaseLogger, 'error' | 'warn' | 'info'>;
}

export class ProjectMonitorManager {
  private intervalId: NodeJS.Timeout | null = null;
  private runningSweep: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly registry: RegistryDatabase,
    private readonly reconciler: ProjectReconciler,
    private readonly options: ProjectMonitorManagerOptions = {},
  ) {}

  start() {
    if (this.closed || this.intervalId !== null) {
      return;
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

    await this.runningSweep?.catch(() => undefined);
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

    await Promise.all(
      projects.map(async (project) => {
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
      }),
    );
  }
}
