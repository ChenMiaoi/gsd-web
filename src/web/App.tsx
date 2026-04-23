import {
  type KeyboardEvent,
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
type AppPage = 'overview' | 'details';
type AppRoute =
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

type TaskTimelineEntry = {
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

type ProjectOverviewRow = {
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

type PortfolioSummary = {
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

const APP_PAGES: readonly AppPage[] = ['overview', 'details'];
const ROUTE_BASE_PATH = '/hello';
const ROUTE_OVERVIEW_PATH = `${ROUTE_BASE_PATH}/all`;
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
const INVENTORY_AUTO_REFRESH_MS = 5_000;
const INIT_TERMINAL_FAILURE_STAGES: ReadonlySet<ProjectInitJobStage> = new Set([
  'failed',
  'timed_out',
  'cancelled',
]);
const WARNING_TEXT_LIMIT = 240;
const WORKFLOW_GRAPH_BASE_WIDTH = 860;
const WORKFLOW_GRAPH_BASE_HEIGHT = 252;
const WORKFLOW_GRAPH_ROW_HEIGHT = 72;
const WORKFLOW_GRAPH_MIN_ZOOM = 0.75;
const WORKFLOW_GRAPH_MAX_ZOOM = 1.6;
const WORKFLOW_GRAPH_ZOOM_STEP = 0.15;
const RUNTIME_CHART_WIDTH = 420;
const RUNTIME_CHART_HEIGHT = 140;
const KNOWN_EVENT_TYPES: ReadonlySet<KnownEventType> = new Set([
  'service.ready',
  'project.registered',
  'project.refreshed',
  'project.relinked',
  'project.monitor.updated',
  'project.init.updated',
]);

function stripTrailingSlashes(pathname: string) {
  const stripped = pathname.replace(/\/+$/, '');

  return stripped.length === 0 ? '/' : stripped;
}

function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseAppRoute(pathname: string): AppRoute {
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

function getAppRoutePath(route: AppRoute) {
  if (route.page === 'welcome') {
    return ROUTE_BASE_PATH;
  }

  if (route.page === 'overview') {
    return ROUTE_OVERVIEW_PATH;
  }

  return `${ROUTE_BASE_PATH}/${encodeURIComponent(route.projectId)}`;
}

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

function trimDisplayName(value: string | null | undefined) {
  const trimmed = value?.trim() ?? '';

  return trimmed.length === 0 ? null : trimmed;
}

function isGenericDisplayName(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase().replace(/[\s_-]+/gu, ' ') ?? '';

  return normalized === 'project' || normalized === 'untitled project' || normalized === 'project snapshot fixture';
}

function describeProject(project: ProjectRecord) {
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

function isWorkflowStatusPending(status: string | null) {
  return status !== null && /^(pending|queued|planned|ready|todo|to_do|not_started|not-started|open)$/iu.test(status.trim());
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

  if (isWorkflowStatusPending(status)) {
    return 'pending';
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

function getDisplayStartedAt(
  aggregate: ExecutionAggregate | undefined,
  entity: {
    startedAt: string | number | null;
  },
) {
  return aggregate?.firstStartedAtMs ?? normalizeWorkflowTimestamp(entity.startedAt);
}

function getDisplayFinishedAt(
  aggregate: ExecutionAggregate | undefined,
  entity: {
    finishedAt: string | number | null;
  },
) {
  return aggregate?.lastFinishedAtMs ?? normalizeWorkflowTimestamp(entity.finishedAt);
}

function getTaskTimelineActivityTime(entry: TaskTimelineEntry) {
  if (entry.startedAtMs === null && entry.finishedAtMs === null) {
    return null;
  }

  return Math.max(entry.startedAtMs ?? Number.NEGATIVE_INFINITY, entry.finishedAtMs ?? Number.NEGATIVE_INFINITY);
}

function getTaskTimelineStatusRank(entry: TaskTimelineEntry) {
  return getWorkflowStatusRank(entry.task.status);
}

function buildTaskTimelineEntries(
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

function getWorkflowStatusRank(status: string | null) {
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

function getWorkflowEntityActivityTime(entity: {
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

function getTaskWorkflowActivityTime(task: GsdDbTaskSummary) {
  return getWorkflowEntityActivityTime(task);
}

function getSliceWorkflowActivityTime(slice: GsdDbSliceSummary) {
  const ownActivityMs = getWorkflowEntityActivityTime(slice);
  const taskActivityTimes = slice.tasks
    .map(getTaskWorkflowActivityTime)
    .filter((value): value is number => value !== null);

  return taskActivityTimes.length > 0
    ? Math.max(...taskActivityTimes, ownActivityMs ?? Number.NEGATIVE_INFINITY)
    : ownActivityMs;
}

function getMilestoneWorkflowActivityTime(milestone: GsdDbMilestoneSummary) {
  const ownActivityMs = getWorkflowEntityActivityTime(milestone);
  const sliceActivityTimes = milestone.slices
    .map(getSliceWorkflowActivityTime)
    .filter((value): value is number => value !== null);

  return sliceActivityTimes.length > 0
    ? Math.max(...sliceActivityTimes, ownActivityMs ?? Number.NEGATIVE_INFINITY)
    : ownActivityMs;
}

function compareWorkflowActivity(
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

function getMilestoneProgressPercent(milestone: GsdDbMilestoneSummary) {
  const milestoneProgress = getMilestoneProgress(milestone);

  if (milestoneProgress.total === 0) {
    return isMilestoneEffectivelyComplete(milestone) ? 100 : 0;
  }

  return Math.max(0, Math.min(100, Math.round((milestoneProgress.completed / milestoneProgress.total) * 100)));
}

function getSliceProgressPercent(slice: GsdDbSliceSummary) {
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

function getWorkflowFocus(
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

function clampRecentUnits(units: ExecutionUnitView[], limit: number = 10) {
  return units.slice(Math.max(0, units.length - limit));
}

type SparklinePoint = {
  x: number;
  y: number;
  value: number;
};

type DragScrollPointerState = {
  pointerId: number;
  clientX: number;
  clientY: number;
  scrollLeft: number;
  scrollTop: number;
};

type DragScrollViewportOptions = {
  contentWidth: number;
  contentHeight: number;
  initialZoom?: number;
  minZoom?: number;
  maxZoom?: number;
  zoomStep?: number;
  lockVertical?: boolean;
  translateWheelToHorizontal?: boolean;
};

type WorkflowGraphConnector = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

function buildSparklinePoints(values: number[], width: number, height: number) {
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

function buildSparklineSeries(values: number[], width: number, height: number) {
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

function buildSparklineAreaPoints(points: SparklinePoint[], height: number) {
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

function clampWorkflowGraphZoom(value: number) {
  return Math.max(
    WORKFLOW_GRAPH_MIN_ZOOM,
    Math.min(WORKFLOW_GRAPH_MAX_ZOOM, Math.round(value * 100) / 100),
  );
}

function buildWorkflowGraphConnectorPath(connector: WorkflowGraphConnector) {
  const curve = Math.max(20, Math.abs(connector.x2 - connector.x1) * 0.38);

  return [
    `M ${connector.x1.toFixed(2)} ${connector.y1.toFixed(2)}`,
    `C ${(connector.x1 + curve).toFixed(2)} ${connector.y1.toFixed(2)}`,
    `${(connector.x2 - curve).toFixed(2)} ${connector.y2.toFixed(2)}`,
    `${connector.x2.toFixed(2)} ${connector.y2.toFixed(2)}`,
  ].join(' ');
}

function useDragScrollViewport({
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

function getExecutionUnitLabel(unit: ExecutionUnitView, index: number) {
  const raw = unit.taskId ?? unit.sliceId ?? unit.id ?? unit.type ?? `U${index + 1}`;

  return raw.length > 14 ? `${raw.slice(0, 14)}…` : raw;
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

function getSliceOrderRank(slice: GsdDbSliceSummary, activeSliceId: string | null) {
  if (slice.id === activeSliceId) {
    return 0;
  }

  const taskRanks = slice.tasks.map((task) => getWorkflowStatusRank(task.status));
  const bestTaskRank = taskRanks.length > 0 ? Math.min(...taskRanks) : Number.POSITIVE_INFINITY;

  return Math.min(getWorkflowStatusRank(slice.status), bestTaskRank);
}

function getMilestoneOrderRank(milestone: GsdDbMilestoneSummary, activeMilestoneId: string | null) {
  if (milestone.id === activeMilestoneId) {
    return 0;
  }

  const sliceRanks = milestone.slices.map((slice) => getSliceOrderRank(slice, null));
  const bestSliceRank = sliceRanks.length > 0 ? Math.min(...sliceRanks) : Number.POSITIVE_INFINITY;

  return Math.min(getWorkflowStatusRank(milestone.status), bestSliceRank);
}

function orderWorkflowMilestones(
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

function orderWorkflowSlices(slices: GsdDbSliceSummary[], activeSliceId: string | null) {
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

function orderWorkflowTasks(tasks: GsdDbTaskSummary[], activeTaskId: string | null) {
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

function findActiveMilestone(milestones: GsdDbMilestoneSummary[]) {
  return orderWorkflowMilestones(milestones, null).find((milestone) => !isMilestoneEffectivelyComplete(milestone)) ?? null;
}

function findActiveTask(slice: GsdDbSliceSummary | null) {
  if (!slice) {
    return null;
  }

  return orderWorkflowTasks(slice.tasks, null).find((task) => !isWorkflowStatusComplete(task.status)) ?? null;
}

function findActiveSlice(milestone: GsdDbMilestoneSummary | null) {
  if (!milestone) {
    return null;
  }

  return orderWorkflowSlices(milestone.slices, null).find((slice) => !isWorkflowStatusComplete(slice.status)) ?? null;
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

function appPageLabel(page: AppPage, copy: UiCopy) {
  return page === 'overview' ? copy.labels.overview : copy.labels.details;
}

function getProjectWorkflowPhase(project: ProjectRecord, copy: UiCopy) {
  const initJob = project.latestInitJob;

  if (initJob && hasActiveInitJob(initJob)) {
    return copy.initStageLabels[initJob.stage];
  }

  return copy.statusLabels[project.snapshot.status];
}

function describeProjectCurrentStage(
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

function buildProjectOverviewRow(project: ProjectRecord, nowMs: number, copy: UiCopy): ProjectOverviewRow {
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

function compareProjectOverviewRows(first: ProjectOverviewRow, second: ProjectOverviewRow) {
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

function buildPortfolioSummary(projects: ProjectRecord[], nowMs: number, copy: UiCopy): PortfolioSummary {
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

function AppPageIcon({ page }: { page: AppPage }) {
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

function OpenDetailsIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 10h10" />
      <path d="m11 6 4 4-4 4" />
    </svg>
  );
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

function ZoomInIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="9" cy="9" r="5.5" />
      <path d="M9 6.5v5" />
      <path d="M6.5 9h5" />
      <path d="m13.2 13.2 3.3 3.3" />
    </svg>
  );
}

function ZoomOutIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="9" cy="9" r="5.5" />
      <path d="M6.5 9h5" />
      <path d="m13.2 13.2 3.3 3.3" />
    </svg>
  );
}

function ResetZoomIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.5 10a5.5 5.5 0 1 0 2-4.2" />
      <path d="M4 4.5v3.8h3.8" />
      <path d="M10 7.3v2.6" />
      <path d="M8.7 8.6h2.6" />
    </svg>
  );
}

function WorkflowGraphPanel({
  milestones,
  dependencies,
  activeMilestoneId,
  activeSliceId,
  activeTask,
  copy,
}: {
  milestones: GsdDbMilestoneSummary[];
  dependencies: SliceDependencyView[];
  activeMilestoneId: string | null;
  activeSliceId: string | null;
  activeTask: GsdDbTaskSummary | null;
  copy: UiCopy;
}) {
  const { focusedMilestone, focusedSlice, focusedTask } = getWorkflowFocus(
    milestones,
    activeMilestoneId,
    activeSliceId,
    activeTask,
  );
  const visibleMilestones = milestones;
  const visibleSlices = focusedMilestone?.slices ?? [];
  const visibleTasks = focusedSlice?.tasks ?? [];
  const activePath = [focusedMilestone?.id, focusedSlice?.id, focusedTask?.id]
    .filter((segment): segment is string => Boolean(segment))
    .join(' -> ');
  const visibleDependencies =
    focusedMilestone === null
      ? dependencies
      : dependencies.filter((dependency) => dependency.milestoneId === focusedMilestone.id);
  const graphHeight = Math.max(
    WORKFLOW_GRAPH_BASE_HEIGHT,
    Math.max(visibleMilestones.length, visibleSlices.length, visibleTasks.length, 3) * WORKFLOW_GRAPH_ROW_HEIGHT,
  );
  const graphCanvasRef = useRef<HTMLDivElement | null>(null);
  const activeMilestoneNodeRef = useRef<HTMLLIElement | null>(null);
  const activeSliceNodeRef = useRef<HTMLLIElement | null>(null);
  const activeTaskNodeRef = useRef<HTMLLIElement | null>(null);
  const [connectors, setConnectors] = useState<{
    milestoneToSlice: WorkflowGraphConnector | null;
    sliceToTask: WorkflowGraphConnector | null;
  }>({
    milestoneToSlice: null,
    sliceToTask: null,
  });
  const setActiveMilestoneNodeRef = useCallback((node: HTMLLIElement | null) => {
    activeMilestoneNodeRef.current = node;
  }, []);
  const setActiveSliceNodeRef = useCallback((node: HTMLLIElement | null) => {
    activeSliceNodeRef.current = node;
  }, []);
  const setActiveTaskNodeRef = useCallback((node: HTMLLIElement | null) => {
    activeTaskNodeRef.current = node;
  }, []);
  const graphViewport = useDragScrollViewport({
    contentWidth: WORKFLOW_GRAPH_BASE_WIDTH,
    contentHeight: graphHeight,
    initialZoom: 1,
    minZoom: WORKFLOW_GRAPH_MIN_ZOOM,
    maxZoom: WORKFLOW_GRAPH_MAX_ZOOM,
    zoomStep: WORKFLOW_GRAPH_ZOOM_STEP,
  });
  const graphWidth = WORKFLOW_GRAPH_BASE_WIDTH * graphViewport.zoom;
  const graphScaledHeight = graphHeight * graphViewport.zoom;

  useEffect(() => {
    const canvas = graphCanvasRef.current;

    if (!canvas) {
      return undefined;
    }

    const measureConnectors = () => {
      const canvasRect = canvas.getBoundingClientRect();
      const measure = (from: HTMLElement | null, to: HTMLElement | null) => {
        if (!from || !to) {
          return null;
        }

        const fromRect = from.getBoundingClientRect();
        const toRect = to.getBoundingClientRect();

        return {
          x1: fromRect.right - canvasRect.left,
          y1: fromRect.top - canvasRect.top + fromRect.height / 2,
          x2: toRect.left - canvasRect.left,
          y2: toRect.top - canvasRect.top + toRect.height / 2,
        };
      };

      setConnectors({
        milestoneToSlice: measure(activeMilestoneNodeRef.current, activeSliceNodeRef.current),
        sliceToTask:
          focusedTask !== null
            ? measure(activeSliceNodeRef.current, activeTaskNodeRef.current)
            : null,
      });
    };

    const frameId = window.requestAnimationFrame(() => {
      measureConnectors();
    });
    const handleResize = () => {
      measureConnectors();
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', handleResize);
    };
  }, [
    focusedMilestone?.id,
    focusedSlice?.id,
    focusedTask?.id,
    graphHeight,
    graphViewport.zoom,
    visibleMilestones.length,
    visibleSlices.length,
    visibleTasks.length,
  ]);

  return (
    <section className="dashboard-panel workflow-graph-panel" data-testid="workflow-graph-panel">
      <div className="dashboard-panel__header dashboard-panel__header--graph">
        <div className="dashboard-panel__copy">
          <h4>{copy.labels.workflowVisualizer}</h4>
          <p>
            {copy.labels.criticalPath}: <span className="inline-code">{activePath || copy.messages.notRecorded}</span>
          </p>
        </div>
        <div className="detail-header__meta">
          <span className="meta-badge">{copy.formatCount(milestones.length, 'milestone')}</span>
          <span className="meta-badge">
            {copy.formatCount(focusedMilestone?.sliceCount ?? 0, 'slice')}
          </span>
          <span className="meta-badge">
            {copy.formatCount(focusedMilestone?.taskCount ?? 0, 'task')}
          </span>
        </div>
      </div>

      {milestones.length === 0 ? (
        <p>{copy.messages.noMilestones}</p>
      ) : (
        <>
          <div className="workflow-graph__stage">
            <div className="workflow-graph__toolbar">
              <p className="workflow-graph__hint">{copy.messages.dragGraphHint}</p>

              <div className="workflow-graph__controls">
                <span className="meta-badge">{graphViewport.zoomPercentage}%</span>
                <button
                  type="button"
                  className="secondary-button secondary-button--icon"
                  aria-label={copy.actions.zoomOutGraph}
                  title={copy.actions.zoomOutGraph}
                  disabled={!graphViewport.canZoom || graphViewport.zoom <= WORKFLOW_GRAPH_MIN_ZOOM}
                  onClick={() => {
                    graphViewport.zoomOut();
                  }}
                >
                  <ZoomOutIcon />
                </button>
                <button
                  type="button"
                  className="secondary-button secondary-button--icon"
                  aria-label={copy.actions.zoomInGraph}
                  title={copy.actions.zoomInGraph}
                  disabled={!graphViewport.canZoom || graphViewport.zoom >= WORKFLOW_GRAPH_MAX_ZOOM}
                  onClick={() => {
                    graphViewport.zoomIn();
                  }}
                >
                  <ZoomInIcon />
                </button>
                <button
                  type="button"
                  className="secondary-button secondary-button--icon"
                  aria-label={copy.actions.resetGraphZoom}
                  title={copy.actions.resetGraphZoom}
                  disabled={graphViewport.zoom === 1}
                  onClick={() => {
                    graphViewport.resetZoom();
                  }}
                >
                  <ResetZoomIcon />
                </button>
              </div>
            </div>

            <div
              ref={graphViewport.viewportRef}
              className="workflow-graph__viewport"
              data-draggable={graphViewport.canPan}
              data-dragging={graphViewport.isDragging}
              data-testid="workflow-graph-viewport"
              onPointerDown={graphViewport.handlePointerDown}
              onPointerMove={graphViewport.handlePointerMove}
              onPointerUp={graphViewport.handlePointerUp}
              onPointerCancel={graphViewport.handlePointerCancel}
              onWheel={graphViewport.handleWheel}
            >
              <div
                ref={graphCanvasRef}
                className="workflow-graph__canvas"
                style={{
                  width: `${graphWidth}px`,
                  height: `${graphScaledHeight}px`,
                }}
              >
                <svg
                  className="workflow-graph__overlay"
                  aria-hidden="true"
                  viewBox={`0 0 ${graphWidth} ${graphScaledHeight}`}
                >
                  <defs>
                    <linearGradient id="workflow-graph-connector-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="rgba(255, 83, 207, 0.94)" />
                      <stop offset="100%" stopColor="rgba(66, 221, 255, 0.96)" />
                    </linearGradient>
                    <marker
                      id="workflow-graph-arrowhead"
                      markerWidth="10"
                      markerHeight="10"
                      refX="8"
                      refY="3.5"
                      orient="auto"
                    >
                      <path d="M0 0 8 3.5 0 7z" fill="rgba(66, 221, 255, 0.96)" />
                    </marker>
                  </defs>

                  {connectors.milestoneToSlice ? (
                    <path
                      className="workflow-graph__connector-path"
                      d={buildWorkflowGraphConnectorPath(connectors.milestoneToSlice)}
                      markerEnd="url(#workflow-graph-arrowhead)"
                    />
                  ) : null}

                  {connectors.sliceToTask ? (
                    <path
                      className="workflow-graph__connector-path"
                      d={buildWorkflowGraphConnectorPath(connectors.sliceToTask)}
                      markerEnd="url(#workflow-graph-arrowhead)"
                    />
                  ) : null}
                </svg>

                <div
                  className="workflow-graph"
                  style={{
                    width: `${WORKFLOW_GRAPH_BASE_WIDTH}px`,
                    height: `${graphHeight}px`,
                    transform: `scale(${graphViewport.zoom})`,
                  }}
                >
                  <section className="workflow-graph__column">
                    <span className="workflow-graph__label">{copy.labels.gsdMilestones}</span>
                    <ol className="workflow-graph__stack">
                      {visibleMilestones.map((milestone) => {
                        const isActive = milestone.id === focusedMilestone?.id;

                        return (
                          <li
                            className="workflow-graph__node"
                            data-active={isActive}
                            data-status={statusTone(milestone.status)}
                            key={milestone.id}
                            ref={isActive ? setActiveMilestoneNodeRef : undefined}
                          >
                            <span className="workflow-graph__node-id">{milestone.id}</span>
                          </li>
                        );
                      })}
                    </ol>
                  </section>

                  <div className="workflow-graph__connector" aria-hidden="true" />

                  <section className="workflow-graph__column">
                    <span className="workflow-graph__label">{copy.labels.slices}</span>
                    <ol className="workflow-graph__stack">
                      {visibleSlices.length === 0 ? (
                        <li className="workflow-graph__node workflow-graph__node--empty" data-status="neutral">
                          <span className="workflow-graph__node-id">--</span>
                        </li>
                      ) : (
                        visibleSlices.map((slice) => {
                          const isActive = slice.id === focusedSlice?.id;

                          return (
                            <li
                              className="workflow-graph__node"
                              data-active={isActive}
                              data-status={statusTone(slice.status)}
                              key={`${focusedMilestone?.id ?? 'milestone'}-${slice.id}`}
                              ref={isActive ? setActiveSliceNodeRef : undefined}
                            >
                              <span className="workflow-graph__node-id">{slice.id}</span>
                            </li>
                          );
                        })
                      )}
                    </ol>
                  </section>

                  <div className="workflow-graph__connector" aria-hidden="true" />

                  <section className="workflow-graph__column">
                    <span className="workflow-graph__label">{copy.labels.tasks}</span>
                    <ol className="workflow-graph__stack">
                      {visibleTasks.length === 0 ? (
                        <li className="workflow-graph__node workflow-graph__node--empty" data-status="neutral">
                          <span className="workflow-graph__node-id">--</span>
                        </li>
                      ) : (
                        visibleTasks.map((task) => {
                          const isActive = task.id === focusedTask?.id;

                          return (
                            <li
                              className="workflow-graph__node"
                              data-active={isActive}
                              data-status={isActive ? 'active' : statusTone(task.status)}
                              key={`${focusedSlice?.id ?? 'slice'}-${task.id}`}
                              ref={isActive ? setActiveTaskNodeRef : undefined}
                            >
                              <span className="workflow-graph__node-id">{task.id}</span>
                            </li>
                          );
                        })
                      )}
                    </ol>
                  </section>
                </div>
              </div>
            </div>
          </div>

          <div className="workflow-graph__dependencies">
            <span className="workflow-graph__dependencies-label">{copy.labels.dependencies}</span>
            {visibleDependencies.length === 0 ? (
              <span className="workflow-graph__dependency-pill">
                {copy.messages.noDependencies}
              </span>
            ) : (
              visibleDependencies.map((dependency) => (
                <span
                  className="workflow-graph__dependency-pill"
                  key={`${dependency.milestoneId}-${dependency.fromId}-${dependency.toId}`}
                >
                  {dependency.fromId} -&gt; {dependency.toId}
                </span>
              ))
            )}
            <span className="workflow-graph__dependencies-count">
              {copy.formatCount(visibleDependencies.length, 'entry')}
            </span>
          </div>
        </>
      )}
    </section>
  );
}

function RuntimeMetricsPanel({
  metrics,
  executionStats,
  workflowPhase,
  locale,
  copy,
}: {
  metrics: GsdMetricsSummaryValue | null;
  executionStats: WorkflowExecutionStats;
  workflowPhase: string;
  locale: Locale;
  copy: UiCopy;
}) {
  const chartUnits = clampRecentUnits(executionStats.units, 9);
  const durationSeries = chartUnits.map((unit) => Math.max(0, unit.durationMs ?? 0));
  const tokenSeries = chartUnits.map((unit) => Math.max(0, unit.totalTokens));
  const activitySeries = chartUnits.map((unit) => Math.max(0, unit.toolCalls + unit.apiRequests));
  const hasChartData = durationSeries.length > 0;

  return (
    <section className="dashboard-panel runtime-metrics-panel" data-testid="runtime-metrics-dashboard">
      <div className="dashboard-panel__header">
        <div className="dashboard-panel__copy">
          <h4>{copy.labels.metrics}</h4>
          <p>{copy.labels.source}: .gsd/metrics.json</p>
        </div>
        <div className="detail-header__meta">
          <span className="meta-badge">{copy.formatCount(executionStats.remainingTasks, 'task')}</span>
          <span className="meta-badge">
            {formatDuration(executionStats.estimatedRemainingMs, locale, copy.messages.estimateUnavailable)}
          </span>
        </div>
      </div>

      <div className="runtime-metrics-panel__stats">
        <div>
          <span className="stat-card__label">{copy.labels.elapsed}</span>
          <strong>{formatDuration(executionStats.elapsedMs, locale, copy.messages.notRecorded)}</strong>
        </div>
        <div>
          <span className="stat-card__label">{copy.labels.units}</span>
          <strong>{executionStats.units.length}</strong>
        </div>
        <div>
          <span className="stat-card__label">{copy.labels.tokens}</span>
          <strong>{formatCompactNumber(metrics?.totals.totalTokens ?? 0, locale)}</strong>
        </div>
        <div>
          <span className="stat-card__label">{copy.labels.apiRequests}</span>
          <strong>{formatCompactNumber(metrics?.totals.apiRequests ?? 0, locale)}</strong>
        </div>
      </div>

      <div className="runtime-metrics-panel__chart-shell">
        {hasChartData ? (
          <svg
            className="runtime-metrics-panel__chart"
            viewBox="0 0 420 180"
            role="img"
            aria-label={copy.labels.metrics}
          >
            <defs>
              <linearGradient id="runtimeAreaGradient" x1="0%" x2="0%" y1="0%" y2="100%">
                <stop offset="0%" stopColor="rgba(255, 83, 207, 0.26)" />
                <stop offset="100%" stopColor="rgba(255, 83, 207, 0)" />
              </linearGradient>
            </defs>

            {['25%', '50%', '75%'].map((label, index) => (
              <line
                key={label}
                className="runtime-metrics-panel__grid-line"
                x1="0"
                x2="420"
                y1={40 + index * 35}
                y2={40 + index * 35}
              />
            ))}

            <polyline
              className="runtime-metrics-panel__series runtime-metrics-panel__series--duration"
              points={buildSparklinePoints(durationSeries, 420, 180)}
            />
            <polyline
              className="runtime-metrics-panel__series runtime-metrics-panel__series--tokens"
              points={buildSparklinePoints(tokenSeries, 420, 180)}
            />
            <polyline
              className="runtime-metrics-panel__series runtime-metrics-panel__series--activity"
              points={buildSparklinePoints(activitySeries, 420, 180)}
            />
          </svg>
        ) : (
          <p className="runtime-metrics-panel__empty">{copy.messages.noExecutionUnits}</p>
        )}

        <div className="runtime-metrics-panel__legend">
          <span data-series="duration">{copy.labels.actualDuration}</span>
          <span data-series="tokens">{copy.labels.tokens}</span>
          <span data-series="activity">{copy.labels.toolCalls}</span>
        </div>
      </div>

      <div className="runtime-metrics-panel__footer">
        <div>
          <span className="stat-card__label">{copy.labels.currentStage}</span>
          <strong>{workflowPhase}</strong>
        </div>
        <div>
          <span className="stat-card__label">{copy.labels.averageTaskDuration}</span>
          <strong>{formatDuration(executionStats.averageTaskDurationMs, locale, copy.messages.notRecorded)}</strong>
        </div>
        <div>
          <span className="stat-card__label">{copy.labels.estimatedFinish}</span>
          <strong>
            {executionStats.estimatedFinishAtMs === null
              ? copy.messages.estimateUnavailable
              : formatTimestamp(new Date(executionStats.estimatedFinishAtMs).toISOString(), locale)}
          </strong>
        </div>
      </div>
    </section>
  );
}

function WorkflowMilestoneRail({
  milestones,
  dependencies,
  activeMilestoneId,
  activeSliceId,
  activeTask,
  validationIssueCount,
  locale,
  copy,
  variant = 'rail',
}: {
  milestones: GsdDbMilestoneSummary[];
  dependencies: SliceDependencyView[];
  activeMilestoneId: string | null;
  activeSliceId: string | null;
  activeTask: GsdDbTaskSummary | null;
  validationIssueCount: number;
  locale: Locale;
  copy: UiCopy;
  variant?: 'rail' | 'dashboard';
}) {
  const orderedMilestones = orderWorkflowMilestones(milestones, activeMilestoneId);
  const { focusedMilestone, focusedSlice, focusedTask } = getWorkflowFocus(
    orderedMilestones,
    activeMilestoneId,
    activeSliceId,
    activeTask,
  );
  const dependencyLookup = new Map(
    dependencies.map((dependency) => [workflowSliceKey(dependency.milestoneId, dependency.toId), dependency]),
  );
  const focusedPath =
    focusedMilestone !== null && focusedSlice !== null && focusedTask !== null
      ? `${focusedMilestone.id} -> ${focusedSlice.id} -> ${focusedTask.id}`
      : focusedMilestone !== null && focusedSlice !== null
        ? `${focusedMilestone.id} -> ${focusedSlice.id}`
        : focusedMilestone?.id ?? copy.messages.notRecorded;

  return (
    <aside
      className={`milestone-rail ${variant === 'dashboard' ? 'milestone-rail--dashboard' : ''}`}
      aria-label={variant === 'dashboard' ? copy.labels.progress : copy.labels.milestoneRail}
    >
      <div className="milestone-rail__header">
        <div>
          <span className="stat-card__label">
            {variant === 'dashboard' ? copy.labels.progress : copy.labels.milestoneRail}
          </span>
          <strong>{copy.formatCount(orderedMilestones.length, 'milestone')}</strong>
        </div>
        {variant === 'dashboard' ? <span className="meta-badge">{focusedPath}</span> : null}
      </div>

      {orderedMilestones.length === 0 ? (
        <p className="milestone-rail__empty">{copy.messages.noMilestones}</p>
      ) : (
        <div className="milestone-focus">
          <div className="milestone-focus__body" data-testid="milestone-focus-panel">
            {orderedMilestones.map((milestone) => {
              const milestoneExpanded = focusedMilestone?.id === milestone.id;
              const milestoneProgress = getMilestoneProgress(milestone);
              const milestoneProgressPercent = getMilestoneProgressPercent(milestone);
              const milestoneSlices = orderWorkflowSlices(
                milestone.slices,
                milestoneExpanded ? focusedSlice?.id ?? null : null,
              );
              const milestonePath =
                milestoneExpanded && focusedSlice !== null && focusedTask !== null
                  ? `${milestone.id} -> ${focusedSlice.id} -> ${focusedTask.id}`
                  : milestoneExpanded && focusedSlice !== null
                    ? `${milestone.id} -> ${focusedSlice.id}`
                    : milestone.id;

              return (
                <details
                  className="milestone-focus__milestone"
                  data-active={milestoneExpanded}
                  data-status={statusTone(milestone.status)}
                  data-testid="milestone-focus-milestone"
                  key={milestone.id}
                  open={milestoneExpanded}
                >
                  <summary className="milestone-focus__summary">
                    <div className="milestone-focus__summary-header">
                      <div className="milestone-focus__summary-title">
                        <span className="meta-badge workflow-id-badge" data-level="milestone">
                          {milestone.id}
                        </span>
                        <strong>{milestoneTitle(milestone)}</strong>
                      </div>
                      <span className="status-pill" data-status={statusTone(milestone.status)}>
                        {milestone.status ?? copy.messages.unknown}
                      </span>
                    </div>

                    <div className="milestone-focus__summary-meter" aria-hidden="true">
                      <span style={{ width: `${milestoneProgressPercent}%` }} />
                    </div>

                    <div className="milestone-focus__summary-meta">
                      <span>
                        {milestoneProgress.completed}/{milestoneProgress.total} {copy.labels.completed}
                      </span>
                      <span>{copy.formatCount(milestone.sliceCount, 'slice')}</span>
                      <span>
                        {milestone.completedTaskCount}/{milestone.taskCount} {copy.labels.tasks}
                      </span>
                    </div>

                    <div className="milestone-focus__summary-path">
                      <span className="stat-card__label">{copy.labels.criticalPath}</span>
                      <strong>{milestonePath}</strong>
                    </div>
                  </summary>

                  {milestoneSlices.length > 0 ? (
                    <div className="milestone-focus__slice-stack">
                      {milestoneSlices.map((slice) => {
                        const sliceActive = milestoneExpanded && focusedSlice?.id === slice.id;
                        const sliceCurrentTask = sliceActive ? activeTask : findActiveTask(slice);
                        const slicePercent = getSliceProgressPercent(slice);
                        const dependency = dependencyLookup.get(workflowSliceKey(milestone.id, slice.id)) ?? null;
                        const orderedTasks = orderWorkflowTasks(
                          slice.tasks,
                          sliceCurrentTask?.id ?? null,
                        );

                        return (
                          <details
                            className="milestone-focus__slice"
                            data-active={sliceActive}
                            data-status={statusTone(slice.status)}
                            data-risk={getSliceRiskLevel(slice)}
                            data-testid="milestone-focus-slice"
                            key={`${milestone.id}-${slice.id}`}
                            open={sliceActive}
                          >
                            <summary className="milestone-focus__slice-summary">
                              <div className="milestone-focus__slice-header">
                                <span className="meta-badge workflow-id-badge" data-level="slice">
                                  {slice.id}
                                </span>
                                <span className="status-pill" data-status={statusTone(slice.status)}>
                                  {slice.status ?? copy.messages.unknown}
                                </span>
                              </div>

                              <strong>{sentenceCaseTitle(sliceTitle(slice))}</strong>

                              <div className="milestone-focus__slice-meter" aria-hidden="true">
                                <span style={{ width: `${slicePercent}%` }} />
                              </div>

                              <div className="milestone-focus__slice-meta">
                                <span>
                                  {slice.completedTaskCount}/{slice.taskCount} {copy.labels.tasks}
                                </span>
                                {dependency ? <span>{dependency.fromId} -&gt; {slice.id}</span> : <span>{milestone.id} -&gt; {slice.id}</span>}
                              </div>

                              {sliceCurrentTask ? (
                                <span className="milestone-focus__current">
                                  {copy.labels.currentTask}: {sliceCurrentTask.id}
                                </span>
                              ) : null}
                            </summary>

                            {orderedTasks.length > 0 ? (
                              <ol className="milestone-focus__task-list">
                                {orderedTasks.map((task) => {
                                  const taskCurrent = sliceCurrentTask?.id === task.id;

                                  return (
                                    <li
                                      className="milestone-focus__task"
                                      data-current={taskCurrent}
                                      data-status={taskCurrent ? 'active' : statusTone(task.status)}
                                      key={`${slice.id}-${task.id}`}
                                    >
                                      <div className="milestone-focus__task-main">
                                        <span
                                          className="status-dot"
                                          data-status={taskCurrent ? 'active' : statusTone(task.status)}
                                        />
                                        <strong className="workflow-id-badge" data-level="task">
                                          {task.id}
                                        </strong>
                                        <span>{taskTitle(task)}</span>
                                      </div>
                                      <span
                                        className="status-pill"
                                        data-status={taskCurrent ? 'active' : statusTone(task.status)}
                                      >
                                        {taskCurrent ? copy.labels.currentTask : task.status ?? copy.messages.unknown}
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
                  ) : null}
                </details>
              );
            })}
          </div>
        </div>
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
  const [appRoute, setAppRoute] = useState<AppRoute>(() => parseAppRoute(window.location.pathname));
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
  const initialRouteRef = useRef(appRoute);

  const activeAppPage: AppPage | null = appRoute.page === 'welcome' ? null : appRoute.page;

  const navigateToRoute = useCallback((nextRoute: AppRoute, options: { replace?: boolean } = {}) => {
    const nextPath = getAppRoutePath(nextRoute);

    if (window.location.pathname !== nextPath || window.location.search.length > 0 || window.location.hash.length > 0) {
      if (options.replace) {
        window.history.replaceState(null, '', nextPath);
      } else {
        window.history.pushState(null, '', nextPath);
      }
    }

    setAppRoute(nextRoute);
  }, []);

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
    const handlePopState = () => {
      setAppRoute(parseAppRoute(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
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
        fallbackToFirstProject?: boolean;
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
          response.items.find((project) => project.projectId === preferredProjectId)
          ?? (options.fallbackToFirstProject === false ? null : response.items[0])
          ?? null;

        if (!nextProject) {
          selectedProjectIdRef.current = null;
          setSelectedProjectId(null);
          setSelectedProject(null);
          setProjectTimeline({ items: [], total: 0 });
          setDetailError(null);
          setTimelineError(null);
          return true;
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
    const initialRoute = initialRouteRef.current;
    const initialProjectId = initialRoute.page === 'details' ? initialRoute.projectId : null;

    void syncInventory(initialProjectId, {
      fallbackToFirstProject: initialProjectId === null,
    });
  }, [syncInventory]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void syncInventory(selectedProjectIdRef.current, {
        preserveSelectedDetail: true,
      });
    }, INVENTORY_AUTO_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
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
    (project: ProjectRecord, options: { updateRoute?: boolean } = {}) => {
      if (options.updateRoute !== false) {
        navigateToRoute({
          page: 'details',
          projectId: project.projectId,
        });
      }

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
    [navigateToRoute, syncSelectedProjectPanels],
  );

  useEffect(() => {
    if (appRoute.page !== 'details' || inventoryLoading) {
      return;
    }

    const routeProject = projects.find((project) => project.projectId === appRoute.projectId) ?? null;

    if (routeProject) {
      if (selectedProjectIdRef.current !== routeProject.projectId) {
        selectProject(routeProject, { updateRoute: false });
      }

      return;
    }

    selectedProjectIdRef.current = null;
    setSelectedProjectId(null);
    setSelectedProject(null);
    setProjectTimeline({ items: [], total: 0 });
    setDetailError(copy.errors.projectRouteNotFound(appRoute.projectId));
    setTimelineError(null);
  }, [appRoute, copy.errors, inventoryLoading, projects, selectProject]);

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

  const submitRegisterPath = useCallback(
    async (rawPath: string, options: { closeDirectoryPickerOnSuccess?: boolean } = {}) => {
      const candidatePath = rawPath.trim();

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
      setRegisterPath(candidatePath);
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
        navigateToRoute({
          page: 'details',
          projectId: response.project.projectId,
        });
        if (options.closeDirectoryPickerOnSuccess) {
          setDirectoryPickerOpen(false);
        }
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
      navigateToRoute,
      projects,
      syncSelectedProjectPanels,
    ],
  );

  const handleRegister = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void submitRegisterPath(registerPath);
    },
    [registerPath, submitRegisterPath],
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
  const nowMs = Date.now();
  const portfolioSummary = buildPortfolioSummary(projects, nowMs, copy);
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
          : selectedProject
            ? describeProject(selectedProject)
            : copy.messages.notRecorded;
  const selectedWorkflowPhase =
    selectedInitJob && hasActiveInitJob(selectedInitJob)
      ? copy.initStageLabels[selectedInitJob.stage]
      : selectedProject
        ? copy.statusLabels[selectedProject.snapshot.status]
        : copy.messages.notRecorded;
  const selectedExecutionStats = buildWorkflowExecutionStats(selectedMilestones, selectedMetrics, nowMs, copy);
  const selectedTaskTimeline = buildTaskTimelineEntries(selectedMilestones, selectedExecutionStats);
  const selectedTaskTimelineCountLabel = copy.formatCount(selectedTaskTimeline.length, 'task');
  const selectedRecentExecutionUnits = (selectedMetrics?.recentUnits ?? []).map(toExecutionUnit);
  const primaryModel = selectedExecutionStats.modelUsage[0]?.model ?? copy.messages.notRecorded;
  const averageUnitDurationMs = averageDuration(selectedExecutionStats.units);
  const routePreviewProject = selectedProject ?? projects.find((project) => project.projectId === selectedProjectId) ?? projects[0] ?? null;
  const routePreviewRow = routePreviewProject
    ? portfolioSummary.rows.find((row) => row.project.projectId === routePreviewProject.projectId) ?? null
    : null;
  const routePreviewHeading = routePreviewProject ? describeProject(routePreviewProject) : copy.labels.projectOverview;
  const routePreviewStage =
    activeAppPage === 'details' ? routePreviewRow?.currentStage ?? selectedWorkflowPhase : copy.labels.projectOverview;
  const routePreviewActionLabel =
    activeAppPage === 'overview' ? copy.actions.openSelectedProject : copy.actions.enterOverview;
  const topbarMarqueeLabel =
    activeAppPage === 'details' ? copy.labels.projectDetail : copy.labels.portfolio;
  const topbarMarqueeHeading =
    activeAppPage === 'details' ? routePreviewHeading : totalProjectsLabel;
  const topbarMarqueeCopy =
    activeAppPage === 'details' ? routePreviewStage : copy.help.portfolioProjection;
  const topbarStageLabel =
    activeAppPage === 'details' ? copy.labels.currentStage : copy.labels.activeProjects;
  const topbarStageValue =
    activeAppPage === 'details' ? routePreviewStage : String(portfolioSummary.activeProjects);
  const topbarStageMeta =
    activeAppPage === 'details' ? routePreviewHeading : `${initializedCount} ${copy.stats.initialized}`;
  const topbarCost = activeAppPage === 'details' ? routePreviewRow?.cost ?? 0 : portfolioSummary.totalCost;
  const topbarTokens =
    activeAppPage === 'details' ? routePreviewRow?.totalTokens ?? 0 : portfolioSummary.totalTokens;
  const switcherProject = selectedProject ?? routePreviewProject;
  const openRegisterDirectoryPicker = () => {
    setRegisterError(null);
    setRegisterSuccess(null);
    setDirectoryPickerOpen(true);
    void loadDirectoryPicker(registerPath);
  };
  const renderLocaleSwitch = () => (
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
  );
  const renderRegisterPanel = (inputId: string, options: { pickerOnly?: boolean } = {}) => (
    <div className="register-panel">
      <div>
        <h2>{copy.actions.registerProject}</h2>
        <p>{copy.help.registerPanel}</p>
      </div>

      {options.pickerOnly ? (
        <>
          <div className="field register-panel__field">
            <span>{copy.labels.projectPath}</span>
            <div className="register-panel__path" data-testid="register-selected-path">
              {registerPath || copy.messages.selectedFolderHint}
            </div>
          </div>

          <div className="register-panel__actions">
            <button
              type="button"
              className="primary-button"
              onClick={openRegisterDirectoryPicker}
              disabled={directoryPickerLoading}
            >
              <FolderIcon />
              <span>{copy.actions.browseFolders}</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <form onSubmit={handleRegister}>
            <div className="field register-panel__field">
              <label htmlFor={inputId}>{copy.labels.projectPath}</label>
              <div className="path-input-row">
                <input
                  id={inputId}
                  name={inputId}
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
                  onClick={openRegisterDirectoryPicker}
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
          </form>
        </>
      )}

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
    </div>
  );
  const renderProjectSwitcher = () => (
    <section className="project-switcher" aria-labelledby="project-switch-heading">
      <div className="panel-header project-switcher__header">
        <div>
          <h2 id="project-switch-heading">{copy.labels.projectSwitch}</h2>
          <p>{copy.formatCount(projects.length, 'project')}</p>
        </div>
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
        <div className="project-switcher__body">
          <div className="project-switcher__current" data-testid="project-switcher-current">
            <span className="eyebrow">{copy.labels.projectDetail}</span>
            <strong data-testid="project-switcher-current-name">
              {switcherProject ? describeProject(switcherProject) : copy.empty.detailTitle}
            </strong>
            <span className="project-switcher__path">
              {switcherProject?.canonicalPath ?? copy.empty.detailCopy}
            </span>
          </div>

          <div className="project-switcher__dots">
            {projects.map((project) => {
              const label = describeProject(project);
              const isSelected = selectedProjectId === project.projectId;

              return (
                <button
                  key={project.projectId}
                  type="button"
                  className="project-switcher__dot"
                  data-status={project.snapshot.status}
                  data-active={isSelected}
                  data-testid={`project-card-${project.projectId}`}
                  aria-label={label}
                  aria-pressed={isSelected}
                  title={label}
                  onClick={() => {
                    selectProject(project);
                  }}
                >
                  <span className="visually-hidden">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
  const renderStreamStrip = () => (
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
  );
  const renderWelcomePage = () => (
    <section className="welcome-page" aria-labelledby="welcome-heading" data-testid="welcome-page">
      <header className="welcome-nav">
        <div>
          <span>{copy.app.eyebrow}</span>
          <strong>gsd-web</strong>
        </div>
        {renderLocaleSwitch()}
      </header>

      <section className="welcome-hero">
        <div className="welcome-copy">
          <p className="eyebrow">{copy.app.welcomeEyebrow}</p>
          <h1 id="welcome-heading">gsd-web</h1>
          <p>{copy.app.welcomeLead}</p>
          <div className="welcome-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                navigateToRoute({ page: 'overview' });
              }}
            >
              {copy.actions.enterOverview}
            </button>
            {routePreviewProject ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  selectProject(routePreviewProject);
                }}
              >
                {copy.actions.openSelectedProject}
              </button>
            ) : null}
          </div>
        </div>

        <div className="welcome-visual" aria-label={copy.labels.workspacePages}>
          <div className="welcome-route-map">
            <span data-active="true">{ROUTE_BASE_PATH}</span>
            <span>{ROUTE_OVERVIEW_PATH}</span>
            <span>
              {routePreviewProject ? getAppRoutePath({ page: 'details', projectId: routePreviewProject.projectId }) : `${ROUTE_BASE_PATH}/:projectId`}
            </span>
          </div>

          <div className="welcome-stat-grid">
            <div>
              <span className="stat-card__label">{copy.stats.registered}</span>
              <strong>{totalProjectsLabel}</strong>
            </div>
            <div>
              <span className="stat-card__label">{copy.stats.initialized}</span>
              <strong>{initializedCount}</strong>
            </div>
            <div>
              <span className="stat-card__label">{copy.labels.totalCost}</span>
              <strong>{formatCost(portfolioSummary.totalCost, locale)}</strong>
            </div>
            <div data-stream-status={streamStatus}>
              <span className="stat-card__label">{copy.stats.liveStream}</span>
              <strong>{copy.streamStatusLabels[streamStatus]}</strong>
            </div>
          </div>

          <div className="welcome-preview">
            <div>
              <span className="status-pill" data-status="initialized">{initializedCount} {copy.stats.initialized}</span>
              <span className="status-pill" data-status="degraded">{degradedCount} {copy.stats.degraded}</span>
              <span className="status-pill" data-status="uninitialized">{uninitializedCount} {copy.stats.uninitialized}</span>
            </div>
            <strong>{copy.labels.projectOverview}</strong>
            <p>{copy.app.welcomePreview}</p>
          </div>
        </div>
      </section>
    </section>
  );
  const renderAppRail = () => (
    <aside className="app-rail panel" aria-label={copy.labels.workspacePages}>
      <div className="app-rail__brand">
        <div className="app-rail__brand-mark" aria-hidden="true">
          <span />
        </div>
        <div className="app-rail__brand-copy">
          <span className="stat-card__label">{copy.app.welcomeEyebrow}</span>
          <strong>gsd-web</strong>
          <span>{copy.app.title}</span>
        </div>
      </div>

      <div className="app-rail__section">
        <span className="stat-card__label">{copy.labels.workspacePages}</span>
        <div className="app-page-tabs" role="tablist" aria-label={copy.labels.workspacePages}>
          {APP_PAGES.map((page) => (
            <button
              key={page}
              type="button"
              className="app-page-tabs__item"
              role="tab"
              aria-selected={activeAppPage === page}
              aria-controls={`app-page-${page}`}
              data-active={activeAppPage === page}
              onClick={() => {
                if (page === 'overview') {
                  navigateToRoute({ page: 'overview' });
                  return;
                }

                if (routePreviewProject) {
                  selectProject(routePreviewProject);
                  return;
                }

                navigateToRoute({ page: 'overview' });
              }}
            >
              <AppPageIcon page={page} />
              <span>{appPageLabel(page, copy)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="app-rail__status-grid">
        <div className="app-rail__metric" data-stream-status={streamStatus}>
          <span className="stat-card__label">{copy.stats.liveStream}</span>
          <strong>{copy.streamStatusLabels[streamStatus]}</strong>
          <span>{streamSummary?.type ?? copy.stats.waitingForEvent}</span>
        </div>
        <div className="app-rail__metric">
          <span className="stat-card__label">{copy.labels.activeProjects}</span>
          <strong>{portfolioSummary.activeProjects}</strong>
          <span>{initializedCount} {copy.stats.initialized}</span>
        </div>
        <div className="app-rail__metric">
          <span className="stat-card__label">{copy.labels.totalWarnings}</span>
          <strong>{portfolioSummary.totalWarnings}</strong>
          <span>{degradedCount} {copy.stats.degraded}</span>
        </div>
      </div>

      <div className="app-rail__footer">
        {routePreviewProject ? (
          <button
            type="button"
            className="app-rail__project"
            onClick={() => {
              if (activeAppPage === 'overview') {
                selectProject(routePreviewProject);
                return;
              }

              navigateToRoute({ page: 'overview' });
            }}
          >
            <span className="stat-card__label">{routePreviewActionLabel}</span>
            <strong>{routePreviewHeading}</strong>
            <span>{routePreviewStage}</span>
          </button>
        ) : null}
        {renderLocaleSwitch()}
      </div>
    </aside>
  );

  return (
    <main className="app-shell" data-locale={locale}>
      {appRoute.page === 'welcome' ? renderWelcomePage() : (
      <section className="app-frame">
        {renderAppRail()}

        <section className="app-stage">
          <header className="app-topbar panel">
            <div className="app-topbar__title">
              <p className="eyebrow">{copy.app.eyebrow}</p>
              <h1>gsd-web</h1>
              <p className="lede">{copy.app.title}</p>
            </div>

            <div className="app-topbar__marquee">
              <span className="stat-card__label">{topbarMarqueeLabel}</span>
              <strong data-testid="app-topbar-marquee-heading">{topbarMarqueeHeading}</strong>
              <p data-testid="app-topbar-marquee-copy">{topbarMarqueeCopy}</p>
            </div>

            <div className="app-topbar__hud">
              <div className="app-topbar__hud-card" data-stream-status={streamStatus}>
                <span className="stat-card__label">{copy.stats.liveStream}</span>
                <strong>{copy.streamStatusLabels[streamStatus]}</strong>
                <span>
                  {streamSummary ? formatTimestamp(streamSummary.emittedAt, locale) : copy.stats.waitingForEvent}
                </span>
              </div>
              <div className="app-topbar__hud-card">
                <span className="stat-card__label">{topbarStageLabel}</span>
                <strong data-testid="app-topbar-stage-value">{topbarStageValue}</strong>
                <span data-testid="app-topbar-stage-meta">{topbarStageMeta}</span>
              </div>
              <div className="app-topbar__hud-card">
                <span className="stat-card__label">{copy.labels.totalCost}</span>
                <strong data-testid="app-topbar-total-cost">{formatCost(topbarCost, locale)}</strong>
                <span data-testid="app-topbar-total-tokens">
                  {formatCompactNumber(topbarTokens, locale)} {copy.labels.tokens}
                </span>
              </div>
            </div>

          </header>

        {activeAppPage === 'overview' ? (
          <section className="overview-layout app-page" id="app-page-overview" aria-labelledby="overview-heading">
            <section className="overview-hero panel">
              <div className="overview-hero__copy">
                <p className="eyebrow">{copy.app.healthRailLabel}</p>
                <h2 id="overview-heading">{copy.labels.portfolio}</h2>
                <p>{copy.app.healthRailCopy}</p>
              </div>

              <div className="overview-metrics">
                <div className="overview-metric-card" data-testid="inventory-count">
                  <span className="stat-card__label">{copy.stats.registered}</span>
                  <strong>{totalProjectsLabel}</strong>
                  <small>{initializedCount} {copy.stats.initialized}</small>
                </div>
                <div className="overview-metric-card">
                  <span className="stat-card__label">{copy.labels.totalCost}</span>
                  <strong>{formatCost(portfolioSummary.totalCost, locale)}</strong>
                  <small>{copy.formatCount(portfolioSummary.metricsProjects, 'project')}</small>
                </div>
                <div className="overview-metric-card">
                  <span className="stat-card__label">{copy.labels.totalElapsed}</span>
                  <strong>{formatDuration(portfolioSummary.totalElapsedMs, locale, copy.messages.notRecorded)}</strong>
                  <small>{formatCompactNumber(portfolioSummary.totalTokens, locale)} {copy.labels.tokens}</small>
                </div>
                <div className="overview-metric-card">
                  <span className="stat-card__label">{copy.labels.remainingTasks}</span>
                  <strong>{portfolioSummary.remainingTasks}</strong>
                  <small>
                    {portfolioSummary.completedTasks}/{portfolioSummary.totalTasks} {copy.labels.completed}
                  </small>
                </div>
              </div>
            </section>

            <div className="overview-content">
              <section className="overview-board panel" aria-labelledby="overview-projects-heading">
                <div className="panel-header inventory-panel__header">
                  <div>
                    <h2 id="overview-projects-heading">{copy.labels.projectOverview}</h2>
                    <p>{copy.help.portfolioProjection}</p>
                  </div>
                  <div className="detail-header__meta">
                    <span className="status-pill" data-status="initialized">{initializedCount} {copy.stats.initialized}</span>
                    <span className="status-pill" data-status="degraded">{degradedCount} {copy.stats.degraded}</span>
                    <span className="status-pill" data-status="uninitialized">
                      {uninitializedCount} {copy.stats.uninitialized}
                    </span>
                  </div>
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
                  <div className="overview-project-list">
                    {portfolioSummary.rows.map((row) => (
                      <button
                        key={row.project.projectId}
                        type="button"
                        className="overview-project-row"
                        data-status={row.project.snapshot.status}
                        data-testid={`overview-project-card-${row.project.projectId}`}
                        onClick={() => {
                          selectProject(row.project);
                        }}
                      >
                        <span className="overview-project-row__identity">
                          <strong>{row.label}</strong>
                        </span>

                        <span className="overview-project-row__state">
                          <span className="overview-project-row__meter" aria-hidden="true">
                            <span style={{ width: `${row.progressPercent}%` }} />
                          </span>
                          <span className="overview-project-row__badges">
                            <span className="status-pill" data-status={row.project.snapshot.status}>
                              {copy.statusLabels[row.project.snapshot.status]}
                            </span>
                            <span className="status-pill" data-status={row.project.monitor.health}>
                              {copy.monitorHealthLabels[row.project.monitor.health]}
                            </span>
                            <span className="status-pill" data-status={continuityTone(row.continuity.state)}>
                              {copy.continuityStateLabels[row.continuity.state]}
                            </span>
                          </span>
                        </span>

                        <span className="overview-project-row__facts">
                          <span>
                            <small>{copy.labels.cost}</small>
                            <strong>{formatCost(row.cost, locale)}</strong>
                          </span>
                          <span>
                            <small>{copy.labels.elapsed}</small>
                            <strong>{formatDuration(row.elapsedMs, locale, copy.messages.notRecorded)}</strong>
                          </span>
                          <span>
                            <small>{copy.labels.currentStage}</small>
                            <strong title={row.currentStage}>{row.currentStage}</strong>
                          </span>
                          <span>
                            <small>{copy.labels.estimatedRemaining}</small>
                            <strong>
                              {formatDuration(
                                row.estimatedRemainingMs,
                                locale,
                                copy.messages.estimateUnavailable,
                              )}
                            </strong>
                          </span>
                        </span>

                        <span className="overview-project-row__open">
                          <OpenDetailsIcon />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <aside className="overview-side" aria-label={copy.labels.serviceState}>
                <section className="overview-register panel">
                  {renderRegisterPanel('overview-project-path', { pickerOnly: true })}
                </section>
                <section className="overview-status panel">
                  <div className="subpanel__header">
                    <h2>{copy.labels.statusBreakdown}</h2>
                    <p>{copy.help.statusBreakdown}</p>
                  </div>
                  <dl className="detail-facts detail-facts--compact">
                    <div>
                      <dt>{copy.labels.activeProjects}</dt>
                      <dd>{portfolioSummary.activeProjects}</dd>
                    </div>
                    <div>
                      <dt>{copy.labels.totalWarnings}</dt>
                      <dd>{portfolioSummary.totalWarnings}</dd>
                    </div>
                    <div>
                      <dt>{copy.labels.apiRequests}</dt>
                      <dd>
                        {formatCompactNumber(
                          portfolioSummary.rows.reduce(
                            (total, row) => total + (row.project.snapshot.sources.metricsJson.value?.totals.apiRequests ?? 0),
                            0,
                          ),
                          locale,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{copy.labels.units}</dt>
                      <dd>{portfolioSummary.rows.reduce((total, row) => total + row.unitCount, 0)}</dd>
                    </div>
                  </dl>
                </section>
                <section className="overview-stream panel">
                  {renderStreamStrip()}
                </section>
              </aside>
            </div>
          </section>
        ) : null}

        {activeAppPage === 'details' ? (
        <section className="workspace-layout app-page detail-workspace" id="app-page-details" aria-labelledby="detail-heading">
        <section className="panel detail-panel" aria-labelledby="detail-heading">
          <h2 id="detail-heading" className="visually-hidden">{copy.labels.workflowVisualizer}</h2>

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
              <div className="visually-hidden">
                <span data-testid="detail-canonical-path">{selectedProject.canonicalPath}</span>
                <span data-testid="detail-status">{copy.statusLabels[selectedProject.snapshot.status]}</span>
                <span data-testid="detail-monitor-health">{copy.monitorHealthLabels[selectedProject.monitor.health]}</span>
                <span data-testid="detail-continuity-state">
                  {copy.continuityStateLabels[selectedContinuity!.state]}
                </span>
                <span data-testid="detail-warning-count">
                  {copy.formatCount(selectedProject.snapshot.warnings.length, 'warning')}
                </span>
                <span data-testid="detail-project-id-value">{selectedProject.projectId}</span>
                <span data-testid="detail-snapshot-checked-at">
                  {formatTimestamp(selectedProject.snapshot.checkedAt, locale)}
                </span>
                <span data-testid="detail-monitor-last-attempted">
                  {selectedProject.monitor.lastAttemptedAt
                    ? formatTimestamp(selectedProject.monitor.lastAttemptedAt, locale)
                    : copy.messages.notRecorded}
                </span>
                <span data-testid="detail-monitor-last-successful">
                  {selectedProject.monitor.lastSuccessfulAt
                    ? formatTimestamp(selectedProject.monitor.lastSuccessfulAt, locale)
                    : copy.messages.notRecorded}
                </span>
                <span data-testid="detail-monitor-last-trigger">
                  {formatProjectReconcileTrigger(selectedProject.monitor.lastTrigger, copy)}
                </span>
                <span data-testid="detail-gsd-id">
                  {selectedProject.snapshot.identityHints.gsdId ?? copy.messages.noGsdId}
                </span>
                {renderStreamStrip()}
              </div>

              <div className="visualizer-dashboard">
                <div className="visualizer-dashboard__left">
                  <WorkflowGraphPanel
                    milestones={selectedMilestones}
                    dependencies={selectedSliceDependencies}
                    activeMilestoneId={selectedActiveMilestone?.id ?? null}
                    activeSliceId={selectedActiveSlice?.id ?? null}
                    activeTask={selectedActiveTask}
                    copy={copy}
                  />

                  <RuntimeMetricsPanel
                    metrics={selectedMetrics}
                    executionStats={selectedExecutionStats}
                    workflowPhase={selectedWorkflowPhase}
                    locale={locale}
                    copy={copy}
                  />
                </div>

                <div className="visualizer-dashboard__right">
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
                <WorkflowMilestoneRail
                  milestones={selectedMilestones}
                  dependencies={selectedSliceDependencies}
                  activeMilestoneId={selectedActiveMilestone?.id ?? null}
                  activeSliceId={selectedActiveSlice?.id ?? null}
                  activeTask={selectedActiveTask}
                  validationIssueCount={selectedProject.snapshot.warnings.length}
                  locale={locale}
                  copy={copy}
                  variant="dashboard"
                />
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
                      {selectedTaskTimelineCountLabel}
                    </span>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        if (selectedProjectIdRef.current) {
                          void syncSelectedProjectPanels(selectedProjectIdRef.current);
                        }
                      }}
                      disabled={!selectedProjectId || detailLoading || timelineLoading}
                    >
                      {detailLoading || timelineLoading ? copy.actions.reloading : copy.actions.reloadTimeline}
                    </button>
                  </div>
                </div>

                {selectedTaskTimeline.length === 0 ? (
                  <p data-testid="timeline-empty">{copy.empty.timeline}</p>
                ) : null}

                {selectedTaskTimeline.length > 0 ? (
                  <ol className="timeline-list" data-testid="timeline-list">
                    {selectedTaskTimeline.map((entry) => {
                      const taskStatus = entry.task.status ?? copy.messages.unknown;
                      const taskTone = statusTone(entry.task.status);
                      const elapsedActiveMs =
                        entry.actualDurationMs
                        ?? (entry.startedAtMs !== null && entry.finishedAtMs === null && isWorkflowStatusActive(entry.task.status)
                          ? Math.max(0, nowMs - entry.startedAtMs)
                          : null);
                      const timelineBudgetMs = (elapsedActiveMs ?? 0) + (entry.estimatedRemainingMs ?? 0);
                      const actualWidthPercent =
                        timelineBudgetMs > 0 && elapsedActiveMs !== null
                          ? Math.min(100, Math.max(6, Math.round((elapsedActiveMs / timelineBudgetMs) * 100)))
                          : isWorkflowStatusComplete(entry.task.status)
                            ? 100
                            : 0;

                      return (
                        <li
                          className="timeline-item timeline-item--task"
                          data-status={taskTone}
                          data-testid="task-timeline-item"
                          key={entry.key}
                        >
                          <div className="timeline-item__header timeline-item__header--task">
                            <div>
                              <span className="meta-badge">{entry.path}</span>
                              <strong>{sentenceCaseTitle(taskTitle(entry.task))}</strong>
                            </div>
                            <span className="status-pill" data-status={taskTone}>
                              {taskStatus}
                            </span>
                          </div>

                          <div
                            className="task-timeline__bar"
                            aria-hidden="true"
                            data-complete={isWorkflowStatusComplete(entry.task.status)}
                          >
                            <span style={{ width: `${actualWidthPercent}%` }} />
                          </div>

                          <dl className="task-timeline__meta">
                            <div>
                              <dt>{copy.labels.firstStarted}</dt>
                              <dd>
                                {entry.startedAtMs === null
                                  ? copy.messages.notRecorded
                                  : formatMetricTimestamp(entry.startedAtMs, locale, copy.messages.notRecorded)}
                              </dd>
                            </div>
                            <div>
                              <dt>{copy.labels.lastFinished}</dt>
                              <dd>
                                {entry.finishedAtMs === null
                                  ? isWorkflowStatusActive(entry.task.status)
                                    ? taskStatus
                                    : copy.messages.notRecorded
                                  : formatMetricTimestamp(entry.finishedAtMs, locale, copy.messages.notRecorded)}
                              </dd>
                            </div>
                            <div>
                              <dt>{copy.labels.actualDuration}</dt>
                              <dd>{formatDuration(elapsedActiveMs, locale, copy.messages.notRecorded)}</dd>
                            </div>
                            <div>
                              <dt>{copy.labels.estimatedRemaining}</dt>
                              <dd>{formatDuration(entry.estimatedRemainingMs, locale, copy.messages.estimateUnavailable)}</dd>
                            </div>
                          </dl>
                        </li>
                      );
                    })}
                  </ol>
                ) : null}

                <section className="project-event-log" data-testid="project-event-log">
                  <div className="project-event-log__header">
                    <h5>{copy.labels.project} {copy.labels.event}</h5>
                    <span className="meta-badge" data-testid="project-event-total">
                      {selectedTimelineCountLabel}
                    </span>
                  </div>

                  {projectTimeline.items.length === 0 ? (
                    <p>{copy.messages.noLastEvent}</p>
                  ) : (
                    <ol className="project-event-list" data-testid="project-event-list">
                      {projectTimeline.items.map((entry) => (
                        <li className="timeline-item" data-type={entry.type} key={entry.id}>
                          <div className="timeline-item__header">
                            <strong>{copy.timelineTypeLabels[entry.type]}</strong>
                            <time dateTime={entry.emittedAt}>{formatTimestamp(entry.emittedAt, locale)}</time>
                          </div>

                          <div className="timeline-item__badges">
                            <span className="status-pill" data-status={timelineTone(entry.type)}>
                              {copy.timelineTypeLabels[entry.type]}
                            </span>
                            <span className="status-pill" data-status={entry.snapshotStatus}>
                              {copy.statusLabels[entry.snapshotStatus]}
                            </span>
                            <span className="status-pill" data-status={entry.monitorHealth}>
                              {copy.monitorHealthLabels[entry.monitorHealth]}
                            </span>
                            <span className="meta-badge">
                              {copy.reconcileTriggerLabels[entry.trigger]}
                            </span>
                            <span className="meta-badge">
                              {copy.formatCount(entry.warningCount, 'warning')}
                            </span>
                          </div>

                          <p className="timeline-item__detail">{entry.detail}</p>

                          {entry.error ? (
                            <div className="timeline-item__error inline-alert inline-alert--error">
                              <strong>
                                {entry.error.scope} · {formatTimestamp(entry.error.at, locale)}
                              </strong>
                              <p>{clampWarning(entry.error.message)}</p>
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
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
              </div>
            </div>
          ) : (
            <div className="empty-state" data-testid="detail-empty">
              <h3>{copy.empty.detailTitle}</h3>
              <p>{copy.empty.detailCopy}</p>
            </div>
          )}
          </div>
          <div className="terminal-dock">
            <div className="terminal-dock__status">
              <strong>{copy.labels.terminal}</strong>
              <span aria-hidden="true">^</span>
              <p>
                {selectedProject
                  ? `${copy.messages.terminalIdle} · ${selectedProject.dataLocation.gsdDbPath}`
                  : copy.messages.terminalIdle}
              </p>
            </div>
            {selectedProject ? (
              <div className="terminal-dock__actions">
                {selectedInitActionVisible ? (
                  <button
                    type="button"
                    className="secondary-button"
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
                ) : null}
                <button
                  type="button"
                  className={selectedInitActionVisible ? 'secondary-button' : 'primary-button'}
                  onClick={() => {
                    void handleRefreshSelected();
                  }}
                  disabled={!selectedProjectId || refreshPending}
                >
                  {refreshPending ? copy.actions.refreshing : copy.actions.refreshSelected}
                </button>
              </div>
            ) : null}
          </div>
        </section>
        </section>
        ) : null}
        </section>
      </section>
      )}

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
                  disabled={!directoryPicker || registerPending}
                  onClick={() => {
                    if (directoryPicker) {
                      void submitRegisterPath(directoryPicker.path, {
                        closeDirectoryPickerOnSuccess: true,
                      });
                    }
                  }}
                >
                  <FolderIcon />
                  <span>{registerPending ? copy.actions.registering : copy.actions.useCurrentFolder}</span>
                </button>
              </div>
            </div>

            <div className="directory-picker__browser">
              {registerError ? (
                <p className="inline-alert inline-alert--error" role="alert" data-testid="directory-register-error">
                  {registerError}
                </p>
              ) : null}

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
