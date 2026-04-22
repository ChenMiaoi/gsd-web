import { useCallback, useEffect, useRef, useState } from 'react';

import {
  PROJECT_INIT_JOB_STAGES,
  PROJECT_INIT_REFRESH_RESULT_STATUSES,
  PROJECT_SNAPSHOT_STATUSES,
  SNAPSHOT_SOURCE_NAMES,
  SNAPSHOT_SOURCE_STATES,
  isProjectInitJobTerminalStage,
  type DirectorySummary,
  type ProjectInitEventPayload,
  type ProjectInitJob,
  type ProjectInitJobHistoryEntry,
  type ProjectInitJobStage,
  type ProjectInitRefreshResult,
  type ProjectInitRefreshResultStatus,
  type ProjectMutationResponse,
  type ProjectRecord,
  type ProjectSnapshot,
  type ProjectSnapshotEventPayload,
  type ProjectSnapshotStatus,
  type ProjectsResponse,
  type SnapshotSourceName,
  type SnapshotSourceState,
  type SnapshotWarning,
} from '../shared/contracts.js';

type StreamStatus = 'connecting' | 'connected' | 'stale' | 'disconnected';
type KnownEventType = 'service.ready' | 'project.registered' | 'project.refreshed' | 'project.init.updated';

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

const REQUEST_TIMEOUT_MS = 8_000;
const INIT_TERMINAL_FAILURE_STAGES: ReadonlySet<ProjectInitJobStage> = new Set([
  'failed',
  'timed_out',
  'cancelled',
]);
const INIT_STAGE_LABELS: Record<ProjectInitJobStage, string> = {
  queued: 'Queued',
  starting: 'Starting',
  initializing: 'Initializing',
  refreshing: 'Refreshing',
  succeeded: 'Succeeded',
  failed: 'Failed',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
};
const STREAM_STALE_MS = 30_000;
const WARNING_TEXT_LIMIT = 240;
const KNOWN_EVENT_TYPES: ReadonlySet<KnownEventType> = new Set([
  'service.ready',
  'project.registered',
  'project.refreshed',
  'project.init.updated',
]);

const SOURCE_LABELS: Record<SnapshotSourceName, string> = {
  directory: 'Directory',
  gsdDirectory: '.gsd directory',
  gsdId: '.gsd-id',
  projectMd: 'PROJECT.md',
  repoMeta: 'repo-meta.json',
  autoLock: 'auto.lock',
  stateMd: 'STATE.md',
  gsdDb: 'gsd.db',
};

const STATUS_LABELS: Record<ProjectSnapshotStatus, string> = {
  uninitialized: 'Uninitialized',
  initialized: 'Initialized',
  degraded: 'Degraded',
};

const STREAM_STATUS_LABELS: Record<StreamStatus, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  stale: 'Stale',
  disconnected: 'Disconnected',
};

const STREAM_STATUS_MESSAGES: Record<StreamStatus, string> = {
  connecting: 'Opening the live snapshot stream…',
  connected: 'Live snapshot events are flowing from /api/events.',
  stale: 'No recent snapshot events arrived. Manual refresh still works.',
  disconnected: 'Live events dropped. Use manual refresh while EventSource reconnects.',
};

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
      projects:
        counts.projects === null || counts.projects === undefined
          ? null
          : expectNumber(counts.projects, `${label}.counts.projects`),
    },
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
  const latestInitJob =
    record.latestInitJob === null || record.latestInitJob === undefined
      ? null
      : assertUiSafeInitJob(parseProjectInitJob(record.latestInitJob, `${label}.latestInitJob`), snapshot.status, `${label}.latestInitJob`);

  return {
    projectId: expectString(record.projectId, `${label}.projectId`),
    registeredPath: expectString(record.registeredPath, `${label}.registeredPath`),
    canonicalPath: expectString(record.canonicalPath, `${label}.canonicalPath`),
    createdAt: expectString(record.createdAt, `${label}.createdAt`),
    updatedAt: expectString(record.updatedAt, `${label}.updatedAt`),
    lastEventId:
      record.lastEventId === undefined ? null : expectNullableString(record.lastEventId, `${label}.lastEventId`),
    snapshot,
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
    gsdDb: parseSnapshotSourceState(record.gsdDb, `${label}.gsdDb`),
  };
}

function parseProjectSnapshotEventPayload(value: unknown, label: string): ProjectSnapshotEventPayload {
  const record = expectRecord(value, label);

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
  };
}

function parseProjectInitEventPayload(value: unknown, label: string): ProjectInitEventPayload {
  const record = expectRecord(value, label);

  return {
    projectId: expectString(record.projectId, `${label}.projectId`),
    canonicalPath: expectString(record.canonicalPath, `${label}.canonicalPath`),
    snapshotStatus: parseSnapshotStatus(record.snapshotStatus, `${label}.snapshotStatus`),
    job: parseProjectInitJob(record.job, `${label}.job`),
    historyEntry: parseProjectInitJobHistoryEntry(record.historyEntry, `${label}.historyEntry`),
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

function formatRequestError(error: unknown, timeoutMessage: string): string {
  if (error instanceof TimeoutError) {
    return timeoutMessage;
  }

  if (error instanceof HttpError || error instanceof ResponseShapeError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'An unexpected dashboard error occurred.';
}

function clampWarning(message: string) {
  if (message.length <= WARNING_TEXT_LIMIT) {
    return message;
  }

  return `${message.slice(0, WARNING_TEXT_LIMIT - 1)}…`;
}

function formatTimestamp(timestamp: string) {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function basenameFromPath(value: string) {
  const segments = value.split(/[\\/]/u).filter(Boolean);

  return segments.at(-1) ?? value;
}

function describeProject(project: ProjectRecord) {
  return (
    project.snapshot.sources.projectMd.value?.title ??
    project.snapshot.sources.repoMeta.value?.projectName ??
    project.snapshot.identityHints.gsdId ??
    basenameFromPath(project.canonicalPath)
  );
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

function summarizeInitJob(job: ProjectInitJob | null) {
  if (!job) {
    return null;
  }

  return job.refreshResult?.detail ?? getLatestInitHistoryEntry(job)?.detail ?? 'Waiting for initialization updates.';
}

function initButtonLabel(
  project: ProjectRecord,
  options: { requestPending: boolean; syncingDetail: boolean },
) {
  if (options.requestPending) {
    return 'Starting initialization…';
  }

  if (options.syncingDetail) {
    return 'Refreshing monitored detail…';
  }

  if (hasActiveInitJob(project.latestInitJob)) {
    return `Initialization ${INIT_STAGE_LABELS[project.latestInitJob!.stage]}…`;
  }

  if (canRetryInitJob(project.latestInitJob)) {
    return 'Retry initialization';
  }

  return 'Initialize project';
}

export default function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectRecord | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [registerPath, setRegisterPath] = useState('');
  const [registerPending, setRegisterPending] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerSuccess, setRegisterSuccess] = useState<string | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [initPendingProjectId, setInitPendingProjectId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [initDetailSyncProjectId, setInitDetailSyncProjectId] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');
  const [streamSummary, setStreamSummary] = useState<StreamSummary | null>(null);

  const mountedRef = useRef(true);
  const selectedProjectIdRef = useRef<string | null>(null);
  const selectedProjectRef = useRef<ProjectRecord | null>(null);
  const projectsRef = useRef<ProjectRecord[]>([]);
  const staleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;

      if (staleTimerRef.current !== null) {
        window.clearTimeout(staleTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const markStreamActive = useCallback((summary?: StreamSummary) => {
    if (!mountedRef.current) {
      return;
    }

    setStreamStatus('connected');

    if (summary) {
      setStreamSummary(summary);
    }

    if (staleTimerRef.current !== null) {
      window.clearTimeout(staleTimerRef.current);
    }

    staleTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) {
        setStreamStatus((current) => (current === 'connected' ? 'stale' : current));
      }
    }, STREAM_STALE_MS);
  }, []);

  const loadProjectDetail = useCallback(async (projectId: string, fallbackProject?: ProjectRecord | null) => {
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
        (value) => parseProjectRecord(value, 'project detail'),
        'Project detail',
      );

      if (!mountedRef.current || selectedProjectIdRef.current !== projectId) {
        return;
      }

      setSelectedProject(project);
      setProjects((current) => upsertProject(current, project));
      setDetailError(null);
    } catch (error) {
      if (!mountedRef.current || selectedProjectIdRef.current !== projectId) {
        return;
      }

      setDetailError(
        formatRequestError(
          error,
          'Project detail timed out. The last visible snapshot is still shown while you retry.',
        ),
      );
    } finally {
      if (mountedRef.current && selectedProjectIdRef.current === projectId) {
        setDetailLoading(false);
      }
    }
  }, []);

  const syncInitDetailAfterSuccess = useCallback(
    async (projectId: string, fallbackProject: ProjectRecord) => {
      setInitDetailSyncProjectId(projectId);

      try {
        await loadProjectDetail(projectId, fallbackProject);
      } finally {
        if (mountedRef.current) {
          setInitDetailSyncProjectId((current) => (current === projectId ? null : current));
        }
      }
    },
    [loadProjectDetail],
  );

  const syncInventory = useCallback(
    async (
      selectionHint?: string | null,
      options: {
        preserveSelectedDetail?: boolean;
      } = {},
    ) => {
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

        if (!mountedRef.current) {
          return;
        }

        setProjects(response.items);
        setInventoryError(null);

        if (response.items.length === 0) {
          setSelectedProjectId(null);
          setSelectedProject(null);
          setDetailError(null);
          return;
        }

        const preferredProjectId = selectionHint ?? selectedProjectIdRef.current;
        const nextProject =
          response.items.find((project) => project.projectId === preferredProjectId) ?? response.items[0] ?? null;

        if (!nextProject) {
          return;
        }

        const shouldPreserveSelectedDetail =
          options.preserveSelectedDetail === true &&
          selectedProjectRef.current !== null &&
          selectedProjectRef.current.projectId === nextProject.projectId &&
          selectedProjectIdRef.current === nextProject.projectId;

        setSelectedProjectId(nextProject.projectId);

        if (shouldPreserveSelectedDetail) {
          return;
        }

        setSelectedProject(nextProject);

        void loadProjectDetail(nextProject.projectId, nextProject);
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }

        setInventoryError(
          formatRequestError(
            error,
            'Project inventory timed out. Retry to keep the current list and detail visible.',
          ),
        );
      } finally {
        if (mountedRef.current) {
          setInventoryLoading(false);
        }
      }
    },
    [loadProjectDetail],
  );

  useEffect(() => {
    void syncInventory();
  }, [syncInventory]);

  useEffect(() => {
    const eventSource = new EventSource('/api/events');

    const handleEnvelope = (event: MessageEvent<string>) => {
      try {
        const raw = JSON.parse(event.data) as unknown;
        const summary = parseEventEnvelope(raw);
        markStreamActive(summary);

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
              selectedProject.latestInitJob?.jobId === initEnvelope.payload.job.jobId &&
              selectedProject.latestInitJob.stage === 'succeeded';

            setSelectedProject(mergedProject);
            setInitError(null);

            if (initEnvelope.payload.job.stage === 'succeeded' && !alreadySucceeded) {
              void syncInitDetailAfterSuccess(initEnvelope.projectId, mergedProject);
            }
          }

          return;
        }

        if (summary.type === 'project.registered' || summary.type === 'project.refreshed') {
          const shouldSyncDetail =
            summary.projectId !== null &&
            (selectedProjectIdRef.current === summary.projectId || selectedProjectIdRef.current === null);
          const activeSelectedInitJob = selectedProjectRef.current?.latestInitJob ?? null;
          const preserveSelectedDetail =
            summary.type === 'project.refreshed' &&
            summary.projectId !== null &&
            selectedProjectRef.current?.projectId === summary.projectId &&
            (hasActiveInitJob(activeSelectedInitJob) || initDetailSyncProjectId === summary.projectId);

          void syncInventory(summary.projectId ?? selectedProjectIdRef.current, {
            preserveSelectedDetail,
          });

          if (!preserveSelectedDetail && shouldSyncDetail && summary.projectId) {
            const fallbackProject =
              projectsRef.current.find((project) => project.projectId === summary.projectId) ??
              selectedProjectRef.current;

            void loadProjectDetail(summary.projectId, fallbackProject);
          }
        }
      } catch {
        // Ignore unknown or malformed SSE payloads and keep the dashboard usable.
      }
    };

    eventSource.onopen = () => {
      markStreamActive();
    };

    eventSource.onerror = () => {
      if (mountedRef.current) {
        setStreamStatus('disconnected');
      }
    };

    eventSource.addEventListener('service.ready', handleEnvelope as EventListener);
    eventSource.addEventListener('project.registered', handleEnvelope as EventListener);
    eventSource.addEventListener('project.refreshed', handleEnvelope as EventListener);
    eventSource.addEventListener('project.init.updated', handleEnvelope as EventListener);

    return () => {
      eventSource.removeEventListener('service.ready', handleEnvelope as EventListener);
      eventSource.removeEventListener('project.registered', handleEnvelope as EventListener);
      eventSource.removeEventListener('project.refreshed', handleEnvelope as EventListener);
      eventSource.removeEventListener('project.init.updated', handleEnvelope as EventListener);
      eventSource.close();
    };
  }, [initDetailSyncProjectId, loadProjectDetail, markStreamActive, syncInitDetailAfterSuccess, syncInventory]);

  const selectProject = useCallback(
    (project: ProjectRecord) => {
      setSelectedProjectId(project.projectId);
      setSelectedProject(project);
      setDetailError(null);
      setRefreshError(null);
      setInitError(null);
      setRegisterSuccess(null);
      void loadProjectDetail(project.projectId, project);
    },
    [loadProjectDetail],
  );

  const handleRegister = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const candidatePath = registerPath.trim();

      if (candidatePath.length === 0) {
        setRegisterError('Enter a local path before registering a project.');
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
        setRegisterError('That path is already present in the inventory.');
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
        setSelectedProjectId(response.project.projectId);
        setSelectedProject(response.project);
        setRegisterPath('');
        setRegisterSuccess(`Registered ${describeProject(response.project)}.`);
        setDetailError(null);
        setRefreshError(null);
        setInitError(null);
        void loadProjectDetail(response.project.projectId, response.project);
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }

        setRegisterError(
          formatRequestError(
            error,
            'Project registration timed out. Your current input and inventory remain unchanged.',
          ),
        );
      } finally {
        if (mountedRef.current) {
          setRegisterPending(false);
        }
      }
    },
    [loadProjectDetail, projects, registerPath],
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
          'Project initialization timed out. The current project detail stayed visible, and you can retry when the request resolves.',
        ),
      );
    } finally {
      if (mountedRef.current) {
        setInitPendingProjectId((current) => (current === selected.projectId ? null : current));
      }
    }
  }, []);

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
      setInitError(null);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }

      setRefreshError(
        formatRequestError(
          error,
          'Project refresh timed out. The last visible snapshot is still shown while you retry.',
        ),
      );
    } finally {
      if (mountedRef.current) {
        setRefreshPending(false);
      }
    }
  }, []);

  const totalProjectsLabel = pluralize(projects.length, 'project');
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
  const selectedInitSummary = summarizeInitJob(selectedInitJob);

  return (
    <main className="app-shell">
      <section className="hero panel">
        <div>
          <p className="eyebrow">LOCAL-FIRST SERVICE SHELL</p>
          <h1>Project inventory</h1>
          <p className="lede">
            Register local paths, inspect truthful snapshot health, and watch live refresh events land
            from the same hosted Fastify process.
          </p>
        </div>
        <div className="hero__meta">
          <div className="stat-card" data-testid="inventory-count">
            <span className="stat-card__label">Registered</span>
            <strong>{totalProjectsLabel}</strong>
          </div>
          <div className="stat-card" data-testid="stream-status" data-stream-status={streamStatus}>
            <span className="stat-card__label">Live stream</span>
            <strong>{STREAM_STATUS_LABELS[streamStatus]}</strong>
            <span>{STREAM_STATUS_MESSAGES[streamStatus]}</span>
          </div>
          <div className="stat-card" data-testid="stream-last-event">
            <span className="stat-card__label">Last SSE event</span>
            {streamSummary ? (
              <>
                <strong>{streamSummary.type}</strong>
                <span>{streamSummary.id}</span>
                <time dateTime={streamSummary.emittedAt}>{formatTimestamp(streamSummary.emittedAt)}</time>
              </>
            ) : (
              <span>Waiting for the first event envelope.</span>
            )}
          </div>
        </div>
      </section>

      <section className="register-layout">
        <form className="panel register-panel" onSubmit={handleRegister}>
          <div>
            <h2>Register a local project path</h2>
            <p>
              Registration stays read-only: the service snapshots the directory, records a stable
              project id, and leaves the monitored workspace untouched.
            </p>
          </div>

          <label className="field" htmlFor="project-path">
            <span>Project path</span>
            <input
              id="project-path"
              name="project-path"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="/absolute/path/to/project"
              value={registerPath}
              onChange={(nextEvent) => {
                setRegisterPath(nextEvent.target.value);
                setRegisterError(null);
                setRegisterSuccess(null);
              }}
            />
          </label>

          <div className="register-panel__actions">
            <button type="submit" className="primary-button" disabled={registerPending}>
              {registerPending ? 'Registering…' : 'Register project'}
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
              Clear input
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
      </section>

      <section className="dashboard-grid">
        <section className="panel inventory-panel" aria-labelledby="inventory-heading">
          <div className="panel-header">
            <div>
              <h2 id="inventory-heading">Registered inventory</h2>
              <p>Current projection from /api/projects.</p>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void syncInventory(selectedProjectIdRef.current);
              }}
              disabled={inventoryLoading}
            >
              {inventoryLoading ? 'Refreshing…' : 'Refresh inventory'}
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
                Retry inventory
              </button>
            </div>
          ) : null}

          {projects.length === 0 ? (
            <div className="empty-state" data-testid="inventory-empty">
              <h3>No registered projects yet.</h3>
              <p>Register an empty directory or initialized workspace to see truthful snapshot status.</p>
            </div>
          ) : (
            <ul className="project-list">
              {projects.map((project) => {
                const label = describeProject(project);
                const warningCount = project.snapshot.warnings.length;
                const initJob = project.latestInitJob;
                const initSummary = summarizeInitJob(initJob);

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
                          {STATUS_LABELS[project.snapshot.status]}
                        </span>
                        <span>{pluralize(warningCount, 'warning')}</span>
                      </div>
                      {initJob ? (
                        <div className="project-card__job" data-testid={`project-init-stage-${project.projectId}`}>
                          <span className="status-pill status-pill--job" data-status={initJob.stage}>
                            {INIT_STAGE_LABELS[initJob.stage]}
                          </span>
                          <span>{initSummary}</span>
                        </div>
                      ) : null}
                      <time dateTime={project.snapshot.checkedAt}>{formatTimestamp(project.snapshot.checkedAt)}</time>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel detail-panel" aria-labelledby="detail-heading">
          <div className="panel-header">
            <div>
              <h2 id="detail-heading">Project detail</h2>
              <p>Truthful snapshot from /api/projects/:id plus manual refresh.</p>
            </div>
            <div className="panel-header__actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  if (selectedProjectIdRef.current) {
                    void loadProjectDetail(selectedProjectIdRef.current, selectedProjectRef.current);
                  }
                }}
                disabled={!selectedProjectId || detailLoading}
              >
                {detailLoading ? 'Reloading…' : 'Reload detail'}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  void handleRefreshSelected();
                }}
                disabled={!selectedProjectId || refreshPending}
              >
                {refreshPending ? 'Refreshing…' : 'Refresh selected project'}
              </button>
            </div>
          </div>

          {detailError ? (
            <p className="inline-alert inline-alert--error" role="alert" data-testid="detail-error">
              {detailError}
            </p>
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
            <div className="detail-content">
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
                    {STATUS_LABELS[selectedProject.snapshot.status]}
                  </span>
                  <span className="meta-badge" data-testid="detail-warning-count">
                    {pluralize(selectedProject.snapshot.warnings.length, 'warning')}
                  </span>
                </div>
              </header>

              <dl className="detail-facts">
                <div>
                  <dt>Registered path</dt>
                  <dd>{selectedProject.registeredPath}</dd>
                </div>
                <div>
                  <dt>Project id</dt>
                  <dd data-testid="detail-project-id-value">{selectedProject.projectId}</dd>
                </div>
                <div>
                  <dt>Last event</dt>
                  <dd>{selectedProject.lastEventId ?? 'Waiting for the first project event.'}</dd>
                </div>
                <div>
                  <dt>Checked at</dt>
                  <dd>
                    <time dateTime={selectedProject.snapshot.checkedAt}>
                      {formatTimestamp(selectedProject.snapshot.checkedAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>GSD id</dt>
                  <dd data-testid="detail-gsd-id">
                    {selectedProject.snapshot.identityHints.gsdId ?? 'No .gsd-id discovered.'}
                  </dd>
                </div>
                <div>
                  <dt>Repo fingerprint</dt>
                  <dd>{selectedProject.snapshot.identityHints.repoFingerprint ?? 'Not available yet.'}</dd>
                </div>
              </dl>

              <section className="subpanel init-panel" data-testid="init-panel">
                <div className="subpanel__header subpanel__header--actions">
                  <div>
                    <h4>Initialization</h4>
                    <p>Explicitly run the supported `/gsd init` flow without leaving this project detail.</p>
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
                      {initButtonLabel(selectedProject, {
                        requestPending: selectedInitRequestPending,
                        syncingDetail: selectedInitSyncingDetail,
                      })}
                    </button>
                  ) : selectedInitJob ? (
                    <span className="status-pill status-pill--job" data-status={selectedInitJob.stage}>
                      {INIT_STAGE_LABELS[selectedInitJob.stage]}
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
                        {INIT_STAGE_LABELS[selectedInitJob.stage]}
                      </span>
                      <span className="meta-badge">
                        Updated {formatTimestamp(selectedInitJob.updatedAt)}
                      </span>
                      {selectedInitSyncingDetail ? (
                        <span className="meta-badge" data-testid="init-refresh-syncing">
                          Refreshing monitored detail…
                        </span>
                      ) : null}
                    </div>

                    <p className="init-banner__copy" data-testid="init-stage-detail">
                      {selectedInitSummary}
                    </p>

                    {hasActiveInitJob(selectedInitJob) && streamStatus !== 'connected' ? (
                      <p className="init-banner__stream-note" data-testid="init-stream-note">
                        Live init updates are {STREAM_STATUS_LABELS[streamStatus].toLowerCase()}. Reload detail to
                        inspect persisted job truth while the stream recovers.
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
                          <dt>Refresh result</dt>
                          <dd>{selectedInitJob.refreshResult.detail}</dd>
                        </div>
                        <div>
                          <dt>Snapshot status</dt>
                          <dd>{selectedInitJob.refreshResult.snapshotStatus ?? 'Unavailable'}</dd>
                        </div>
                        <div>
                          <dt>Warnings after refresh</dt>
                          <dd>
                            {selectedInitJob.refreshResult.warningCount === null
                              ? 'Unavailable'
                              : pluralize(selectedInitJob.refreshResult.warningCount, 'warning')}
                          </dd>
                        </div>
                        <div>
                          <dt>Refresh event</dt>
                          <dd>{selectedInitJob.refreshResult.eventId ?? 'Unavailable'}</dd>
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
                              {INIT_STAGE_LABELS[entry.stage]}
                            </span>
                            <time dateTime={entry.emittedAt}>{formatTimestamp(entry.emittedAt)}</time>
                          </div>
                          <p>{entry.detail}</p>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : (
                  <p data-testid="init-empty-state">
                    This project will stay uninitialized until you explicitly start the supported bootstrap flow.
                  </p>
                )}
              </section>

              <section className="subpanel" data-testid="detail-directory">
                <h4>Directory summary</h4>
                {selectedProject.snapshot.directory.isEmpty ? (
                  <p>The directory is empty, so the project remains uninitialized.</p>
                ) : (
                  <>
                    <p>Sample entries from the live directory read:</p>
                    <ul className="tag-list">
                      {selectedProject.snapshot.directory.sampleEntries.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                      {selectedProject.snapshot.directory.sampleTruncated ? <li>…truncated</li> : null}
                    </ul>
                  </>
                )}
              </section>

              <section className="subpanel" data-testid="warning-list">
                <h4>Warnings</h4>
                {selectedProject.snapshot.warnings.length === 0 ? (
                  <p>No degraded or missing-source warnings were emitted.</p>
                ) : (
                  <ul className="warning-list">
                    {selectedProject.snapshot.warnings.map((warning, index) => (
                      <li key={`${warning.source}-${warning.code}-${index}`}>
                        <strong>{SOURCE_LABELS[warning.source]}</strong>
                        <span className="warning-code">{warning.code}</span>
                        <span title={warning.message}>{clampWarning(warning.message)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="subpanel source-grid">
                <div className="subpanel__header">
                  <h4>Snapshot source states</h4>
                  <p>Per-source truth from the backend snapshot adapter.</p>
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
                          <strong>{SOURCE_LABELS[sourceName]}</strong>
                          <p>{source.detail ?? 'No extra source detail was emitted.'}</p>
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
                <h4>Repo metadata</h4>
                {selectedProject.snapshot.sources.repoMeta.value ? (
                  <dl className="detail-facts detail-facts--compact">
                    <div>
                      <dt>Project</dt>
                      <dd>{selectedProject.snapshot.sources.repoMeta.value.projectName ?? 'Unknown'}</dd>
                    </div>
                    <div>
                      <dt>Branch</dt>
                      <dd>{selectedProject.snapshot.sources.repoMeta.value.currentBranch ?? 'Unknown'}</dd>
                    </div>
                    <div>
                      <dt>Head SHA</dt>
                      <dd>{selectedProject.snapshot.sources.repoMeta.value.headSha ?? 'Unknown'}</dd>
                    </div>
                    <div>
                      <dt>Dirty</dt>
                      <dd>
                        {selectedProject.snapshot.sources.repoMeta.value.dirty === null
                          ? 'Unknown'
                          : String(selectedProject.snapshot.sources.repoMeta.value.dirty)}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p>Repo metadata is unavailable until repo-meta.json parses cleanly.</p>
                )}
              </section>

              <section className="subpanel">
                <h4>Workspace notes</h4>
                <div className="detail-copy">
                  <p>
                    <strong>PROJECT.md:</strong>{' '}
                    {selectedProject.snapshot.sources.projectMd.value?.summary ??
                      selectedProject.snapshot.sources.projectMd.detail ??
                      'No project markdown summary available.'}
                  </p>
                  <p>
                    <strong>STATE.md:</strong>{' '}
                    {selectedProject.snapshot.sources.stateMd.value?.summary ??
                      selectedProject.snapshot.sources.stateMd.detail ??
                      'No state summary available.'}
                  </p>
                </div>
              </section>
            </div>
          ) : (
            <div className="empty-state" data-testid="detail-empty">
              <h3>No project selected.</h3>
              <p>Register or choose a project card to inspect its truthful snapshot detail.</p>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
