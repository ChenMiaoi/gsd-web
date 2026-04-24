export const SERVICE_NAME = 'gsd-web';

export const SNAPSHOT_SOURCE_NAMES = [
  'directory',
  'gsdDirectory',
  'gsdId',
  'projectMd',
  'repoMeta',
  'autoLock',
  'stateMd',
  'metricsJson',
  'gsdDb',
] as const;

export type SnapshotSourceName = (typeof SNAPSHOT_SOURCE_NAMES)[number];

export const SNAPSHOT_SOURCE_STATES = [
  'ok',
  'missing',
  'malformed',
  'unreadable',
  'not_applicable',
] as const;

export type SnapshotSourceState = (typeof SNAPSHOT_SOURCE_STATES)[number];

export const SNAPSHOT_WARNING_CODES = [
  'source_missing',
  'source_malformed',
  'source_unreadable',
  'invalid_path',
  'duplicate_path',
  'snapshot_timeout',
] as const;

export type SnapshotWarningCode = (typeof SNAPSHOT_WARNING_CODES)[number];

export const PROJECT_SNAPSHOT_STATUSES = ['uninitialized', 'initialized', 'degraded'] as const;

export type ProjectSnapshotStatus = (typeof PROJECT_SNAPSHOT_STATUSES)[number];

export const PROJECT_MONITOR_HEALTHS = ['healthy', 'degraded', 'read_failed', 'stale'] as const;

export type ProjectMonitorHealth = (typeof PROJECT_MONITOR_HEALTHS)[number];

export const PROJECT_CONTINUITY_STATES = ['tracked', 'path_lost'] as const;

export type ProjectContinuityState = (typeof PROJECT_CONTINUITY_STATES)[number];

export const PROJECT_RECONCILE_TRIGGERS = [
  'register',
  'manual_refresh',
  'init_refresh',
  'monitor_boot',
  'monitor_interval',
  'watcher',
  'relink',
] as const;

export type ProjectReconcileTrigger = (typeof PROJECT_RECONCILE_TRIGGERS)[number];

export const PROJECT_TIMELINE_ENTRY_TYPES = [
  'registered',
  'refreshed',
  'path_lost',
  'relinked',
  'monitor_degraded',
  'monitor_recovered',
] as const;

export type ProjectTimelineEntryType = (typeof PROJECT_TIMELINE_ENTRY_TYPES)[number];

export const PROJECT_INIT_JOB_STAGES = [
  'queued',
  'starting',
  'initializing',
  'refreshing',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
] as const;

export type ProjectInitJobStage = (typeof PROJECT_INIT_JOB_STAGES)[number];

export const PROJECT_INIT_REFRESH_RESULT_STATUSES = ['succeeded', 'failed'] as const;

export type ProjectInitRefreshResultStatus = (typeof PROJECT_INIT_REFRESH_RESULT_STATUSES)[number];

export interface SnapshotWarning {
  source: SnapshotSourceName;
  code: SnapshotWarningCode;
  message: string;
}

export interface DirectorySummary {
  isEmpty: boolean;
  sampleEntries: string[];
  sampleTruncated: boolean;
}

export interface RepoMetaValue {
  projectName: string | null;
  currentBranch: string | null;
  headSha: string | null;
  repoFingerprint: string | null;
  dirty: boolean | null;
}

export interface AutoLockValue {
  status: string | null;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string | null;
}

export interface ProjectMarkdownValue {
  title: string | null;
  summary: string | null;
}

export interface StateMarkdownValue {
  summary: string;
  activeMilestoneId: string | null;
  activeSliceId: string | null;
  activeTaskId: string | null;
  phase: string | null;
  nextAction: string | null;
}

export interface GsdDbSummaryValue {
  tables: string[];
  counts: {
    milestones: number | null;
    slices: number | null;
    tasks: number | null;
    sliceDependencies: number | null;
    projects: number | null;
  };
  milestones: GsdDbMilestoneSummary[];
  dependencies: GsdDbSliceDependencySummary[];
}

export type GsdWorkflowTimestampValue = string | number | null;

export interface GsdDbTaskSummary {
  id: string;
  title: string | null;
  status: string | null;
  risk: string | null;
  startedAt: GsdWorkflowTimestampValue;
  finishedAt: GsdWorkflowTimestampValue;
}

export interface GsdDbSliceSummary {
  id: string;
  title: string | null;
  status: string | null;
  risk: string | null;
  startedAt: GsdWorkflowTimestampValue;
  finishedAt: GsdWorkflowTimestampValue;
  taskCount: number;
  completedTaskCount: number;
  tasks: GsdDbTaskSummary[];
}

export interface GsdDbMilestoneSummary {
  id: string;
  title: string | null;
  status: string | null;
  startedAt: GsdWorkflowTimestampValue;
  finishedAt: GsdWorkflowTimestampValue;
  sliceCount: number;
  taskCount: number;
  completedTaskCount: number;
  slices: GsdDbSliceSummary[];
}

export interface GsdDbSliceDependencySummary {
  milestoneId: string;
  sliceId: string;
  dependsOnSliceId: string;
}

export interface GsdMetricsTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  toolCalls: number;
  assistantMessages: number;
  userMessages: number;
  apiRequests: number;
  promptCharCount: number;
  baselineCharCount: number;
}

export interface GsdMetricsUnitSummary {
  type: string | null;
  id: string | null;
  model: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  totalTokens: number;
  cost: number;
  toolCalls: number;
  apiRequests: number;
}

export interface GsdMetricsSummaryValue {
  version: number | null;
  projectStartedAt: number | null;
  unitCount: number;
  totals: GsdMetricsTotals;
  units: GsdMetricsUnitSummary[];
  recentUnits: GsdMetricsUnitSummary[];
}

export interface SnapshotSource<T> {
  state: SnapshotSourceState;
  detail?: string;
  value?: T;
}

export interface ProjectSnapshotSources {
  directory: SnapshotSource<DirectorySummary>;
  gsdDirectory: SnapshotSource<{ present: true }>;
  gsdId: SnapshotSource<{ gsdId: string }>;
  projectMd: SnapshotSource<ProjectMarkdownValue>;
  repoMeta: SnapshotSource<RepoMetaValue>;
  autoLock: SnapshotSource<AutoLockValue>;
  stateMd: SnapshotSource<StateMarkdownValue>;
  metricsJson: SnapshotSource<GsdMetricsSummaryValue>;
  gsdDb: SnapshotSource<GsdDbSummaryValue>;
}

export interface ProjectSnapshot {
  status: ProjectSnapshotStatus;
  checkedAt: string;
  directory: DirectorySummary;
  identityHints: {
    gsdId: string | null;
    repoFingerprint: string | null;
    displayName?: string;
    displayNameSource?: 'readme' | 'git' | 'repoMeta' | 'directory' | 'projectMd' | 'gsdId';
  };
  sources: ProjectSnapshotSources;
  warnings: SnapshotWarning[];
}

export interface ProjectMonitorError {
  scope: 'projectRoot' | SnapshotSourceName | 'registry';
  message: string;
  at: string;
}

export interface ProjectMonitorSummary {
  health: ProjectMonitorHealth;
  lastAttemptedAt: string | null;
  lastSuccessfulAt: string | null;
  lastTrigger: ProjectReconcileTrigger | null;
  lastError: ProjectMonitorError | null;
}

export interface ProjectContinuitySummary {
  state: ProjectContinuityState;
  checkedAt: string;
  pathLostAt: string | null;
  lastRelinkedAt: string | null;
  previousRegisteredPath: string | null;
  previousCanonicalPath: string | null;
}

export interface ProjectDataLocation {
  projectRoot: string;
  gsdRootPath: string;
  gsdDbPath: string;
  statePath: string;
  persistenceScope: 'project';
}

export interface ProjectTimelineEntry {
  id: string;
  sequence: number;
  type: ProjectTimelineEntryType;
  projectId: string;
  emittedAt: string;
  trigger: ProjectReconcileTrigger;
  snapshotStatus: ProjectSnapshotStatus;
  monitorHealth: ProjectMonitorHealth;
  warningCount: number;
  changed: boolean;
  detail: string;
  eventId: string | null;
  error: ProjectMonitorError | null;
}

export interface ProjectInitRefreshResult {
  status: ProjectInitRefreshResultStatus;
  checkedAt: string;
  detail: string;
  snapshotStatus: ProjectSnapshotStatus | null;
  warningCount: number | null;
  changed: boolean | null;
  eventId: string | null;
}

export interface ProjectInitJobHistoryEntry {
  id: string;
  sequence: number;
  stage: ProjectInitJobStage;
  detail: string;
  outputExcerpt: string | null;
  emittedAt: string;
}

export interface ProjectInitJob {
  jobId: string;
  stage: ProjectInitJobStage;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  outputExcerpt: string | null;
  lastErrorDetail: string | null;
  refreshResult: ProjectInitRefreshResult | null;
  history: ProjectInitJobHistoryEntry[];
}

export interface ProjectRecord {
  projectId: string;
  registeredPath: string;
  canonicalPath: string;
  createdAt: string;
  updatedAt: string;
  lastEventId: string | null;
  snapshot: ProjectSnapshot;
  monitor: ProjectMonitorSummary;
  continuity?: ProjectContinuitySummary;
  dataLocation: ProjectDataLocation;
  latestInitJob: ProjectInitJob | null;
}

export interface ProjectDetailResponse extends ProjectRecord {
  timeline: ProjectTimelineEntry[];
}

export interface ProjectTimelineResponse {
  items: ProjectTimelineEntry[];
  total: number;
}

export interface FilesystemDirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface FilesystemDirectoryResponse {
  path: string;
  parentPath: string | null;
  entries: FilesystemDirectoryEntry[];
  truncated: boolean;
}

export interface LogPolicySummary {
  enabled: boolean;
  rotateDaily: true;
  compression: 'gzip';
  retentionDays: number;
  maxFileSizeBytes: number;
}

export interface HealthResponse {
  service: typeof SERVICE_NAME;
  status: 'ok';
  checkedAt: string;
  runtime: {
    directory: string;
    logFile: string | null;
    logPolicy: LogPolicySummary;
  };
  database: {
    connected: true;
    fileName: string;
    path: string;
    schemaVersion: string;
  };
  assets: {
    available: true;
    directoryName: string;
    path: string;
  };
  projects: {
    total: number;
  };
}

export interface ProjectsResponse {
  items: ProjectRecord[];
  total: number;
}

export interface RegisterProjectRequest {
  path: string;
}

export interface RelinkProjectRequest {
  path: string;
}

export type ProjectEventType =
  | 'service.ready'
  | 'project.registered'
  | 'project.refreshed'
  | 'project.deleted'
  | 'project.relinked'
  | 'project.monitor.updated'
  | 'project.init.updated';

export interface ServiceReadyEventPayload {
  service: typeof SERVICE_NAME;
  projects: {
    total: number;
  };
}

export interface ProjectSnapshotEventPayload {
  projectId: string;
  canonicalPath: string;
  snapshotStatus: ProjectSnapshotStatus;
  warningCount: number;
  warnings: SnapshotWarning[];
  sourceStates: Record<SnapshotSourceName, SnapshotSourceState>;
  changed: boolean;
  checkedAt: string;
  trigger: ProjectReconcileTrigger;
  monitor: ProjectMonitorSummary;
  continuity?: ProjectContinuitySummary;
}

export interface ProjectRelinkEventPayload {
  projectId: string;
  registeredPath: string;
  canonicalPath: string;
  previousRegisteredPath: string;
  previousCanonicalPath: string;
  snapshotStatus: ProjectSnapshotStatus;
  warningCount: number;
  emittedAt: string;
  continuity: ProjectContinuitySummary;
  monitor: ProjectMonitorSummary;
}

export interface ProjectDeletedEventPayload {
  projectId: string;
  registeredPath: string;
  canonicalPath: string;
  deletedAt: string;
}

export interface ProjectMonitorEventPayload {
  projectId: string;
  canonicalPath: string;
  snapshotStatus: ProjectSnapshotStatus;
  warningCount: number;
  trigger: ProjectReconcileTrigger;
  previousHealth: ProjectMonitorHealth | null;
  monitor: ProjectMonitorSummary;
  continuity?: ProjectContinuitySummary;
}

export interface ProjectInitEventPayload {
  projectId: string;
  canonicalPath: string;
  snapshotStatus: ProjectSnapshotStatus;
  job: ProjectInitJob;
  historyEntry: ProjectInitJobHistoryEntry;
  continuity?: ProjectContinuitySummary;
}

export type ProjectEventPayload =
  | ServiceReadyEventPayload
  | ProjectSnapshotEventPayload
  | ProjectDeletedEventPayload
  | ProjectRelinkEventPayload
  | ProjectMonitorEventPayload
  | ProjectInitEventPayload;

export interface ProjectEventEnvelope<TPayload = ProjectEventPayload> {
  id: string;
  sequence: number;
  type: ProjectEventType;
  emittedAt: string;
  projectId: string | null;
  payload: TPayload;
}

export interface ProjectMutationResponse {
  project: ProjectRecord;
  event: ProjectEventEnvelope<ProjectEventPayload>;
}

export function buildSourceStateMap(
  snapshot: ProjectSnapshot,
): Record<SnapshotSourceName, SnapshotSourceState> {
  return {
    directory: snapshot.sources.directory.state,
    gsdDirectory: snapshot.sources.gsdDirectory.state,
    gsdId: snapshot.sources.gsdId.state,
    projectMd: snapshot.sources.projectMd.state,
    repoMeta: snapshot.sources.repoMeta.state,
    autoLock: snapshot.sources.autoLock.state,
    stateMd: snapshot.sources.stateMd.state,
    metricsJson: snapshot.sources.metricsJson?.state ?? 'missing',
    gsdDb: snapshot.sources.gsdDb.state,
  };
}

export function deriveMonitorHealthFromSnapshot(snapshotStatus: ProjectSnapshotStatus): ProjectMonitorHealth {
  return snapshotStatus === 'degraded' ? 'degraded' : 'healthy';
}

export function createStaleProjectMonitorSummary(): ProjectMonitorSummary {
  return {
    health: 'stale',
    lastAttemptedAt: null,
    lastSuccessfulAt: null,
    lastTrigger: null,
    lastError: null,
  };
}

export function createTrackedProjectContinuitySummary(
  checkedAt: string,
  overrides: Partial<ProjectContinuitySummary> = {},
): ProjectContinuitySummary {
  return {
    state: overrides.state ?? 'tracked',
    checkedAt,
    pathLostAt: overrides.pathLostAt ?? null,
    lastRelinkedAt: overrides.lastRelinkedAt ?? null,
    previousRegisteredPath: overrides.previousRegisteredPath ?? null,
    previousCanonicalPath: overrides.previousCanonicalPath ?? null,
  };
}

export function isProjectInitJobTerminalStage(stage: ProjectInitJobStage) {
  return stage === 'succeeded' || stage === 'failed' || stage === 'timed_out' || stage === 'cancelled';
}
