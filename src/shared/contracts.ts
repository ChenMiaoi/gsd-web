export const SERVICE_NAME = 'gsd-web';

export const SNAPSHOT_SOURCE_NAMES = [
  'directory',
  'gsdDirectory',
  'gsdId',
  'projectMd',
  'repoMeta',
  'autoLock',
  'stateMd',
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
}

export interface GsdDbSummaryValue {
  tables: string[];
  counts: {
    milestones: number | null;
    slices: number | null;
    tasks: number | null;
    projects: number | null;
  };
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
  gsdDb: SnapshotSource<GsdDbSummaryValue>;
}

export interface ProjectSnapshot {
  status: ProjectSnapshotStatus;
  checkedAt: string;
  directory: DirectorySummary;
  identityHints: {
    gsdId: string | null;
    repoFingerprint: string | null;
  };
  sources: ProjectSnapshotSources;
  warnings: SnapshotWarning[];
}

export interface ProjectRecord {
  projectId: string;
  registeredPath: string;
  canonicalPath: string;
  createdAt: string;
  updatedAt: string;
  lastEventId: string | null;
  snapshot: ProjectSnapshot;
}

export interface HealthResponse {
  service: typeof SERVICE_NAME;
  status: 'ok';
  checkedAt: string;
  database: {
    connected: true;
    fileName: string;
    schemaVersion: string;
  };
  assets: {
    available: true;
    directoryName: string;
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

export type ProjectEventType = 'service.ready' | 'project.registered' | 'project.refreshed';

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
}

export type ProjectEventPayload = ServiceReadyEventPayload | ProjectSnapshotEventPayload;

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
  event: ProjectEventEnvelope<ProjectSnapshotEventPayload>;
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
    gsdDb: snapshot.sources.gsdDb.state,
  };
}
