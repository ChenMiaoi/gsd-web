import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';

import {
  PROJECT_CONTINUITY_STATES,
  PROJECT_INIT_JOB_STAGES,
  PROJECT_INIT_REFRESH_RESULT_STATUSES,
  PROJECT_MONITOR_HEALTHS,
  PROJECT_RECONCILE_TRIGGERS,
  PROJECT_SNAPSHOT_STATUSES,
  PROJECT_TIMELINE_ENTRY_TYPES,
  SNAPSHOT_SOURCE_NAMES,
  SNAPSHOT_SOURCE_STATES,
  isProjectInitJobTerminalStage,
  type DirectorySummary,
  type FilesystemDirectoryEntry,
  type FilesystemDirectoryResponse,
  type GsdDbMilestoneSummary,
  type GsdDbSummaryValue,
  type GsdDbSliceDependencySummary,
  type GsdDbSliceSummary,
  type GsdDbTaskSummary,
  type GsdMetricsSummaryValue,
  type ProjectContinuityState,
  type ProjectContinuitySummary,
  type ProjectDataLocation,
  type ProjectDetailResponse,
  type ProjectInitEventPayload,
  type ProjectInitJob,
  type ProjectInitJobHistoryEntry,
  type ProjectInitJobStage,
  type ProjectInitRefreshResult,
  type ProjectInitRefreshResultStatus,
  type ProjectMonitorError,
  type ProjectMonitorEventPayload,
  type ProjectMonitorHealth,
  type ProjectMonitorSummary,
  type ProjectMutationResponse,
  type ProjectRecord,
  type ProjectRelinkEventPayload,
  type ProjectSnapshot,
  type ProjectSnapshotEventPayload,
  type ProjectSnapshotStatus,
  type ProjectReconcileTrigger,
  type ProjectsResponse,
  type ProjectTimelineEntry,
  type ProjectTimelineEntryType,
  type ProjectTimelineResponse,
  type SnapshotSourceName,
  type SnapshotSourceState,
  type SnapshotWarning,
} from '../shared/contracts.js';
import {
  LOCALE_STORAGE_KEY,
  UI_COPY,
  getInitialLocale,
  type Locale,
  type StreamStatus as UiStreamStatus,
  type UiCopy,
} from './i18n.js';

type StreamStatus = UiStreamStatus;
type StreamResyncStatus = 'idle' | 'syncing' | 'failed';
type KnownEventType =
  | 'service.ready'
  | 'project.registered'
  | 'project.refreshed'
  | 'project.relinked'
  | 'project.monitor.updated'
  | 'project.init.updated';

type StreamSummary = {
  id: string;
  type: KnownEventType;
  emittedAt: string;
  projectId: string | null;
};

type ProjectInitEnvelope = {
  id: string;
  emittedAt: string;
  projectId: string;
  payload: ProjectInitEventPayload;
};

type WorkflowTab = 'progress' | 'dependencies' | 'metrics' | 'timeline' | 'agent' | 'changes' | 'export';
type RiskLevel = 'critical' | 'high' | 'medium-high' | 'medium' | 'low' | 'unknown';

type ExecutionUnitView = {
  key: string;
  type: string | null;
  id: string | null;
  model: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  durationMs: number | null;
  totalTokens: number;
  cost: number;
  toolCalls: number;
  apiRequests: number;
  milestoneId: string | null;
  sliceId: string | null;
  taskId: string | null;
};

type ExecutionAggregate = {
  unitCount: number;
  totalDurationMs: number;
  firstStartedAtMs: number | null;
  lastFinishedAtMs: number | null;
};

type ModelUsageSummary = ExecutionAggregate & {
  model: string;
  totalTokens: number;
  cost: number;
  toolCalls: number;
  apiRequests: number;
};

type WorkflowExecutionStats = {
  units: ExecutionUnitView[];
  projectStartedAtMs: number | null;
  elapsedMs: number | null;
  totalTasks: number;
  completedTasks: number;
  remainingTasks: number;
  averageTaskDurationMs: number | null;
  estimatedRemainingMs: number | null;
  estimatedFinishAtMs: number | null;
  milestoneStats: Map<string, ExecutionAggregate>;
  sliceStats: Map<string, ExecutionAggregate>;
  taskStats: Map<string, ExecutionAggregate>;
  taskEstimatedRemainingMs: Map<string, number | null>;
  sliceEstimatedRemainingMs: Map<string, number | null>;
  milestoneEstimatedRemainingMs: Map<string, number | null>;
  modelUsage: ModelUsageSummary[];
};

const WORKFLOW_TABS: readonly WorkflowTab[] = [
  'progress',
  'dependencies',
  'metrics',
  'timeline',
  'agent',
  'changes',
  'export',
];

const REQUEST_TIMEOUT_MS = 8_000;
const INIT_TERMINAL_FAILURE_STAGES: ReadonlySet<ProjectInitJobStage> = new Set([
  'failed',
  'timed_out',
  'cancelled',
]);
const WARNING_TEXT_LIMIT = 240;
const KNOWN_EVENT_TYPES: ReadonlySet<KnownEventType> = new Set([
  'service.ready',
  'project.registered',
  'project.refreshed',
  'project.relinked',
  'project.monitor.updated',
  'project.init.updated',
]);

class HttpError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

class ResponseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseShapeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ResponseShapeError(`${label} must be an object.`);
  }

  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ResponseShapeError(`${label} must be a string.`);
  }

  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ResponseShapeError(`${label} must be a boolean.`);
  }

  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ResponseShapeError(`${label} must be a number.`);
  }

  return value;
}

function expectNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }

  return expectString(value, label);
}

function expectOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectString(value, label);
}

function expectOptionalWorkflowTimestamp(value: unknown, label: string): string | number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
    return value;
  }

  throw new ResponseShapeError(`${label} must be a string, number, or null.`);
}

function expectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ResponseShapeError(`${label} must be a string array.`);
  }

  return value;
}

function parseSnapshotSourceState(value: unknown, label: string): SnapshotSourceState {
  const candidate = expectString(value, label);

  if (!SNAPSHOT_SOURCE_STATES.includes(candidate as SnapshotSourceState)) {
    throw new ResponseShapeError(`${label} must be one of ${SNAPSHOT_SOURCE_STATES.join(', ')}.`);
  }

  return candidate as SnapshotSourceState;
}

function parseSnapshotStatus(value: unknown, label: string): ProjectSnapshotStatus {
  const candidate = expectString(value, label);

  if (!PROJECT_SNAPSHOT_STATUSES.includes(candidate as ProjectSnapshotStatus)) {
    throw new ResponseShapeError(`${label} must be one of ${PROJECT_SNAPSHOT_STATUSES.join(', ')}.`);
  }

  return candidate as ProjectSnapshotStatus;
}

function parseProjectMonitorHealth(value: unknown, label: string): ProjectMonitorHealth {
  const candidate = expectString(value, label);

  if (!PROJECT_MONITOR_HEALTHS.includes(candidate as ProjectMonitorHealth)) {
    throw new ResponseShapeError(`${label} must be one of ${PROJECT_MONITOR_HEALTHS.join(', ')}.`);
  }

  return candidate as ProjectMonitorHealth;
}

function parseProjectContinuityState(value: unknown, label: string): ProjectContinuityState {
  const candidate = expectString(value, label);

  if (!PROJECT_CONTINUITY_STATES.includes(candidate as ProjectContinuityState)) {
    throw new ResponseShapeError(`${label} must be one of ${PROJECT_CONTINUITY_STATES.join(', ')}.`);
  }

  return candidate as ProjectContinuityState;
}

function parseProjectReconcileTrigger(value: unknown, label: string): ProjectReconcileTrigger {
  const candidate = expectString(value, label);

  if (!PROJECT_RECONCILE_TRIGGERS.includes(candidate as ProjectReconcileTrigger)) {
    throw new ResponseShapeError(`${label} must be one of ${PROJECT_RECONCILE_TRIGGERS.join(', ')}.`);
  }

  return candidate as ProjectReconcileTrigger;
}

function parseDirectorySummary(value: unknown, label: string): DirectorySummary {
  const record = expectRecord(value, label);

  return {
    isEmpty: expectBoolean(record.isEmpty, `${label}.isEmpty`),
    sampleEntries: expectStringArray(record.sampleEntries, `${label}.sampleEntries`),
    sampleTruncated: expectBoolean(record.sampleTruncated, `${label}.sampleTruncated`),
  };
}

function parseSnapshotWarning(value: unknown, label: string): SnapshotWarning {
  const record = expectRecord(value, label);

  return {
    source: expectString(record.source, `${label}.source`) as SnapshotSourceName,
    code: expectString(record.code, `${label}.code`) as SnapshotWarning['code'],
    message: expectString(record.message, `${label}.message`),
  };
}

function parseKnownEventType(value: unknown, label: string): KnownEventType {
  const candidate = expectString(value, label);

  if (!KNOWN_EVENT_TYPES.has(candidate as KnownEventType)) {
    throw new ResponseShapeError(`Unsupported event type: ${candidate}`);
  }

  return candidate as KnownEventType;
}

function parseSnapshotSource<T>(
  value: unknown,
  label: string,
  parseInner: (inner: unknown, innerLabel: string) => T,
) {
  const record = expectRecord(value, label);
  const detail = expectOptionalString(record.detail, `${label}.detail`);
  const parsedValue = record.value === undefined ? undefined : parseInner(record.value, `${label}.value`);

  return {
    state: parseSnapshotSourceState(record.state, `${label}.state`),
    ...(detail === undefined ? {} : { detail }),
    ...(parsedValue === undefined ? {} : { value: parsedValue }),
  };
}

function parseOptionalPresentObject<T extends Record<string, unknown>>(value: unknown, label: string): T {
  return expectRecord(value, label) as T;
}

function parseRepoMeta(value: unknown, label: string) {
  const record = expectRecord(value, label);

  return {
    projectName: expectNullableString(record.projectName, `${label}.projectName`),
    currentBranch: expectNullableString(record.currentBranch, `${label}.currentBranch`),
    headSha: expectNullableString(record.headSha, `${label}.headSha`),
    repoFingerprint: expectNullableString(record.repoFingerprint, `${label}.repoFingerprint`),
    dirty:
      record.dirty === null || record.dirty === undefined
        ? null
        : expectBoolean(record.dirty, `${label}.dirty`),
  };
}

function parseAutoLock(value: unknown, label: string) {
  const record = expectRecord(value, label);

  return {
    status: expectNullableString(record.status, `${label}.status`),
    pid: record.pid === null || record.pid === undefined ? null : expectNumber(record.pid, `${label}.pid`),
    startedAt: expectNullableString(record.startedAt, `${label}.startedAt`),
    updatedAt: expectNullableString(record.updatedAt, `${label}.updatedAt`),
  };
}

function parseProjectMarkdown(value: unknown, label: string) {
  const record = expectRecord(value, label);

  return {
    title: expectNullableString(record.title, `${label}.title`),
    summary: expectNullableString(record.summary, `${label}.summary`),
  };
}

function parseStateMarkdown(value: unknown, label: string) {
  const record = expectRecord(value, label);

  return {
    summary: expectString(record.summary, `${label}.summary`),
  };
}

function parseGsdDbTaskSummary(value: unknown, label: string): GsdDbTaskSummary {
  const record = expectRecord(value, label);

  return {
    id: expectString(record.id, `${label}.id`),
    title: expectNullableString(record.title, `${label}.title`),
    status: expectNullableString(record.status, `${label}.status`),
    risk: expectNullableString(record.risk, `${label}.risk`),
    startedAt: expectOptionalWorkflowTimestamp(record.startedAt, `${label}.startedAt`),
    finishedAt: expectOptionalWorkflowTimestamp(record.finishedAt, `${label}.finishedAt`),
  };
}

function parseGsdDbSliceSummary(value: unknown, label: string): GsdDbSliceSummary {
  const record = expectRecord(value, label);

  return {
    id: expectString(record.id, `${label}.id`),
    title: expectNullableString(record.title, `${label}.title`),
    status: expectNullableString(record.status, `${label}.status`),
    risk: expectNullableString(record.risk, `${label}.risk`),
    startedAt: expectOptionalWorkflowTimestamp(record.startedAt, `${label}.startedAt`),
    finishedAt: expectOptionalWorkflowTimestamp(record.finishedAt, `${label}.finishedAt`),
    taskCount: expectNumber(record.taskCount, `${label}.taskCount`),
    completedTaskCount: expectNumber(record.completedTaskCount, `${label}.completedTaskCount`),
    tasks: Array.isArray(record.tasks)
      ? record.tasks.map((task, index) => parseGsdDbTaskSummary(task, `${label}.tasks[${index}]`))
      : (() => {
          throw new ResponseShapeError(`${label}.tasks must be an array.`);
        })(),
  };
}

function parseGsdDbMilestoneSummary(value: unknown, label: string): GsdDbMilestoneSummary {
  const record = expectRecord(value, label);

  return {
    id: expectString(record.id, `${label}.id`),
    title: expectNullableString(record.title, `${label}.title`),
    status: expectNullableString(record.status, `${label}.status`),
    startedAt: expectOptionalWorkflowTimestamp(record.startedAt, `${label}.startedAt`),
    finishedAt: expectOptionalWorkflowTimestamp(record.finishedAt, `${label}.finishedAt`),
    sliceCount: expectNumber(record.sliceCount, `${label}.sliceCount`),
    taskCount: expectNumber(record.taskCount, `${label}.taskCount`),
    completedTaskCount: expectNumber(record.completedTaskCount, `${label}.completedTaskCount`),
    slices: Array.isArray(record.slices)
      ? record.slices.map((slice, index) => parseGsdDbSliceSummary(slice, `${label}.slices[${index}]`))
      : (() => {
          throw new ResponseShapeError(`${label}.slices must be an array.`);
        })(),
  };
}

function parseGsdDbSliceDependencySummary(value: unknown, label: string): GsdDbSliceDependencySummary {
  const record = expectRecord(value, label);

  return {
    milestoneId: expectString(record.milestoneId, `${label}.milestoneId`),
    sliceId: expectString(record.sliceId, `${label}.sliceId`),
    dependsOnSliceId: expectString(record.dependsOnSliceId, `${label}.dependsOnSliceId`),
  };
}

function parseGsdDbSummary(value: unknown, label: string) {
  const record = expectRecord(value, label);
  const counts = expectRecord(record.counts, `${label}.counts`);

  return {
    tables: expectStringArray(record.tables, `${label}.tables`),
    counts: {
      milestones:
        counts.milestones === null || counts.milestones === undefined
          ? null
          : expectNumber(counts.milestones, `${label}.counts.milestones`),
      slices:
        counts.slices === null || counts.slices === undefined
          ? null
          : expectNumber(counts.slices, `${label}.counts.slices`),
      tasks:
        counts.tasks === null || counts.tasks === undefined
          ? null
          : expectNumber(counts.tasks, `${label}.counts.tasks`),
      sliceDependencies:
        counts.sliceDependencies === null || counts.sliceDependencies === undefined
          ? null
          : expectNumber(counts.sliceDependencies, `${label}.counts.sliceDependencies`),
      projects:
        counts.projects === null || counts.projects === undefined
          ? null
          : expectNumber(counts.projects, `${label}.counts.projects`),
    },
    milestones:
      record.milestones === undefined
        ? []
        : Array.isArray(record.milestones)
          ? record.milestones.map((milestone, index) =>
              parseGsdDbMilestoneSummary(milestone, `${label}.milestones[${index}]`),
            )
          : (() => {
              throw new ResponseShapeError(`${label}.milestones must be an array.`);
            })(),
    dependencies:
      record.dependencies === undefined
        ? []
        : Array.isArray(record.dependencies)
          ? record.dependencies.map((dependency, index) =>
              parseGsdDbSliceDependencySummary(dependency, `${label}.dependencies[${index}]`),
            )
          : (() => {
              throw new ResponseShapeError(`${label}.dependencies must be an array.`);
            })(),
  };
}

function parseGsdMetricsSummary(value: unknown, label: string): GsdMetricsSummaryValue {
  const record = expectRecord(value, label);
  const totals = expectRecord(record.totals, `${label}.totals`);
  const parseUnit = (unit: unknown, unitLabel: string) => {
    const unitRecord = expectRecord(unit, unitLabel);

    return {
      type: expectNullableString(unitRecord.type, `${unitLabel}.type`),
      id: expectNullableString(unitRecord.id, `${unitLabel}.id`),
      model: expectNullableString(unitRecord.model, `${unitLabel}.model`),
      startedAt:
        unitRecord.startedAt === null || unitRecord.startedAt === undefined
          ? null
          : expectNumber(unitRecord.startedAt, `${unitLabel}.startedAt`),
      finishedAt:
        unitRecord.finishedAt === null || unitRecord.finishedAt === undefined
          ? null
          : expectNumber(unitRecord.finishedAt, `${unitLabel}.finishedAt`),
      totalTokens: expectNumber(unitRecord.totalTokens, `${unitLabel}.totalTokens`),
      cost: expectNumber(unitRecord.cost, `${unitLabel}.cost`),
      toolCalls: expectNumber(unitRecord.toolCalls, `${unitLabel}.toolCalls`),
      apiRequests: expectNumber(unitRecord.apiRequests, `${unitLabel}.apiRequests`),
    };
  };
  const units =
    record.units === undefined
      ? []
      : Array.isArray(record.units)
        ? record.units.map((unit, index) => parseUnit(unit, `${label}.units[${index}]`))
        : (() => {
            throw new ResponseShapeError(`${label}.units must be an array.`);
          })();
  const recentUnits =
    record.recentUnits === undefined
      ? units.slice(-8).reverse()
      : Array.isArray(record.recentUnits)
        ? record.recentUnits.map((unit, index) => parseUnit(unit, `${label}.recentUnits[${index}]`))
        : (() => {
            throw new ResponseShapeError(`${label}.recentUnits must be an array.`);
          })();

  return {
    version:
      record.version === null || record.version === undefined
        ? null
        : expectNumber(record.version, `${label}.version`),
    projectStartedAt:
      record.projectStartedAt === null || record.projectStartedAt === undefined
        ? null
        : expectNumber(record.projectStartedAt, `${label}.projectStartedAt`),
    unitCount: expectNumber(record.unitCount, `${label}.unitCount`),
    totals: {
      inputTokens: expectNumber(totals.inputTokens, `${label}.totals.inputTokens`),
      outputTokens: expectNumber(totals.outputTokens, `${label}.totals.outputTokens`),
      cacheReadTokens: expectNumber(totals.cacheReadTokens, `${label}.totals.cacheReadTokens`),
      cacheWriteTokens: expectNumber(totals.cacheWriteTokens, `${label}.totals.cacheWriteTokens`),
      totalTokens: expectNumber(totals.totalTokens, `${label}.totals.totalTokens`),
      cost: expectNumber(totals.cost, `${label}.totals.cost`),
      toolCalls: expectNumber(totals.toolCalls, `${label}.totals.toolCalls`),
      assistantMessages: expectNumber(totals.assistantMessages, `${label}.totals.assistantMessages`),
      userMessages: expectNumber(totals.userMessages, `${label}.totals.userMessages`),
      apiRequests: expectNumber(totals.apiRequests, `${label}.totals.apiRequests`),
      promptCharCount: expectNumber(totals.promptCharCount, `${label}.totals.promptCharCount`),
      baselineCharCount: expectNumber(totals.baselineCharCount, `${label}.totals.baselineCharCount`),
    },
    units: units.length === 0 && record.units === undefined ? recentUnits : units,
    recentUnits,
  };
}

function parseProjectSnapshot(value: unknown, label: string): ProjectSnapshot {
  const record = expectRecord(value, label);
  const identityHints = expectRecord(record.identityHints, `${label}.identityHints`);
  const sources = expectRecord(record.sources, `${label}.sources`);

  return {
    status: parseSnapshotStatus(record.status, `${label}.status`),
    checkedAt: expectString(record.checkedAt, `${label}.checkedAt`),
    directory: parseDirectorySummary(record.directory, `${label}.directory`),
    identityHints: {
      gsdId: expectNullableString(identityHints.gsdId, `${label}.identityHints.gsdId`),
      repoFingerprint: expectNullableString(
        identityHints.repoFingerprint,
        `${label}.identityHints.repoFingerprint`,
      ),
    },
    sources: {
      directory: parseSnapshotSource(sources.directory, `${label}.sources.directory`, parseDirectorySummary),
      gsdDirectory: parseSnapshotSource(
        sources.gsdDirectory,
        `${label}.sources.gsdDirectory`,
        parseOptionalPresentObject<{ present: true }>,
      ),
      gsdId: parseSnapshotSource(sources.gsdId, `${label}.sources.gsdId`, (inner, innerLabel) => {
        const innerRecord = expectRecord(inner, innerLabel);

        return {
          gsdId: expectString(innerRecord.gsdId, `${innerLabel}.gsdId`),
        };
      }),
      projectMd: parseSnapshotSource(sources.projectMd, `${label}.sources.projectMd`, parseProjectMarkdown),
      repoMeta: parseSnapshotSource(sources.repoMeta, `${label}.sources.repoMeta`, parseRepoMeta),
      autoLock: parseSnapshotSource(sources.autoLock, `${label}.sources.autoLock`, parseAutoLock),
      stateMd: parseSnapshotSource(sources.stateMd, `${label}.sources.stateMd`, parseStateMarkdown),
      metricsJson:
        sources.metricsJson === undefined
          ? { state: 'missing' as const, detail: '.gsd/metrics.json has not been read yet.' }
          : parseSnapshotSource(sources.metricsJson, `${label}.sources.metricsJson`, parseGsdMetricsSummary),
      gsdDb: parseSnapshotSource(sources.gsdDb, `${label}.sources.gsdDb`, parseGsdDbSummary),
    },
    warnings: Array.isArray(record.warnings)
      ? record.warnings.map((warning, index) => parseSnapshotWarning(warning, `${label}.warnings[${index}]`))
      : (() => {
          throw new ResponseShapeError(`${label}.warnings must be an array.`);
        })(),
  };
}

function parseProjectInitJobStage(value: unknown, label: string): ProjectInitJobStage {
  const candidate = expectString(value, label);

  if (!PROJECT_INIT_JOB_STAGES.includes(candidate as ProjectInitJobStage)) {
    throw new ResponseShapeError(`${label} must be one of ${PROJECT_INIT_JOB_STAGES.join(', ')}.`);
  }

  return candidate as ProjectInitJobStage;
}

function parseProjectInitRefreshResultStatus(
  value: unknown,
  label: string,
): ProjectInitRefreshResultStatus {
  const candidate = expectString(value, label);

  if (!PROJECT_INIT_REFRESH_RESULT_STATUSES.includes(candidate as ProjectInitRefreshResultStatus)) {
    throw new ResponseShapeError(
      `${label} must be one of ${PROJECT_INIT_REFRESH_RESULT_STATUSES.join(', ')}.`,
    );
  }

  return candidate as ProjectInitRefreshResultStatus;
}

function parseProjectInitJobHistoryEntry(value: unknown, label: string): ProjectInitJobHistoryEntry {
  const record = expectRecord(value, label);

  return {
    id: expectString(record.id, `${label}.id`),
    sequence: expectNumber(record.sequence, `${label}.sequence`),
    stage: parseProjectInitJobStage(record.stage, `${label}.stage`),
    detail: expectString(record.detail, `${label}.detail`),
    outputExcerpt:
      record.outputExcerpt === undefined
        ? null
        : expectNullableString(record.outputExcerpt, `${label}.outputExcerpt`),
    emittedAt: expectString(record.emittedAt, `${label}.emittedAt`),
  };
}

function parseProjectInitRefreshResult(value: unknown, label: string): ProjectInitRefreshResult {
  const record = expectRecord(value, label);

  return {
    status: parseProjectInitRefreshResultStatus(record.status, `${label}.status`),
    checkedAt: expectString(record.checkedAt, `${label}.checkedAt`),
    detail: expectString(record.detail, `${label}.detail`),
    snapshotStatus:
      record.snapshotStatus === null || record.snapshotStatus === undefined
        ? null
        : parseSnapshotStatus(record.snapshotStatus, `${label}.snapshotStatus`),
    warningCount:
      record.warningCount === null || record.warningCount === undefined
        ? null
        : expectNumber(record.warningCount, `${label}.warningCount`),
    changed:
      record.changed === null || record.changed === undefined
        ? null
        : expectBoolean(record.changed, `${label}.changed`),
    eventId:
      record.eventId === null || record.eventId === undefined
        ? null
        : expectString(record.eventId, `${label}.eventId`),
  };
}

function parseProjectInitJob(value: unknown, label: string): ProjectInitJob {
  const record = expectRecord(value, label);

  return {
    jobId: expectString(record.jobId, `${label}.jobId`),
    stage: parseProjectInitJobStage(record.stage, `${label}.stage`),
    startedAt: expectString(record.startedAt, `${label}.startedAt`),
    updatedAt: expectString(record.updatedAt, `${label}.updatedAt`),
    finishedAt:
      record.finishedAt === undefined ? null : expectNullableString(record.finishedAt, `${label}.finishedAt`),
    outputExcerpt:
      record.outputExcerpt === undefined
        ? null
        : expectNullableString(record.outputExcerpt, `${label}.outputExcerpt`),
    lastErrorDetail:
      record.lastErrorDetail === undefined
        ? null
        : expectNullableString(record.lastErrorDetail, `${label}.lastErrorDetail`),
    refreshResult:
      record.refreshResult === null || record.refreshResult === undefined
        ? null
        : parseProjectInitRefreshResult(record.refreshResult, `${label}.refreshResult`),
    history: Array.isArray(record.history)
      ? record.history.map((entry, index) => parseProjectInitJobHistoryEntry(entry, `${label}.history[${index}]`))
      : (() => {
          throw new ResponseShapeError(`${label}.history must be an array.`);
        })(),
  };
}

function parseProjectMonitorError(value: unknown, label: string): ProjectMonitorError {
  const record = expectRecord(value, label);

  return {
    scope: expectString(record.scope, `${label}.scope`) as ProjectMonitorError['scope'],
    message: expectString(record.message, `${label}.message`),
    at: expectString(record.at, `${label}.at`),
  };
}

function parseProjectMonitorSummary(value: unknown, label: string): ProjectMonitorSummary {
  const record = expectRecord(value, label);

  return {
    health: parseProjectMonitorHealth(record.health, `${label}.health`),
    lastAttemptedAt:
      record.lastAttemptedAt === null || record.lastAttemptedAt === undefined
        ? null
        : expectString(record.lastAttemptedAt, `${label}.lastAttemptedAt`),
    lastSuccessfulAt:
      record.lastSuccessfulAt === null || record.lastSuccessfulAt === undefined
        ? null
        : expectString(record.lastSuccessfulAt, `${label}.lastSuccessfulAt`),
    lastTrigger:
      record.lastTrigger === null || record.lastTrigger === undefined
        ? null
        : parseProjectReconcileTrigger(record.lastTrigger, `${label}.lastTrigger`),
    lastError:
      record.lastError === null || record.lastError === undefined
        ? null
        : parseProjectMonitorError(record.lastError, `${label}.lastError`),
  };
}

function parseProjectContinuitySummary(value: unknown, label: string): ProjectContinuitySummary {
  const record = expectRecord(value, label);

  return {
    state: parseProjectContinuityState(record.state, `${label}.state`),
    checkedAt: expectString(record.checkedAt, `${label}.checkedAt`),
    pathLostAt:
      record.pathLostAt === null || record.pathLostAt === undefined
        ? null
        : expectString(record.pathLostAt, `${label}.pathLostAt`),
    lastRelinkedAt:
      record.lastRelinkedAt === null || record.lastRelinkedAt === undefined
        ? null
        : expectString(record.lastRelinkedAt, `${label}.lastRelinkedAt`),
    previousRegisteredPath:
      record.previousRegisteredPath === null || record.previousRegisteredPath === undefined
        ? null
        : expectString(record.previousRegisteredPath, `${label}.previousRegisteredPath`),
    previousCanonicalPath:
      record.previousCanonicalPath === null || record.previousCanonicalPath === undefined
        ? null
        : expectString(record.previousCanonicalPath, `${label}.previousCanonicalPath`),
  };
}

function parseProjectDataLocation(value: unknown, label: string): ProjectDataLocation {
  const record = expectRecord(value, label);
  const persistenceScope = expectString(record.persistenceScope, `${label}.persistenceScope`);

  if (persistenceScope !== 'project') {
    throw new ResponseShapeError(`${label}.persistenceScope must be project.`);
  }

  return {
    projectRoot: expectString(record.projectRoot, `${label}.projectRoot`),
    gsdRootPath: expectString(record.gsdRootPath, `${label}.gsdRootPath`),
    gsdDbPath: expectString(record.gsdDbPath, `${label}.gsdDbPath`),
    statePath: expectString(record.statePath, `${label}.statePath`),
    persistenceScope,
  };
}

function parseProjectTimelineEntryType(value: unknown, label: string): ProjectTimelineEntryType {
  const candidate = expectString(value, label);

  if (!PROJECT_TIMELINE_ENTRY_TYPES.includes(candidate as ProjectTimelineEntryType)) {
    throw new ResponseShapeError(
      `${label} must be one of ${PROJECT_TIMELINE_ENTRY_TYPES.join(', ')}.`,
    );
  }

  return candidate as ProjectTimelineEntryType;
}

function parseProjectTimelineEntry(
  value: unknown,
  label: string,
  expectedProjectId?: string,
): ProjectTimelineEntry {
  const record = expectRecord(value, label);
  const projectId = expectString(record.projectId, `${label}.projectId`);

  if (expectedProjectId && projectId !== expectedProjectId) {
    throw new ResponseShapeError(`${label}.projectId must match ${expectedProjectId}.`);
  }

  return {
    id: expectString(record.id, `${label}.id`),
    sequence: expectNumber(record.sequence, `${label}.sequence`),
    type: parseProjectTimelineEntryType(record.type, `${label}.type`),
    projectId,
    emittedAt: expectString(record.emittedAt, `${label}.emittedAt`),
    trigger: parseProjectReconcileTrigger(record.trigger, `${label}.trigger`),
    snapshotStatus: parseSnapshotStatus(record.snapshotStatus, `${label}.snapshotStatus`),
    monitorHealth: parseProjectMonitorHealth(record.monitorHealth, `${label}.monitorHealth`),
    warningCount: expectNumber(record.warningCount, `${label}.warningCount`),
    changed: expectBoolean(record.changed, `${label}.changed`),
    detail: expectString(record.detail, `${label}.detail`),
    eventId:
      record.eventId === null || record.eventId === undefined
        ? null
        : expectString(record.eventId, `${label}.eventId`),
    error:
      record.error === null || record.error === undefined
        ? null
        : parseProjectMonitorError(record.error, `${label}.error`),
  };
}

function parseProjectTimelineResponse(value: unknown, expectedProjectId?: string): ProjectTimelineResponse {
  const record = expectRecord(value, 'project timeline response');
  const items = Array.isArray(record.items)
    ? record.items.map((entry, index) =>
        parseProjectTimelineEntry(
          entry,
          `project timeline response.items[${index}]`,
          expectedProjectId,
        ),
      )
    : (() => {
        throw new ResponseShapeError('project timeline response.items must be an array.');
      })();

  return {
    items,
    total: expectNumber(record.total, 'project timeline response.total'),
  };
}

function parseProjectDetailResponse(value: unknown): ProjectDetailResponse {
  const project = parseProjectRecord(value, 'project detail');
  const record = expectRecord(value, 'project detail');
  const timeline = Array.isArray(record.timeline)
    ? record.timeline.map((entry, index) =>
        parseProjectTimelineEntry(entry, `project detail.timeline[${index}]`, project.projectId),
      )
    : (() => {
        throw new ResponseShapeError('project detail.timeline must be an array.');
      })();

  return {
    ...project,
    timeline,
  };
}

function assertUiSafeInitJob(
  job: ProjectInitJob,
  snapshotStatus: ProjectSnapshotStatus,
  label: string,
): ProjectInitJob {
  if (INIT_TERMINAL_FAILURE_STAGES.has(job.stage)) {
    if (!job.lastErrorDetail || job.lastErrorDetail.trim().length === 0) {
      throw new ResponseShapeError(`${label}.lastErrorDetail is required for ${job.stage} jobs.`);
    }
  }

  if (job.stage === 'succeeded') {
    if (job.refreshResult?.status !== 'succeeded') {
      throw new ResponseShapeError(`${label}.refreshResult must prove success before a job can succeed.`);
    }

    if (
      snapshotStatus === 'uninitialized' ||
      job.refreshResult.snapshotStatus === null ||
      job.refreshResult.snapshotStatus === 'uninitialized'
    ) {
      throw new ResponseShapeError(`${label} cannot report success before refreshed detail proves initialization.`);
    }
  }

  return job;
}

function parseProjectInitEventEnvelope(value: unknown): ProjectInitEnvelope {
  const record = expectRecord(value, 'project init event envelope');
  const type = parseKnownEventType(record.type, 'project init event envelope.type');

  if (type !== 'project.init.updated') {
    throw new ResponseShapeError(`Expected project.init.updated, received ${type}.`);
  }

  const projectId = expectString(record.projectId, 'project init event envelope.projectId');
  const payload = parseProjectInitEventPayload(record.payload, 'project init event envelope.payload');

  if (payload.projectId !== projectId) {
    throw new ResponseShapeError('project init event envelope.projectId must match payload.projectId.');
  }

  return {
    id: expectString(record.id, 'project init event envelope.id'),
    emittedAt: expectString(record.emittedAt, 'project init event envelope.emittedAt'),
    projectId,
    payload: {
      ...payload,
      job: assertUiSafeInitJob(payload.job, payload.snapshotStatus, 'project init event envelope.payload.job'),
    },
  };
}

function parseProjectRecord(value: unknown, label: string = 'project'): ProjectRecord {
  const record = expectRecord(value, label);
  const snapshot = parseProjectSnapshot(record.snapshot, `${label}.snapshot`);
  const canonicalPath = expectString(record.canonicalPath, `${label}.canonicalPath`);
  const latestInitJob =
    record.latestInitJob === null || record.latestInitJob === undefined
      ? null
      : assertUiSafeInitJob(parseProjectInitJob(record.latestInitJob, `${label}.latestInitJob`), snapshot.status, `${label}.latestInitJob`);
  const continuity =
    record.continuity === null || record.continuity === undefined
      ? undefined
      : parseProjectContinuitySummary(record.continuity, `${label}.continuity`);

  return {
    projectId: expectString(record.projectId, `${label}.projectId`),
    registeredPath: expectString(record.registeredPath, `${label}.registeredPath`),
    canonicalPath,
    createdAt: expectString(record.createdAt, `${label}.createdAt`),
    updatedAt: expectString(record.updatedAt, `${label}.updatedAt`),
    lastEventId:
      record.lastEventId === undefined ? null : expectNullableString(record.lastEventId, `${label}.lastEventId`),
    snapshot,
    monitor: parseProjectMonitorSummary(record.monitor, `${label}.monitor`),
    ...(continuity ? { continuity } : {}),
    dataLocation:
      record.dataLocation === undefined
        ? inferProjectDataLocation(canonicalPath)
        : parseProjectDataLocation(record.dataLocation, `${label}.dataLocation`),
    latestInitJob,
  };
}

function parseProjectsResponse(value: unknown): ProjectsResponse {
  const record = expectRecord(value, 'projects response');
  const items = Array.isArray(record.items)
    ? record.items.map((entry, index) => parseProjectRecord(entry, `projects response.items[${index}]`))
    : (() => {
        throw new ResponseShapeError('projects response.items must be an array.');
      })();

  return {
    items,
    total: expectNumber(record.total, 'projects response.total'),
  };
}

function parseFilesystemDirectoryEntry(value: unknown, label: string): FilesystemDirectoryEntry {
  const record = expectRecord(value, label);

  return {
    name: expectString(record.name, `${label}.name`),
    path: expectString(record.path, `${label}.path`),
    hidden: expectBoolean(record.hidden, `${label}.hidden`),
  };
}

function parseFilesystemDirectoryResponse(value: unknown): FilesystemDirectoryResponse {
  const record = expectRecord(value, 'filesystem directory response');

  if (!Array.isArray(record.entries)) {
    throw new ResponseShapeError('filesystem directory response.entries must be an array.');
  }

  return {
    path: expectString(record.path, 'filesystem directory response.path'),
    parentPath: expectNullableString(record.parentPath, 'filesystem directory response.parentPath'),
    entries: record.entries.map((entry, index) =>
      parseFilesystemDirectoryEntry(entry, `filesystem directory response.entries[${index}]`),
    ),
    truncated: expectBoolean(record.truncated, 'filesystem directory response.truncated'),
  };
}

function parseSourceStateMap(
  value: unknown,
  label: string,
): Record<SnapshotSourceName, SnapshotSourceState> {
  const record = expectRecord(value, label);

  return {
    directory: parseSnapshotSourceState(record.directory, `${label}.directory`),
    gsdDirectory: parseSnapshotSourceState(record.gsdDirectory, `${label}.gsdDirectory`),
    gsdId: parseSnapshotSourceState(record.gsdId, `${label}.gsdId`),
    projectMd: parseSnapshotSourceState(record.projectMd, `${label}.projectMd`),
    repoMeta: parseSnapshotSourceState(record.repoMeta, `${label}.repoMeta`),
    autoLock: parseSnapshotSourceState(record.autoLock, `${label}.autoLock`),
    stateMd: parseSnapshotSourceState(record.stateMd, `${label}.stateMd`),
    metricsJson:
      record.metricsJson === undefined
        ? 'missing'
        : parseSnapshotSourceState(record.metricsJson, `${label}.metricsJson`),
    gsdDb: parseSnapshotSourceState(record.gsdDb, `${label}.gsdDb`),
  };
}

function parseProjectSnapshotEventPayload(value: unknown, label: string): ProjectSnapshotEventPayload {
  const record = expectRecord(value, label);
  const continuity =
    record.continuity === null || record.continuity === undefined
      ? undefined
      : parseProjectContinuitySummary(record.continuity, `${label}.continuity`);

  return {
    projectId: expectString(record.projectId, `${label}.projectId`),
    canonicalPath: expectString(record.canonicalPath, `${label}.canonicalPath`),
    snapshotStatus: parseSnapshotStatus(record.snapshotStatus, `${label}.snapshotStatus`),
    warningCount: expectNumber(record.warningCount, `${label}.warningCount`),
    warnings: Array.isArray(record.warnings)
      ? record.warnings.map((warning, index) => parseSnapshotWarning(warning, `${label}.warnings[${index}]`))
      : (() => {
          throw new ResponseShapeError(`${label}.warnings must be an array.`);
        })(),
    sourceStates: parseSourceStateMap(record.sourceStates, `${label}.sourceStates`),
    changed: expectBoolean(record.changed, `${label}.changed`),
    checkedAt: expectString(record.checkedAt, `${label}.checkedAt`),
    trigger: parseProjectReconcileTrigger(record.trigger, `${label}.trigger`),
    monitor: parseProjectMonitorSummary(record.monitor, `${label}.monitor`),
    ...(continuity ? { continuity } : {}),
  };
}

function parseProjectMonitorEventPayload(value: unknown, label: string): ProjectMonitorEventPayload {
  const record = expectRecord(value, label);
  const continuity =
    record.continuity === null || record.continuity === undefined
      ? undefined
      : parseProjectContinuitySummary(record.continuity, `${label}.continuity`);

  return {
    projectId: expectString(record.projectId, `${label}.projectId`),
    canonicalPath: expectString(record.canonicalPath, `${label}.canonicalPath`),
    snapshotStatus: parseSnapshotStatus(record.snapshotStatus, `${label}.snapshotStatus`),
    warningCount: expectNumber(record.warningCount, `${label}.warningCount`),
    trigger: parseProjectReconcileTrigger(record.trigger, `${label}.trigger`),
    previousHealth:
      record.previousHealth === null || record.previousHealth === undefined
        ? null
        : parseProjectMonitorHealth(record.previousHealth, `${label}.previousHealth`),
    monitor: parseProjectMonitorSummary(record.monitor, `${label}.monitor`),
    ...(continuity ? { continuity } : {}),
  };
}

function parseProjectRelinkEventPayload(value: unknown, label: string): ProjectRelinkEventPayload {
  const record = expectRecord(value, label);

  return {
    projectId: expectString(record.projectId, `${label}.projectId`),
    registeredPath: expectString(record.registeredPath, `${label}.registeredPath`),
    canonicalPath: expectString(record.canonicalPath, `${label}.canonicalPath`),
    previousRegisteredPath: expectString(record.previousRegisteredPath, `${label}.previousRegisteredPath`),
    previousCanonicalPath: expectString(record.previousCanonicalPath, `${label}.previousCanonicalPath`),
    snapshotStatus: parseSnapshotStatus(record.snapshotStatus, `${label}.snapshotStatus`),
    warningCount: expectNumber(record.warningCount, `${label}.warningCount`),
    emittedAt: expectString(record.emittedAt, `${label}.emittedAt`),
    continuity: parseProjectContinuitySummary(record.continuity, `${label}.continuity`),
    monitor: parseProjectMonitorSummary(record.monitor, `${label}.monitor`),
  };
}

function parseProjectInitEventPayload(value: unknown, label: string): ProjectInitEventPayload {
  const record = expectRecord(value, label);
  const continuity =
    record.continuity === null || record.continuity === undefined
      ? undefined
      : parseProjectContinuitySummary(record.continuity, `${label}.continuity`);

  return {
    projectId: expectString(record.projectId, `${label}.projectId`),
    canonicalPath: expectString(record.canonicalPath, `${label}.canonicalPath`),
    snapshotStatus: parseSnapshotStatus(record.snapshotStatus, `${label}.snapshotStatus`),
    job: parseProjectInitJob(record.job, `${label}.job`),
    historyEntry: parseProjectInitJobHistoryEntry(record.historyEntry, `${label}.historyEntry`),
    ...(continuity ? { continuity } : {}),
  };
}

function parseEventEnvelope(value: unknown): StreamSummary {
  const record = expectRecord(value, 'project event envelope');
  const type = parseKnownEventType(record.type, 'project event envelope.type');

  return {
    id: expectString(record.id, 'project event envelope.id'),
    type,
    emittedAt: expectString(record.emittedAt, 'project event envelope.emittedAt'),
    projectId:
      record.projectId === undefined
        ? null
        : expectNullableString(record.projectId, 'project event envelope.projectId'),
  };
}

function parseProjectMutationResponse(value: unknown): ProjectMutationResponse {
  const record = expectRecord(value, 'project mutation response');
  const eventRecord = expectRecord(record.event, 'project mutation response.event');
  const eventType = parseKnownEventType(eventRecord.type, 'project mutation response.event.type');

  return {
    project: parseProjectRecord(record.project, 'project mutation response.project'),
    event: {
      id: expectString(eventRecord.id, 'project mutation response.event.id'),
      sequence: expectNumber(eventRecord.sequence, 'project mutation response.event.sequence'),
      type: eventType,
      emittedAt: expectString(eventRecord.emittedAt, 'project mutation response.event.emittedAt'),
      projectId:
        eventRecord.projectId === undefined
          ? null
          : expectNullableString(eventRecord.projectId, 'project mutation response.event.projectId'),
      payload:
        eventType === 'project.init.updated'
          ? parseProjectInitEventPayload(eventRecord.payload, 'project mutation response.event.payload')
          : eventType === 'project.monitor.updated'
            ? parseProjectMonitorEventPayload(eventRecord.payload, 'project mutation response.event.payload')
            : eventType === 'project.relinked'
              ? parseProjectRelinkEventPayload(eventRecord.payload, 'project mutation response.event.payload')
              : parseProjectSnapshotEventPayload(eventRecord.payload, 'project mutation response.event.payload'),
    },
  };
}

async function readJsonPayload(response: Response, label: string): Promise<unknown> {
  const raw = await response.text();

  if (raw.trim().length === 0) {
    throw new ResponseShapeError(`${label} returned an empty response body.`);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ResponseShapeError(`${label} returned malformed JSON.`);
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TimeoutError('The request timed out before the service responded.');
    }

    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  parse: (value: unknown) => T,
  label: string,
): Promise<T> {
  const response = await fetchWithTimeout(input, init);
  const payload = await readJsonPayload(response, label);

  if (!response.ok) {
    const errorPayload = isRecord(payload) ? payload : null;
    const message =
      errorPayload && typeof errorPayload.message === 'string'
        ? errorPayload.message
        : `${label} failed with HTTP ${response.status}.`;

    throw new HttpError(message, response.status);
  }

  return parse(payload);
}

function normalizePathForComparison(value: string) {
  return value.trim().replace(/[\\/]+$/u, '');
}

function formatRequestError(error: unknown, timeoutMessage: string, unexpectedMessage: string): string {
  if (error instanceof TimeoutError) {
    return timeoutMessage;
  }

  if (error instanceof HttpError || error instanceof ResponseShapeError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return unexpectedMessage;
}

function clampWarning(message: string) {
  if (message.length <= WARNING_TEXT_LIMIT) {
    return message;
  }

  return `${message.slice(0, WARNING_TEXT_LIMIT - 1)}…`;
}

function formatTimestamp(timestamp: string, locale: Locale) {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatCompactNumber(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCost(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value);
}

function basenameFromPath(value: string) {
  const segments = value.split(/[\\/]/u).filter(Boolean);

  return segments.at(-1) ?? value;
}

function joinProjectPath(projectRoot: string, ...segments: string[]) {
  const separator = projectRoot.includes('\\') ? '\\' : '/';
  const trimmedRoot = projectRoot.replace(/[\\/]+$/u, '');

  return [trimmedRoot, ...segments].join(separator);
}

function inferProjectDataLocation(projectRoot: string): ProjectDataLocation {
  const gsdRootPath = joinProjectPath(projectRoot, '.gsd');

  return {
    projectRoot,
    gsdRootPath,
    gsdDbPath: joinProjectPath(gsdRootPath, 'gsd.db'),
    statePath: joinProjectPath(gsdRootPath, 'STATE.md'),
    persistenceScope: 'project',
  };
}

function describeProject(project: ProjectRecord) {
  return (
    project.snapshot.sources.projectMd.value?.title ??
    project.snapshot.sources.repoMeta.value?.projectName ??
    project.snapshot.identityHints.gsdId ??
    basenameFromPath(project.canonicalPath)
  );
}

function getProjectContinuity(project: ProjectRecord): ProjectContinuitySummary {
  return (
    project.continuity ?? {
      state: 'tracked',
      checkedAt: project.snapshot.checkedAt,
      pathLostAt: null,
      lastRelinkedAt: null,
      previousRegisteredPath: null,
      previousCanonicalPath: null,
    }
  );
}

function continuityTone(state: ProjectContinuityState) {
  return state === 'tracked' ? 'ok' : 'warning';
}

function describeContinuityState(project: ProjectRecord, copy: UiCopy) {
  const continuity = getProjectContinuity(project);

  if (continuity.state === 'path_lost') {
    return copy.messages.pathLostCopy(project.projectId);
  }

  if (continuity.lastRelinkedAt) {
    return copy.messages.relinkedCopy(project.projectId);
  }

  return copy.summaries.continuityTracked;
}

function sourceTone(state: SnapshotSourceState) {
  if (state === 'ok') {
    return 'ok';
  }

  if (state === 'not_applicable') {
    return 'neutral';
  }

  return 'warning';
}

function formatProjectReconcileTrigger(trigger: ProjectReconcileTrigger | null, copy: UiCopy) {
  if (!trigger) {
    return copy.messages.notRecorded;
  }

  return copy.reconcileTriggerLabels[trigger];
}

function describeMonitorState(
  monitor: ProjectMonitorSummary,
  snapshotStatus: ProjectSnapshotStatus,
  copy: UiCopy,
) {
  switch (monitor.health) {
    case 'healthy':
      return copy.summaries.monitorHealthy(
        copy.statusLabels[snapshotStatus],
        formatProjectReconcileTrigger(monitor.lastTrigger, copy),
      );
    case 'degraded':
      return copy.summaries.monitorDegraded;
    case 'read_failed':
      return copy.summaries.monitorReadFailed;
    case 'stale':
      return copy.summaries.monitorStale;
    default:
      return copy.messages.unavailable;
  }
}

function describeTimelineCount(total: number, copy: UiCopy) {
  return copy.formatCount(total, 'entry');
}

function timelineTone(type: ProjectTimelineEntryType) {
  if (type === 'monitor_recovered') {
    return 'ok';
  }

  if (type === 'path_lost' || type === 'monitor_degraded') {
    return 'warning';
  }

  return 'neutral';
}

function isWorkflowStatusComplete(status: string | null) {
  return status !== null && /^(complete|completed|done|succeeded|success)$/iu.test(status.trim());
}

function isWorkflowStatusActive(status: string | null) {
  return status !== null && /^(active|running|executing|in_progress|in-progress|current)$/iu.test(status.trim());
}

function isWorkflowStatusBlocked(status: string | null) {
  return status !== null && /^(failed|blocked|error|degraded|high)$/iu.test(status.trim());
}

function statusTone(status: string | null) {
  if (!status) {
    return 'neutral';
  }

  if (isWorkflowStatusComplete(status)) {
    return 'ok';
  }

  if (isWorkflowStatusActive(status)) {
    return 'active';
  }

  if (isWorkflowStatusBlocked(status)) {
    return 'warning';
  }

  return 'neutral';
}

function milestoneTitle(milestone: GsdDbMilestoneSummary) {
  return milestone.title ?? milestone.id;
}

function sliceTitle(slice: GsdDbSliceSummary) {
  return slice.title ?? slice.id;
}

function taskTitle(task: GsdDbTaskSummary) {
  return task.title ?? task.status ?? task.id;
}

function workflowTaskKey(milestoneId: string, sliceId: string, taskId: string) {
  return `${milestoneId}/${sliceId}/${taskId}`;
}

function workflowSliceKey(milestoneId: string, sliceId: string) {
  return `${milestoneId}/${sliceId}`;
}

const RISK_LEVELS: readonly RiskLevel[] = ['critical', 'high', 'medium-high', 'medium', 'low', 'unknown'];
const KNOWN_ACRONYMS = new Set([
  'api',
  'ci',
  'cli',
  'db',
  'gsd',
  'id',
  'json',
  'llm',
  'mcp',
  'poc',
  'sse',
  'sql',
  'tui',
  'ui',
]);

function normalizeRiskLevel(value: string | null): RiskLevel {
  if (!value) {
    return 'unknown';
  }

  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, '-');

  if (/critical|blocker|severe/.test(normalized)) {
    return 'critical';
  }

  if (/medium-high|med-high|mid-high/.test(normalized)) {
    return 'medium-high';
  }

  if (/\bhigh\b/.test(normalized)) {
    return 'high';
  }

  if (/\bmedium\b|\bmed\b/.test(normalized)) {
    return 'medium';
  }

  if (/\blow\b/.test(normalized)) {
    return 'low';
  }

  return 'unknown';
}

function extractRiskPrefix(value: string | null) {
  return value?.match(/^\s*(critical|high|medium-high|medium|low)\s*(?:[-:—]|without|if|the)\b/i)?.[1] ?? null;
}

function getSliceRiskLevel(slice: GsdDbSliceSummary) {
  return normalizeRiskLevel(slice.risk ?? extractRiskPrefix(slice.title));
}

function readableRiskLabel(level: RiskLevel, locale: Locale) {
  const labels: Record<Locale, Record<RiskLevel, string>> = {
    en: {
      critical: 'Critical',
      high: 'High',
      'medium-high': 'Medium-high',
      medium: 'Medium',
      low: 'Low',
      unknown: 'Unscored',
    },
    zh: {
      critical: '严重',
      high: '高',
      'medium-high': '中高',
      medium: '中',
      low: '低',
      unknown: '未分级',
    },
  };

  return labels[locale][level];
}

function stripRiskPrefix(value: string) {
  return value.replace(/^\s*(critical|high|medium-high|medium|low)\s*(?:[-:—]\s*)?/i, '').trim();
}

function sentenceCaseTitle(value: string) {
  const trimmed = stripRiskPrefix(value);

  if (!/[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed)) {
    return trimmed
      .toLowerCase()
      .replace(/\b[a-z][a-z0-9-]*\b/g, (word, offset) => {
        if (KNOWN_ACRONYMS.has(word)) {
          return word.toUpperCase();
        }

        return offset === 0 ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word;
      })
      .replace(/([.!?]\s+)([a-z])/g, (_match, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`);
  }

  return trimmed;
}

function groupedSlicesByRisk(slices: GsdDbSliceSummary[]) {
  return RISK_LEVELS.map((level) => ({
    level,
    slices: slices.filter((slice) => getSliceRiskLevel(slice) === level),
  })).filter((group) => group.slices.length > 0);
}

function normalizeMetricTimestamp(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value < 10_000_000_000 ? value * 1000 : value;
}

function normalizeWorkflowTimestamp(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value === 'number') {
    return normalizeMetricTimestamp(value);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const numericValue = Number(trimmed);

  if (Number.isFinite(numericValue)) {
    return normalizeMetricTimestamp(numericValue);
  }

  const parsed = Date.parse(trimmed);

  return Number.isFinite(parsed) ? parsed : null;
}

function getWorkflowEntityDurationMs(entity: {
  startedAt: string | number | null;
  finishedAt: string | number | null;
}) {
  const startedAtMs = normalizeWorkflowTimestamp(entity.startedAt);
  const finishedAtMs = normalizeWorkflowTimestamp(entity.finishedAt);

  return startedAtMs !== null && finishedAtMs !== null && finishedAtMs >= startedAtMs
    ? finishedAtMs - startedAtMs
    : null;
}

function averageNumbers(values: number[]) {
  const usableValues = values.filter((value) => Number.isFinite(value) && value > 0);

  return usableValues.length === 0
    ? null
    : usableValues.reduce((total, value) => total + value, 0) / usableValues.length;
}

function formatDuration(durationMs: number | null, locale: Locale, fallback: string) {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return fallback;
  }

  if (durationMs === 0) {
    return locale === 'zh' ? '0秒' : '0s';
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (locale === 'zh') {
    if (days > 0) {
      return `${days}天 ${hours}小时`;
    }

    if (hours > 0) {
      return `${hours}小时 ${minutes}分钟`;
    }

    if (minutes > 0) {
      return `${minutes}分钟`;
    }

    return `${seconds}秒`;
  }

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return `${seconds}s`;
}

function formatMetricTimestamp(value: number | null, locale: Locale, fallback: string) {
  if (value === null) {
    return fallback;
  }

  return formatTimestamp(new Date(value).toISOString(), locale);
}

function parseUnitIdentity(id: string | null) {
  const parts = id?.split(/[/:>\s]+/u).filter(Boolean) ?? [];
  const findId = (pattern: RegExp) => {
    const match = parts.find((part) => pattern.test(part));

    return match ? match.toUpperCase() : null;
  };

  return {
    milestoneId: findId(/^m\d+/i),
    sliceId: findId(/^s\d+/i),
    taskId: findId(/^t\d+/i),
  };
}

function toExecutionUnit(unit: GsdMetricsSummaryValue['recentUnits'][number], index: number): ExecutionUnitView {
  const startedAtMs = normalizeMetricTimestamp(unit.startedAt);
  const finishedAtMs = normalizeMetricTimestamp(unit.finishedAt);
  const durationMs =
    startedAtMs !== null && finishedAtMs !== null && finishedAtMs >= startedAtMs
      ? finishedAtMs - startedAtMs
      : null;
  const identity = parseUnitIdentity(unit.id);

  return {
    key: `${unit.id ?? 'unit'}-${index}`,
    type: unit.type,
    id: unit.id,
    model: unit.model,
    startedAtMs,
    finishedAtMs,
    durationMs,
    totalTokens: unit.totalTokens,
    cost: unit.cost,
    toolCalls: unit.toolCalls,
    apiRequests: unit.apiRequests,
    ...identity,
  };
}

function createAggregate(): ExecutionAggregate {
  return {
    unitCount: 0,
    totalDurationMs: 0,
    firstStartedAtMs: null,
    lastFinishedAtMs: null,
  };
}

function addUnitToAggregate(aggregate: ExecutionAggregate, unit: ExecutionUnitView) {
  aggregate.unitCount += 1;

  if (unit.durationMs !== null) {
    aggregate.totalDurationMs += unit.durationMs;
  }

  if (unit.startedAtMs !== null) {
    aggregate.firstStartedAtMs =
      aggregate.firstStartedAtMs === null
        ? unit.startedAtMs
        : Math.min(aggregate.firstStartedAtMs, unit.startedAtMs);
  }

  if (unit.finishedAtMs !== null) {
    aggregate.lastFinishedAtMs =
      aggregate.lastFinishedAtMs === null
        ? unit.finishedAtMs
        : Math.max(aggregate.lastFinishedAtMs, unit.finishedAtMs);
  }
}

function addUnitToAggregateMap(map: Map<string, ExecutionAggregate>, key: string | null, unit: ExecutionUnitView) {
  if (!key) {
    return;
  }

  const aggregate = map.get(key) ?? createAggregate();

  addUnitToAggregate(aggregate, unit);
  map.set(key, aggregate);
}

function buildModelUsage(units: ExecutionUnitView[], unknownLabel: string): ModelUsageSummary[] {
  const byModel = new Map<string, ModelUsageSummary>();

  for (const unit of units) {
    const model = unit.model ?? unknownLabel;
    const summary = byModel.get(model) ?? {
      ...createAggregate(),
      model,
      totalTokens: 0,
      cost: 0,
      toolCalls: 0,
      apiRequests: 0,
    };

    addUnitToAggregate(summary, unit);
    summary.totalTokens += unit.totalTokens;
    summary.cost += unit.cost;
    summary.toolCalls += unit.toolCalls;
    summary.apiRequests += unit.apiRequests;
    byModel.set(model, summary);
  }

  return Array.from(byModel.values()).sort((first, second) => second.totalTokens - first.totalTokens);
}

function averageDuration(units: ExecutionUnitView[]) {
  const durations = units
    .map((unit) => unit.durationMs)
    .filter((duration): duration is number => duration !== null && duration > 0);

  return averageNumbers(durations);
}

function getObservedSliceDurationMs(
  milestoneId: string,
  slice: GsdDbSliceSummary,
  sliceStats: Map<string, ExecutionAggregate>,
) {
  const key = workflowSliceKey(milestoneId, slice.id);

  return getAggregateDuration(sliceStats.get(key)) ?? getWorkflowEntityDurationMs(slice);
}

function getObservedTaskDurationMs(
  milestoneId: string,
  sliceId: string,
  task: GsdDbTaskSummary,
  taskStats: Map<string, ExecutionAggregate>,
) {
  const key = workflowTaskKey(milestoneId, sliceId, task.id);

  return getAggregateDuration(taskStats.get(key)) ?? getWorkflowEntityDurationMs(task);
}

function collectSliceDurationSamples(
  milestones: GsdDbMilestoneSummary[],
  sliceStats: Map<string, ExecutionAggregate>,
) {
  const completedDurations: number[] = [];
  const observedDurations: number[] = [];

  for (const milestone of milestones) {
    for (const slice of milestone.slices) {
      const duration = getObservedSliceDurationMs(milestone.id, slice, sliceStats);

      if (duration === null || duration <= 0) {
        continue;
      }

      observedDurations.push(duration);

      if (isWorkflowStatusComplete(slice.status)) {
        completedDurations.push(duration);
      }
    }
  }

  return completedDurations.length > 0 ? completedDurations : observedDurations;
}

function collectTaskDurationSamples(
  milestones: GsdDbMilestoneSummary[],
  taskStats: Map<string, ExecutionAggregate>,
) {
  const completedDurations: number[] = [];
  const observedDurations: number[] = [];
  const inferredCompletedDurations: number[] = [];
  const inferredObservedDurations: number[] = [];

  const addInferredTaskDuration = (
    target: number[],
    durationMs: number | null,
    taskCount: number,
  ) => {
    if (durationMs === null || durationMs <= 0 || taskCount <= 0) {
      return;
    }

    target.push(durationMs / taskCount);
  };

  for (const milestone of milestones) {
    for (const slice of milestone.slices) {
      for (const task of slice.tasks) {
        const duration = getObservedTaskDurationMs(milestone.id, slice.id, task, taskStats);

        if (duration === null || duration <= 0) {
          continue;
        }

        observedDurations.push(duration);

        if (isWorkflowStatusComplete(task.status)) {
          completedDurations.push(duration);
        }
      }

      const sliceDuration = getWorkflowEntityDurationMs(slice);
      const inferredSliceTaskCount =
        slice.completedTaskCount > 0 ? slice.completedTaskCount : slice.taskCount;

      addInferredTaskDuration(
        isWorkflowStatusComplete(slice.status) ? inferredCompletedDurations : inferredObservedDurations,
        sliceDuration,
        inferredSliceTaskCount,
      );
    }

    const milestoneDuration = getWorkflowEntityDurationMs(milestone);
    const inferredMilestoneTaskCount =
      milestone.completedTaskCount > 0 ? milestone.completedTaskCount : milestone.taskCount;

    addInferredTaskDuration(
      isWorkflowStatusComplete(milestone.status) ? inferredCompletedDurations : inferredObservedDurations,
      milestoneDuration,
      inferredMilestoneTaskCount,
    );
  }

  if (completedDurations.length > 0) {
    return completedDurations;
  }

  if (observedDurations.length > 0) {
    return observedDurations;
  }

  return inferredCompletedDurations.length > 0 ? inferredCompletedDurations : inferredObservedDurations;
}

function estimateTaskRemainingDuration(
  task: GsdDbTaskSummary,
  observedDurationMs: number | null,
  averageTaskDurationMs: number | null,
  nowMs: number,
) {
  if (isWorkflowStatusComplete(task.status)) {
    return 0;
  }

  if (averageTaskDurationMs === null) {
    return null;
  }

  const startedAtMs = normalizeWorkflowTimestamp(task.startedAt);
  const elapsedActiveMs =
    observedDurationMs === null
    && isWorkflowStatusActive(task.status)
    && startedAtMs !== null
    && nowMs >= startedAtMs
      ? nowMs - startedAtMs
      : null;

  return Math.max(0, averageTaskDurationMs - (observedDurationMs ?? elapsedActiveMs ?? 0));
}

function estimateSliceRemainingDuration(
  slice: GsdDbSliceSummary,
  observedDurationMs: number | null,
  averageSliceDurationMs: number | null,
  nowMs: number,
) {
  if (isWorkflowStatusComplete(slice.status)) {
    return 0;
  }

  if (averageSliceDurationMs === null) {
    return null;
  }

  const startedAtMs = normalizeWorkflowTimestamp(slice.startedAt);
  const elapsedActiveMs =
    observedDurationMs === null
    && isWorkflowStatusActive(slice.status)
    && startedAtMs !== null
    && nowMs >= startedAtMs
      ? nowMs - startedAtMs
      : null;

  return Math.max(0, averageSliceDurationMs - (observedDurationMs ?? elapsedActiveMs ?? 0));
}

function addNullableDuration(first: number | null, second: number | null) {
  if (first === null || second === null) {
    return null;
  }

  return first + second;
}

function buildWorkflowForecasts(
  milestones: GsdDbMilestoneSummary[],
  sliceStats: Map<string, ExecutionAggregate>,
  taskStats: Map<string, ExecutionAggregate>,
  averageTaskDurationMs: number | null,
  averageSliceDurationMs: number | null,
  nowMs: number,
) {
  const taskEstimatedRemainingMs = new Map<string, number | null>();
  const sliceEstimatedRemainingMs = new Map<string, number | null>();
  const milestoneEstimatedRemainingMs = new Map<string, number | null>();
  let totalEstimatedRemainingMs: number | null = 0;

  for (const milestone of milestones) {
    let milestoneRemainingMs: number | null = 0;

    for (const slice of milestone.slices) {
      let sliceRemainingMs: number | null = 0;

      if (slice.tasks.length === 0) {
        const observedDurationMs = getObservedSliceDurationMs(milestone.id, slice, sliceStats);

        sliceRemainingMs = estimateSliceRemainingDuration(slice, observedDurationMs, averageSliceDurationMs, nowMs);
      } else {
        for (const task of slice.tasks) {
          const taskKey = workflowTaskKey(milestone.id, slice.id, task.id);
          const observedDurationMs = getObservedTaskDurationMs(milestone.id, slice.id, task, taskStats);
          const taskRemainingMs = estimateTaskRemainingDuration(task, observedDurationMs, averageTaskDurationMs, nowMs);

          taskEstimatedRemainingMs.set(taskKey, taskRemainingMs);
          sliceRemainingMs = addNullableDuration(sliceRemainingMs, taskRemainingMs);
        }
      }

      sliceEstimatedRemainingMs.set(workflowSliceKey(milestone.id, slice.id), sliceRemainingMs);
      milestoneRemainingMs = addNullableDuration(milestoneRemainingMs, sliceRemainingMs);
    }

    milestoneEstimatedRemainingMs.set(milestone.id, milestoneRemainingMs);
    totalEstimatedRemainingMs = addNullableDuration(totalEstimatedRemainingMs, milestoneRemainingMs);
  }

  return {
    taskEstimatedRemainingMs,
    sliceEstimatedRemainingMs,
    milestoneEstimatedRemainingMs,
    totalEstimatedRemainingMs,
  };
}

function buildWorkflowExecutionStats(
  milestones: GsdDbMilestoneSummary[],
  metrics: GsdMetricsSummaryValue | null,
  nowMs: number,
  copy: UiCopy,
): WorkflowExecutionStats {
  const units = (metrics?.units ?? metrics?.recentUnits ?? []).map(toExecutionUnit);
  const milestoneStats = new Map<string, ExecutionAggregate>();
  const sliceStats = new Map<string, ExecutionAggregate>();
  const taskStats = new Map<string, ExecutionAggregate>();

  for (const unit of units) {
    addUnitToAggregateMap(milestoneStats, unit.milestoneId, unit);
    addUnitToAggregateMap(
      sliceStats,
      unit.milestoneId && unit.sliceId ? `${unit.milestoneId}/${unit.sliceId}` : null,
      unit,
    );
    addUnitToAggregateMap(
      taskStats,
      unit.milestoneId && unit.sliceId && unit.taskId
        ? `${unit.milestoneId}/${unit.sliceId}/${unit.taskId}`
        : null,
      unit,
    );
  }

  const totalTasks = milestones.reduce((total, milestone) => total + milestone.taskCount, 0);
  const completedTasks = getCompletedTaskCount(milestones);
  const remainingTasks = getRemainingWorkflowUnitCount(milestones);
  const taskUnits = units.filter((unit) => unit.taskId !== null);
  const averageTaskDurationMs =
    averageNumbers(collectTaskDurationSamples(milestones, taskStats))
    ?? averageDuration(taskUnits.length > 0 ? taskUnits : units);
  const averageSliceDurationMs =
    averageNumbers(collectSliceDurationSamples(milestones, sliceStats))
    ?? averageDuration(units.filter((unit) => unit.sliceId !== null));
  const forecasts = buildWorkflowForecasts(
    milestones,
    sliceStats,
    taskStats,
    averageTaskDurationMs,
    averageSliceDurationMs,
    nowMs,
  );
  const unitStarts = units
    .map((unit) => unit.startedAtMs)
    .filter((value): value is number => value !== null);
  const unitEnds = units
    .map((unit) => unit.finishedAtMs)
    .filter((value): value is number => value !== null);
  const projectStartedAtMs =
    unitStarts.length > 0
      ? Math.min(...unitStarts)
      : normalizeMetricTimestamp(metrics?.projectStartedAt ?? null);
  const lastFinishedAtMs = unitEnds.length > 0 ? Math.max(...unitEnds) : null;
  const totalExecutionDurationMs = units.reduce(
    (total, unit) => total + (unit.durationMs === null ? 0 : Math.max(0, unit.durationMs)),
    0,
  );
  const entityExecutionDurationMs = milestones.reduce((milestoneTotal, milestone) => {
    const taskDurationMs = milestone.slices.reduce(
      (sliceTotal, slice) =>
        sliceTotal
        + slice.tasks.reduce((taskTotal, task) => taskTotal + (getWorkflowEntityDurationMs(task) ?? 0), 0),
      0,
    );

    if (taskDurationMs > 0) {
      return milestoneTotal + taskDurationMs;
    }

    const sliceDurationMs = milestone.slices.reduce(
      (sliceTotal, slice) => sliceTotal + (getWorkflowEntityDurationMs(slice) ?? 0),
      0,
    );

    return milestoneTotal + (sliceDurationMs > 0 ? sliceDurationMs : getWorkflowEntityDurationMs(milestone) ?? 0);
  }, 0);
  const activeExecutionDurationMs = totalExecutionDurationMs > 0 ? totalExecutionDurationMs : entityExecutionDurationMs;
  const estimatedRemainingMs = remainingTasks === 0 ? 0 : forecasts.totalEstimatedRemainingMs;
  const estimatedFinishAtMs =
    estimatedRemainingMs === null
      ? null
      : estimatedRemainingMs === 0
        ? lastFinishedAtMs ?? nowMs
        : nowMs + estimatedRemainingMs;

  return {
    units,
    projectStartedAtMs,
    elapsedMs: activeExecutionDurationMs > 0 ? activeExecutionDurationMs : null,
    totalTasks,
    completedTasks,
    remainingTasks,
    averageTaskDurationMs,
    estimatedRemainingMs,
    estimatedFinishAtMs,
    milestoneStats,
    sliceStats,
    taskStats,
    taskEstimatedRemainingMs: forecasts.taskEstimatedRemainingMs,
    sliceEstimatedRemainingMs: forecasts.sliceEstimatedRemainingMs,
    milestoneEstimatedRemainingMs: forecasts.milestoneEstimatedRemainingMs,
    modelUsage: buildModelUsage(units, copy.messages.unknown),
  };
}

function getAggregateDuration(aggregate: ExecutionAggregate | undefined) {
  return aggregate && aggregate.totalDurationMs > 0 ? aggregate.totalDurationMs : null;
}

function getDisplayDuration(
  aggregate: ExecutionAggregate | undefined,
  entity: {
    startedAt: string | number | null;
    finishedAt: string | number | null;
  },
) {
  return getAggregateDuration(aggregate) ?? getWorkflowEntityDurationMs(entity);
}

function getTaskDisplayDuration(
  taskStats: Map<string, ExecutionAggregate>,
  milestoneId: string,
  sliceId: string,
  task: GsdDbTaskSummary,
) {
  return getDisplayDuration(taskStats.get(workflowTaskKey(milestoneId, sliceId, task.id)), task);
}

function getSliceTaskDurationTotal(
  taskStats: Map<string, ExecutionAggregate>,
  milestoneId: string,
  slice: GsdDbSliceSummary,
) {
  let total = 0;
  let durationCount = 0;

  for (const task of slice.tasks) {
    const duration = getTaskDisplayDuration(taskStats, milestoneId, slice.id, task);

    if (duration !== null && duration > 0) {
      total += duration;
      durationCount += 1;
    }
  }

  return durationCount > 0 ? total : null;
}

function getSliceDisplayDuration(
  sliceStats: Map<string, ExecutionAggregate>,
  taskStats: Map<string, ExecutionAggregate>,
  milestoneId: string,
  slice: GsdDbSliceSummary,
) {
  return getSliceTaskDurationTotal(taskStats, milestoneId, slice)
    ?? getDisplayDuration(sliceStats.get(workflowSliceKey(milestoneId, slice.id)), slice);
}

function getMilestoneDisplayDuration(
  milestoneStats: Map<string, ExecutionAggregate>,
  sliceStats: Map<string, ExecutionAggregate>,
  taskStats: Map<string, ExecutionAggregate>,
  milestone: GsdDbMilestoneSummary,
) {
  let total = 0;
  let durationCount = 0;

  for (const slice of milestone.slices) {
    const duration = getSliceDisplayDuration(sliceStats, taskStats, milestone.id, slice);

    if (duration !== null && duration > 0) {
      total += duration;
      durationCount += 1;
    }
  }

  return durationCount > 0
    ? total
    : getDisplayDuration(milestoneStats.get(milestone.id), milestone);
}

interface SliceDependencyView {
  milestoneId: string;
  fromId: string;
  fromTitle: string | null;
  toId: string;
  toTitle: string | null;
}

function getInferredSliceDependencies(milestones: GsdDbMilestoneSummary[]) {
  return milestones.flatMap((milestone) =>
    milestone.slices.slice(1).map((slice, index) => ({
      milestoneId: milestone.id,
      fromId: milestone.slices[index]!.id,
      fromTitle: sliceTitle(milestone.slices[index]!),
      toId: slice.id,
      toTitle: sliceTitle(slice),
    })),
  );
}

function getSliceDependencies(gsdDb: GsdDbSummaryValue | null): SliceDependencyView[] {
  if (!gsdDb) {
    return [];
  }

  if (gsdDb.dependencies.length === 0) {
    return getInferredSliceDependencies(gsdDb.milestones);
  }

  const slicesByMilestone = new Map<string, Map<string, GsdDbSliceSummary>>();

  for (const milestone of gsdDb.milestones) {
    slicesByMilestone.set(
      milestone.id,
      new Map(milestone.slices.map((slice) => [slice.id, slice])),
    );
  }

  return gsdDb.dependencies.map((dependency) => {
    const slices = slicesByMilestone.get(dependency.milestoneId);
    const from = slices?.get(dependency.dependsOnSliceId) ?? null;
    const to = slices?.get(dependency.sliceId) ?? null;

    return {
      milestoneId: dependency.milestoneId,
      fromId: dependency.dependsOnSliceId,
      fromTitle: from ? sliceTitle(from) : null,
      toId: dependency.sliceId,
      toTitle: to ? sliceTitle(to) : null,
    };
  });
}

function getRemainingSliceCount(milestones: GsdDbMilestoneSummary[]) {
  return milestones.reduce(
    (total, milestone) =>
      total + milestone.slices.filter((slice) => !isWorkflowStatusComplete(slice.status)).length,
    0,
  );
}

function getRemainingWorkflowUnitCount(milestones: GsdDbMilestoneSummary[]) {
  return milestones.reduce(
    (milestoneTotal, milestone) =>
      milestoneTotal
      + milestone.slices.reduce((sliceTotal, slice) => {
        if (isWorkflowStatusComplete(slice.status)) {
          return sliceTotal;
        }

        const remainingMaterializedTasks = slice.tasks.filter(
          (task) => !isWorkflowStatusComplete(task.status),
        ).length;

        return sliceTotal + (slice.tasks.length === 0 ? 1 : remainingMaterializedTasks);
      }, 0),
    0,
  );
}

function getCompletedTaskCount(milestones: GsdDbMilestoneSummary[]) {
  return milestones.reduce((total, milestone) => total + milestone.completedTaskCount, 0);
}

function getCompletedSliceCount(milestone: GsdDbMilestoneSummary) {
  return milestone.slices.filter((slice) => isWorkflowStatusComplete(slice.status)).length;
}

function getMilestoneProgress(milestone: GsdDbMilestoneSummary) {
  if (milestone.sliceCount > 0) {
    return {
      completed: getCompletedSliceCount(milestone),
      total: milestone.sliceCount,
    };
  }

  return {
    completed: milestone.completedTaskCount,
    total: milestone.taskCount,
  };
}

function isMilestoneEffectivelyComplete(milestone: GsdDbMilestoneSummary) {
  if (isWorkflowStatusComplete(milestone.status)) {
    return true;
  }

  if (milestone.sliceCount > 0) {
    return getCompletedSliceCount(milestone) >= milestone.sliceCount;
  }

  return milestone.taskCount > 0 && milestone.completedTaskCount >= milestone.taskCount;
}

function getMilestoneOrderBucket(milestone: GsdDbMilestoneSummary, activeMilestoneId: string | null) {
  if (milestone.id === activeMilestoneId) {
    return 0;
  }

  if (isMilestoneEffectivelyComplete(milestone)) {
    return 2;
  }

  return 1;
}

function orderWorkflowMilestones(
  milestones: GsdDbMilestoneSummary[],
  activeMilestoneId: string | null,
) {
  return milestones
    .map((milestone, index) => ({ milestone, index }))
    .sort((first, second) => {
      const firstBucket = getMilestoneOrderBucket(first.milestone, activeMilestoneId);
      const secondBucket = getMilestoneOrderBucket(second.milestone, activeMilestoneId);

      return firstBucket === secondBucket ? first.index - second.index : firstBucket - secondBucket;
    })
    .map((entry) => entry.milestone);
}

function findActiveMilestone(milestones: GsdDbMilestoneSummary[]) {
  return (
    milestones.find((milestone) => isWorkflowStatusActive(milestone.status))
    ?? milestones.find((milestone) => !isMilestoneEffectivelyComplete(milestone))
    ?? null
  );
}

function findActiveTask(slice: GsdDbSliceSummary | null) {
  if (!slice) {
    return null;
  }

  return (
    slice.tasks.find((task) => isWorkflowStatusActive(task.status))
    ?? slice.tasks.find((task) => !isWorkflowStatusComplete(task.status))
    ?? null
  );
}

function findActiveSlice(milestone: GsdDbMilestoneSummary | null) {
  if (!milestone) {
    return null;
  }

  return (
    milestone.slices.find((slice) => isWorkflowStatusActive(slice.status))
    ?? milestone.slices.find((slice) => !isWorkflowStatusComplete(slice.status))
    ?? null
  );
}

function upsertProject(projects: ProjectRecord[], nextProject: ProjectRecord) {
  const existingIndex = projects.findIndex((project) => project.projectId === nextProject.projectId);

  if (existingIndex === -1) {
    return [...projects, nextProject];
  }

  return projects.map((project) => (project.projectId === nextProject.projectId ? nextProject : project));
}

function mergeProjectInitJob(project: ProjectRecord, envelope: ProjectInitEnvelope): ProjectRecord {
  return {
    ...project,
    updatedAt: envelope.payload.job.updatedAt,
    lastEventId: envelope.id,
    ...(envelope.payload.continuity ? { continuity: envelope.payload.continuity } : {}),
    latestInitJob: envelope.payload.job,
  };
}

function getLatestInitHistoryEntry(job: ProjectInitJob | null) {
  return job?.history.at(-1) ?? null;
}

function hasActiveInitJob(job: ProjectInitJob | null) {
  return job !== null && !isProjectInitJobTerminalStage(job.stage);
}

function canRetryInitJob(job: ProjectInitJob | null) {
  return job !== null && INIT_TERMINAL_FAILURE_STAGES.has(job.stage);
}

function shouldShowInitAction(project: ProjectRecord | null) {
  if (!project || project.snapshot.status !== 'uninitialized') {
    return false;
  }

  return project.latestInitJob?.stage !== 'succeeded';
}

function summarizeInitJob(job: ProjectInitJob | null, copy: UiCopy) {
  if (!job) {
    return null;
  }

  return job.refreshResult?.detail ?? getLatestInitHistoryEntry(job)?.detail ?? copy.empty.init;
}

function initButtonLabel(
  project: ProjectRecord,
  options: { requestPending: boolean; syncingDetail: boolean },
  copy: UiCopy,
) {
  if (options.requestPending) {
    return copy.actions.startingInitialization;
  }

  if (options.syncingDetail) {
    return copy.actions.refreshingMonitoredDetail;
  }

  if (hasActiveInitJob(project.latestInitJob)) {
    return `${copy.labels.initialization} ${copy.initStageLabels[project.latestInitJob!.stage]}...`;
  }

  if (canRetryInitJob(project.latestInitJob)) {
    return copy.actions.retryInitialization;
  }

  return copy.actions.initializeProject;
}

function workflowTabLabel(tab: WorkflowTab, copy: UiCopy) {
  switch (tab) {
    case 'progress':
      return copy.labels.progress;
    case 'dependencies':
      return copy.labels.dependencies;
    case 'metrics':
      return copy.labels.metrics;
    case 'timeline':
      return copy.labels.recentTimeline;
    case 'agent':
      return copy.labels.agent;
    case 'changes':
      return copy.labels.changes;
    case 'export':
      return copy.labels.export;
    default:
      return tab;
  }
}

function WorkflowIcon({ tab }: { tab: WorkflowTab }) {
  switch (tab) {
    case 'progress':
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 6.5 10 3l6 3.5-6 3.5-6-3.5Z" />
          <path d="M4 10.5 10 14l6-3.5" />
          <path d="M4 14.5 10 18l6-3.5" />
        </svg>
      );
    case 'dependencies':
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M6 5h4a4 4 0 0 1 4 4v6" />
          <path d="M4 5h2" />
          <path d="M14 15h2" />
          <path d="M6 15h4" />
          <path d="M10 15V9" />
        </svg>
      );
    case 'metrics':
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 16V9" />
          <path d="M10 16V4" />
          <path d="M16 16v-6" />
          <path d="M3 16h14" />
        </svg>
      );
    case 'timeline':
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="6" />
          <path d="M10 6v4l3 2" />
        </svg>
      );
    case 'agent':
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M6 8h8v7H6z" />
          <path d="M10 8V4" />
          <path d="M7.5 11h0" />
          <path d="M12.5 11h0" />
        </svg>
      );
    case 'changes':
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 6h7" />
          <path d="M4 10h12" />
          <path d="M4 14h9" />
          <path d="m14 5 2 2-2 2" />
        </svg>
      );
    case 'export':
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 3v9" />
          <path d="m6 8 4 4 4-4" />
          <path d="M5 15h10" />
        </svg>
      );
    default:
      return null;
  }
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 6.5h5l1.5 2h6.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15V8a1.5 1.5 0 0 1 .5-1.5Z" />
      <path d="M4 6V4.8A1.3 1.3 0 0 1 5.3 3.5h3.1l1.4 1.6H15a1 1 0 0 1 1 1v2.4" />
    </svg>
  );
}

function WorkflowMilestoneRail({
  milestones,
  activeMilestoneId,
  activeSliceId,
  activeTask,
  validationIssueCount,
  copy,
}: {
  milestones: GsdDbMilestoneSummary[];
  activeMilestoneId: string | null;
  activeSliceId: string | null;
  activeTask: GsdDbTaskSummary | null;
  validationIssueCount: number;
  copy: UiCopy;
}) {
  return (
    <aside className="milestone-rail" aria-label={copy.labels.milestoneRail}>
      <div className="milestone-rail__header">
        <span className="stat-card__label">{copy.labels.milestoneRail}</span>
        <strong>{copy.formatCount(milestones.length, 'milestone')}</strong>
      </div>

      {milestones.length === 0 ? (
        <p className="milestone-rail__empty">{copy.messages.noMilestones}</p>
      ) : (
        <ol className="milestone-tree">
          {milestones.map((milestone) => {
            const milestoneActive = milestone.id === activeMilestoneId;

            return (
              <li key={milestone.id} className="milestone-tree__milestone" data-active={milestoneActive}>
                <div className="milestone-tree__row">
                  <span className="status-dot" data-status={statusTone(milestone.status)} />
                  <strong>{milestone.id}</strong>
                  <span>{milestoneTitle(milestone)}</span>
                </div>

                {milestone.slices.length > 0 ? (
                  <ol className="milestone-tree__slices">
                    {milestone.slices.map((slice) => {
                      const sliceActive = milestoneActive && slice.id === activeSliceId;

                      return (
                        <li key={`${milestone.id}-${slice.id}`} data-active={sliceActive}>
                          <div className="milestone-tree__row milestone-tree__row--slice">
                            <span className="status-dot" data-status={statusTone(slice.status)} />
                            <strong>{slice.id}</strong>
                            <span>{sliceTitle(slice)}</span>
                          </div>

                          {milestoneActive && slice.tasks.length > 0 ? (
                            <ol className="milestone-tree__tasks">
                              {slice.tasks.map((task) => (
                                <li
                                  key={`${slice.id}-${task.id}`}
                                  data-current={sliceActive && task === activeTask}
                                >
                                  <span
                                    className="status-dot"
                                    data-status={sliceActive && task === activeTask ? 'active' : statusTone(task.status)}
                                  />
                                  <strong>{task.id}</strong>
                                  <span>{taskTitle(task)}</span>
                                </li>
                              ))}
                            </ol>
                          ) : null}
                        </li>
                      );
                    })}
                  </ol>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      <div className="validation-dock">
        <strong>{copy.formatCount(validationIssueCount, 'warning')}</strong>
        <span>{validationIssueCount === 0 ? copy.messages.validationClear : copy.labels.validationIssues}</span>
      </div>
    </aside>
  );
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale());
  const copy = UI_COPY[locale];
  const [activeWorkflowTab, setActiveWorkflowTab] = useState<WorkflowTab>('progress');
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectRecord | null>(null);
  const [projectTimeline, setProjectTimeline] = useState<ProjectTimelineResponse>({
    items: [],
    total: 0,
  });
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [registerPath, setRegisterPath] = useState('');
  const [registerPending, setRegisterPending] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerSuccess, setRegisterSuccess] = useState<string | null>(null);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [directoryPicker, setDirectoryPicker] = useState<FilesystemDirectoryResponse | null>(null);
  const [directoryPickerLoading, setDirectoryPickerLoading] = useState(false);
  const [directoryPickerError, setDirectoryPickerError] = useState<string | null>(null);
  const [relinkPath, setRelinkPath] = useState('');
  const [relinkPending, setRelinkPending] = useState(false);
  const [relinkError, setRelinkError] = useState<string | null>(null);
  const [relinkSuccess, setRelinkSuccess] = useState<string | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [initPendingProjectId, setInitPendingProjectId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [initDetailSyncProjectId, setInitDetailSyncProjectId] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');
  const [streamSummary, setStreamSummary] = useState<StreamSummary | null>(null);
  const [streamResyncStatus, setStreamResyncStatus] = useState<StreamResyncStatus>('idle');
  const [streamResyncMessage, setStreamResyncMessage] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const selectedProjectIdRef = useRef<string | null>(null);
  const selectedProjectRef = useRef<ProjectRecord | null>(null);
  const initDetailSyncProjectIdRef = useRef<string | null>(null);
  const inventoryRequestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  const timelineRequestIdRef = useRef(0);
  const shouldResyncOnOpenRef = useRef(false);

  const handleWorkflowTabSelect = useCallback((tab: WorkflowTab) => {
    setActiveWorkflowTab(tab);
  }, []);

  const handleWorkflowTabsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const currentIndex = WORKFLOW_TABS.indexOf(activeWorkflowTab);
      let nextTab: WorkflowTab | null = null;

      if (event.key === 'ArrowRight') {
        nextTab = WORKFLOW_TABS[(currentIndex + 1) % WORKFLOW_TABS.length] ?? null;
      } else if (event.key === 'ArrowLeft') {
        nextTab = WORKFLOW_TABS[(currentIndex - 1 + WORKFLOW_TABS.length) % WORKFLOW_TABS.length] ?? null;
      } else if (event.key === 'Home') {
        nextTab = WORKFLOW_TABS[0] ?? null;
      } else if (event.key === 'End') {
        nextTab = WORKFLOW_TABS[WORKFLOW_TABS.length - 1] ?? null;
      }

      if (nextTab) {
        event.preventDefault();
        handleWorkflowTabSelect(nextTab);
        window.requestAnimationFrame(() => {
          document.getElementById(`workflow-tab-${nextTab}`)?.focus();
        });
      }
    },
    [activeWorkflowTab, handleWorkflowTabSelect],
  );

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    document.documentElement.lang = locale === 'zh' ? 'zh-Hans' : 'en';
  }, [locale]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    setRelinkPath('');
    setRelinkError(null);
    setRelinkSuccess(null);
  }, [selectedProjectId]);

  const loadProjectDetail = useCallback(async (projectId: string, fallbackProject?: ProjectRecord | null) => {
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;

    if (fallbackProject && mountedRef.current) {
      setSelectedProject(fallbackProject);
    }

    setDetailLoading(true);

    try {
      const project = await requestJson(
        `/api/projects/${projectId}`,
        {
          headers: {
            accept: 'application/json',
          },
        },
        parseProjectDetailResponse,
        'Project detail',
      );

      if (
        !mountedRef.current
        || selectedProjectIdRef.current !== projectId
        || detailRequestIdRef.current !== requestId
      ) {
        return true;
      }

      setSelectedProject(project);
      setProjects((current) => upsertProject(current, project));
      setProjectTimeline((current) => {
        if (current.items.length > 0) {
          return current;
        }

        return {
          items: project.timeline,
          total: project.timeline.length,
        };
      });
      setDetailError(null);
      return true;
    } catch (error) {
      if (
        !mountedRef.current
        || selectedProjectIdRef.current !== projectId
        || detailRequestIdRef.current !== requestId
      ) {
        return true;
      }

      setDetailError(
        formatRequestError(
          error,
          copy.errors.detailTimeout,
          copy.errors.unexpected,
        ),
      );
      return false;
    } finally {
      if (
        mountedRef.current
        && selectedProjectIdRef.current === projectId
        && detailRequestIdRef.current === requestId
      ) {
        setDetailLoading(false);
      }
    }
  }, [copy.errors.detailTimeout, copy.errors.unexpected]);

  const loadProjectTimeline = useCallback(async (projectId: string) => {
    const requestId = timelineRequestIdRef.current + 1;
    timelineRequestIdRef.current = requestId;

    setTimelineLoading(true);

    try {
      const timeline = await requestJson(
        `/api/projects/${projectId}/timeline`,
        {
          headers: {
            accept: 'application/json',
          },
        },
        (value) => parseProjectTimelineResponse(value, projectId),
        'Project timeline',
      );

      if (
        !mountedRef.current
        || selectedProjectIdRef.current !== projectId
        || timelineRequestIdRef.current !== requestId
      ) {
        return true;
      }

      setProjectTimeline(timeline);
      setTimelineError(null);
      return true;
    } catch (error) {
      if (
        !mountedRef.current
        || selectedProjectIdRef.current !== projectId
        || timelineRequestIdRef.current !== requestId
      ) {
        return true;
      }

      setTimelineError(
        formatRequestError(
          error,
          copy.errors.timelineTimeout,
          copy.errors.unexpected,
        ),
      );
      return false;
    } finally {
      if (
        mountedRef.current
        && selectedProjectIdRef.current === projectId
        && timelineRequestIdRef.current === requestId
      ) {
        setTimelineLoading(false);
      }
    }
  }, [copy.errors.timelineTimeout, copy.errors.unexpected]);

  const syncSelectedProjectPanels = useCallback(
    async (projectId: string, fallbackProject?: ProjectRecord | null) => {
      const [detailOk, timelineOk] = await Promise.all([
        loadProjectDetail(projectId, fallbackProject),
        loadProjectTimeline(projectId),
      ]);

      return detailOk && timelineOk;
    },
    [loadProjectDetail, loadProjectTimeline],
  );

  const syncInitDetailAfterSuccess = useCallback(
    async (projectId: string, fallbackProject: ProjectRecord) => {
      initDetailSyncProjectIdRef.current = projectId;
      setInitDetailSyncProjectId(projectId);

      try {
        await syncSelectedProjectPanels(projectId, fallbackProject);
      } finally {
        initDetailSyncProjectIdRef.current =
          initDetailSyncProjectIdRef.current === projectId ? null : initDetailSyncProjectIdRef.current;

        if (mountedRef.current) {
          setInitDetailSyncProjectId((current) => (current === projectId ? null : current));
        }
      }
    },
    [syncSelectedProjectPanels],
  );

  const syncInventory = useCallback(
    async (
      selectionHint?: string | null,
      options: {
        preserveSelectedDetail?: boolean;
      } = {},
    ) => {
      const requestId = inventoryRequestIdRef.current + 1;
      inventoryRequestIdRef.current = requestId;
      setInventoryLoading(true);

      try {
        const response = await requestJson(
          '/api/projects',
          {
            headers: {
              accept: 'application/json',
            },
          },
          parseProjectsResponse,
          'Project inventory',
        );

        if (!mountedRef.current || inventoryRequestIdRef.current !== requestId) {
          return true;
        }

        setProjects(response.items);
        setInventoryError(null);

        if (response.items.length === 0) {
          selectedProjectIdRef.current = null;
          setSelectedProjectId(null);
          setSelectedProject(null);
          setProjectTimeline({ items: [], total: 0 });
          setDetailError(null);
          setTimelineError(null);
          return true;
        }

        const preferredProjectId = selectionHint ?? selectedProjectIdRef.current;
        const nextProject =
          response.items.find((project) => project.projectId === preferredProjectId) ?? response.items[0] ?? null;

        if (!nextProject) {
          return false;
        }

        const selectionChanged = selectedProjectIdRef.current !== nextProject.projectId;
        const shouldPreserveSelectedDetail =
          options.preserveSelectedDetail === true
          && !selectionChanged
          && selectedProjectRef.current !== null
          && selectedProjectRef.current.projectId === nextProject.projectId;

        selectedProjectIdRef.current = nextProject.projectId;
        setSelectedProjectId(nextProject.projectId);

        if (shouldPreserveSelectedDetail) {
          return true;
        }

        const fallbackProject =
          selectionChanged || selectedProjectRef.current === null || selectedProjectRef.current.projectId !== nextProject.projectId
            ? nextProject
            : undefined;

        if (fallbackProject) {
          setSelectedProject(fallbackProject);
          setProjectTimeline({ items: [], total: 0 });
          setDetailError(null);
          setTimelineError(null);
        }

        return await syncSelectedProjectPanels(nextProject.projectId, fallbackProject);
      } catch (error) {
        if (!mountedRef.current || inventoryRequestIdRef.current !== requestId) {
          return true;
        }

        setInventoryError(
          formatRequestError(
            error,
            copy.errors.inventoryTimeout,
            copy.errors.unexpected,
          ),
        );
        return false;
      } finally {
        if (mountedRef.current && inventoryRequestIdRef.current === requestId) {
          setInventoryLoading(false);
        }
      }
    },
    [copy.errors.inventoryTimeout, copy.errors.unexpected, syncSelectedProjectPanels],
  );

  const resyncAfterReconnect = useCallback(async () => {
    if (!mountedRef.current) {
      return;
    }

    setStreamResyncStatus('syncing');
    setStreamResyncMessage(copy.notices.reconnecting);

    const success = await syncInventory(selectedProjectIdRef.current);

    if (!mountedRef.current) {
      return;
    }

    if (success) {
      setStreamResyncStatus('idle');
      setStreamResyncMessage(
        selectedProjectIdRef.current
          ? copy.notices.reconnectedWithSelection
          : copy.notices.reconnectedInventory,
      );
      return;
    }

    setStreamResyncStatus('failed');
    setStreamResyncMessage(copy.notices.reconnectFailed);
  }, [
    copy.notices.reconnectedInventory,
    copy.notices.reconnectedWithSelection,
    copy.notices.reconnectFailed,
    copy.notices.reconnecting,
    syncInventory,
  ]);

  useEffect(() => {
    void syncInventory();
  }, [syncInventory]);

  useEffect(() => {
    const eventSource = new EventSource('/api/events');

    const handleEnvelope = (event: MessageEvent<string>) => {
      try {
        const raw = JSON.parse(event.data) as unknown;
        const summary = parseEventEnvelope(raw);

        if (!mountedRef.current) {
          return;
        }

        setStreamStatus('connected');
        setStreamSummary(summary);

        if (summary.type === 'project.init.updated') {
          const initEnvelope = parseProjectInitEventEnvelope(raw);

          setProjects((current) =>
            current.map((project) =>
              project.projectId === initEnvelope.projectId ? mergeProjectInitJob(project, initEnvelope) : project,
            ),
          );

          const selectedProject = selectedProjectRef.current;

          if (selectedProject && selectedProject.projectId === initEnvelope.projectId) {
            const mergedProject = mergeProjectInitJob(selectedProject, initEnvelope);
            const alreadySucceeded =
              selectedProject.latestInitJob?.jobId === initEnvelope.payload.job.jobId
              && selectedProject.latestInitJob.stage === 'succeeded';

            setSelectedProject(mergedProject);
            setInitError(null);

            if (initEnvelope.payload.job.stage === 'succeeded' && !alreadySucceeded) {
              void syncInitDetailAfterSuccess(initEnvelope.projectId, mergedProject);
            }
          }

          return;
        }

        if (
          summary.type === 'project.registered'
          || summary.type === 'project.refreshed'
          || summary.type === 'project.relinked'
          || summary.type === 'project.monitor.updated'
        ) {
          const activeSelectedInitJob = selectedProjectRef.current?.latestInitJob ?? null;
          const preserveSelectedDetail =
            summary.type === 'project.refreshed'
            && summary.projectId !== null
            && selectedProjectRef.current?.projectId === summary.projectId
            && (hasActiveInitJob(activeSelectedInitJob) || initDetailSyncProjectIdRef.current === summary.projectId);

          void syncInventory(summary.projectId ?? selectedProjectIdRef.current, {
            preserveSelectedDetail,
          });
        }
      } catch {
        // Ignore unknown or malformed SSE payloads and keep the dashboard usable.
      }
    };

    eventSource.onopen = () => {
      if (!mountedRef.current) {
        return;
      }

      setStreamStatus('connected');

      if (shouldResyncOnOpenRef.current) {
        shouldResyncOnOpenRef.current = false;
        void resyncAfterReconnect();
      }
    };

    eventSource.onerror = () => {
      if (mountedRef.current) {
        shouldResyncOnOpenRef.current = true;
        setStreamStatus('disconnected');
      }
    };

    eventSource.addEventListener('service.ready', handleEnvelope as EventListener);
    eventSource.addEventListener('project.registered', handleEnvelope as EventListener);
    eventSource.addEventListener('project.refreshed', handleEnvelope as EventListener);
    eventSource.addEventListener('project.relinked', handleEnvelope as EventListener);
    eventSource.addEventListener('project.monitor.updated', handleEnvelope as EventListener);
    eventSource.addEventListener('project.init.updated', handleEnvelope as EventListener);

    return () => {
      eventSource.removeEventListener('service.ready', handleEnvelope as EventListener);
      eventSource.removeEventListener('project.registered', handleEnvelope as EventListener);
      eventSource.removeEventListener('project.refreshed', handleEnvelope as EventListener);
      eventSource.removeEventListener('project.relinked', handleEnvelope as EventListener);
      eventSource.removeEventListener('project.monitor.updated', handleEnvelope as EventListener);
      eventSource.removeEventListener('project.init.updated', handleEnvelope as EventListener);
      eventSource.close();
    };
  }, [resyncAfterReconnect, syncInitDetailAfterSuccess, syncInventory]);

  const selectProject = useCallback(
    (project: ProjectRecord) => {
      selectedProjectIdRef.current = project.projectId;
      setSelectedProjectId(project.projectId);
      setSelectedProject(project);
      setProjectTimeline({ items: [], total: 0 });
      setDetailError(null);
      setTimelineError(null);
      setRefreshError(null);
      setInitError(null);
      setRelinkError(null);
      setRelinkSuccess(null);
      setRelinkPath('');
      setRegisterSuccess(null);
      void syncSelectedProjectPanels(project.projectId, project);
    },
    [syncSelectedProjectPanels],
  );

  const loadDirectoryPicker = useCallback(
    async (pathHint?: string | null) => {
      const params = new URLSearchParams();
      const trimmedPath = pathHint?.trim() ?? '';

      if (trimmedPath.length > 0) {
        params.set('path', trimmedPath);
      }

      setDirectoryPickerLoading(true);
      setDirectoryPickerError(null);

      try {
        const directory = await requestJson(
          `/api/filesystem/directories${params.size > 0 ? `?${params.toString()}` : ''}`,
          {
            headers: {
              accept: 'application/json',
            },
          },
          parseFilesystemDirectoryResponse,
          'Filesystem directory',
        );

        if (!mountedRef.current) {
          return;
        }

        setDirectoryPicker(directory);
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }

        setDirectoryPickerError(formatRequestError(error, copy.errors.folderBrowserTimeout, copy.errors.unexpected));
      } finally {
        if (mountedRef.current) {
          setDirectoryPickerLoading(false);
        }
      }
    },
    [copy.errors.folderBrowserTimeout, copy.errors.unexpected],
  );

  const handleRegister = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const candidatePath = registerPath.trim();

      if (candidatePath.length === 0) {
        setRegisterError(copy.errors.emptyRegisterPath);
        setRegisterSuccess(null);
        return;
      }

      const duplicateProject = projects.find((project) => {
        const normalizedCandidate = normalizePathForComparison(candidatePath);

        return [project.registeredPath, project.canonicalPath].some(
          (pathValue) => normalizePathForComparison(pathValue) === normalizedCandidate,
        );
      });

      if (duplicateProject) {
        setRegisterError(copy.errors.duplicateRegisterPath);
        setRegisterSuccess(null);
        return;
      }

      setRegisterPending(true);
      setRegisterError(null);
      setRegisterSuccess(null);

      try {
        const response = await requestJson(
          '/api/projects/register',
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ path: candidatePath }),
          },
          parseProjectMutationResponse,
          'Project registration',
        );

        if (!mountedRef.current) {
          return;
        }

        setProjects((current) => upsertProject(current, response.project));
        selectedProjectIdRef.current = response.project.projectId;
        setSelectedProjectId(response.project.projectId);
        setSelectedProject(response.project);
        setProjectTimeline({ items: [], total: 0 });
        setRegisterPath('');
        setRegisterSuccess(copy.notices.registeredSuccess(describeProject(response.project)));
        setRelinkPath('');
        setRelinkError(null);
        setRelinkSuccess(null);
        setDetailError(null);
        setTimelineError(null);
        setRefreshError(null);
        setInitError(null);
        void syncSelectedProjectPanels(response.project.projectId, response.project);
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }

        setRegisterError(
          formatRequestError(
            error,
            copy.errors.registerTimeout,
            copy.errors.unexpected,
          ),
        );
      } finally {
        if (mountedRef.current) {
          setRegisterPending(false);
        }
      }
    },
    [
      copy.errors.duplicateRegisterPath,
      copy.errors.emptyRegisterPath,
      copy.errors.registerTimeout,
      copy.errors.unexpected,
      copy.notices,
      projects,
      registerPath,
      syncSelectedProjectPanels,
    ],
  );

  const handleRelinkSelected = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const selected = selectedProjectRef.current;

      if (!selected) {
        return;
      }

      const continuity = getProjectContinuity(selected);

      if (continuity.state !== 'path_lost') {
        setRelinkError(copy.errors.relinkUnavailable);
        setRelinkSuccess(null);
        return;
      }

      const candidatePath = relinkPath.trim();

      if (candidatePath.length === 0) {
        setRelinkError(copy.errors.emptyRelinkPath);
        setRelinkSuccess(null);
        return;
      }

      const duplicateProject = projects.find((project) => {
        if (project.projectId === selected.projectId) {
          return false;
        }

        const normalizedCandidate = normalizePathForComparison(candidatePath);

        return [project.registeredPath, project.canonicalPath].some(
          (pathValue) => normalizePathForComparison(pathValue) === normalizedCandidate,
        );
      });

      if (duplicateProject) {
        setRelinkError(copy.errors.duplicateRelinkPath);
        setRelinkSuccess(null);
        return;
      }

      setRelinkPending(true);
      setRelinkError(null);
      setRelinkSuccess(null);

      try {
        const response = await requestJson(
          `/api/projects/${selected.projectId}/relink`,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ path: candidatePath }),
          },
          parseProjectMutationResponse,
          'Project relink',
        );

        if (!mountedRef.current) {
          return;
        }

        setProjects((current) => upsertProject(current, response.project));
        selectedProjectIdRef.current = response.project.projectId;
        setSelectedProjectId(response.project.projectId);
        setSelectedProject(response.project);
        setRelinkPath('');
        setRelinkSuccess(copy.notices.relinkSuccess(response.project.projectId, response.project.canonicalPath));
        setDetailError(null);
        setTimelineError(null);
        setRefreshError(null);
        setInitError(null);
        void syncSelectedProjectPanels(response.project.projectId, response.project);
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }

        setRelinkError(
          formatRequestError(
            error,
            copy.errors.relinkTimeout,
            copy.errors.unexpected,
          ),
        );
      } finally {
        if (mountedRef.current) {
          setRelinkPending(false);
        }
      }
    },
    [
      copy.errors.duplicateRelinkPath,
      copy.errors.emptyRelinkPath,
      copy.errors.relinkTimeout,
      copy.errors.relinkUnavailable,
      copy.errors.unexpected,
      copy.notices,
      projects,
      relinkPath,
      syncSelectedProjectPanels,
    ],
  );

  const handleInitializeSelected = useCallback(async () => {
    const selected = selectedProjectRef.current;

    if (!selected || !shouldShowInitAction(selected)) {
      return;
    }

    setInitPendingProjectId(selected.projectId);
    setInitError(null);
    setDetailError(null);

    try {
      const response = await requestJson(
        `/api/projects/${selected.projectId}/init`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
          },
        },
        parseProjectMutationResponse,
        'Project initialization',
      );

      if (!mountedRef.current) {
        return;
      }

      setProjects((current) => upsertProject(current, response.project));

      if (selectedProjectIdRef.current === response.project.projectId) {
        setSelectedProject(response.project);
      }
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }

      setInitError(
        formatRequestError(
          error,
          copy.errors.initTimeout,
          copy.errors.unexpected,
        ),
      );
    } finally {
      if (mountedRef.current) {
        setInitPendingProjectId((current) => (current === selected.projectId ? null : current));
      }
    }
  }, [copy.errors.initTimeout, copy.errors.unexpected]);

  const handleRefreshSelected = useCallback(async () => {
    if (!selectedProjectIdRef.current) {
      return;
    }

    setRefreshPending(true);
    setRefreshError(null);

    try {
      const response = await requestJson(
        `/api/projects/${selectedProjectIdRef.current}/refresh`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
          },
        },
        parseProjectMutationResponse,
        'Project refresh',
      );

      if (!mountedRef.current) {
        return;
      }

      setProjects((current) => upsertProject(current, response.project));
      setSelectedProject(response.project);
      setDetailError(null);
      setTimelineError(null);
      setInitError(null);
      void syncSelectedProjectPanels(response.project.projectId);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }

      setRefreshError(
        formatRequestError(
          error,
          copy.errors.refreshTimeout,
          copy.errors.unexpected,
        ),
      );
    } finally {
      if (mountedRef.current) {
        setRefreshPending(false);
      }
    }
  }, [copy.errors.refreshTimeout, copy.errors.unexpected, syncSelectedProjectPanels]);

  const handleExportSelected = useCallback(() => {
    const selected = selectedProjectRef.current;

    if (!selected) {
      return;
    }

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      project: selected,
      timeline: projectTimeline,
    };
    const blob = new Blob([`${JSON.stringify(exportPayload, null, 2)}\n`], {
      type: 'application/json',
    });
    const objectUrl = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = objectUrl;
    anchor.download = `${selected.projectId}-snapshot.json`;
    anchor.click();
    window.URL.revokeObjectURL(objectUrl);
  }, [projectTimeline]);

  const totalProjectsLabel = copy.formatCount(projects.length, 'project');
  const initializedCount = projects.filter((project) => project.snapshot.status === 'initialized').length;
  const degradedCount = projects.filter((project) => project.snapshot.status === 'degraded').length;
  const uninitializedCount = projects.filter((project) => project.snapshot.status === 'uninitialized').length;
  const selectedInitJob = selectedProject?.latestInitJob ?? null;
  const selectedInitRequestPending =
    selectedProject !== null && initPendingProjectId === selectedProject.projectId;
  const selectedInitSyncingDetail =
    selectedProject !== null && initDetailSyncProjectId === selectedProject.projectId;
  const selectedInitActionVisible = shouldShowInitAction(selectedProject);
  const selectedInitActionDisabled =
    selectedProject === null
      ? true
      : selectedInitRequestPending ||
        selectedInitSyncingDetail ||
        hasActiveInitJob(selectedInitJob);
  const selectedInitSummary = summarizeInitJob(selectedInitJob, copy);
  const selectedMonitorSummary =
    selectedProject === null
      ? null
      : describeMonitorState(selectedProject.monitor, selectedProject.snapshot.status, copy);
  const selectedContinuity = selectedProject === null ? null : getProjectContinuity(selectedProject);
  const selectedContinuitySummary =
    selectedProject === null ? null : describeContinuityState(selectedProject, copy);
  const selectedTimelineCountLabel = describeTimelineCount(projectTimeline.total, copy);
  const selectedGsdDb = selectedProject?.snapshot.sources.gsdDb.value ?? null;
  const selectedMetrics = selectedProject?.snapshot.sources.metricsJson.value ?? null;
  const selectedMilestoneSource = selectedGsdDb?.milestones ?? [];
  const selectedActiveMilestone = findActiveMilestone(selectedMilestoneSource);
  const selectedMilestones = orderWorkflowMilestones(selectedMilestoneSource, selectedActiveMilestone?.id ?? null);
  const selectedSliceDependencies = getSliceDependencies(selectedGsdDb);
  const selectedRemainingSlices = getRemainingSliceCount(selectedMilestones);
  const selectedCompletedSlices = selectedMilestones.reduce(
    (total, milestone) => total + getCompletedSliceCount(milestone),
    0,
  );
  const selectedActiveSlice = findActiveSlice(selectedActiveMilestone);
  const selectedActiveTask = findActiveTask(selectedActiveSlice);
  const selectedExecutionPath =
    selectedActiveMilestone && selectedActiveSlice && selectedActiveTask
      ? `${selectedActiveMilestone.id}/${selectedActiveSlice.id}/${selectedActiveTask.id}`
      : selectedActiveMilestone && selectedActiveSlice
        ? `${selectedActiveMilestone.id}/${selectedActiveSlice.id}`
        : selectedActiveMilestone
          ? selectedActiveMilestone.id
      : selectedProject?.projectId ?? copy.messages.notRecorded;
  const selectedWorkflowPhase =
    selectedInitJob && hasActiveInitJob(selectedInitJob)
      ? copy.initStageLabels[selectedInitJob.stage]
      : selectedProject
        ? copy.statusLabels[selectedProject.snapshot.status]
        : copy.messages.notRecorded;
  const selectedExecutionStats = buildWorkflowExecutionStats(selectedMilestones, selectedMetrics, Date.now(), copy);
  const selectedRecentExecutionUnits = (selectedMetrics?.recentUnits ?? []).map(toExecutionUnit);
  const primaryModel = selectedExecutionStats.modelUsage[0]?.model ?? copy.messages.notRecorded;
  const averageUnitDurationMs = averageDuration(selectedExecutionStats.units);

  return (
    <main className="app-shell" data-locale={locale}>
      <section className="workspace-layout">
        <aside className="project-sidebar panel" aria-labelledby="inventory-heading">
          <div className="sidebar-header">
            <div className="sidebar-title">
              <p className="eyebrow">{copy.app.eyebrow}</p>
              <h1>{copy.app.title}</h1>
              <p className="lede">{copy.app.lede}</p>
            </div>
            <div className="locale-switch" role="group" aria-label={copy.languageToggleLabel}>
              {(['en', 'zh'] as Locale[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className="locale-switch__option"
                  aria-pressed={locale === option}
                  onClick={() => {
                    setLocale(option);
                  }}
                >
                  {copy.localeOptions[option]}
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-stats">
            <div className="stat-card" data-testid="inventory-count">
              <span className="stat-card__label">{copy.stats.registered}</span>
              <strong>{totalProjectsLabel}</strong>
            </div>
            <div className="stat-card stat-card--compact">
              <span className="stat-card__label">{copy.stats.initialized}</span>
              <strong>{initializedCount}</strong>
            </div>
            <div className="stat-card stat-card--compact">
              <span className="stat-card__label">{copy.stats.degraded}</span>
              <strong>{degradedCount}</strong>
            </div>
            <div className="stat-card stat-card--compact">
              <span className="stat-card__label">{copy.stats.uninitialized}</span>
              <strong>{uninitializedCount}</strong>
            </div>
          </div>

          <form className="register-panel" onSubmit={handleRegister}>
            <div>
              <h2>{copy.actions.registerProject}</h2>
              <p>{copy.help.registerPanel}</p>
            </div>

            <div className="field register-panel__field">
              <label htmlFor="project-path">{copy.labels.projectPath}</label>
              <div className="path-input-row">
                <input
                  id="project-path"
                  name="project-path"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={copy.placeholders.projectPath}
                  value={registerPath}
                  onChange={(nextEvent) => {
                    setRegisterPath(nextEvent.target.value);
                    setRegisterError(null);
                    setRegisterSuccess(null);
                  }}
                />
                <button
                  type="button"
                  className="secondary-button secondary-button--icon"
                  onClick={() => {
                    setDirectoryPickerOpen(true);
                    void loadDirectoryPicker(registerPath);
                  }}
                  disabled={directoryPickerLoading}
                >
                  <FolderIcon />
                  <span>{copy.actions.browseFolders}</span>
                </button>
              </div>
            </div>

            <div className="register-panel__actions">
              <button type="submit" className="primary-button" disabled={registerPending}>
                {registerPending ? copy.actions.registering : copy.actions.registerProject}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setRegisterPath('');
                  setRegisterError(null);
                  setRegisterSuccess(null);
                }}
                disabled={registerPending || registerPath.length === 0}
              >
                {copy.actions.clearInput}
              </button>
            </div>

            {registerError ? (
              <p className="inline-alert inline-alert--error" role="alert" data-testid="register-error">
                {registerError}
              </p>
            ) : null}

            {registerSuccess ? (
              <p className="inline-alert inline-alert--success" data-testid="register-success">
                {registerSuccess}
              </p>
            ) : null}
          </form>

          <section className="inventory-panel">
            <div className="panel-header inventory-panel__header">
            <div>
              <h2 id="inventory-heading">{copy.labels.registeredInventory}</h2>
              <p>{copy.help.inventoryProjection}</p>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void syncInventory(selectedProjectIdRef.current);
              }}
              disabled={inventoryLoading}
            >
              {inventoryLoading ? copy.actions.refreshing : copy.actions.refreshInventory}
            </button>
            </div>

          {inventoryError ? (
            <div className="inline-alert inline-alert--error" role="alert" data-testid="inventory-error">
              <p>{inventoryError}</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void syncInventory(selectedProjectIdRef.current);
                }}
              >
                {copy.actions.retryInventory}
              </button>
            </div>
          ) : null}

          {projects.length === 0 ? (
            <div className="empty-state" data-testid="inventory-empty">
              <h3>{copy.empty.inventoryTitle}</h3>
              <p>{copy.empty.inventoryCopy}</p>
            </div>
          ) : (
            <ul className="project-list">
              {projects.map((project) => {
                const label = describeProject(project);
                const warningCount = project.snapshot.warnings.length;
                const initJob = project.latestInitJob;
                const initSummary = summarizeInitJob(initJob, copy);
                const continuity = getProjectContinuity(project);

                return (
                  <li key={project.projectId}>
                    <button
                      type="button"
                      className="project-card"
                      data-testid={`project-card-${project.projectId}`}
                      data-status={project.snapshot.status}
                      aria-pressed={selectedProjectId === project.projectId}
                      onClick={() => {
                        selectProject(project);
                      }}
                    >
                      <span className="project-card__eyebrow">{project.projectId}</span>
                      <strong>{label}</strong>
                      <span className="project-card__path">{project.canonicalPath}</span>
                      <div className="project-card__meta">
                        <span className="status-pill" data-status={project.snapshot.status}>
                          {copy.statusLabels[project.snapshot.status]}
                        </span>
                        <span
                          className="status-pill"
                          data-status={project.monitor.health}
                          data-testid={`project-monitor-health-${project.projectId}`}
                        >
                          {copy.monitorHealthLabels[project.monitor.health]}
                        </span>
                        <span
                          className="status-pill"
                          data-status={continuityTone(continuity.state)}
                          data-testid={`project-continuity-${project.projectId}`}
                        >
                          {copy.continuityStateLabels[continuity.state]}
                        </span>
                        <span>{copy.formatCount(warningCount, 'warning')}</span>
                      </div>
                      <p className="project-card__monitor" data-testid={`project-monitor-summary-${project.projectId}`}>
                        {describeMonitorState(project.monitor, project.snapshot.status, copy)}
                      </p>
                      {initJob ? (
                        <div className="project-card__job" data-testid={`project-init-stage-${project.projectId}`}>
                          <span className="status-pill status-pill--job" data-status={initJob.stage}>
                            {copy.initStageLabels[initJob.stage]}
                          </span>
                          <span>{initSummary}</span>
                        </div>
                      ) : null}
                      <time dateTime={project.snapshot.checkedAt}>{formatTimestamp(project.snapshot.checkedAt, locale)}</time>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          </section>

          <div className="stream-strip">
            <div data-testid="stream-status" data-stream-status={streamStatus}>
              <span className="stat-card__label">{copy.stats.liveStream}</span>
              <strong>{copy.streamStatusLabels[streamStatus]}</strong>
              <span>{copy.streamStatusMessages[streamStatus]}</span>
              {streamResyncMessage ? (
                <span
                  className="stream-resync-note"
                  data-testid="stream-resync-status"
                  data-resync-status={streamResyncStatus}
                >
                  {streamResyncMessage}
                </span>
              ) : null}
            </div>
            <div data-testid="stream-last-event">
              <span className="stat-card__label">{copy.stats.lastSseEvent}</span>
              {streamSummary ? (
                <>
                  <strong>{streamSummary.type}</strong>
                  <span>{streamSummary.id}</span>
                  <time dateTime={streamSummary.emittedAt}>{formatTimestamp(streamSummary.emittedAt, locale)}</time>
                </>
              ) : (
                <span>{copy.stats.waitingForEvent}</span>
              )}
            </div>
          </div>
        </aside>

        <section className="panel detail-panel" aria-labelledby="detail-heading">
          <div className="panel-header visualizer-titlebar">
            <div>
              <h2 id="detail-heading">{copy.labels.workflowVisualizer}</h2>
              <p>
                {copy.labels.workflowPhase}: <span className="inline-code">{selectedWorkflowPhase}</span>
                {' · '}
                {copy.labels.remainingSlices}: <span className="inline-code">{selectedRemainingSlices}</span>
              </p>
            </div>
            <div className="panel-header__actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  if (selectedProjectIdRef.current) {
                    void syncSelectedProjectPanels(selectedProjectIdRef.current, selectedProjectRef.current);
                  }
                }}
                disabled={!selectedProjectId || detailLoading || timelineLoading}
              >
                {detailLoading || timelineLoading ? copy.actions.reloading : copy.actions.reloadDetail}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  void handleRefreshSelected();
                }}
                disabled={!selectedProjectId || refreshPending}
              >
                {refreshPending ? copy.actions.refreshing : copy.actions.refreshSelected}
              </button>
            </div>
          </div>

          <div className="detail-panel__body">
          {detailError ? (
            <p className="inline-alert inline-alert--error" role="alert" data-testid="detail-error">
              {detailError}
            </p>
          ) : null}
          {timelineError ? (
            <div className="inline-alert inline-alert--error" role="alert" data-testid="timeline-error">
              <p>{timelineError}</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  if (selectedProjectIdRef.current) {
                    void loadProjectTimeline(selectedProjectIdRef.current);
                  }
                }}
              >
                {copy.actions.retryTimeline}
              </button>
            </div>
          ) : null}
          {refreshError ? (
            <p className="inline-alert inline-alert--error" role="alert" data-testid="refresh-error">
              {refreshError}
            </p>
          ) : null}
          {initError ? (
            <p className="inline-alert inline-alert--error" role="alert" data-testid="init-error">
              {initError}
            </p>
          ) : null}

          {selectedProject ? (
            <div className="detail-content visualizer-content">
              <div className="workflow-canvas">
              <header className="detail-header">
                <div>
                  <p className="eyebrow">{selectedProject.projectId}</p>
                  <h3>{describeProject(selectedProject)}</h3>
                  <p className="detail-header__path" data-testid="detail-canonical-path">
                    {selectedProject.canonicalPath}
                  </p>
                </div>
                <div className="detail-header__meta">
                  <span className="status-pill" data-status={selectedProject.snapshot.status} data-testid="detail-status">
                    {copy.statusLabels[selectedProject.snapshot.status]}
                  </span>
                  <span className="status-pill" data-status={selectedProject.monitor.health} data-testid="detail-monitor-health">
                    {copy.monitorHealthLabels[selectedProject.monitor.health]}
                  </span>
                  <span
                    className="status-pill"
                    data-status={continuityTone(selectedContinuity!.state)}
                    data-testid="detail-continuity-state"
                  >
                    {copy.continuityStateLabels[selectedContinuity!.state]}
                  </span>
                  <span className="meta-badge" data-testid="detail-warning-count">
                    {copy.formatCount(selectedProject.snapshot.warnings.length, 'warning')}
                  </span>
                </div>
              </header>

              <details className="project-meta-corner">
                <summary>
                  <span>{copy.labels.projectDetail}</span>
                  <span>{copy.labels.snapshotChecked}</span>
                </summary>
                <dl className="detail-facts detail-facts--compact">
                  <div>
                    <dt>{copy.labels.registeredPath}</dt>
                    <dd>{selectedProject.registeredPath}</dd>
                  </div>
                  <div>
                    <dt>{copy.labels.projectId}</dt>
                    <dd data-testid="detail-project-id-value">{selectedProject.projectId}</dd>
                  </div>
                  <div>
                    <dt>{copy.labels.lastEvent}</dt>
                    <dd>{selectedProject.lastEventId ?? copy.messages.noLastEvent}</dd>
                  </div>
                  <div>
                    <dt>{copy.labels.snapshotChecked}</dt>
                    <dd>
                      <time dateTime={selectedProject.snapshot.checkedAt} data-testid="detail-snapshot-checked-at">
                        {formatTimestamp(selectedProject.snapshot.checkedAt, locale)}
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt>{copy.labels.lastAttempted}</dt>
                    <dd data-testid="detail-monitor-last-attempted">
                      {selectedProject.monitor.lastAttemptedAt ? (
                        <time dateTime={selectedProject.monitor.lastAttemptedAt}>
                          {formatTimestamp(selectedProject.monitor.lastAttemptedAt, locale)}
                        </time>
                      ) : (
                        copy.messages.notRecorded
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{copy.labels.lastSuccessful}</dt>
                    <dd data-testid="detail-monitor-last-successful">
                      {selectedProject.monitor.lastSuccessfulAt ? (
                        <time dateTime={selectedProject.monitor.lastSuccessfulAt}>
                          {formatTimestamp(selectedProject.monitor.lastSuccessfulAt, locale)}
                        </time>
                      ) : (
                        copy.messages.notRecorded
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{copy.labels.lastTrigger}</dt>
                    <dd data-testid="detail-monitor-last-trigger">
                      {formatProjectReconcileTrigger(selectedProject.monitor.lastTrigger, copy)}
                    </dd>
                  </div>
                  <div>
                    <dt>{copy.labels.gsdId}</dt>
                    <dd data-testid="detail-gsd-id">
                      {selectedProject.snapshot.identityHints.gsdId ?? copy.messages.noGsdId}
                    </dd>
                  </div>
                  <div>
                    <dt>{copy.labels.repoFingerprint}</dt>
                    <dd>{selectedProject.snapshot.identityHints.repoFingerprint ?? copy.messages.repoFingerprintUnavailable}</dd>
                  </div>
                  <div>
                    <dt>{copy.labels.dataLocation}</dt>
                    <dd>{selectedProject.dataLocation.gsdDbPath}</dd>
                  </div>
                </dl>
              </details>

              <div className="workflow-stat-strip">
                <div>
                  <span className="stat-card__label">{copy.labels.criticalPath}</span>
                  <strong>{selectedExecutionPath}</strong>
                </div>
                <div>
                  <span className="stat-card__label">{copy.labels.completed}</span>
                  <strong>{selectedCompletedSlices}</strong>
                </div>
                <div>
                  <span className="stat-card__label">{copy.labels.gsdDbPath}</span>
                  <strong>{basenameFromPath(selectedProject.dataLocation.gsdDbPath)}</strong>
                </div>
              </div>

              <div
                className="workflow-tabs"
                aria-label="GSD workflow sections"
                role="tablist"
                onKeyDown={handleWorkflowTabsKeyDown}
              >
                {WORKFLOW_TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className="workflow-tabs__item"
                    id={`workflow-tab-${tab}`}
                    role="tab"
                    aria-selected={activeWorkflowTab === tab}
                    aria-controls={`workflow-panel-${tab}`}
                    aria-current={activeWorkflowTab === tab ? 'page' : undefined}
                    data-active={activeWorkflowTab === tab}
                    tabIndex={activeWorkflowTab === tab ? 0 : -1}
                    onClick={() => {
                      handleWorkflowTabSelect(tab);
                    }}
                  >
                    <WorkflowIcon tab={tab} />
                    <span>{workflowTabLabel(tab, copy)}</span>
                  </button>
                ))}
              </div>

              <div className="workflow-pages" data-active-tab={activeWorkflowTab}>
              <section
                className="workflow-page subpanel milestones-panel"
                id="workflow-panel-progress"
                role="tabpanel"
                aria-labelledby="workflow-tab-progress"
                data-testid="milestones-panel"
                hidden={activeWorkflowTab !== 'progress'}
              >
                <div className="subpanel__header subpanel__header--actions">
                  <div>
                    <h4>{copy.labels.gsdMilestones}</h4>
                    <p>{copy.formatCount(selectedMilestones.length, 'milestone')}</p>
                  </div>
                  {selectedGsdDb ? (
                    <div className="detail-header__meta">
                      <span className="meta-badge">{copy.formatCount(selectedGsdDb.counts.slices ?? 0, 'slice')}</span>
                      <span className="meta-badge">{copy.formatCount(selectedGsdDb.counts.tasks ?? 0, 'task')}</span>
                    </div>
                  ) : null}
                </div>

                {selectedMilestones.length === 0 ? (
                  <p>{copy.messages.noMilestones}</p>
                ) : (
                  <div className="milestone-list">
                    {selectedMilestones.map((milestone) => {
                      const milestoneProgress = getMilestoneProgress(milestone);
                      const milestoneProgressPercent =
                        milestoneProgress.total === 0
                          ? 0
                          : Math.round((milestoneProgress.completed / milestoneProgress.total) * 100);
                      const milestoneActive = milestone.id === selectedActiveMilestone?.id;

                      return (
                      <details
                        className="milestone-row"
                        data-active={milestoneActive}
                        data-status={statusTone(milestone.status)}
                        key={milestone.id}
                        open={milestoneActive || undefined}
                      >
                        <summary className="milestone-row__summary">
                          <div className="milestone-row__header">
                            <span className="meta-badge">{milestone.id}</span>
                            <strong>{milestoneTitle(milestone)}</strong>
                            {milestone.status ? (
                              <span className="status-pill" data-status={statusTone(milestone.status)}>
                                {milestone.status}
                              </span>
                            ) : null}
                          </div>
                          <div className="milestone-row__meter">
                            <span style={{ width: `${milestoneProgressPercent}%` }} />
                          </div>
                          <div className="milestone-row__meta">
                            <span>
                              {milestoneProgress.completed}/{milestoneProgress.total} {copy.labels.completed}
                            </span>
                            <span>{copy.formatCount(milestone.sliceCount, 'slice')}</span>
                            <span>
                              {milestone.completedTaskCount}/{milestone.taskCount} {copy.labels.tasks}
                            </span>
                          </div>
                        </summary>
                        {milestone.slices.length > 0 ? (
                          <div className="slice-risk-board">
                            {groupedSlicesByRisk(milestone.slices).map((group) => (
                              <section
                                className="slice-risk-group"
                                data-risk={group.level}
                                key={`${milestone.id}-${group.level}`}
                              >
                                <div className="slice-risk-group__header">
                                  <span>{readableRiskLabel(group.level, locale)}</span>
                                  <strong>{copy.formatCount(group.slices.length, 'slice')}</strong>
                                </div>
                                <div className="slice-list">
                                  {group.slices.map((slice) => {
                                    const sliceActive =
                                      milestone.id === selectedActiveMilestone?.id
                                      && slice.id === selectedActiveSlice?.id;
                                    const sliceCurrentTask = sliceActive ? selectedActiveTask : null;

                                    return (
                                      <details
                                        className="slice-card"
                                        data-status={statusTone(slice.status)}
                                        data-risk={getSliceRiskLevel(slice)}
                                        data-active={sliceActive}
                                        open={sliceActive || undefined}
                                        key={`${milestone.id}-${slice.id}`}
                                      >
                                        <summary className="slice-card__summary">
                                          <div className="slice-card__header">
                                            <span className="meta-badge">{slice.id}</span>
                                            <span className="status-pill" data-status={statusTone(slice.status)}>
                                              {slice.status ?? copy.messages.unknown}
                                            </span>
                                          </div>
                                          <strong>{sentenceCaseTitle(sliceTitle(slice))}</strong>
                                          <div className="slice-card__footer">
                                            <span>
                                              {slice.completedTaskCount}/{slice.taskCount} {copy.labels.tasks}
                                            </span>
                                            <span className="warning-code">
                                              {readableRiskLabel(getSliceRiskLevel(slice), locale)}
                                            </span>
                                          </div>
                                          {sliceCurrentTask ? (
                                            <span className="slice-card__current">
                                              {copy.labels.currentTask}: {sliceCurrentTask.id}
                                            </span>
                                          ) : null}
                                        </summary>

                                        {slice.tasks.length > 0 ? (
                                          <ol className="slice-task-list">
                                            {slice.tasks.map((task) => {
                                              const taskCurrent =
                                                sliceCurrentTask !== null && task === sliceCurrentTask;

                                              return (
                                                <li
                                                  className="slice-task-row"
                                                  data-current={taskCurrent}
                                                  data-status={statusTone(task.status)}
                                                  key={`${slice.id}-${task.id}`}
                                                >
                                                  <span
                                                    className="status-dot"
                                                    data-status={taskCurrent ? 'active' : statusTone(task.status)}
                                                  />
                                                  <strong>{task.id}</strong>
                                                  <span>{taskTitle(task)}</span>
                                                  <span
                                                    className="status-pill"
                                                    data-status={taskCurrent ? 'active' : statusTone(task.status)}
                                                  >
                                                    {taskCurrent
                                                      ? copy.labels.currentTask
                                                      : task.status ?? copy.messages.unknown}
                                                  </span>
                                                </li>
                                              );
                                            })}
                                          </ol>
                                        ) : null}
                                      </details>
                                    );
                                  })}
                                </div>
                              </section>
                            ))}
                          </div>
                        ) : null}
                      </details>
                    );
                    })}
                  </div>
                )}
              </section>

              <section
                className="workflow-page subpanel dependencies-panel"
                id="workflow-panel-dependencies"
                role="tabpanel"
                aria-labelledby="workflow-tab-dependencies"
                data-testid="dependencies-panel"
                hidden={activeWorkflowTab !== 'dependencies'}
              >
                <div className="subpanel__header">
                  <h4>{copy.labels.dependencies}</h4>
                  <p>{copy.formatCount(selectedSliceDependencies.length, 'entry')}</p>
                </div>
                {selectedSliceDependencies.length === 0 ? (
                  <p>{copy.messages.noDependencies}</p>
                ) : (
                  <div className="dependency-list dependency-map">
                    {selectedSliceDependencies.map((dependency) => (
                      <article
                        className="dependency-row"
                        key={`${dependency.milestoneId}-${dependency.fromId}-${dependency.toId}`}
                      >
                        <span className="meta-badge dependency-row__milestone">{dependency.milestoneId}</span>
                        <div className="dependency-node dependency-node--from">
                          <span>{copy.labels.source}</span>
                          <strong>{dependency.fromId}</strong>
                          <small>{dependency.fromTitle ?? copy.messages.unknown}</small>
                        </div>
                        <span className="dependency-link" aria-hidden="true">
                          <svg viewBox="0 0 72 20" focusable="false">
                            <path d="M2 10h62" />
                            <path d="m58 4 8 6-8 6" />
                          </svg>
                        </span>
                        <div className="dependency-node dependency-node--to">
                          <span>{copy.labels.tasks}</span>
                          <strong>{dependency.toId}</strong>
                          <small>{dependency.toTitle ?? copy.messages.unknown}</small>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <section
                className="workflow-page subpanel metrics-panel"
                id="workflow-panel-metrics"
                role="tabpanel"
                aria-labelledby="workflow-tab-metrics"
                data-testid="metrics-panel"
                hidden={activeWorkflowTab !== 'metrics'}
              >
                <div className="subpanel__header">
                  <h4>{copy.labels.metrics}</h4>
                  <p>{copy.labels.source}: .gsd/gsd.db + .gsd/metrics.json</p>
                </div>
                <div className="metric-grid">
                  <div>
                    <span className="stat-card__label">{copy.labels.gsdMilestones}</span>
                    <strong>{selectedGsdDb?.counts.milestones ?? 0}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.slices}</span>
                    <strong>{selectedGsdDb?.counts.slices ?? 0}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.tasks}</span>
                    <strong>{selectedGsdDb?.counts.tasks ?? 0}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.completed}</span>
                    <strong>{selectedMilestones.reduce((total, milestone) => total + milestone.completedTaskCount, 0)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.units}</span>
                    <strong>{selectedMetrics?.unitCount ?? 0}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.tokens}</span>
                    <strong>{formatCompactNumber(selectedMetrics?.totals.totalTokens ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.cost}</span>
                    <strong>{formatCost(selectedMetrics?.totals.cost ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.apiRequests}</span>
                    <strong>{formatCompactNumber(selectedMetrics?.totals.apiRequests ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.toolCalls}</span>
                    <strong>{formatCompactNumber(selectedMetrics?.totals.toolCalls ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.dependencies}</span>
                    <strong>{selectedSliceDependencies.length}</strong>
                  </div>
                </div>
              </section>

              <section
                className="workflow-page subpanel timeline-panel"
                id="workflow-panel-timeline"
                role="tabpanel"
                aria-labelledby="workflow-tab-timeline"
                data-testid="timeline-panel"
                hidden={activeWorkflowTab !== 'timeline'}
              >
                <div className="subpanel__header subpanel__header--actions">
                  <div>
                    <h4>{copy.labels.recentTimeline}</h4>
                    <p>{copy.help.timeline}</p>
                  </div>
                  <div className="panel-header__actions">
                    <span className="meta-badge" data-testid="timeline-total">
                      {copy.formatCount(selectedExecutionStats.remainingTasks, 'task')}
                    </span>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        if (selectedProjectIdRef.current) {
                          void loadProjectTimeline(selectedProjectIdRef.current);
                        }
                      }}
                      disabled={!selectedProjectId || timelineLoading}
                    >
                      {timelineLoading ? copy.actions.reloading : copy.actions.reloadTimeline}
                    </button>
                  </div>
                </div>

                <div className="execution-summary-grid">
                  <div>
                    <span className="stat-card__label">{copy.labels.elapsed}</span>
                    <strong>
                      {formatDuration(selectedExecutionStats.elapsedMs, locale, copy.messages.notRecorded)}
                    </strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.averageTaskDuration}</span>
                    <strong>
                      {formatDuration(
                        selectedExecutionStats.averageTaskDurationMs,
                        locale,
                        copy.messages.estimateUnavailable,
                      )}
                    </strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.remainingTasks}</span>
                    <strong>{selectedExecutionStats.remainingTasks}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.estimatedRemaining}</span>
                    <strong>
                      {formatDuration(
                        selectedExecutionStats.estimatedRemainingMs,
                        locale,
                        copy.messages.estimateUnavailable,
                      )}
                    </strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.estimatedFinish}</span>
                    <strong>
                      {formatMetricTimestamp(
                        selectedExecutionStats.estimatedFinishAtMs,
                        locale,
                        copy.messages.estimateUnavailable,
                      )}
                    </strong>
                  </div>
                </div>

                {selectedExecutionStats.units.length === 0 ? (
                  <p data-testid="timeline-empty">{copy.messages.noExecutionUnits}</p>
                ) : null}

                {selectedMilestones.length === 0 ? (
                  <p>{copy.messages.noMilestones}</p>
                ) : (
                  <div className="execution-tree" data-testid="timeline-list">
                    {selectedMilestones.map((milestone) => {
                      const milestoneEstimate =
                        selectedExecutionStats.milestoneEstimatedRemainingMs.get(milestone.id) ?? null;
                      const milestoneActive = milestone.id === selectedActiveMilestone?.id;

                      return (
                        <details
                          className="execution-milestone"
                          data-active={milestoneActive}
                          key={milestone.id}
                          open={milestoneActive || undefined}
                        >
                          <summary className="execution-milestone__summary">
                            <div className="execution-row execution-row--milestone">
                              <span className="meta-badge">{milestone.id}</span>
                              <strong>{milestoneTitle(milestone)}</strong>
                              <span>
                                {formatDuration(
                                  getMilestoneDisplayDuration(
                                    selectedExecutionStats.milestoneStats,
                                    selectedExecutionStats.sliceStats,
                                    selectedExecutionStats.taskStats,
                                    milestone,
                                  ),
                                  locale,
                                  copy.messages.notRecorded,
                                )}
                              </span>
                              <span>{formatDuration(milestoneEstimate, locale, copy.messages.estimateUnavailable)}</span>
                            </div>
                            <div className="execution-row__labels">
                              <span>{copy.labels.actualDuration}</span>
                              <span>{copy.labels.estimatedRemaining}</span>
                            </div>
                          </summary>
                          <div className="execution-slice-list">
                            {milestone.slices.map((slice) => {
                              const sliceKey = `${milestone.id}/${slice.id}`;
                              const sliceActive =
                                milestone.id === selectedActiveMilestone?.id && slice.id === selectedActiveSlice?.id;
                              const sliceCurrentTask = sliceActive ? selectedActiveTask : null;
                              const sliceEstimate =
                                selectedExecutionStats.sliceEstimatedRemainingMs.get(sliceKey) ?? null;

                              return (
                                <details className="execution-slice" open={sliceActive || undefined} key={sliceKey}>
                                  <summary>
                                    <span className="warning-code" data-risk={getSliceRiskLevel(slice)}>
                                      {readableRiskLabel(getSliceRiskLevel(slice), locale)}
                                    </span>
                                    <strong>{slice.id}</strong>
                                    <span>{sentenceCaseTitle(sliceTitle(slice))}</span>
                                    <span>
                                      {formatDuration(
                                        getSliceDisplayDuration(
                                          selectedExecutionStats.sliceStats,
                                          selectedExecutionStats.taskStats,
                                          milestone.id,
                                          slice,
                                        ),
                                        locale,
                                        copy.messages.notRecorded,
                                      )}
                                    </span>
                                    <span>{formatDuration(sliceEstimate, locale, copy.messages.estimateUnavailable)}</span>
                                  </summary>

                                  {slice.tasks.length === 0 ? null : (
                                    <div className="execution-task-grid">
                                      {slice.tasks.map((task) => {
                                        const taskKey = `${milestone.id}/${slice.id}/${task.id}`;
                                        const taskCurrent =
                                          sliceCurrentTask !== null && task === sliceCurrentTask;
                                        const taskEstimate =
                                          selectedExecutionStats.taskEstimatedRemainingMs.get(taskKey) ?? null;

                                        return (
                                          <div className="execution-task" data-current={taskCurrent} key={taskKey}>
                                            <span
                                              className="status-dot"
                                              data-status={taskCurrent ? 'active' : statusTone(task.status)}
                                            />
                                            <strong>{task.id}</strong>
                                            <span>
                                              {taskTitle(task)}
                                              {taskCurrent ? ` · ${copy.labels.currentTask}` : ''}
                                            </span>
                                            <span>
                                              {formatDuration(
                                                getTaskDisplayDuration(
                                                  selectedExecutionStats.taskStats,
                                                  milestone.id,
                                                  slice.id,
                                                  task,
                                                ),
                                                locale,
                                                copy.messages.notRecorded,
                                              )}
                                            </span>
                                            <span>
                                              {formatDuration(taskEstimate, locale, copy.messages.estimateUnavailable)}
                                            </span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </details>
                              );
                            })}
                          </div>
                        </details>
                      );
                    })}
                  </div>
                )}
              </section>

              <section
                className="workflow-page workflow-page--stack"
                id="workflow-panel-agent"
                role="tabpanel"
                aria-labelledby="workflow-tab-agent"
                hidden={activeWorkflowTab !== 'agent'}
              >
              <section className="subpanel agent-panel" data-testid="agent-panel">
                <div className="subpanel__header subpanel__header--actions">
                  <div>
                    <h4>{copy.labels.agent}</h4>
                    <p>{copy.labels.source}: .gsd/metrics.json</p>
                  </div>
                  <div className="detail-header__meta">
                    <span className="meta-badge">{copy.labels.primaryModel}: {primaryModel}</span>
                    <span className="meta-badge">{copy.formatCount(selectedExecutionStats.units.length, 'unit')}</span>
                  </div>
                </div>

                <div className="agent-summary-grid">
                  <div>
                    <span className="stat-card__label">{copy.labels.tokens}</span>
                    <strong>{formatCompactNumber(selectedMetrics?.totals.totalTokens ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.cost}</span>
                    <strong>{formatCost(selectedMetrics?.totals.cost ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.toolCalls}</span>
                    <strong>{formatCompactNumber(selectedMetrics?.totals.toolCalls ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.apiRequests}</span>
                    <strong>{formatCompactNumber(selectedMetrics?.totals.apiRequests ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.averageUnitDuration}</span>
                    <strong>{formatDuration(averageUnitDurationMs, locale, copy.messages.notRecorded)}</strong>
                  </div>
                </div>

                <div className="agent-usage-layout">
                  <section>
                    <h5>{copy.labels.modelUsage}</h5>
                    {selectedExecutionStats.modelUsage.length === 0 ? (
                      <p>{copy.messages.noModelUsage}</p>
                    ) : (
                      <div className="model-usage-list">
                        {selectedExecutionStats.modelUsage.map((model) => (
                          <article className="model-usage-row" key={model.model}>
                            <div>
                              <strong>{model.model}</strong>
                              <span>{model.unitCount} {copy.labels.units}</span>
                            </div>
                            <span>{formatCompactNumber(model.totalTokens, locale)} {copy.labels.tokens}</span>
                            <span>{formatCost(model.cost, locale)}</span>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                  <section>
                    <h5>{copy.labels.recentAgentUnits}</h5>
                    {selectedRecentExecutionUnits.length === 0 ? (
                      <p>{copy.messages.noAgentUnits}</p>
                    ) : (
                      <ol className="agent-unit-list">
                        {selectedRecentExecutionUnits.map((unit) => (
                          <li key={unit.key}>
                            <div>
                              <strong>{unit.id ?? unit.type ?? copy.messages.unknown}</strong>
                              <span>{unit.model ?? copy.messages.unknown}</span>
                            </div>
                            <span>{formatDuration(unit.durationMs, locale, copy.messages.notRecorded)}</span>
                            <span>{formatCompactNumber(unit.totalTokens, locale)} {copy.labels.tokens}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                </div>
              </section>

              <section
                className="subpanel monitor-panel"
                data-testid="monitor-panel"
              >
                <div className="subpanel__header">
                  <div>
                    <h4>{copy.labels.monitorFreshness}</h4>
                    <p>{copy.help.monitor}</p>
                  </div>
                  <div className="detail-header__meta detail-header__meta--monitor">
                    <span className="status-pill" data-status={selectedProject.monitor.health}>
                      {copy.monitorHealthLabels[selectedProject.monitor.health]}
                    </span>
                    <span className="meta-badge">{formatProjectReconcileTrigger(selectedProject.monitor.lastTrigger, copy)}</span>
                  </div>
                </div>

                <p className="detail-copy__lead" data-testid="monitor-summary-copy">
                  {selectedMonitorSummary}
                </p>

                {selectedProject.monitor.lastError ? (
                  <div className="inline-alert inline-alert--error monitor-alert" data-testid="monitor-last-error">
                    <strong>
                      {selectedProject.monitor.lastError.scope} at {formatTimestamp(selectedProject.monitor.lastError.at, locale)}
                    </strong>
                    <p>{clampWarning(selectedProject.monitor.lastError.message)}</p>
                  </div>
                ) : null}
              </section>

              <section className="subpanel continuity-panel" data-testid="continuity-panel">
                <div className="subpanel__header subpanel__header--actions">
                  <div>
                    <h4>{copy.labels.projectContinuity}</h4>
                    <p>{copy.help.continuity}</p>
                  </div>
                  <div className="detail-header__meta detail-header__meta--monitor">
                    <span className="status-pill" data-status={continuityTone(selectedContinuity!.state)}>
                      {copy.continuityStateLabels[selectedContinuity!.state]}
                    </span>
                    <span className="meta-badge">ID preserved</span>
                  </div>
                </div>

                <p className="detail-copy__lead" data-testid="continuity-summary-copy">
                  {selectedContinuitySummary}
                </p>

                <dl className="detail-facts detail-facts--compact">
                  <div>
                    <dt>{copy.labels.pathLostAt}</dt>
                    <dd data-testid="continuity-path-lost-at">
                      {selectedContinuity!.pathLostAt ? (
                        <time dateTime={selectedContinuity!.pathLostAt}>
                          {formatTimestamp(selectedContinuity!.pathLostAt, locale)}
                        </time>
                      ) : (
                        copy.messages.noMissingPath
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{copy.labels.lastRelinked}</dt>
                    <dd data-testid="continuity-last-relinked-at">
                      {selectedContinuity!.lastRelinkedAt ? (
                        <time dateTime={selectedContinuity!.lastRelinkedAt}>
                          {formatTimestamp(selectedContinuity!.lastRelinkedAt, locale)}
                        </time>
                      ) : (
                        copy.messages.noRelink
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{copy.labels.previousPath}</dt>
                    <dd data-testid="continuity-previous-canonical-path">
                      {selectedContinuity!.previousCanonicalPath ?? copy.messages.noPriorPath}
                    </dd>
                  </div>
                  <div>
                    <dt>{copy.labels.continuityChecked}</dt>
                    <dd>
                      <time dateTime={selectedContinuity!.checkedAt}>
                        {formatTimestamp(selectedContinuity!.checkedAt, locale)}
                      </time>
                    </dd>
                  </div>
                </dl>

                {selectedContinuity!.state === 'path_lost' ? (
                  <div className="inline-alert inline-alert--error continuity-alert" data-testid="continuity-path-lost-alert">
                    <strong>{copy.messages.pathLostTitle}</strong>
                    <p>{copy.messages.pathLostCopy(selectedProject.projectId)}</p>
                  </div>
                ) : null}

                {selectedContinuity!.lastRelinkedAt ? (
                  <div className="inline-alert inline-alert--success continuity-alert" data-testid="continuity-relinked-note">
                    <strong>{copy.messages.relinkedTitle}</strong>
                    <p>{copy.messages.relinkedCopy(selectedProject.projectId)}</p>
                  </div>
                ) : null}

                {relinkError ? (
                  <p className="inline-alert inline-alert--error" role="alert" data-testid="relink-error">
                    {relinkError}
                  </p>
                ) : null}

                {relinkSuccess ? (
                  <p className="inline-alert inline-alert--success" data-testid="relink-success">
                    {relinkSuccess}
                  </p>
                ) : null}

                {selectedContinuity!.state === 'path_lost' ? (
                  <form className="relink-form" data-testid="relink-form" onSubmit={handleRelinkSelected}>
                    <label className="field" htmlFor="relink-path">
                      <span>{copy.labels.newProjectPath}</span>
                      <input
                        id="relink-path"
                        name="relink-path"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        data-testid="relink-path-input"
                        placeholder={copy.placeholders.movedProjectPath}
                        value={relinkPath}
                        onChange={(nextEvent) => {
                          setRelinkPath(nextEvent.target.value);
                          setRelinkError(null);
                          setRelinkSuccess(null);
                        }}
                      />
                    </label>

                    <div className="relink-form__actions">
                      <button type="submit" className="primary-button" disabled={relinkPending}>
                        {relinkPending ? copy.actions.relinking : copy.actions.relinkProject}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          setRelinkPath('');
                          setRelinkError(null);
                          setRelinkSuccess(null);
                        }}
                        disabled={relinkPending || relinkPath.length === 0}
                      >
                        {copy.actions.clearRelinkPath}
                      </button>
                    </div>
                  </form>
                ) : null}
              </section>

              <section className="subpanel init-panel" data-testid="init-panel">
                <div className="subpanel__header subpanel__header--actions">
                  <div>
                    <h4>{copy.labels.initialization}</h4>
                    <p>{copy.help.initialization}</p>
                  </div>
                  {selectedInitActionVisible ? (
                    <button
                      type="button"
                      className="primary-button"
                      data-testid="init-action"
                      onClick={() => {
                        void handleInitializeSelected();
                      }}
                      disabled={selectedInitActionDisabled}
                    >
                      {initButtonLabel(
                        selectedProject,
                        {
                          requestPending: selectedInitRequestPending,
                          syncingDetail: selectedInitSyncingDetail,
                        },
                        copy,
                      )}
                    </button>
                  ) : selectedInitJob ? (
                    <span className="status-pill status-pill--job" data-status={selectedInitJob.stage}>
                      {copy.initStageLabels[selectedInitJob.stage]}
                    </span>
                  ) : null}
                </div>

                {selectedInitJob ? (
                  <div
                    className="init-banner"
                    data-stage={selectedInitJob.stage}
                    data-testid="init-stage-banner"
                  >
                    <div className="init-banner__meta">
                      <span className="status-pill status-pill--job" data-status={selectedInitJob.stage}>
                        {copy.initStageLabels[selectedInitJob.stage]}
                      </span>
                      <span className="meta-badge">
                        Updated {formatTimestamp(selectedInitJob.updatedAt, locale)}
                      </span>
                      {selectedInitSyncingDetail ? (
                        <span className="meta-badge" data-testid="init-refresh-syncing">
                          {copy.actions.refreshingMonitoredDetail}
                        </span>
                      ) : null}
                    </div>

                    <p className="init-banner__copy" data-testid="init-stage-detail">
                      {selectedInitSummary}
                    </p>

                    {hasActiveInitJob(selectedInitJob) && streamStatus !== 'connected' ? (
                      <p className="init-banner__stream-note" data-testid="init-stream-note">
                        {copy.messages.initStreamNote(copy.streamStatusLabels[streamStatus])}
                      </p>
                    ) : null}

                    {selectedInitJob.lastErrorDetail ? (
                      <p className="inline-alert inline-alert--error" data-testid="init-failure-detail">
                        {selectedInitJob.lastErrorDetail}
                      </p>
                    ) : null}

                    {selectedInitJob.refreshResult ? (
                      <dl className="detail-facts detail-facts--compact" data-testid="init-refresh-result">
                        <div>
                          <dt>{copy.labels.refreshResult}</dt>
                          <dd>{selectedInitJob.refreshResult.detail}</dd>
                        </div>
                        <div>
                          <dt>{copy.labels.snapshotStatus}</dt>
                          <dd>
                            {selectedInitJob.refreshResult.snapshotStatus
                              ? copy.statusLabels[selectedInitJob.refreshResult.snapshotStatus]
                              : copy.messages.unavailable}
                          </dd>
                        </div>
                        <div>
                          <dt>{copy.labels.warningsAfterRefresh}</dt>
                          <dd>
                            {selectedInitJob.refreshResult.warningCount === null
                              ? copy.messages.unavailable
                              : copy.formatCount(selectedInitJob.refreshResult.warningCount, 'warning')}
                          </dd>
                        </div>
                        <div>
                          <dt>{copy.labels.refreshEvent}</dt>
                          <dd>{selectedInitJob.refreshResult.eventId ?? copy.messages.unavailable}</dd>
                        </div>
                      </dl>
                    ) : null}

                    {selectedInitJob.outputExcerpt ? (
                      <pre className="init-output" data-testid="init-output-excerpt">
                        {selectedInitJob.outputExcerpt}
                      </pre>
                    ) : null}

                    <ol className="init-history" data-testid="init-history">
                      {selectedInitJob.history.map((entry) => (
                        <li key={entry.id}>
                          <div className="init-history__header">
                            <span className="status-pill status-pill--job" data-status={entry.stage}>
                              {copy.initStageLabels[entry.stage]}
                            </span>
                            <time dateTime={entry.emittedAt}>{formatTimestamp(entry.emittedAt, locale)}</time>
                          </div>
                          <p>{entry.detail}</p>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : (
                  <p data-testid="init-empty-state">{copy.empty.init}</p>
                )}
              </section>
              </section>

              <section
                className="workflow-page workflow-page--stack"
                id="workflow-panel-changes"
                role="tabpanel"
                aria-labelledby="workflow-tab-changes"
                hidden={activeWorkflowTab !== 'changes'}
              >
              <section className="subpanel" data-testid="detail-directory">
                <h4>{copy.labels.directorySummary}</h4>
                {selectedProject.snapshot.directory.isEmpty ? (
                  <p>{copy.messages.directoryEmpty}</p>
                ) : (
                  <>
                    <p>{copy.messages.directorySamples}</p>
                    <ul className="tag-list">
                      {selectedProject.snapshot.directory.sampleEntries.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                      {selectedProject.snapshot.directory.sampleTruncated ? <li>{copy.messages.truncated}</li> : null}
                    </ul>
                  </>
                )}
              </section>

              <section className="subpanel" data-testid="warning-list">
                <h4>{copy.labels.warnings}</h4>
                {selectedProject.snapshot.warnings.length === 0 ? (
                  <p>{copy.messages.noWarnings}</p>
                ) : (
                  <ul className="warning-list">
                    {selectedProject.snapshot.warnings.map((warning, index) => (
                      <li key={`${warning.source}-${warning.code}-${index}`}>
                        <strong>{copy.sourceLabels[warning.source]}</strong>
                        <span className="warning-code">{warning.code}</span>
                        <span title={warning.message}>{clampWarning(warning.message)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section
                className="subpanel source-grid"
                data-testid="source-grid"
              >
                <div className="subpanel__header">
                  <h4>{copy.labels.snapshotSourceStates}</h4>
                  <p>{copy.help.sources}</p>
                </div>
                <div className="source-grid__rows">
                  {SNAPSHOT_SOURCE_NAMES.map((sourceName) => {
                    const source = selectedProject.snapshot.sources[sourceName];

                    return (
                      <article
                        key={sourceName}
                        className="source-row"
                        data-source-state={source.state}
                        data-testid={`source-${sourceName}`}
                      >
                        <div>
                          <strong>{copy.sourceLabels[sourceName]}</strong>
                          <p>{source.detail ?? copy.messages.noExtraSourceDetail}</p>
                        </div>
                        <span className="status-pill status-pill--source" data-status={sourceTone(source.state)}>
                          {source.state}
                        </span>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="subpanel" data-testid="repo-meta-section">
                <h4>{copy.labels.repoMetadata}</h4>
                {selectedProject.snapshot.sources.repoMeta.value ? (
                  <dl className="detail-facts detail-facts--compact">
                    <div>
                      <dt>{copy.labels.project}</dt>
                      <dd>{selectedProject.snapshot.sources.repoMeta.value.projectName ?? copy.messages.unknown}</dd>
                    </div>
                    <div>
                      <dt>{copy.labels.branch}</dt>
                      <dd>{selectedProject.snapshot.sources.repoMeta.value.currentBranch ?? copy.messages.unknown}</dd>
                    </div>
                    <div>
                      <dt>{copy.labels.headSha}</dt>
                      <dd>{selectedProject.snapshot.sources.repoMeta.value.headSha ?? copy.messages.unknown}</dd>
                    </div>
                    <div>
                      <dt>{copy.labels.dirty}</dt>
                      <dd>
                        {selectedProject.snapshot.sources.repoMeta.value.dirty === null
                          ? copy.messages.unknown
                          : copy.formatBoolean(selectedProject.snapshot.sources.repoMeta.value.dirty)}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p>{copy.messages.repoMetaUnavailable}</p>
                )}
              </section>

              <section className="subpanel">
                <h4>{copy.labels.workspaceNotes}</h4>
                <div className="detail-copy">
                  <p>
                    <strong>PROJECT.md:</strong>{' '}
                    {selectedProject.snapshot.sources.projectMd.value?.summary ??
                      selectedProject.snapshot.sources.projectMd.detail ??
                      copy.messages.noProjectSummary}
                  </p>
                  <p>
                    <strong>STATE.md:</strong>{' '}
                    {selectedProject.snapshot.sources.stateMd.value?.summary ??
                      selectedProject.snapshot.sources.stateMd.detail ??
                      copy.messages.noStateSummary}
                  </p>
                </div>
              </section>
              </section>

              <section
                className="workflow-page subpanel export-panel"
                id="workflow-panel-export"
                role="tabpanel"
                aria-labelledby="workflow-tab-export"
                data-testid="export-panel"
                hidden={activeWorkflowTab !== 'export'}
              >
                <div className="subpanel__header subpanel__header--actions">
                  <div>
                    <h4>{copy.labels.export}</h4>
                    <p>{copy.labels.dataLocation}</p>
                  </div>
                  <button type="button" className="primary-button" onClick={handleExportSelected}>
                    <WorkflowIcon tab="export" />
                    <span>{copy.actions.exportSnapshot}</span>
                  </button>
                </div>

                <dl className="detail-facts detail-facts--compact">
                  <div>
                    <dt>{copy.labels.projectId}</dt>
                    <dd>{selectedProject.projectId}</dd>
                  </div>
                  <div>
                    <dt>{copy.labels.registeredPath}</dt>
                    <dd>{selectedProject.registeredPath}</dd>
                  </div>
                  <div>
                    <dt>{copy.labels.gsdRoot}</dt>
                    <dd>{selectedProject.dataLocation.gsdRootPath}</dd>
                  </div>
                  <div>
                    <dt>{copy.labels.gsdDbPath}</dt>
                    <dd>{selectedProject.dataLocation.gsdDbPath}</dd>
                  </div>
                </dl>
              </section>
              </div>
              </div>

              <WorkflowMilestoneRail
                milestones={selectedMilestones}
                activeMilestoneId={selectedActiveMilestone?.id ?? null}
                activeSliceId={selectedActiveSlice?.id ?? null}
                activeTask={selectedActiveTask}
                validationIssueCount={selectedProject.snapshot.warnings.length}
                copy={copy}
              />
            </div>
          ) : (
            <div className="empty-state" data-testid="detail-empty">
              <h3>{copy.empty.detailTitle}</h3>
              <p>{copy.empty.detailCopy}</p>
            </div>
          )}
          </div>
          <div className="terminal-dock">
            <strong>{copy.labels.terminal}</strong>
            <span aria-hidden="true">^</span>
            <p>
              {selectedProject
                ? `${copy.messages.terminalIdle} · ${selectedProject.dataLocation.gsdDbPath}`
                : copy.messages.terminalIdle}
            </p>
          </div>
        </section>
      </section>

      {directoryPickerOpen ? (
        <div className="directory-picker-backdrop" role="presentation">
          <section
            className="directory-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="directory-picker-heading"
            data-testid="directory-picker"
          >
            <div className="directory-picker__header">
              <div>
                <p className="eyebrow">{copy.labels.serverFilesystem}</p>
                <h2 id="directory-picker-heading">{copy.actions.browseFolders}</h2>
                <p>{copy.messages.selectedFolderHint}</p>
              </div>
              <button
                type="button"
                className="secondary-button secondary-button--icon"
                onClick={() => {
                  setDirectoryPickerOpen(false);
                }}
              >
                <span>{copy.actions.closePicker}</span>
              </button>
            </div>

            <div className="directory-picker__toolbar">
              <div>
                <span className="stat-card__label">{copy.labels.currentFolder}</span>
                <strong>{directoryPicker?.path ?? copy.messages.notRecorded}</strong>
              </div>
              <div className="directory-picker__actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!directoryPicker?.parentPath || directoryPickerLoading}
                  onClick={() => {
                    void loadDirectoryPicker(directoryPicker?.parentPath ?? null);
                  }}
                >
                  {copy.actions.openParentFolder}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={directoryPickerLoading}
                  onClick={() => {
                    void loadDirectoryPicker(directoryPicker?.path ?? registerPath);
                  }}
                >
                  {directoryPickerLoading ? copy.actions.loadingFolders : copy.actions.refreshFolders}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!directoryPicker}
                  onClick={() => {
                    if (directoryPicker) {
                      setRegisterPath(directoryPicker.path);
                      setRegisterError(null);
                      setRegisterSuccess(null);
                      setDirectoryPickerOpen(false);
                    }
                  }}
                >
                  <FolderIcon />
                  <span>{copy.actions.useCurrentFolder}</span>
                </button>
              </div>
            </div>

            <div className="directory-picker__browser">
              {directoryPickerError ? (
                <p className="inline-alert inline-alert--error" role="alert">
                  {directoryPickerError}
                </p>
              ) : null}

              {directoryPickerLoading && !directoryPicker ? (
                <p className="directory-picker__empty">{copy.actions.loadingFolders}</p>
              ) : directoryPicker && directoryPicker.entries.length > 0 ? (
                <ul className="directory-picker__list">
                  {directoryPicker.entries.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        className="directory-picker__entry"
                        onClick={() => {
                          void loadDirectoryPicker(entry.path);
                        }}
                      >
                        <FolderIcon />
                        <span>{entry.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="directory-picker__empty">{copy.messages.noFolderEntries}</p>
              )}
            </div>

            {directoryPicker?.truncated ? (
              <p className="directory-picker__note">{copy.messages.folderListTruncated}</p>
            ) : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
