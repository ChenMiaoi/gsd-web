import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type {
  ProjectContinuityState,
  ProjectContinuitySummary,
  ProjectEventEnvelope,
  ProjectEventPayload,
  ProjectEventType,
  ProjectInitEventPayload,
  ProjectInitJob,
  ProjectInitJobHistoryEntry,
  ProjectInitJobStage,
  ProjectInitRefreshResult,
  ProjectMonitorError,
  ProjectMonitorEventPayload,
  ProjectMonitorHealth,
  ProjectMonitorSummary,
  ProjectRecord,
  ProjectReconcileTrigger,
  ProjectRelinkEventPayload,
  ProjectSnapshot,
  ProjectSnapshotEventPayload,
  ProjectSnapshotStatus,
  ProjectTimelineEntry,
  ProjectTimelineEntryType,
  ProjectTimelineResponse,
  ServiceReadyEventPayload,
  SnapshotSourceName,
} from '../shared/contracts.js';
import {
  PROJECT_CONTINUITY_STATES,
  PROJECT_INIT_JOB_STAGES,
  PROJECT_MONITOR_HEALTHS,
  PROJECT_RECONCILE_TRIGGERS,
  PROJECT_TIMELINE_ENTRY_TYPES,
  SNAPSHOT_SOURCE_NAMES,
  createStaleProjectMonitorSummary,
  createTrackedProjectContinuitySummary,
  isProjectInitJobTerminalStage,
} from '../shared/contracts.js';

export const REGISTRY_SCHEMA_VERSION = '5';

const MAX_INIT_JOB_HISTORY_ENTRIES = 32;
const MAX_PROJECT_TIMELINE_ENTRIES = 32;
const MAX_RETAINED_RAW_EVENTS = 256;
const MAX_TIMELINE_DETAIL_LENGTH = 320;
const MAX_INIT_DETAIL_LENGTH = 320;
const MAX_INIT_OUTPUT_EXCERPT_LENGTH = 1_200;
const MAX_INIT_ERROR_DETAIL_LENGTH = 640;
const MAX_MONITOR_ERROR_DETAIL_LENGTH = 320;
const DEFAULT_MONITOR_JSON = JSON.stringify(createStaleProjectMonitorSummary()).replace(/'/g, "''");
const DEFAULT_CONTINUITY_JSON = JSON.stringify(createTrackedProjectContinuitySummary(new Date(0).toISOString())).replace(/'/g, "''");

interface ProjectRow {
  project_id: string;
  registered_path: string;
  canonical_path: string;
  snapshot_json: string;
  monitor_json: string;
  continuity_json: string;
  created_at: string;
  updated_at: string;
  last_event_sequence: number | null;
}

interface EventRow {
  sequence: number;
  event_type: ProjectEventType;
  project_id: string | null;
  emitted_at: string;
  payload_json: string;
}

interface TimelineRow {
  timeline_sequence: number;
  project_id: string;
  timeline_type: string;
  emitted_at: string;
  trigger: string;
  snapshot_status: string;
  monitor_health: string;
  warning_count: number;
  changed: number;
  detail: string;
  error_json: string | null;
  event_sequence: number | null;
}

interface InitJobRow {
  job_id: string;
  project_id: string;
  stage: string;
  output_excerpt: string | null;
  last_error_detail: string | null;
  refresh_result_json: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  last_event_sequence: number | null;
}

interface InitJobHistoryRow {
  history_sequence: number;
  job_id: string;
  stage: string;
  emitted_at: string;
  detail: string;
  output_excerpt: string | null;
}

export interface EventReplayWindow {
  earliestRetainedEventId: string | null;
  latestRetainedEventId: string | null;
  retainedEvents: number;
}

export interface EventReplayBatch {
  items: ProjectEventEnvelope[];
  window: EventReplayWindow;
  replayGapDetected: boolean;
}

export interface TimelineEntryInput {
  type: ProjectTimelineEntryType;
  emittedAt: string;
  trigger: ProjectReconcileTrigger;
  snapshotStatus: ProjectSnapshotStatus;
  monitorHealth: ProjectMonitorHealth;
  warningCount: number;
  changed: boolean;
  detail: string;
  error?: ProjectMonitorError | null;
}

export interface RegisterProjectInput {
  projectId?: string;
  registeredPath: string;
  canonicalPath: string;
  snapshot: ProjectSnapshot;
  monitor: ProjectMonitorSummary;
  continuity?: ProjectContinuitySummary;
  eventPayload: ProjectSnapshotEventPayload;
  timelineEntry?: TimelineEntryInput | null;
}

export interface RefreshProjectInput {
  projectId: string;
  snapshot: ProjectSnapshot;
  monitor: ProjectMonitorSummary;
  continuity?: ProjectContinuitySummary;
  eventPayload: ProjectSnapshotEventPayload;
  timelineEntry?: TimelineEntryInput | null;
}

export interface RelinkProjectInput {
  projectId: string;
  registeredPath: string;
  canonicalPath: string;
  emittedAt: string;
  continuity?: ProjectContinuitySummary;
  eventPayload: ProjectRelinkEventPayload;
  timelineEntry?: TimelineEntryInput | null;
}

export interface UpdateProjectMonitorInput {
  projectId: string;
  monitor: ProjectMonitorSummary;
  continuity?: ProjectContinuitySummary;
  emittedAt: string;
  eventPayload?: ProjectMonitorEventPayload;
  timelineEntry?: TimelineEntryInput | null;
}

export interface StartInitJobInput {
  projectId: string;
  detail: string;
  emittedAt?: string;
  outputExcerpt?: string | null;
}

export interface AppendInitJobUpdateInput {
  projectId: string;
  jobId: string;
  stage: ProjectInitJobStage;
  detail: string;
  emittedAt: string;
  outputExcerpt?: string | null;
  lastErrorDetail?: string | null;
  refreshResult?: ProjectInitRefreshResult | null;
}

export class DuplicateProjectError extends Error {
  readonly canonicalPath: string;

  constructor(canonicalPath: string) {
    super(`Project path is already registered: ${canonicalPath}`);
    this.name = 'DuplicateProjectError';
    this.canonicalPath = canonicalPath;
  }
}

export class ProjectNotFoundError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`Unknown project id: ${projectId}`);
    this.name = 'ProjectNotFoundError';
    this.projectId = projectId;
  }
}

export class ActiveInitJobError extends Error {
  readonly projectId: string;
  readonly jobId: string;

  constructor(projectId: string, jobId: string) {
    super(`Project ${projectId} already has an active init job (${jobId}).`);
    this.name = 'ActiveInitJobError';
    this.projectId = projectId;
    this.jobId = jobId;
  }
}

export class InitJobNotFoundError extends Error {
  readonly projectId: string;
  readonly jobId: string;

  constructor(projectId: string, jobId: string) {
    super(`Unknown init job ${jobId} for project ${projectId}.`);
    this.name = 'InitJobNotFoundError';
    this.projectId = projectId;
    this.jobId = jobId;
  }
}

function createProjectId() {
  return `prj_${randomUUID()}`;
}

function createInitJobId() {
  return `init_${randomUUID()}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error
    && (/SQLITE_CONSTRAINT/i.test(error.message) || /UNIQUE constraint failed/i.test(error.message))
    && /projects\.canonical_path/i.test(error.message)
  );
}

function clampText(value: string | null | undefined, maxLength: number) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    return null;
  }

  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function parseProjectInitJobStage(stage: string): ProjectInitJobStage {
  if (!PROJECT_INIT_JOB_STAGES.includes(stage as ProjectInitJobStage)) {
    throw new Error(`Invalid persisted init job stage: ${stage}`);
  }

  return stage as ProjectInitJobStage;
}

function parseProjectMonitorHealth(health: string): ProjectMonitorHealth {
  if (!PROJECT_MONITOR_HEALTHS.includes(health as ProjectMonitorHealth)) {
    throw new Error(`Invalid persisted monitor health: ${health}`);
  }

  return health as ProjectMonitorHealth;
}

function parseProjectContinuityState(state: string): ProjectContinuityState {
  if (!PROJECT_CONTINUITY_STATES.includes(state as ProjectContinuityState)) {
    throw new Error(`Invalid persisted continuity state: ${state}`);
  }

  return state as ProjectContinuityState;
}

function parseProjectReconcileTrigger(trigger: string): ProjectReconcileTrigger {
  if (!PROJECT_RECONCILE_TRIGGERS.includes(trigger as ProjectReconcileTrigger)) {
    throw new Error(`Invalid persisted reconcile trigger: ${trigger}`);
  }

  return trigger as ProjectReconcileTrigger;
}

function parseProjectTimelineEntryType(type: string): ProjectTimelineEntryType {
  if (!PROJECT_TIMELINE_ENTRY_TYPES.includes(type as ProjectTimelineEntryType)) {
    throw new Error(`Invalid persisted timeline entry type: ${type}`);
  }

  return type as ProjectTimelineEntryType;
}

function parseSnapshotSourceName(scope: string): ProjectMonitorError['scope'] {
  if (scope === 'projectRoot' || scope === 'registry') {
    return scope;
  }

  if (SNAPSHOT_SOURCE_NAMES.includes(scope as SnapshotSourceName)) {
    return scope as SnapshotSourceName;
  }

  throw new Error(`Invalid persisted monitor error scope: ${scope}`);
}

function expectNullableString(value: unknown, label: string) {
  if (value === null) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  throw new Error(`Invalid persisted ${label}.`);
}

function parseProjectMonitorError(value: unknown): ProjectMonitorError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid persisted project monitor error payload.');
  }

  const record = value as Record<string, unknown>;

  return {
    scope: parseSnapshotSourceName(String(record.scope ?? '')),
    message: clampText(typeof record.message === 'string' ? record.message : null, MAX_MONITOR_ERROR_DETAIL_LENGTH)
      ?? 'Unknown monitor error.',
    at: typeof record.at === 'string' ? record.at : new Date(0).toISOString(),
  };
}

function parseProjectMonitorSummary(raw: string): ProjectMonitorSummary {
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid persisted project monitor summary.');
  }

  const record = parsed as Record<string, unknown>;

  return {
    health: parseProjectMonitorHealth(String(record.health ?? '')),
    lastAttemptedAt: expectNullableString(record.lastAttemptedAt ?? null, 'project monitor lastAttemptedAt'),
    lastSuccessfulAt: expectNullableString(record.lastSuccessfulAt ?? null, 'project monitor lastSuccessfulAt'),
    lastTrigger:
      record.lastTrigger === null || record.lastTrigger === undefined
        ? null
        : parseProjectReconcileTrigger(String(record.lastTrigger)),
    lastError:
      record.lastError === null || record.lastError === undefined
        ? null
        : parseProjectMonitorError(record.lastError),
  };
}

function parseProjectContinuitySummary(raw: string): ProjectContinuitySummary {
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid persisted project continuity summary.');
  }

  const record = parsed as Record<string, unknown>;
  const checkedAt = typeof record.checkedAt === 'string' ? record.checkedAt : new Date(0).toISOString();

  return createTrackedProjectContinuitySummary(checkedAt, {
    state: parseProjectContinuityState(String(record.state ?? '')),
    pathLostAt: expectNullableString(record.pathLostAt ?? null, 'project continuity pathLostAt'),
    lastRelinkedAt: expectNullableString(record.lastRelinkedAt ?? null, 'project continuity lastRelinkedAt'),
    previousRegisteredPath: expectNullableString(
      record.previousRegisteredPath ?? null,
      'project continuity previousRegisteredPath',
    ),
    previousCanonicalPath: expectNullableString(
      record.previousCanonicalPath ?? null,
      'project continuity previousCanonicalPath',
    ),
  });
}

function parseEventRow<TPayload extends ProjectEventPayload>(row: EventRow): ProjectEventEnvelope<TPayload> {
  return {
    id: `evt_${row.sequence}`,
    sequence: row.sequence,
    type: row.event_type,
    emittedAt: row.emitted_at,
    projectId: row.project_id,
    payload: JSON.parse(row.payload_json) as TPayload,
  };
}

function parseInitJobHistoryRow(row: InitJobHistoryRow): ProjectInitJobHistoryEntry {
  return {
    id: `ijh_${row.history_sequence}`,
    sequence: row.history_sequence,
    stage: parseProjectInitJobStage(row.stage),
    detail: row.detail,
    outputExcerpt: row.output_excerpt,
    emittedAt: row.emitted_at,
  };
}

function parseTimelineRow(row: TimelineRow): ProjectTimelineEntry {
  return {
    id: `tle_${row.timeline_sequence}`,
    sequence: row.timeline_sequence,
    type: parseProjectTimelineEntryType(row.timeline_type),
    projectId: row.project_id,
    emittedAt: row.emitted_at,
    trigger: parseProjectReconcileTrigger(row.trigger),
    snapshotStatus: row.snapshot_status as ProjectSnapshotStatus,
    monitorHealth: parseProjectMonitorHealth(row.monitor_health),
    warningCount: row.warning_count,
    changed: Boolean(row.changed),
    detail: row.detail,
    eventId: row.event_sequence === null ? null : `evt_${row.event_sequence}`,
    error: row.error_json === null ? null : parseProjectMonitorError(JSON.parse(row.error_json) as unknown),
  };
}

function mergeProjectContinuitySummary(
  checkedAt: string,
  existing: ProjectContinuitySummary | undefined | null,
  overrides: Partial<ProjectContinuitySummary> = {},
): ProjectContinuitySummary {
  return createTrackedProjectContinuitySummary(checkedAt, {
    state: overrides.state ?? existing?.state ?? 'tracked',
    pathLostAt: overrides.pathLostAt !== undefined ? overrides.pathLostAt : existing?.pathLostAt ?? null,
    lastRelinkedAt:
      overrides.lastRelinkedAt !== undefined ? overrides.lastRelinkedAt : existing?.lastRelinkedAt ?? null,
    previousRegisteredPath:
      overrides.previousRegisteredPath !== undefined
        ? overrides.previousRegisteredPath
        : existing?.previousRegisteredPath ?? null,
    previousCanonicalPath:
      overrides.previousCanonicalPath !== undefined
        ? overrides.previousCanonicalPath
        : existing?.previousCanonicalPath ?? null,
  });
}

export class RegistryDatabase {
  private readonly database: DatabaseSync;

  constructor(private readonly databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.initializeSchema();
  }

  close() {
    this.database.close();
  }

  getDatabasePath() {
    return this.databasePath;
  }

  getProjectCount() {
    const row = this.database
      .prepare('SELECT COUNT(*) AS total FROM projects')
      .get() as { total: number };

    return row.total;
  }

  listProjects(): ProjectRecord[] {
    const rows = this.database
      .prepare(
        `SELECT
          project_id,
          registered_path,
          canonical_path,
          snapshot_json,
          monitor_json,
          continuity_json,
          created_at,
          updated_at,
          last_event_sequence
        FROM projects
        ORDER BY created_at ASC, project_id ASC`,
      )
      .all() as unknown as ProjectRow[];

    return rows.map((row) => this.parseProjectRow(row));
  }

  getProjectById(projectId: string): ProjectRecord | null {
    const row = this.database
      .prepare(
        `SELECT
          project_id,
          registered_path,
          canonical_path,
          snapshot_json,
          monitor_json,
          continuity_json,
          created_at,
          updated_at,
          last_event_sequence
        FROM projects
        WHERE project_id = ?`,
      )
      .get(projectId) as ProjectRow | undefined;

    return row ? this.parseProjectRow(row) : null;
  }

  getProjectByCanonicalPath(canonicalPath: string): ProjectRecord | null {
    const row = this.database
      .prepare(
        `SELECT
          project_id,
          registered_path,
          canonical_path,
          snapshot_json,
          monitor_json,
          continuity_json,
          created_at,
          updated_at,
          last_event_sequence
        FROM projects
        WHERE canonical_path = ?`,
      )
      .get(canonicalPath) as ProjectRow | undefined;

    return row ? this.parseProjectRow(row) : null;
  }

  getProjectTimeline(projectId: string, limit: number = 20): ProjectTimelineResponse {
    const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : 20;
    const totalRow = this.database
      .prepare('SELECT COUNT(*) AS total FROM project_timeline WHERE project_id = ?')
      .get(projectId) as { total: number };
    const rows = this.database
      .prepare(
        `SELECT
          timeline_sequence,
          project_id,
          timeline_type,
          emitted_at,
          trigger,
          snapshot_status,
          monitor_health,
          warning_count,
          changed,
          detail,
          error_json,
          event_sequence
        FROM project_timeline
        WHERE project_id = ?
        ORDER BY timeline_sequence DESC
        LIMIT ?`,
      )
      .all(projectId, normalizedLimit) as unknown as TimelineRow[];

    return {
      items: rows.map((row) => parseTimelineRow(row)),
      total: totalRow.total,
    };
  }

  registerProject(input: RegisterProjectInput): {
    project: ProjectRecord;
    event: ProjectEventEnvelope<ProjectSnapshotEventPayload>;
  } {
    const now = input.snapshot.checkedAt;
    const projectId = input.projectId ?? createProjectId();
    const snapshotJson = JSON.stringify(input.snapshot);
    const monitorJson = JSON.stringify(input.monitor);
    const continuityJson = JSON.stringify(input.continuity ?? createTrackedProjectContinuitySummary(now));

    this.begin();

    try {
      this.database
        .prepare(
          `INSERT INTO projects (
            project_id,
            registered_path,
            canonical_path,
            snapshot_json,
            monitor_json,
            continuity_json,
            created_at,
            updated_at,
            last_event_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(projectId, input.registeredPath, input.canonicalPath, snapshotJson, monitorJson, continuityJson, now, now);

      const event = this.insertEvent('project.registered', projectId, now, input.eventPayload);

      if (input.timelineEntry) {
        this.insertTimelineEntry(projectId, input.timelineEntry, event.sequence);
      }

      this.database
        .prepare('UPDATE projects SET last_event_sequence = ? WHERE project_id = ?')
        .run(event.sequence, projectId);

      this.commit();

      return {
        project: this.requireProject(projectId),
        event,
      };
    } catch (error) {
      this.rollback();

      if (isUniqueConstraintError(error)) {
        throw new DuplicateProjectError(input.canonicalPath);
      }

      throw error;
    }
  }

  refreshProject(input: RefreshProjectInput): {
    project: ProjectRecord;
    event: ProjectEventEnvelope<ProjectSnapshotEventPayload>;
  } {
    const existing = this.getProjectById(input.projectId);

    if (!existing) {
      throw new ProjectNotFoundError(input.projectId);
    }

    const now = input.snapshot.checkedAt;
    const snapshotJson = JSON.stringify(input.snapshot);
    const monitorJson = JSON.stringify(input.monitor);
    const continuityJson = JSON.stringify(
      input.continuity ?? mergeProjectContinuitySummary(now, existing.continuity),
    );

    this.begin();

    try {
      const updateResult = this.database
        .prepare(
          `UPDATE projects
          SET snapshot_json = ?, monitor_json = ?, continuity_json = ?, updated_at = ?
          WHERE project_id = ?`,
        )
        .run(snapshotJson, monitorJson, continuityJson, now, input.projectId);

      if (Number(updateResult.changes) !== 1) {
        throw new ProjectNotFoundError(input.projectId);
      }

      const event = this.insertEvent('project.refreshed', input.projectId, now, input.eventPayload);

      if (input.timelineEntry) {
        this.insertTimelineEntry(input.projectId, input.timelineEntry, event.sequence);
      }

      this.database
        .prepare('UPDATE projects SET last_event_sequence = ? WHERE project_id = ?')
        .run(event.sequence, input.projectId);

      this.commit();

      return {
        project: this.requireProject(input.projectId),
        event,
      };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  relinkProject(input: RelinkProjectInput): {
    project: ProjectRecord;
    event: ProjectEventEnvelope<ProjectRelinkEventPayload>;
  } {
    const existing = this.getProjectById(input.projectId);

    if (!existing) {
      throw new ProjectNotFoundError(input.projectId);
    }

    const duplicate = this.getProjectByCanonicalPath(input.canonicalPath);

    if (duplicate && duplicate.projectId !== input.projectId) {
      throw new DuplicateProjectError(input.canonicalPath);
    }

    const continuity = input.continuity
      ?? mergeProjectContinuitySummary(input.emittedAt, existing.continuity, {
        state: 'tracked',
        pathLostAt: null,
        lastRelinkedAt: input.emittedAt,
        previousRegisteredPath: existing.registeredPath,
        previousCanonicalPath: existing.canonicalPath,
      });

    this.begin();

    try {
      const updateResult = this.database
        .prepare(
          `UPDATE projects
          SET registered_path = ?, canonical_path = ?, continuity_json = ?, updated_at = ?
          WHERE project_id = ?`,
        )
        .run(
          input.registeredPath,
          input.canonicalPath,
          JSON.stringify(continuity),
          input.emittedAt,
          input.projectId,
        );

      if (Number(updateResult.changes) !== 1) {
        throw new ProjectNotFoundError(input.projectId);
      }

      const event = this.insertEvent('project.relinked', input.projectId, input.emittedAt, input.eventPayload);

      if (input.timelineEntry) {
        this.insertTimelineEntry(input.projectId, input.timelineEntry, event.sequence);
      }

      this.database
        .prepare('UPDATE projects SET last_event_sequence = ? WHERE project_id = ?')
        .run(event.sequence, input.projectId);

      this.commit();

      return {
        project: this.requireProject(input.projectId),
        event,
      };
    } catch (error) {
      this.rollback();

      if (isUniqueConstraintError(error)) {
        throw new DuplicateProjectError(input.canonicalPath);
      }

      throw error;
    }
  }

  updateProjectMonitor(input: UpdateProjectMonitorInput): {
    project: ProjectRecord;
    event: ProjectEventEnvelope<ProjectMonitorEventPayload> | null;
    timeline: ProjectTimelineEntry | null;
  } {
    this.begin();

    try {
      const existing = this.requireProject(input.projectId);
      const continuityJson = JSON.stringify(
        input.continuity ?? mergeProjectContinuitySummary(input.emittedAt, existing.continuity),
      );

      const updateResult = this.database
        .prepare(
          `UPDATE projects
          SET monitor_json = ?, continuity_json = ?, updated_at = ?
          WHERE project_id = ?`,
        )
        .run(JSON.stringify(input.monitor), continuityJson, input.emittedAt, input.projectId);

      if (Number(updateResult.changes) !== 1) {
        throw new ProjectNotFoundError(input.projectId);
      }

      let event: ProjectEventEnvelope<ProjectMonitorEventPayload> | null = null;

      if (input.eventPayload) {
        event = this.insertEvent('project.monitor.updated', input.projectId, input.emittedAt, input.eventPayload);
        this.database
          .prepare('UPDATE projects SET last_event_sequence = ? WHERE project_id = ?')
          .run(event.sequence, input.projectId);
      }

      const timeline = input.timelineEntry
        ? this.insertTimelineEntry(input.projectId, input.timelineEntry, event?.sequence ?? null)
        : null;

      this.commit();

      return {
        project: this.requireProject(input.projectId),
        event,
        timeline,
      };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  startInitJob(input: StartInitJobInput): {
    project: ProjectRecord;
    event: ProjectEventEnvelope<ProjectInitEventPayload>;
  } {
    const emittedAt = input.emittedAt ?? new Date().toISOString();
    const detail = clampText(input.detail, MAX_INIT_DETAIL_LENGTH) ?? 'Project initialization was queued.';
    const outputExcerpt = clampText(input.outputExcerpt, MAX_INIT_OUTPUT_EXCERPT_LENGTH);
    const jobId = createInitJobId();

    this.begin();

    try {
      this.requireProject(input.projectId);

      const activeJob = this.getLatestInitJob(input.projectId);

      if (activeJob && !isProjectInitJobTerminalStage(activeJob.stage)) {
        throw new ActiveInitJobError(input.projectId, activeJob.jobId);
      }

      this.database
        .prepare(
          `INSERT INTO init_jobs (
            job_id,
            project_id,
            stage,
            output_excerpt,
            last_error_detail,
            refresh_result_json,
            created_at,
            updated_at,
            finished_at,
            last_event_sequence
          ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
        )
        .run(jobId, input.projectId, 'queued', outputExcerpt, emittedAt, emittedAt);

      const historyEntry = this.insertInitJobHistory({
        jobId,
        stage: 'queued',
        detail,
        outputExcerpt,
        emittedAt,
      });
      const project = this.requireProject(input.projectId);
      const payload = this.buildProjectInitEventPayload(project, historyEntry);
      const event = this.insertEvent('project.init.updated', input.projectId, emittedAt, payload);

      this.database
        .prepare('UPDATE projects SET last_event_sequence = ? WHERE project_id = ?')
        .run(event.sequence, input.projectId);
      this.database
        .prepare('UPDATE init_jobs SET last_event_sequence = ? WHERE job_id = ?')
        .run(event.sequence, jobId);

      this.commit();

      return {
        project: this.requireProject(input.projectId),
        event,
      };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  appendInitJobUpdate(input: AppendInitJobUpdateInput): {
    project: ProjectRecord;
    event: ProjectEventEnvelope<ProjectInitEventPayload>;
  } {
    this.begin();

    try {
      this.requireProject(input.projectId);
      const jobRow = this.getInitJobRow(input.jobId);

      if (!jobRow || jobRow.project_id !== input.projectId) {
        throw new InitJobNotFoundError(input.projectId, input.jobId);
      }

      const stage = parseProjectInitJobStage(input.stage);
      const detail = clampText(input.detail, MAX_INIT_DETAIL_LENGTH) ?? 'Project init job updated.';
      const nextOutputExcerpt =
        input.outputExcerpt === undefined
          ? jobRow.output_excerpt
          : clampText(input.outputExcerpt, MAX_INIT_OUTPUT_EXCERPT_LENGTH);
      const nextLastErrorDetail =
        input.lastErrorDetail === undefined
          ? jobRow.last_error_detail
          : clampText(input.lastErrorDetail, MAX_INIT_ERROR_DETAIL_LENGTH);
      const nextRefreshResult =
        input.refreshResult === undefined ? this.parseRefreshResultJson(jobRow.refresh_result_json) : input.refreshResult;
      const finishedAt = isProjectInitJobTerminalStage(stage) ? input.emittedAt : null;

      const updateResult = this.database
        .prepare(
          `UPDATE init_jobs
          SET stage = ?,
              output_excerpt = ?,
              last_error_detail = ?,
              refresh_result_json = ?,
              updated_at = ?,
              finished_at = ?
          WHERE job_id = ?`,
        )
        .run(
          stage,
          nextOutputExcerpt,
          nextLastErrorDetail,
          nextRefreshResult === null ? null : JSON.stringify(nextRefreshResult),
          input.emittedAt,
          finishedAt,
          input.jobId,
        );

      if (Number(updateResult.changes) !== 1) {
        throw new InitJobNotFoundError(input.projectId, input.jobId);
      }

      const historyEntry = this.insertInitJobHistory({
        jobId: input.jobId,
        stage,
        detail,
        outputExcerpt: nextOutputExcerpt,
        emittedAt: input.emittedAt,
      });
      const project = this.requireProject(input.projectId);
      const payload = this.buildProjectInitEventPayload(project, historyEntry);
      const event = this.insertEvent('project.init.updated', input.projectId, input.emittedAt, payload);

      this.database
        .prepare('UPDATE projects SET last_event_sequence = ? WHERE project_id = ?')
        .run(event.sequence, input.projectId);
      this.database
        .prepare('UPDATE init_jobs SET last_event_sequence = ? WHERE job_id = ?')
        .run(event.sequence, input.jobId);

      this.commit();

      return {
        project: this.requireProject(input.projectId),
        event,
      };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  getLatestInitJob(projectId: string): ProjectInitJob | null {
    const row = this.getLatestInitJobRow(projectId);

    return row ? this.parseInitJobRow(row) : null;
  }

  appendServiceReadyEvent(payload: ServiceReadyEventPayload, emittedAt: string = new Date().toISOString()) {
    return this.insertEvent('service.ready', null, emittedAt, payload);
  }

  listEventsAfter(sequence: number, limit: number = 100): ProjectEventEnvelope[] {
    const rows = this.database
      .prepare(
        `SELECT
          sequence,
          event_type,
          project_id,
          emitted_at,
          payload_json
        FROM project_events
        WHERE sequence > ?
        ORDER BY sequence ASC
        LIMIT ?`,
      )
      .all(sequence, limit) as unknown as EventRow[];

    return rows.map((row) => parseEventRow(row));
  }

  getEventReplayBatch(sequence: number, limit: number = 100): EventReplayBatch {
    const items = this.listEventsAfter(sequence, limit);
    const window = this.getEventReplayWindow();
    const earliestSequence = window.earliestRetainedEventId === null
      ? null
      : Number.parseInt(window.earliestRetainedEventId.slice(4), 10);

    return {
      items,
      window,
      replayGapDetected: earliestSequence !== null && sequence > 0 && earliestSequence > sequence + 1,
    };
  }

  private initializeSchema() {
    this.database.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS service_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        registered_path TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        snapshot_json TEXT NOT NULL,
        monitor_json TEXT NOT NULL DEFAULT '${DEFAULT_MONITOR_JSON}',
        continuity_json TEXT NOT NULL DEFAULT '${DEFAULT_CONTINUITY_JSON}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_event_sequence INTEGER,
        FOREIGN KEY(last_event_sequence) REFERENCES project_events(sequence)
      );

      CREATE TABLE IF NOT EXISTS project_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        project_id TEXT,
        emitted_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );

      CREATE TABLE IF NOT EXISTS project_timeline (
        timeline_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        timeline_type TEXT NOT NULL,
        emitted_at TEXT NOT NULL,
        trigger TEXT NOT NULL,
        snapshot_status TEXT NOT NULL,
        monitor_health TEXT NOT NULL,
        warning_count INTEGER NOT NULL,
        changed INTEGER NOT NULL,
        detail TEXT NOT NULL,
        error_json TEXT,
        event_sequence INTEGER,
        FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
        FOREIGN KEY(event_sequence) REFERENCES project_events(sequence)
      );

      CREATE TABLE IF NOT EXISTS init_jobs (
        job_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        output_excerpt TEXT,
        last_error_detail TEXT,
        refresh_result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        last_event_sequence INTEGER,
        FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
        FOREIGN KEY(last_event_sequence) REFERENCES project_events(sequence)
      );

      CREATE TABLE IF NOT EXISTS init_job_history (
        history_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        emitted_at TEXT NOT NULL,
        detail TEXT NOT NULL,
        output_excerpt TEXT,
        FOREIGN KEY(job_id) REFERENCES init_jobs(job_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_projects_canonical_path ON projects(canonical_path);
      CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);
      CREATE INDEX IF NOT EXISTS idx_project_events_project_id ON project_events(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_events_emitted_at ON project_events(emitted_at);
      CREATE INDEX IF NOT EXISTS idx_project_timeline_project_sequence ON project_timeline(project_id, timeline_sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_project_timeline_emitted_at ON project_timeline(emitted_at);
      CREATE INDEX IF NOT EXISTS idx_init_jobs_project_updated_at ON init_jobs(project_id, updated_at DESC, job_sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_init_job_history_job_sequence ON init_job_history(job_id, history_sequence ASC);
    `);

    this.ensureProjectMonitorColumn();
    this.ensureProjectContinuityColumn();

    const upsertMetadata = this.database.prepare(`
      INSERT INTO service_metadata (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    upsertMetadata.run('schemaVersion', REGISTRY_SCHEMA_VERSION);
    upsertMetadata.run('lastBootedAt', new Date().toISOString());
  }

  private ensureProjectMonitorColumn() {
    const columns = this.database.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;

    if (!columns.some((column) => column.name === 'monitor_json')) {
      this.database.exec(
        `ALTER TABLE projects ADD COLUMN monitor_json TEXT NOT NULL DEFAULT '${DEFAULT_MONITOR_JSON}'`,
      );
    }

    this.database.exec(
      `UPDATE projects
       SET monitor_json = '${DEFAULT_MONITOR_JSON}'
       WHERE monitor_json IS NULL OR TRIM(monitor_json) = ''`,
    );
  }

  private ensureProjectContinuityColumn() {
    const columns = this.database.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;

    if (!columns.some((column) => column.name === 'continuity_json')) {
      this.database.exec(
        `ALTER TABLE projects ADD COLUMN continuity_json TEXT NOT NULL DEFAULT '${DEFAULT_CONTINUITY_JSON}'`,
      );
    }

    this.database.exec(
      `UPDATE projects
       SET continuity_json = '${DEFAULT_CONTINUITY_JSON}'
       WHERE continuity_json IS NULL OR TRIM(continuity_json) = ''`,
    );
  }

  private parseProjectRow(row: ProjectRow): ProjectRecord {
    return {
      projectId: row.project_id,
      registeredPath: row.registered_path,
      canonicalPath: row.canonical_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastEventId: row.last_event_sequence === null ? null : `evt_${row.last_event_sequence}`,
      snapshot: JSON.parse(row.snapshot_json) as ProjectSnapshot,
      monitor: parseProjectMonitorSummary(row.monitor_json),
      continuity: parseProjectContinuitySummary(row.continuity_json),
      latestInitJob: this.getLatestInitJob(row.project_id),
    };
  }

  private getLatestInitJobRow(projectId: string): InitJobRow | null {
    const row = this.database
      .prepare(
        `SELECT
          job_id,
          project_id,
          stage,
          output_excerpt,
          last_error_detail,
          refresh_result_json,
          created_at,
          updated_at,
          finished_at,
          last_event_sequence
        FROM init_jobs
        WHERE project_id = ?
        ORDER BY updated_at DESC, job_sequence DESC
        LIMIT 1`,
      )
      .get(projectId) as InitJobRow | undefined;

    return row ?? null;
  }

  private getInitJobRow(jobId: string): InitJobRow | null {
    const row = this.database
      .prepare(
        `SELECT
          job_id,
          project_id,
          stage,
          output_excerpt,
          last_error_detail,
          refresh_result_json,
          created_at,
          updated_at,
          finished_at,
          last_event_sequence
        FROM init_jobs
        WHERE job_id = ?`,
      )
      .get(jobId) as InitJobRow | undefined;

    return row ?? null;
  }

  private parseInitJobRow(row: InitJobRow): ProjectInitJob {
    const history = this.database
      .prepare(
        `SELECT
          history_sequence,
          job_id,
          stage,
          emitted_at,
          detail,
          output_excerpt
        FROM init_job_history
        WHERE job_id = ?
        ORDER BY history_sequence ASC`,
      )
      .all(row.job_id) as unknown as InitJobHistoryRow[];

    return {
      jobId: row.job_id,
      stage: parseProjectInitJobStage(row.stage),
      startedAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
      outputExcerpt: row.output_excerpt,
      lastErrorDetail: row.last_error_detail,
      refreshResult: this.parseRefreshResultJson(row.refresh_result_json),
      history: history.map((entry) => parseInitJobHistoryRow(entry)),
    };
  }

  private parseRefreshResultJson(raw: string | null): ProjectInitRefreshResult | null {
    if (raw === null) {
      return null;
    }

    return JSON.parse(raw) as ProjectInitRefreshResult;
  }

  private insertInitJobHistory(input: {
    jobId: string;
    stage: ProjectInitJobStage;
    detail: string;
    outputExcerpt: string | null;
    emittedAt: string;
  }): ProjectInitJobHistoryEntry {
    const result = this.database
      .prepare(
        `INSERT INTO init_job_history (
          job_id,
          stage,
          emitted_at,
          detail,
          output_excerpt
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.jobId, input.stage, input.emittedAt, input.detail, input.outputExcerpt);

    this.database
      .prepare(
        `DELETE FROM init_job_history
        WHERE history_sequence IN (
          SELECT history_sequence
          FROM init_job_history
          WHERE job_id = ?
          ORDER BY history_sequence DESC
          LIMIT -1 OFFSET ?
        )`,
      )
      .run(input.jobId, MAX_INIT_JOB_HISTORY_ENTRIES);

    this.pruneProjectEvents();

    const row = this.database
      .prepare(
        `SELECT
          history_sequence,
          job_id,
          stage,
          emitted_at,
          detail,
          output_excerpt
        FROM init_job_history
        WHERE history_sequence = ?`,
      )
      .get(Number(result.lastInsertRowid)) as unknown as InitJobHistoryRow;

    return parseInitJobHistoryRow(row);
  }

  private insertTimelineEntry(
    projectId: string,
    input: TimelineEntryInput,
    eventSequence: number | null,
  ): ProjectTimelineEntry {
    const result = this.database
      .prepare(
        `INSERT INTO project_timeline (
          project_id,
          timeline_type,
          emitted_at,
          trigger,
          snapshot_status,
          monitor_health,
          warning_count,
          changed,
          detail,
          error_json,
          event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        input.type,
        input.emittedAt,
        input.trigger,
        input.snapshotStatus,
        input.monitorHealth,
        input.warningCount,
        input.changed ? 1 : 0,
        clampText(input.detail, MAX_TIMELINE_DETAIL_LENGTH) ?? 'Project timeline updated.',
        input.error ? JSON.stringify(input.error) : null,
        eventSequence,
      );

    this.database
      .prepare(
        `DELETE FROM project_timeline
         WHERE timeline_sequence IN (
           SELECT timeline_sequence
           FROM project_timeline
           WHERE project_id = ?
           ORDER BY timeline_sequence DESC
           LIMIT -1 OFFSET ?
         )`,
      )
      .run(projectId, MAX_PROJECT_TIMELINE_ENTRIES);

    this.pruneProjectEvents();

    const row = this.database
      .prepare(
        `SELECT
          timeline_sequence,
          project_id,
          timeline_type,
          emitted_at,
          trigger,
          snapshot_status,
          monitor_health,
          warning_count,
          changed,
          detail,
          error_json,
          event_sequence
        FROM project_timeline
        WHERE timeline_sequence = ?`,
      )
      .get(Number(result.lastInsertRowid)) as unknown as TimelineRow;

    return parseTimelineRow(row);
  }

  private buildProjectInitEventPayload(
    project: ProjectRecord,
    historyEntry: ProjectInitJobHistoryEntry,
  ): ProjectInitEventPayload {
    if (project.latestInitJob === null) {
      throw new Error(`Expected project ${project.projectId} to have a latest init job.`);
    }

    return {
      projectId: project.projectId,
      canonicalPath: project.canonicalPath,
      snapshotStatus: project.snapshot.status,
      job: project.latestInitJob,
      historyEntry,
      continuity: project.continuity,
    };
  }

  private insertEvent<TPayload extends ProjectEventPayload>(
    eventType: ProjectEventType,
    projectId: string | null,
    emittedAt: string,
    payload: TPayload,
  ): ProjectEventEnvelope<TPayload> {
    const result = this.database
      .prepare(
        `INSERT INTO project_events (
          event_type,
          project_id,
          emitted_at,
          payload_json
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(eventType, projectId, emittedAt, JSON.stringify(payload));

    this.pruneProjectEvents();
    const sequence = Number(result.lastInsertRowid);

    return {
      id: `evt_${sequence}`,
      sequence,
      type: eventType,
      emittedAt,
      projectId,
      payload,
    };
  }

  private getEventReplayWindow(): EventReplayWindow {
    const row = this.database
      .prepare(
        `SELECT
          MIN(sequence) AS earliest_sequence,
          MAX(sequence) AS latest_sequence,
          COUNT(*) AS retained_events
        FROM project_events`,
      )
      .get() as { earliest_sequence: number | null; latest_sequence: number | null; retained_events: number };

    return {
      earliestRetainedEventId: row.earliest_sequence === null ? null : `evt_${row.earliest_sequence}`,
      latestRetainedEventId: row.latest_sequence === null ? null : `evt_${row.latest_sequence}`,
      retainedEvents: row.retained_events,
    };
  }

  private pruneProjectEvents() {
    this.database
      .prepare(
        `DELETE FROM project_events
         WHERE sequence IN (
           SELECT sequence
           FROM project_events
           WHERE sequence NOT IN (
             SELECT last_event_sequence FROM projects WHERE last_event_sequence IS NOT NULL
           )
             AND sequence NOT IN (
               SELECT event_sequence FROM project_timeline WHERE event_sequence IS NOT NULL
             )
             AND sequence NOT IN (
               SELECT last_event_sequence FROM init_jobs WHERE last_event_sequence IS NOT NULL
             )
           ORDER BY sequence DESC
           LIMIT -1 OFFSET ?
         )`,
      )
      .run(MAX_RETAINED_RAW_EVENTS);
  }

  private requireProject(projectId: string): ProjectRecord {
    const project = this.getProjectById(projectId);

    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }

    return project;
  }

  private begin() {
    this.database.exec('BEGIN IMMEDIATE');
  }

  private commit() {
    this.database.exec('COMMIT');
  }

  private rollback() {
    try {
      this.database.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors when no transaction is active.
    }
  }
}
