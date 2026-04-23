import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

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
} from '../../shared/contracts.js';
import {
  LOCALE_STORAGE_KEY,
  UI_COPY,
  getInitialLocale,
  type Locale,
  type StreamStatus as UiStreamStatus,
  type UiCopy,
} from '../i18n.js';

export type StreamStatus = UiStreamStatus;
export type StreamResyncStatus = 'idle' | 'syncing' | 'failed';
export type AppPage = 'overview' | 'details';
export type AppRoute =
  | {
      page: 'welcome';
    }
  | {
      page: 'overview';
    }
  | {
      page: 'details';
      projectId: string;
    };
export type KnownEventType =
  | 'service.ready'
  | 'project.registered'
  | 'project.refreshed'
  | 'project.relinked'
  | 'project.monitor.updated'
  | 'project.init.updated';

export type StreamSummary = {
  id: string;
  type: KnownEventType;
  emittedAt: string;
  projectId: string | null;
};

export type ProjectInitEnvelope = {
  id: string;
  emittedAt: string;
  projectId: string;
  payload: ProjectInitEventPayload;
};

export type WorkflowTab = 'progress' | 'dependencies' | 'metrics' | 'timeline' | 'agent' | 'changes' | 'export';
export type RiskLevel = 'critical' | 'high' | 'medium-high' | 'medium' | 'low' | 'unknown';

export type ExecutionUnitView = {
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

export type ExecutionAggregate = {
  unitCount: number;
  totalDurationMs: number;
  firstStartedAtMs: number | null;
  lastFinishedAtMs: number | null;
};

export type TaskTimelineEntry = {
  key: string;
  path: string;
  milestoneId: string;
  sliceId: string;
  task: GsdDbTaskSummary;
  order: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  actualDurationMs: number | null;
  estimatedRemainingMs: number | null;
};

export type ModelUsageSummary = ExecutionAggregate & {
  model: string;
  totalTokens: number;
  cost: number;
  toolCalls: number;
  apiRequests: number;
};

export type WorkflowExecutionStats = {
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

export type ProjectOverviewRow = {
  project: ProjectRecord;
  label: string;
  continuity: ProjectContinuitySummary;
  workflowPhase: string;
  currentStage: string;
  cost: number;
  totalTokens: number;
  elapsedMs: number | null;
  estimatedRemainingMs: number | null;
  completedTasks: number;
  totalTasks: number;
  remainingTasks: number;
  progressPercent: number;
  warningCount: number;
  unitCount: number;
  metricsAvailable: boolean;
};

export type PortfolioSummary = {
  rows: ProjectOverviewRow[];
  totalCost: number;
  totalTokens: number;
  totalElapsedMs: number | null;
  totalWarnings: number;
  completedTasks: number;
  totalTasks: number;
  remainingTasks: number;
  activeProjects: number;
  metricsProjects: number;
};

export const APP_PAGES: readonly AppPage[] = ['overview', 'details'];
export const ROUTE_BASE_PATH = '/lazy';
export const ROUTE_OVERVIEW_PATH = `${ROUTE_BASE_PATH}/all`;
export const WORKFLOW_TABS: readonly WorkflowTab[] = [
  'progress',
  'dependencies',
  'metrics',
  'timeline',
  'agent',
  'changes',
  'export',
];

export const REQUEST_TIMEOUT_MS = 8_000;
export const INVENTORY_AUTO_REFRESH_MS = 5_000;
export const INIT_TERMINAL_FAILURE_STAGES: ReadonlySet<ProjectInitJobStage> = new Set([
  'failed',
  'timed_out',
  'cancelled',
]);
export const WARNING_TEXT_LIMIT = 240;
export const WORKFLOW_GRAPH_BASE_WIDTH = 860;
export const WORKFLOW_GRAPH_BASE_HEIGHT = 252;
export const WORKFLOW_GRAPH_ROW_HEIGHT = 72;
export const WORKFLOW_GRAPH_MIN_ZOOM = 0.75;
export const WORKFLOW_GRAPH_MAX_ZOOM = 1.6;
export const WORKFLOW_GRAPH_ZOOM_STEP = 0.15;
export const RUNTIME_CHART_WIDTH = 420;
export const RUNTIME_CHART_HEIGHT = 140;
export const KNOWN_EVENT_TYPES: ReadonlySet<KnownEventType> = new Set([
  'service.ready',
  'project.registered',
  'project.refreshed',
  'project.relinked',
  'project.monitor.updated',
  'project.init.updated',
]);

export function stripTrailingSlashes(pathname: string) {
  const stripped = pathname.replace(/\/+$/, '');

  return stripped.length === 0 ? '/' : stripped;
}

export function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseAppRoute(pathname: string): AppRoute {
  const normalizedPath = stripTrailingSlashes(pathname);

  if (normalizedPath === '/' || normalizedPath === ROUTE_BASE_PATH) {
    return { page: 'welcome' };
  }

  if (normalizedPath === ROUTE_OVERVIEW_PATH) {
    return { page: 'overview' };
  }

  if (normalizedPath.startsWith(`${ROUTE_BASE_PATH}/`)) {
    const projectId = safeDecodePathSegment(normalizedPath.slice(ROUTE_BASE_PATH.length + 1));

    if (projectId.length > 0 && projectId !== 'all') {
      return {
        page: 'details',
        projectId,
      };
    }
  }

  return { page: 'welcome' };
}

export function getAppRoutePath(route: AppRoute) {
  if (route.page === 'welcome') {
    return ROUTE_BASE_PATH;
  }

  if (route.page === 'overview') {
    return ROUTE_OVERVIEW_PATH;
  }

  return `${ROUTE_BASE_PATH}/${encodeURIComponent(route.projectId)}`;
}

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class ResponseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseShapeError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ResponseShapeError(`${label} must be an object.`);
  }

  return value;
}

export function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ResponseShapeError(`${label} must be a string.`);
  }

  return value;
}

export function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ResponseShapeError(`${label} must be a boolean.`);
  }

  return value;
}

export function expectNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ResponseShapeError(`${label} must be a number.`);
  }

  return value;
}

export function expectNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }

  return expectString(value, label);
}

export function expectOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectString(value, label);
}

export function expectOptionalWorkflowTimestamp(value: unknown, label: string): string | number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
    return value;
  }

  throw new ResponseShapeError(`${label} must be a string, number, or null.`);
}

export function expectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ResponseShapeError(`${label} must be a string array.`);
  }

  return value;
}

export function parseSnapshotSourceState(value: unknown, label: string): SnapshotSourceState {
  const candidate = expectString(value, label);

  if (!SNAPSHOT_SOURCE_STATES.includes(candidate as SnapshotSourceState)) {
    throw new ResponseShapeError(`${label} must be one of ${SNAPSHOT_SOURCE_STATES.join(', ')}.`);
  }

  return candidate as SnapshotSourceState;
}

export function parseSnapshotStatus(value: unknown, label: string): ProjectSnapshotStatus {
  const candidate = expectString(value, label);

  if (!PROJECT_SNAPSHOT_STATUSES.includes(candidate as ProjectSnapshotStatus)) {
    throw new ResponseShapeError(`${label} must be one of ${PROJECT_SNAPSHOT_STATUSES.join(', ')}.`);
  }

  return candidate as ProjectSnapshotStatus;
}

export function parseProjectMonitorHealth(value: unknown, label: string): ProjectMonitorHealth {
  const candidate = expectString(value, label);

  if (!PROJECT_MONITOR_HEALTHS.includes(candidate as ProjectMonitorHealth)) {
    throw new ResponseShapeError(`${label} must be one of ${PROJECT_MONITOR_HEALTHS.join(', ')}.`);
  }

  return candidate as ProjectMonitorHealth;
}

export function parseProjectContinuityState(value: unknown, label: string): ProjectContinuityState {
  const candidate = expectString(value, label);

  if (!PROJECT_CONTINUITY_STATES.includes(candidate as ProjectContinuityState)) {
    throw new ResponseShapeError(`${label} must be one of ${PROJECT_CONTINUITY_STATES.join(', ')}.`);
  }

  return candidate as ProjectContinuityState;
}

export function parseProjectReconcileTrigger(value: unknown, label: string): ProjectReconcileTrigger {
  const candidate = expectString(value, label);

  if (!PROJECT_RECONCILE_TRIGGERS.includes(candidate as ProjectReconcileTrigger)) {
    throw new ResponseShapeError(`${label} must be one of ${PROJECT_RECONCILE_TRIGGERS.join(', ')}.`);
  }

  return candidate as ProjectReconcileTrigger;
}

export function parseDirectorySummary(value: unknown, label: string): DirectorySummary {
  const record = expectRecord(value, label);

  return {
    isEmpty: expectBoolean(record.isEmpty, `${label}.isEmpty`),
    sampleEntries: expectStringArray(record.sampleEntries, `${label}.sampleEntries`),
    sampleTruncated: expectBoolean(record.sampleTruncated, `${label}.sampleTruncated`),
  };
}

export function parseSnapshotWarning(value: unknown, label: string): SnapshotWarning {
  const record = expectRecord(value, label);

  return {
    source: expectString(record.source, `${label}.source`) as SnapshotSourceName,
    code: expectString(record.code, `${label}.code`) as SnapshotWarning['code'],
    message: expectString(record.message, `${label}.message`),
  };
}

export function parseKnownEventType(value: unknown, label: string): KnownEventType {
  const candidate = expectString(value, label);

  if (!KNOWN_EVENT_TYPES.has(candidate as KnownEventType)) {
    throw new ResponseShapeError(`Unsupported event type: ${candidate}`);
  }

  return candidate as KnownEventType;
}

export function parseSnapshotSource<T>(
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

export function parseOptionalPresentObject<T extends Record<string, unknown>>(value: unknown, label: string): T {
  return expectRecord(value, label) as T;
}

export function parseRepoMeta(value: unknown, label: string) {
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

export function parseAutoLock(value: unknown, label: string) {
  const record = expectRecord(value, label);

  return {
    status: expectNullableString(record.status, `${label}.status`),
    pid: record.pid === null || record.pid === undefined ? null : expectNumber(record.pid, `${label}.pid`),
    startedAt: expectNullableString(record.startedAt, `${label}.startedAt`),
    updatedAt: expectNullableString(record.updatedAt, `${label}.updatedAt`),
  };
}

export function parseProjectMarkdown(value: unknown, label: string) {
  const record = expectRecord(value, label);

  return {
    title: expectNullableString(record.title, `${label}.title`),
    summary: expectNullableString(record.summary, `${label}.summary`),
  };
}

export function parseStateMarkdown(value: unknown, label: string) {
  const record = expectRecord(value, label);

  return {
    summary: expectString(record.summary, `${label}.summary`),
  };
}

export function parseGsdDbTaskSummary(value: unknown, label: string): GsdDbTaskSummary {
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

export function parseGsdDbSliceSummary(value: unknown, label: string): GsdDbSliceSummary {
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

export function parseGsdDbMilestoneSummary(value: unknown, label: string): GsdDbMilestoneSummary {
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

export function parseGsdDbSliceDependencySummary(value: unknown, label: string): GsdDbSliceDependencySummary {
  const record = expectRecord(value, label);

  return {
    milestoneId: expectString(record.milestoneId, `${label}.milestoneId`),
    sliceId: expectString(record.sliceId, `${label}.sliceId`),
    dependsOnSliceId: expectString(record.dependsOnSliceId, `${label}.dependsOnSliceId`),
  };
}

export function parseGsdDbSummary(value: unknown, label: string) {
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

export function parseGsdMetricsSummary(value: unknown, label: string): GsdMetricsSummaryValue {
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

export function parseProjectSnapshot(value: unknown, label: string): ProjectSnapshot {
  const record = expectRecord(value, label);
  const identityHints = expectRecord(record.identityHints, `${label}.identityHints`);
  const sources = expectRecord(record.sources, `${label}.sources`);
  const displayName = expectOptionalString(identityHints.displayName, `${label}.identityHints.displayName`);
  const displayNameSource = expectOptionalString(
    identityHints.displayNameSource,
    `${label}.identityHints.displayNameSource`,
  ) as ProjectSnapshot['identityHints']['displayNameSource'];

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
      ...(displayName === undefined ? {} : { displayName }),
      ...(displayNameSource === undefined ? {} : { displayNameSource }),
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

export function parseProjectInitJobStage(value: unknown, label: string): ProjectInitJobStage {
  const candidate = expectString(value, label);

  if (!PROJECT_INIT_JOB_STAGES.includes(candidate as ProjectInitJobStage)) {
    throw new ResponseShapeError(`${label} must be one of ${PROJECT_INIT_JOB_STAGES.join(', ')}.`);
  }

  return candidate as ProjectInitJobStage;
}

export function parseProjectInitRefreshResultStatus(
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

export function parseProjectInitJobHistoryEntry(value: unknown, label: string): ProjectInitJobHistoryEntry {
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

export function parseProjectInitRefreshResult(value: unknown, label: string): ProjectInitRefreshResult {
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

export function parseProjectInitJob(value: unknown, label: string): ProjectInitJob {
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

export function parseProjectMonitorError(value: unknown, label: string): ProjectMonitorError {
  const record = expectRecord(value, label);

  return {
    scope: expectString(record.scope, `${label}.scope`) as ProjectMonitorError['scope'],
    message: expectString(record.message, `${label}.message`),
    at: expectString(record.at, `${label}.at`),
  };
}

export function parseProjectMonitorSummary(value: unknown, label: string): ProjectMonitorSummary {
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

export function parseProjectContinuitySummary(value: unknown, label: string): ProjectContinuitySummary {
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

export function parseProjectDataLocation(value: unknown, label: string): ProjectDataLocation {
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

export function parseProjectTimelineEntryType(value: unknown, label: string): ProjectTimelineEntryType {
  const candidate = expectString(value, label);

  if (!PROJECT_TIMELINE_ENTRY_TYPES.includes(candidate as ProjectTimelineEntryType)) {
    throw new ResponseShapeError(
      `${label} must be one of ${PROJECT_TIMELINE_ENTRY_TYPES.join(', ')}.`,
    );
  }

  return candidate as ProjectTimelineEntryType;
}

export function parseProjectTimelineEntry(
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

export function parseProjectTimelineResponse(value: unknown, expectedProjectId?: string): ProjectTimelineResponse {
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

export function parseProjectDetailResponse(value: unknown): ProjectDetailResponse {
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

export function assertUiSafeInitJob(
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

export function parseProjectInitEventEnvelope(value: unknown): ProjectInitEnvelope {
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

export function parseProjectRecord(value: unknown, label: string = 'project'): ProjectRecord {
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

export function parseProjectsResponse(value: unknown): ProjectsResponse {
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

export function parseFilesystemDirectoryEntry(value: unknown, label: string): FilesystemDirectoryEntry {
  const record = expectRecord(value, label);

  return {
    name: expectString(record.name, `${label}.name`),
    path: expectString(record.path, `${label}.path`),
    hidden: expectBoolean(record.hidden, `${label}.hidden`),
  };
}

export function parseFilesystemDirectoryResponse(value: unknown): FilesystemDirectoryResponse {
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

export function parseSourceStateMap(
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

export function parseProjectSnapshotEventPayload(value: unknown, label: string): ProjectSnapshotEventPayload {
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

export function parseProjectMonitorEventPayload(value: unknown, label: string): ProjectMonitorEventPayload {
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

export function parseProjectRelinkEventPayload(value: unknown, label: string): ProjectRelinkEventPayload {
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

export function parseProjectInitEventPayload(value: unknown, label: string): ProjectInitEventPayload {
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

export function parseEventEnvelope(value: unknown): StreamSummary {
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

export function parseProjectMutationResponse(value: unknown): ProjectMutationResponse {
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

export async function readJsonPayload(response: Response, label: string): Promise<unknown> {
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

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}) {
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

export async function requestJson<T>(
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

export function normalizePathForComparison(value: string) {
  return value.trim().replace(/[\\/]+$/u, '');
}

export function formatRequestError(error: unknown, timeoutMessage: string, unexpectedMessage: string): string {
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

export function clampWarning(message: string) {
  if (message.length <= WARNING_TEXT_LIMIT) {
    return message;
  }

  return `${message.slice(0, WARNING_TEXT_LIMIT - 1)}…`;
}

export function formatTimestamp(timestamp: string, locale: Locale) {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatCompactNumber(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatCost(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value);
}

export function basenameFromPath(value: string) {
  const segments = value.split(/[\\/]/u).filter(Boolean);

  return segments.at(-1) ?? value;
}

export function joinProjectPath(projectRoot: string, ...segments: string[]) {
  const separator = projectRoot.includes('\\') ? '\\' : '/';
  const trimmedRoot = projectRoot.replace(/[\\/]+$/u, '');

  return [trimmedRoot, ...segments].join(separator);
}

export function inferProjectDataLocation(projectRoot: string): ProjectDataLocation {
  const gsdRootPath = joinProjectPath(projectRoot, '.gsd');

  return {
    projectRoot,
    gsdRootPath,
    gsdDbPath: joinProjectPath(gsdRootPath, 'gsd.db'),
    statePath: joinProjectPath(gsdRootPath, 'STATE.md'),
    persistenceScope: 'project',
  };
}

export function trimDisplayName(value: string | null | undefined) {
  const trimmed = value?.trim() ?? '';

  return trimmed.length === 0 ? null : trimmed;
}

export function isGenericDisplayName(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase().replace(/[\s_-]+/gu, ' ') ?? '';

  return normalized === 'project' || normalized === 'untitled project' || normalized === 'project snapshot fixture';
}

export function describeProject(project: ProjectRecord) {
  const hintedName = trimDisplayName(project.snapshot.identityHints.displayName);
  const repoName = trimDisplayName(project.snapshot.sources.repoMeta.value?.projectName);
  const directoryName = trimDisplayName(basenameFromPath(project.canonicalPath));
  const projectTitle = trimDisplayName(project.snapshot.sources.projectMd.value?.title);
  const gsdId = trimDisplayName(project.snapshot.identityHints.gsdId);

  return (
    (projectTitle && !isGenericDisplayName(projectTitle) ? projectTitle : null)
    ?? (hintedName && !isGenericDisplayName(hintedName) ? hintedName : null)
    ?? (repoName && !isGenericDisplayName(repoName) ? repoName : null)
    ?? directoryName
    ?? gsdId
    ?? project.canonicalPath
  );
}

export function getProjectContinuity(project: ProjectRecord): ProjectContinuitySummary {
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

export function continuityTone(state: ProjectContinuityState) {
  return state === 'tracked' ? 'ok' : 'warning';
}

export function describeContinuityState(project: ProjectRecord, copy: UiCopy) {
  const continuity = getProjectContinuity(project);

  if (continuity.state === 'path_lost') {
    return copy.messages.pathLostCopy(project.projectId);
  }

  if (continuity.lastRelinkedAt) {
    return copy.messages.relinkedCopy(project.projectId);
  }

  return copy.summaries.continuityTracked;
}

export function sourceTone(state: SnapshotSourceState) {
  if (state === 'ok') {
    return 'ok';
  }

  if (state === 'not_applicable') {
    return 'neutral';
  }

  return 'warning';
}

export function formatProjectReconcileTrigger(trigger: ProjectReconcileTrigger | null, copy: UiCopy) {
  if (!trigger) {
    return copy.messages.notRecorded;
  }

  return copy.reconcileTriggerLabels[trigger];
}

export function describeMonitorState(
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

export function describeTimelineCount(total: number, copy: UiCopy) {
  return copy.formatCount(total, 'entry');
}

export function timelineTone(type: ProjectTimelineEntryType) {
  if (type === 'monitor_recovered') {
    return 'ok';
  }

  if (type === 'path_lost' || type === 'monitor_degraded') {
    return 'warning';
  }

  return 'neutral';
}

export function isWorkflowStatusComplete(status: string | null) {
  return status !== null && /^(complete|completed|done|succeeded|success)$/iu.test(status.trim());
}

export function isWorkflowStatusActive(status: string | null) {
  return status !== null && /^(active|running|executing|in_progress|in-progress|current)$/iu.test(status.trim());
}

export function isWorkflowStatusPending(status: string | null) {
  return status !== null && /^(pending|queued|planned|ready|todo|to_do|not_started|not-started|open)$/iu.test(status.trim());
}

export function isWorkflowStatusBlocked(status: string | null) {
  return status !== null && /^(failed|blocked|error|degraded|high)$/iu.test(status.trim());
}

export function statusTone(status: string | null) {
  if (!status) {
    return 'neutral';
  }

  if (isWorkflowStatusComplete(status)) {
    return 'ok';
  }

  if (isWorkflowStatusActive(status)) {
    return 'active';
  }

  if (isWorkflowStatusPending(status)) {
    return 'pending';
  }

  if (isWorkflowStatusBlocked(status)) {
    return 'warning';
  }

  return 'neutral';
}

export function milestoneTitle(milestone: GsdDbMilestoneSummary) {
  return milestone.title ?? milestone.id;
}

export function sliceTitle(slice: GsdDbSliceSummary) {
  return slice.title ?? slice.id;
}

function normalizeCopyToken(value: string) {
  return value.trim().toLowerCase().replace(/[_\s]+/gu, '-');
}

function sentenceCaseToken(value: string) {
  const normalized = value.trim().replace(/[_-]+/gu, ' ');

  if (normalized.length === 0) {
    return normalized;
  }

  return normalized.replace(/\b[a-z][a-z0-9]*\b/giu, (word, offset) =>
    offset === 0 ? `${word[0]!.toUpperCase()}${word.slice(1).toLowerCase()}` : word.toLowerCase(),
  );
}

export function formatWorkflowStatus(status: string | null, copy: UiCopy) {
  if (status === null || status.trim().length === 0) {
    return copy.messages.unknown;
  }

  const normalized = normalizeCopyToken(status);

  return copy.workflowStatusLabels[normalized] ?? sentenceCaseToken(status);
}

export function formatRiskLevel(level: string | null, copy: UiCopy) {
  if (level === null || level.trim().length === 0) {
    return copy.riskLevelLabels.unknown ?? copy.messages.unknown;
  }

  const normalized = normalizeCopyToken(level);

  return copy.riskLevelLabels[normalized] ?? sentenceCaseToken(level);
}

export function workflowTaskKey(milestoneId: string, sliceId: string, taskId: string) {
  return `${milestoneId}/${sliceId}/${taskId}`;
}

export function workflowSliceKey(milestoneId: string, sliceId: string) {
  return `${milestoneId}/${sliceId}`;
}

export const RISK_LEVELS: readonly RiskLevel[] = ['critical', 'high', 'medium-high', 'medium', 'low', 'unknown'];
export const KNOWN_ACRONYMS = new Set([
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

export function normalizeRiskLevel(value: string | null): RiskLevel {
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

  if (/\bmedium\b|\bmiddle\b|\bmed\b|\bmid\b/.test(normalized)) {
    return 'medium';
  }

  if (/\blow\b/.test(normalized)) {
    return 'low';
  }

  return 'unknown';
}

export function extractRiskPrefix(value: string | null) {
  return value?.match(/^\s*(critical|high|medium-high|med-high|mid-high|medium|middle|med|mid|low)\s*(?:[-:—]|without|if|the)\b/i)?.[1] ?? null;
}

export function getSliceRiskLevel(slice: GsdDbSliceSummary) {
  return normalizeRiskLevel(slice.risk ?? extractRiskPrefix(slice.title));
}

export function readableRiskLabel(level: RiskLevel, locale: Locale) {
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

export function stripRiskPrefix(value: string) {
  return value.replace(/^\s*(critical|high|medium-high|med-high|mid-high|medium|middle|med|mid|low)\s*(?:[-:—]\s*)?/i, '').trim();
}

export function sentenceCaseTitle(value: string) {
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

export function taskDisplayTitle(task: GsdDbTaskSummary, copy: UiCopy) {
  if (task.title) {
    return sentenceCaseTitle(task.title);
  }

  if (task.status) {
    return formatWorkflowStatus(task.status, copy);
  }

  return task.id;
}

export function groupedSlicesByRisk(slices: GsdDbSliceSummary[]) {
  return RISK_LEVELS.map((level) => ({
    level,
    slices: slices.filter((slice) => getSliceRiskLevel(slice) === level),
  })).filter((group) => group.slices.length > 0);
}

export function normalizeMetricTimestamp(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value < 10_000_000_000 ? value * 1000 : value;
}

export function normalizeWorkflowTimestamp(value: string | number | null): number | null {
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

export function getWorkflowEntityDurationMs(entity: {
  startedAt: string | number | null;
  finishedAt: string | number | null;
}) {
  const startedAtMs = normalizeWorkflowTimestamp(entity.startedAt);
  const finishedAtMs = normalizeWorkflowTimestamp(entity.finishedAt);

  return startedAtMs !== null && finishedAtMs !== null && finishedAtMs >= startedAtMs
    ? finishedAtMs - startedAtMs
    : null;
}

export function averageNumbers(values: number[]) {
  const usableValues = values.filter((value) => Number.isFinite(value) && value > 0);

  return usableValues.length === 0
    ? null
    : usableValues.reduce((total, value) => total + value, 0) / usableValues.length;
}

export function formatDuration(durationMs: number | null, locale: Locale, fallback: string) {
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

export function formatMetricTimestamp(value: number | null, locale: Locale, fallback: string) {
  if (value === null) {
    return fallback;
  }

  return formatTimestamp(new Date(value).toISOString(), locale);
}

export function parseUnitIdentity(id: string | null) {
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

export function toExecutionUnit(unit: GsdMetricsSummaryValue['recentUnits'][number], index: number): ExecutionUnitView {
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

export function createAggregate(): ExecutionAggregate {
  return {
    unitCount: 0,
    totalDurationMs: 0,
    firstStartedAtMs: null,
    lastFinishedAtMs: null,
  };
}

export function addUnitToAggregate(aggregate: ExecutionAggregate, unit: ExecutionUnitView) {
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

export function addUnitToAggregateMap(map: Map<string, ExecutionAggregate>, key: string | null, unit: ExecutionUnitView) {
  if (!key) {
    return;
  }

  const aggregate = map.get(key) ?? createAggregate();

  addUnitToAggregate(aggregate, unit);
  map.set(key, aggregate);
}

export function buildModelUsage(units: ExecutionUnitView[], unknownLabel: string): ModelUsageSummary[] {
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

export function averageDuration(units: ExecutionUnitView[]) {
  const durations = units
    .map((unit) => unit.durationMs)
    .filter((duration): duration is number => duration !== null && duration > 0);

  return averageNumbers(durations);
}

export function getObservedSliceDurationMs(
  milestoneId: string,
  slice: GsdDbSliceSummary,
  sliceStats: Map<string, ExecutionAggregate>,
) {
  const key = workflowSliceKey(milestoneId, slice.id);

  return getAggregateDuration(sliceStats.get(key)) ?? getWorkflowEntityDurationMs(slice);
}

export function getObservedTaskDurationMs(
  milestoneId: string,
  sliceId: string,
  task: GsdDbTaskSummary,
  taskStats: Map<string, ExecutionAggregate>,
) {
  const key = workflowTaskKey(milestoneId, sliceId, task.id);

  return getAggregateDuration(taskStats.get(key)) ?? getWorkflowEntityDurationMs(task);
}

export function collectSliceDurationSamples(
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

export function collectTaskDurationSamples(
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

export function estimateTaskRemainingDuration(
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

export function estimateSliceRemainingDuration(
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

export function addNullableDuration(first: number | null, second: number | null) {
  if (first === null || second === null) {
    return null;
  }

  return first + second;
}

export function buildWorkflowForecasts(
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

export function buildWorkflowExecutionStats(
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

export function getAggregateDuration(aggregate: ExecutionAggregate | undefined) {
  return aggregate && aggregate.totalDurationMs > 0 ? aggregate.totalDurationMs : null;
}

export function getDisplayDuration(
  aggregate: ExecutionAggregate | undefined,
  entity: {
    startedAt: string | number | null;
    finishedAt: string | number | null;
  },
) {
  return getAggregateDuration(aggregate) ?? getWorkflowEntityDurationMs(entity);
}

export function getTaskDisplayDuration(
  taskStats: Map<string, ExecutionAggregate>,
  milestoneId: string,
  sliceId: string,
  task: GsdDbTaskSummary,
) {
  return getDisplayDuration(taskStats.get(workflowTaskKey(milestoneId, sliceId, task.id)), task);
}

export function getDisplayStartedAt(
  aggregate: ExecutionAggregate | undefined,
  entity: {
    startedAt: string | number | null;
  },
) {
  return aggregate?.firstStartedAtMs ?? normalizeWorkflowTimestamp(entity.startedAt);
}

export function getDisplayFinishedAt(
  aggregate: ExecutionAggregate | undefined,
  entity: {
    finishedAt: string | number | null;
  },
) {
  return aggregate?.lastFinishedAtMs ?? normalizeWorkflowTimestamp(entity.finishedAt);
}

export function getTaskTimelineActivityTime(entry: TaskTimelineEntry) {
  if (entry.startedAtMs === null && entry.finishedAtMs === null) {
    return null;
  }

  return Math.max(entry.startedAtMs ?? Number.NEGATIVE_INFINITY, entry.finishedAtMs ?? Number.NEGATIVE_INFINITY);
}

export function getTaskTimelineStatusRank(entry: TaskTimelineEntry) {
  return getWorkflowStatusRank(entry.task.status);
}

export function buildTaskTimelineEntries(
  milestones: GsdDbMilestoneSummary[],
  executionStats: WorkflowExecutionStats,
): TaskTimelineEntry[] {
  const entries: TaskTimelineEntry[] = [];
  let order = 0;

  for (const milestone of milestones) {
    for (const slice of milestone.slices) {
      for (const task of slice.tasks) {
        const key = workflowTaskKey(milestone.id, slice.id, task.id);
        const aggregate = executionStats.taskStats.get(key);

        entries.push({
          key,
          path: key,
          milestoneId: milestone.id,
          sliceId: slice.id,
          task,
          order,
          startedAtMs: getDisplayStartedAt(aggregate, task),
          finishedAtMs: getDisplayFinishedAt(aggregate, task),
          actualDurationMs: getTaskDisplayDuration(executionStats.taskStats, milestone.id, slice.id, task),
          estimatedRemainingMs: executionStats.taskEstimatedRemainingMs.get(key) ?? null,
        });
        order += 1;
      }
    }
  }

  return entries.sort((first, second) => {
    const firstStatusRank = getTaskTimelineStatusRank(first);
    const secondStatusRank = getTaskTimelineStatusRank(second);

    if (firstStatusRank !== secondStatusRank) {
      return firstStatusRank - secondStatusRank;
    }

    const firstActivityMs = getTaskTimelineActivityTime(first);
    const secondActivityMs = getTaskTimelineActivityTime(second);

    if (firstActivityMs !== null && secondActivityMs !== null && firstActivityMs !== secondActivityMs) {
      return secondActivityMs - firstActivityMs;
    }

    if (firstActivityMs !== null && secondActivityMs === null) {
      return -1;
    }

    if (firstActivityMs === null && secondActivityMs !== null) {
      return 1;
    }

    return first.order - second.order;
  });
}

export function getSliceTaskDurationTotal(
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

export function getSliceDisplayDuration(
  sliceStats: Map<string, ExecutionAggregate>,
  taskStats: Map<string, ExecutionAggregate>,
  milestoneId: string,
  slice: GsdDbSliceSummary,
) {
  return getSliceTaskDurationTotal(taskStats, milestoneId, slice)
    ?? getDisplayDuration(sliceStats.get(workflowSliceKey(milestoneId, slice.id)), slice);
}

export function getMilestoneDisplayDuration(
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

export interface SliceDependencyView {
  milestoneId: string;
  fromId: string;
  fromTitle: string | null;
  toId: string;
  toTitle: string | null;
}

export function getInferredSliceDependencies(milestones: GsdDbMilestoneSummary[]) {
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

export function getSliceDependencies(gsdDb: GsdDbSummaryValue | null): SliceDependencyView[] {
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

export function getRemainingSliceCount(milestones: GsdDbMilestoneSummary[]) {
  return milestones.reduce(
    (total, milestone) =>
      total + milestone.slices.filter((slice) => !isWorkflowStatusComplete(slice.status)).length,
    0,
  );
}

export function getRemainingWorkflowUnitCount(milestones: GsdDbMilestoneSummary[]) {
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

export function getCompletedTaskCount(milestones: GsdDbMilestoneSummary[]) {
  return milestones.reduce((total, milestone) => total + milestone.completedTaskCount, 0);
}

export function getCompletedSliceCount(milestone: GsdDbMilestoneSummary) {
  return milestone.slices.filter((slice) => isWorkflowStatusComplete(slice.status)).length;
}

export function getWorkflowStatusRank(status: string | null) {
  if (isWorkflowStatusActive(status)) {
    return 0;
  }

  if (isWorkflowStatusPending(status) || isWorkflowStatusBlocked(status)) {
    return 1;
  }

  if (status !== null && !isWorkflowStatusComplete(status)) {
    return 2;
  }

  if (isWorkflowStatusComplete(status)) {
    return 3;
  }

  return 4;
}

export function getWorkflowEntityActivityTime(entity: {
  startedAt: string | number | null;
  finishedAt: string | number | null;
}) {
  const startedAtMs = normalizeWorkflowTimestamp(entity.startedAt);
  const finishedAtMs = normalizeWorkflowTimestamp(entity.finishedAt);

  if (startedAtMs === null && finishedAtMs === null) {
    return null;
  }

  return Math.max(startedAtMs ?? Number.NEGATIVE_INFINITY, finishedAtMs ?? Number.NEGATIVE_INFINITY);
}

export function getTaskWorkflowActivityTime(task: GsdDbTaskSummary) {
  return getWorkflowEntityActivityTime(task);
}

export function getSliceWorkflowActivityTime(slice: GsdDbSliceSummary) {
  const ownActivityMs = getWorkflowEntityActivityTime(slice);
  const taskActivityTimes = slice.tasks
    .map(getTaskWorkflowActivityTime)
    .filter((value): value is number => value !== null);

  return taskActivityTimes.length > 0
    ? Math.max(...taskActivityTimes, ownActivityMs ?? Number.NEGATIVE_INFINITY)
    : ownActivityMs;
}

export function getMilestoneWorkflowActivityTime(milestone: GsdDbMilestoneSummary) {
  const ownActivityMs = getWorkflowEntityActivityTime(milestone);
  const sliceActivityTimes = milestone.slices
    .map(getSliceWorkflowActivityTime)
    .filter((value): value is number => value !== null);

  return sliceActivityTimes.length > 0
    ? Math.max(...sliceActivityTimes, ownActivityMs ?? Number.NEGATIVE_INFINITY)
    : ownActivityMs;
}

export function compareWorkflowActivity(
  firstActivityMs: number | null,
  secondActivityMs: number | null,
  firstIndex: number,
  secondIndex: number,
) {
  if (firstActivityMs !== null && secondActivityMs !== null && firstActivityMs !== secondActivityMs) {
    return secondActivityMs - firstActivityMs;
  }

  if (firstActivityMs !== null && secondActivityMs === null) {
    return -1;
  }

  if (firstActivityMs === null && secondActivityMs !== null) {
    return 1;
  }

  return secondIndex - firstIndex;
}

export function getMilestoneProgress(milestone: GsdDbMilestoneSummary) {
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

export function getMilestoneProgressPercent(milestone: GsdDbMilestoneSummary) {
  const milestoneProgress = getMilestoneProgress(milestone);

  if (milestoneProgress.total === 0) {
    return isMilestoneEffectivelyComplete(milestone) ? 100 : 0;
  }

  return Math.max(0, Math.min(100, Math.round((milestoneProgress.completed / milestoneProgress.total) * 100)));
}

export function getSliceProgressPercent(slice: GsdDbSliceSummary) {
  if (slice.taskCount > 0) {
    return Math.max(0, Math.min(100, Math.round((slice.completedTaskCount / slice.taskCount) * 100)));
  }

  if (isWorkflowStatusComplete(slice.status)) {
    return 100;
  }

  if (isWorkflowStatusActive(slice.status)) {
    return 56;
  }

  if (isWorkflowStatusBlocked(slice.status)) {
    return 18;
  }

  return 6;
}

export function getWorkflowFocus(
  milestones: GsdDbMilestoneSummary[],
  activeMilestoneId: string | null,
  activeSliceId: string | null,
  activeTask: GsdDbTaskSummary | null,
) {
  const focusedMilestone = milestones.find((milestone) => milestone.id === activeMilestoneId) ?? milestones[0] ?? null;
  const focusedSlice =
    focusedMilestone === null
      ? null
      : (
        focusedMilestone.id === activeMilestoneId
          ? focusedMilestone.slices.find((slice) => slice.id === activeSliceId) ?? findActiveSlice(focusedMilestone)
          : findActiveSlice(focusedMilestone)
      );
  const focusedTask =
    focusedMilestone !== null
      && focusedSlice !== null
      && focusedMilestone.id === activeMilestoneId
      && focusedSlice.id === activeSliceId
      ? activeTask
      : findActiveTask(focusedSlice);

  return {
    focusedMilestone,
    focusedSlice,
    focusedTask,
  };
}

export function clampRecentUnits(units: ExecutionUnitView[], limit: number = 10) {
  return units.slice(Math.max(0, units.length - limit));
}

export type SparklinePoint = {
  x: number;
  y: number;
  value: number;
};

export type DragScrollPointerState = {
  pointerId: number;
  clientX: number;
  clientY: number;
  scrollLeft: number;
  scrollTop: number;
};

export type DragScrollViewportOptions = {
  contentWidth: number;
  contentHeight: number;
  initialZoom?: number;
  minZoom?: number;
  maxZoom?: number;
  zoomStep?: number;
  lockVertical?: boolean;
  translateWheelToHorizontal?: boolean;
};

export type WorkflowGraphConnector = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export function buildSparklinePoints(values: number[], width: number, height: number) {
  const series = values.length > 0 ? values : [0];
  const max = Math.max(...series);
  const min = Math.min(...series);
  const range = max - min === 0 ? 1 : max - min;

  return series
    .map((value, index) => {
      const x = series.length === 1 ? width / 2 : (index / (series.length - 1)) * width;
      const y = height - ((value - min) / range) * height;

      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

export function buildSparklineSeries(values: number[], width: number, height: number) {
  const series = values.length > 0 ? values : [0];
  const max = Math.max(...series);
  const min = Math.min(...series);
  const range = max - min === 0 ? 1 : max - min;

  const points = series.map((value, index) => ({
    x: series.length === 1 ? width / 2 : (index / (series.length - 1)) * width,
    y: height - ((value - min) / range) * height,
    value,
  }));

  return {
    min,
    max,
    points,
  };
}

export function buildSparklineAreaPoints(points: SparklinePoint[], height: number) {
  if (points.length === 0) {
    return '';
  }

  const firstPoint = points[0]!;
  const lastPoint = points[points.length - 1]!;

  return [
    `${firstPoint.x.toFixed(2)},${height.toFixed(2)}`,
    ...points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`),
    `${lastPoint.x.toFixed(2)},${height.toFixed(2)}`,
  ].join(' ');
}

export function clampWorkflowGraphZoom(value: number) {
  return Math.max(
    WORKFLOW_GRAPH_MIN_ZOOM,
    Math.min(WORKFLOW_GRAPH_MAX_ZOOM, Math.round(value * 100) / 100),
  );
}

export function buildWorkflowGraphConnectorPath(connector: WorkflowGraphConnector) {
  const curve = Math.max(20, Math.abs(connector.x2 - connector.x1) * 0.38);

  return [
    `M ${connector.x1.toFixed(2)} ${connector.y1.toFixed(2)}`,
    `C ${(connector.x1 + curve).toFixed(2)} ${connector.y1.toFixed(2)}`,
    `${(connector.x2 - curve).toFixed(2)} ${connector.y2.toFixed(2)}`,
    `${connector.x2.toFixed(2)} ${connector.y2.toFixed(2)}`,
  ].join(' ');
}

export function useDragScrollViewport({
  contentWidth,
  contentHeight,
  initialZoom = 1,
  minZoom = 1,
  maxZoom = 1,
  zoomStep = WORKFLOW_GRAPH_ZOOM_STEP,
  lockVertical = false,
  translateWheelToHorizontal = false,
}: DragScrollViewportOptions) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragScrollPointerState | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(() => {
    const normalizedZoom = Math.round(initialZoom * 100) / 100;
    return Math.max(minZoom, Math.min(maxZoom, normalizedZoom));
  });
  const [isDragging, setIsDragging] = useState(false);
  const canZoom = maxZoom > minZoom;
  const scaledWidth = contentWidth * zoom;
  const scaledHeight = contentHeight * zoom;
  const canPanX = scaledWidth > viewportSize.width + 1;
  const canPanY = !lockVertical && scaledHeight > viewportSize.height + 1;
  const canPan = canPanX || canPanY;
  const clampZoom = useCallback(
    (value: number) => {
      const normalizedZoom = Math.round(value * 100) / 100;
      return Math.max(minZoom, Math.min(maxZoom, normalizedZoom));
    },
    [maxZoom, minZoom],
  );

  useEffect(() => {
    setZoom((currentZoom) => clampZoom(currentZoom));
  }, [clampZoom]);

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return undefined;
    }

    const updateViewportSize = () => {
      setViewportSize({
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      });
    };

    updateViewportSize();

    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      updateViewportSize();
    });

    observer.observe(viewport);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const maxScrollLeft = Math.max(0, scaledWidth - viewport.clientWidth);
    const maxScrollTop = Math.max(0, scaledHeight - viewport.clientHeight);

    viewport.scrollLeft = Math.min(viewport.scrollLeft, maxScrollLeft);
    viewport.scrollTop = Math.min(viewport.scrollTop, maxScrollTop);
  }, [scaledHeight, scaledWidth, viewportSize.height, viewportSize.width]);

  const finishDrag = useCallback((pointerId?: number) => {
    const viewport = viewportRef.current;

    if (viewport && pointerId !== undefined && viewport.hasPointerCapture(pointerId)) {
      viewport.releasePointerCapture(pointerId);
    }

    dragStateRef.current = null;
    setIsDragging(false);
  }, []);

  const updateZoom = useCallback(
    (nextZoom: number, origin?: { x: number; y: number }) => {
      if (!canZoom) {
        return;
      }

      const viewport = viewportRef.current;

      if (!viewport) {
        setZoom(clampZoom(nextZoom));
        return;
      }

      setZoom((currentZoom) => {
        const clampedZoom = clampZoom(nextZoom);

        if (clampedZoom === currentZoom) {
          return currentZoom;
        }

        const focusX = origin?.x ?? viewport.clientWidth / 2;
        const focusY = origin?.y ?? viewport.clientHeight / 2;
        const logicalX = (viewport.scrollLeft + focusX) / currentZoom;
        const logicalY = (viewport.scrollTop + focusY) / currentZoom;

        requestAnimationFrame(() => {
          const maxScrollLeft = Math.max(0, contentWidth * clampedZoom - viewport.clientWidth);
          const maxScrollTop = Math.max(0, contentHeight * clampedZoom - viewport.clientHeight);

          viewport.scrollLeft = Math.min(maxScrollLeft, Math.max(0, logicalX * clampedZoom - focusX));
          viewport.scrollTop = Math.min(maxScrollTop, Math.max(0, logicalY * clampedZoom - focusY));
        });

        return clampedZoom;
      });
    },
    [canZoom, clampZoom, contentHeight, contentWidth],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !canPan) {
        return;
      }

      const viewport = viewportRef.current;

      if (!viewport) {
        return;
      }

      dragStateRef.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      };

      viewport.setPointerCapture(event.pointerId);
      setIsDragging(true);
      event.preventDefault();
    },
    [canPan],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      const viewport = viewportRef.current;

      if (!dragState || dragState.pointerId !== event.pointerId || !viewport) {
        return;
      }

      viewport.scrollLeft = dragState.scrollLeft - (event.clientX - dragState.clientX);

      if (!lockVertical) {
        viewport.scrollTop = dragState.scrollTop - (event.clientY - dragState.clientY);
      }

      event.preventDefault();
    },
    [lockVertical],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragStateRef.current?.pointerId === event.pointerId) {
        finishDrag(event.pointerId);
      }
    },
    [finishDrag],
  );

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      const viewport = viewportRef.current;

      if (!viewport) {
        return;
      }

      if (canZoom && (event.ctrlKey || event.metaKey)) {
        const rect = viewport.getBoundingClientRect();
        const zoomDelta = event.deltaY < 0 ? zoomStep : -zoomStep;

        event.preventDefault();
        updateZoom(zoom + zoomDelta, {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
        return;
      }

      if (translateWheelToHorizontal && canPanX && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        viewport.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    },
    [canPanX, canZoom, translateWheelToHorizontal, updateZoom, zoom, zoomStep],
  );

  return {
    viewportRef,
    zoom,
    zoomPercentage: Math.round(zoom * 100),
    canZoom,
    canPan,
    canPanX,
    canPanY,
    isDragging,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel: handlePointerUp,
    handleWheel,
    zoomIn: () => {
      updateZoom(zoom + zoomStep);
    },
    zoomOut: () => {
      updateZoom(zoom - zoomStep);
    },
    resetZoom: () => {
      updateZoom(1);
    },
  };
}

export function getExecutionUnitLabel(unit: ExecutionUnitView, index: number) {
  const raw = unit.taskId ?? unit.sliceId ?? unit.id ?? unit.type ?? `U${index + 1}`;

  return raw.length > 14 ? `${raw.slice(0, 14)}…` : raw;
}

export function isMilestoneEffectivelyComplete(milestone: GsdDbMilestoneSummary) {
  if (isWorkflowStatusComplete(milestone.status)) {
    return true;
  }

  if (milestone.sliceCount > 0) {
    return getCompletedSliceCount(milestone) >= milestone.sliceCount;
  }

  return milestone.taskCount > 0 && milestone.completedTaskCount >= milestone.taskCount;
}

export function getSliceOrderRank(slice: GsdDbSliceSummary, activeSliceId: string | null) {
  if (slice.id === activeSliceId) {
    return 0;
  }

  const taskRanks = slice.tasks.map((task) => getWorkflowStatusRank(task.status));
  const bestTaskRank = taskRanks.length > 0 ? Math.min(...taskRanks) : Number.POSITIVE_INFINITY;

  return Math.min(getWorkflowStatusRank(slice.status), bestTaskRank);
}

export function getMilestoneOrderRank(milestone: GsdDbMilestoneSummary, activeMilestoneId: string | null) {
  if (milestone.id === activeMilestoneId) {
    return 0;
  }

  const sliceRanks = milestone.slices.map((slice) => getSliceOrderRank(slice, null));
  const bestSliceRank = sliceRanks.length > 0 ? Math.min(...sliceRanks) : Number.POSITIVE_INFINITY;

  return Math.min(getWorkflowStatusRank(milestone.status), bestSliceRank);
}

export function orderWorkflowMilestones(
  milestones: GsdDbMilestoneSummary[],
  activeMilestoneId: string | null,
) {
  return milestones
    .map((milestone, index) => ({ milestone, index }))
    .sort((first, second) => {
      const firstRank = getMilestoneOrderRank(first.milestone, activeMilestoneId);
      const secondRank = getMilestoneOrderRank(second.milestone, activeMilestoneId);

      return firstRank === secondRank
        ? compareWorkflowActivity(
          getMilestoneWorkflowActivityTime(first.milestone),
          getMilestoneWorkflowActivityTime(second.milestone),
          first.index,
          second.index,
        )
        : firstRank - secondRank;
    })
    .map((entry) => entry.milestone);
}

export function orderWorkflowSlices(slices: GsdDbSliceSummary[], activeSliceId: string | null) {
  return slices
    .map((slice, index) => ({ slice, index }))
    .sort((first, second) => {
      const firstRank = getSliceOrderRank(first.slice, activeSliceId);
      const secondRank = getSliceOrderRank(second.slice, activeSliceId);

      return firstRank === secondRank
        ? compareWorkflowActivity(
          getSliceWorkflowActivityTime(first.slice),
          getSliceWorkflowActivityTime(second.slice),
          first.index,
          second.index,
        )
        : firstRank - secondRank;
    })
    .map((entry) => entry.slice);
}

export function orderWorkflowTasks(tasks: GsdDbTaskSummary[], activeTaskId: string | null) {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((first, second) => {
      const firstRank = first.task.id === activeTaskId ? 0 : getWorkflowStatusRank(first.task.status);
      const secondRank = second.task.id === activeTaskId ? 0 : getWorkflowStatusRank(second.task.status);

      return firstRank === secondRank
        ? compareWorkflowActivity(
          getTaskWorkflowActivityTime(first.task),
          getTaskWorkflowActivityTime(second.task),
          first.index,
          second.index,
        )
        : firstRank - secondRank;
    })
    .map((entry) => entry.task);
}

export function findActiveMilestone(milestones: GsdDbMilestoneSummary[]) {
  return orderWorkflowMilestones(milestones, null).find((milestone) => !isMilestoneEffectivelyComplete(milestone)) ?? null;
}

export function findActiveTask(slice: GsdDbSliceSummary | null) {
  if (!slice) {
    return null;
  }

  return orderWorkflowTasks(slice.tasks, null).find((task) => !isWorkflowStatusComplete(task.status)) ?? null;
}

export function findActiveSlice(milestone: GsdDbMilestoneSummary | null) {
  if (!milestone) {
    return null;
  }

  return orderWorkflowSlices(milestone.slices, null).find((slice) => !isWorkflowStatusComplete(slice.status)) ?? null;
}

export function upsertProject(projects: ProjectRecord[], nextProject: ProjectRecord) {
  const existingIndex = projects.findIndex((project) => project.projectId === nextProject.projectId);

  if (existingIndex === -1) {
    return [...projects, nextProject];
  }

  return projects.map((project) => (project.projectId === nextProject.projectId ? nextProject : project));
}

export function mergeProjectInitJob(project: ProjectRecord, envelope: ProjectInitEnvelope): ProjectRecord {
  return {
    ...project,
    updatedAt: envelope.payload.job.updatedAt,
    lastEventId: envelope.id,
    ...(envelope.payload.continuity ? { continuity: envelope.payload.continuity } : {}),
    latestInitJob: envelope.payload.job,
  };
}

export function getLatestInitHistoryEntry(job: ProjectInitJob | null) {
  return job?.history.at(-1) ?? null;
}

export function hasActiveInitJob(job: ProjectInitJob | null) {
  return job !== null && !isProjectInitJobTerminalStage(job.stage);
}

export function canRetryInitJob(job: ProjectInitJob | null) {
  return job !== null && INIT_TERMINAL_FAILURE_STAGES.has(job.stage);
}

export function shouldShowInitAction(project: ProjectRecord | null) {
  if (!project || project.snapshot.status !== 'uninitialized') {
    return false;
  }

  return project.latestInitJob?.stage !== 'succeeded';
}

export function summarizeInitJob(job: ProjectInitJob | null, copy: UiCopy) {
  if (!job) {
    return null;
  }

  return job.refreshResult?.detail ?? getLatestInitHistoryEntry(job)?.detail ?? copy.empty.init;
}

export function initButtonLabel(
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

export function appPageLabel(page: AppPage, copy: UiCopy) {
  return page === 'overview' ? copy.labels.overview : copy.labels.details;
}

export function getProjectWorkflowPhase(project: ProjectRecord, copy: UiCopy) {
  const initJob = project.latestInitJob;

  if (initJob && hasActiveInitJob(initJob)) {
    return copy.initStageLabels[initJob.stage];
  }

  return copy.statusLabels[project.snapshot.status];
}

export function describeProjectCurrentStage(
  project: ProjectRecord,
  activeMilestone: GsdDbMilestoneSummary | null,
  copy: UiCopy,
) {
  const initJob = project.latestInitJob;

  if (initJob && hasActiveInitJob(initJob)) {
    return `${copy.labels.initialization}: ${copy.initStageLabels[initJob.stage]}`;
  }

  const activeSlice = findActiveSlice(activeMilestone);
  const activeTask = findActiveTask(activeSlice);

  if (activeTask && activeSlice && activeMilestone) {
    return `${activeMilestone.id}/${activeSlice.id}/${activeTask.id}`;
  }

  if (activeSlice && activeMilestone) {
    return `${activeMilestone.id}/${activeSlice.id}`;
  }

  if (activeMilestone) {
    return activeMilestone.id;
  }

  return getProjectWorkflowPhase(project, copy);
}

export function buildProjectOverviewRow(project: ProjectRecord, nowMs: number, copy: UiCopy): ProjectOverviewRow {
  const gsdDb = project.snapshot.sources.gsdDb.value ?? null;
  const metrics = project.snapshot.sources.metricsJson.value ?? null;
  const milestoneSource = gsdDb?.milestones ?? [];
  const activeMilestone = findActiveMilestone(milestoneSource);
  const milestones = orderWorkflowMilestones(milestoneSource, activeMilestone?.id ?? null);
  const executionStats = buildWorkflowExecutionStats(milestones, metrics, nowMs, copy);
  const progressPercent =
    executionStats.totalTasks === 0
      ? project.snapshot.status === 'initialized'
        ? 100
        : 0
      : Math.round((executionStats.completedTasks / executionStats.totalTasks) * 100);

  return {
    project,
    label: describeProject(project),
    continuity: getProjectContinuity(project),
    workflowPhase: getProjectWorkflowPhase(project, copy),
    currentStage: describeProjectCurrentStage(project, activeMilestone, copy),
    cost: metrics?.totals.cost ?? 0,
    totalTokens: metrics?.totals.totalTokens ?? 0,
    elapsedMs: executionStats.elapsedMs,
    estimatedRemainingMs: executionStats.estimatedRemainingMs,
    completedTasks: executionStats.completedTasks,
    totalTasks: executionStats.totalTasks,
    remainingTasks: executionStats.remainingTasks,
    progressPercent,
    warningCount: project.snapshot.warnings.length,
    unitCount: metrics?.unitCount ?? 0,
    metricsAvailable: metrics !== null,
  };
}

export function compareProjectOverviewRows(first: ProjectOverviewRow, second: ProjectOverviewRow) {
  const statusRank: Record<ProjectSnapshotStatus, number> = {
    degraded: 0,
    uninitialized: 1,
    initialized: 2,
  };
  const firstRank = statusRank[first.project.snapshot.status];
  const secondRank = statusRank[second.project.snapshot.status];

  if (firstRank !== secondRank) {
    return firstRank - secondRank;
  }

  return second.cost - first.cost || first.label.localeCompare(second.label);
}

export function buildPortfolioSummary(projects: ProjectRecord[], nowMs: number, copy: UiCopy): PortfolioSummary {
  const rows = projects.map((project) => buildProjectOverviewRow(project, nowMs, copy)).sort(compareProjectOverviewRows);
  const elapsedValues = rows
    .map((row) => row.elapsedMs)
    .filter((value): value is number => value !== null && value > 0);

  return {
    rows,
    totalCost: rows.reduce((total, row) => total + row.cost, 0),
    totalTokens: rows.reduce((total, row) => total + row.totalTokens, 0),
    totalElapsedMs: elapsedValues.length === 0 ? null : elapsedValues.reduce((total, value) => total + value, 0),
    totalWarnings: rows.reduce((total, row) => total + row.warningCount, 0),
    completedTasks: rows.reduce((total, row) => total + row.completedTasks, 0),
    totalTasks: rows.reduce((total, row) => total + row.totalTasks, 0),
    remainingTasks: rows.reduce((total, row) => total + row.remainingTasks, 0),
    activeProjects: rows.filter((row) => hasActiveInitJob(row.project.latestInitJob) || row.remainingTasks > 0).length,
    metricsProjects: rows.filter((row) => row.metricsAvailable).length,
  };
}

export function AppPageIcon({ page }: { page: AppPage }) {
  if (page === 'overview') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4 5h12" />
        <path d="M4 10h12" />
        <path d="M4 15h7" />
        <path d="M14 13.5 16.5 16 19 11" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 4h12v12H4z" />
      <path d="M7 8h6" />
      <path d="M7 12h4" />
    </svg>
  );
}

export function OpenDetailsIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 10h10" />
      <path d="m11 6 4 4-4 4" />
    </svg>
  );
}

export function workflowTabLabel(tab: WorkflowTab, copy: UiCopy) {
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

export function WorkflowIcon({ tab }: { tab: WorkflowTab }) {
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

export function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 6.5h5l1.5 2h6.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15V8a1.5 1.5 0 0 1 .5-1.5Z" />
      <path d="M4 6V4.8A1.3 1.3 0 0 1 5.3 3.5h3.1l1.4 1.6H15a1 1 0 0 1 1 1v2.4" />
    </svg>
  );
}

export function ZoomInIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="9" cy="9" r="5.5" />
      <path d="M9 6.5v5" />
      <path d="M6.5 9h5" />
      <path d="m13.2 13.2 3.3 3.3" />
    </svg>
  );
}

export function ZoomOutIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="9" cy="9" r="5.5" />
      <path d="M6.5 9h5" />
      <path d="m13.2 13.2 3.3 3.3" />
    </svg>
  );
}

export function ResetZoomIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.5 10a5.5 5.5 0 1 0 2-4.2" />
      <path d="M4 4.5v3.8h3.8" />
      <path d="M10 7.3v2.6" />
      <path d="M8.7 8.6h2.6" />
    </svg>
  );
}
