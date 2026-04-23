import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { access, constants, opendir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

import type {
  AutoLockValue,
  DirectorySummary,
  GsdDbSliceDependencySummary,
  GsdDbSummaryValue,
  GsdDbMilestoneSummary,
  GsdDbSliceSummary,
  GsdDbTaskSummary,
  GsdMetricsSummaryValue,
  ProjectMarkdownValue,
  ProjectSnapshot,
  ProjectSnapshotSources,
  RepoMetaValue,
  SnapshotSource,
  SnapshotSourceName,
  SnapshotSourceState,
  SnapshotWarning,
  StateMarkdownValue,
} from '../shared/contracts.js';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_DIRECTORY_SAMPLE_ENTRIES = 5;
const MAX_SUMMARY_LENGTH = 240;
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 2_000;

export interface CanonicalProjectPath {
  requestedPath: string;
  normalizedPath: string;
  canonicalPath: string;
}

export const BOOTSTRAP_REQUIRED_ENTRIES = ['STATE.md', 'PREFERENCES.md', 'gsd.db', 'milestones'] as const;

export type BootstrapRequiredEntry = (typeof BOOTSTRAP_REQUIRED_ENTRIES)[number];
export type BootstrapCompletenessState = 'absent' | 'partial' | 'complete' | 'ancestor_conflict';

export interface BootstrapCompleteness {
  state: BootstrapCompletenessState;
  projectRoot: string;
  gsdRootPath: string | null;
  detail: string;
  presentEntries: string[];
  missingEntries: BootstrapRequiredEntry[];
  requiredEntries: BootstrapRequiredEntry[];
}

interface SourceReadResult<T> {
  source: SnapshotSource<T>;
  warning?: SnapshotWarning;
}

type ProjectDisplayNameSource = NonNullable<ProjectSnapshot['identityHints']['displayNameSource']>;

interface ProjectDisplayName {
  name: string;
  source: ProjectDisplayNameSource;
}

class ProjectPathValidationError extends Error {
  readonly responseCode: 'invalid_path';
  readonly statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = 'ProjectPathValidationError';
    this.responseCode = 'invalid_path';
    this.statusCode = statusCode;
  }
}

export class SnapshotTimeoutError extends Error {
  readonly responseCode: 'snapshot_timeout';
  readonly statusCode: number;

  constructor(timeoutMs: number) {
    super(`Snapshot refresh exceeded ${timeoutMs}ms`);
    this.name = 'SnapshotTimeoutError';
    this.responseCode = 'snapshot_timeout';
    this.statusCode = 504;
  }
}

export class ProjectSnapshotReadError extends Error {
  readonly responseCode: 'snapshot_read_failed';
  readonly statusCode: number;
  readonly scope: 'projectRoot' | 'gsdDb';

  constructor(scope: 'projectRoot' | 'gsdDb', message: string, statusCode: number = 503) {
    super(message);
    this.name = 'ProjectSnapshotReadError';
    this.responseCode = 'snapshot_read_failed';
    this.statusCode = statusCode;
    this.scope = scope;
  }
}

function isTransientSqliteReadError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    /SQLITE_(BUSY|LOCKED|CANTOPEN|IOERR|READONLY)/i.test(error.message)
    || /database is locked/i.test(error.message)
    || /unable to open database file/i.test(error.message)
  );
}

function toProjectRootReadError(error: unknown): ProjectSnapshotReadError {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code);

    if (code === 'ENOENT') {
      return new ProjectSnapshotReadError('projectRoot', 'Project root is no longer available.');
    }

    if (code === 'EACCES' || code === 'EPERM') {
      return new ProjectSnapshotReadError('projectRoot', 'Project root is not readable.');
    }

    if (code === 'ENOTDIR') {
      return new ProjectSnapshotReadError('projectRoot', 'Project root no longer resolves to a directory.');
    }
  }

  return new ProjectSnapshotReadError('projectRoot', 'Project root could not be read.');
}

function createSource<T>(state: SnapshotSourceState, value: T, detail?: string): SnapshotSource<T> {
  const source: SnapshotSource<T> = { state };

  source.value = value;

  if (detail !== undefined) {
    source.detail = detail;
  }

  return source;
}

function createEmptySource<T>(state: SnapshotSourceState, detail?: string): SnapshotSource<T> {
  const source: SnapshotSource<T> = { state };

  if (detail !== undefined) {
    source.detail = detail;
  }

  return source;
}

function createWarning(source: SnapshotSourceName, code: SnapshotWarning['code'], message: string) {
  return {
    source,
    code,
    message,
  } satisfies SnapshotWarning;
}

function toMissingResult<T>(
  sourceName: SnapshotSourceName,
  detail: string,
  warnOnMissing: boolean,
  missingState: SnapshotSourceState = 'missing',
): SourceReadResult<T> {
  const source = createEmptySource<T>(missingState, detail);

  if (!warnOnMissing) {
    return { source };
  }

  return {
    source,
    warning: createWarning(sourceName, 'source_missing', detail),
  };
}

function toUnreadableResult<T>(sourceName: SnapshotSourceName, detail: string): SourceReadResult<T> {
  return {
    source: createEmptySource<T>('unreadable', detail),
    warning: createWarning(sourceName, 'source_unreadable', detail),
  };
}

function toMalformedResult<T>(sourceName: SnapshotSourceName, detail: string): SourceReadResult<T> {
  return {
    source: createEmptySource<T>('malformed', detail),
    warning: createWarning(sourceName, 'source_malformed', detail),
  };
}

function trimDetail(detail: string) {
  return detail.length > MAX_SUMMARY_LENGTH ? `${detail.slice(0, MAX_SUMMARY_LENGTH)}…` : detail;
}

function trimProjectName(value: string | null | undefined) {
  const trimmed = value?.trim() ?? '';

  return trimmed.length === 0 ? null : trimDetail(trimmed);
}

function isGenericProjectName(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase().replace(/[\s_-]+/gu, ' ') ?? '';

  return normalized === 'project' || normalized === 'untitled project' || normalized === 'project snapshot fixture';
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string') {
      const trimmed = value.trim();

      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return null;
}

function pickStringOrNumber(record: Record<string, unknown>, keys: string[]): string | number | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();

      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return null;
}

function pickBoolean(record: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'boolean') {
      return value;
    }
  }

  return null;
}

function pickWorkflowTimestamp(record: Record<string, unknown>, prefix: 'started' | 'finished') {
  if (prefix === 'started') {
    return pickStringOrNumber(record, [
      'startedAt',
      'startAt',
      'started_at',
      'start_at',
      'started',
      'startedOn',
      'createdAt',
      'created_at',
    ]);
  }

  return pickStringOrNumber(record, [
    'finishedAt',
    'finishAt',
    'completedAt',
    'endedAt',
    'finished_at',
    'finish_at',
    'completed_at',
    'ended_at',
    'finished',
    'completed',
  ]);
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      return Number.parseInt(value.trim(), 10);
    }
  }

  return null;
}

function pickFiniteNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value.trim());

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function summarizeMarkdown(markdown: string): ProjectMarkdownValue {
  const lines = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const titleLine = lines.find((line) => line.startsWith('# ')) ?? null;
  const summaryLine = lines.find((line) => !line.startsWith('#')) ?? null;

  return {
    title: titleLine === null ? null : trimDetail(titleLine.slice(2).trim()),
    summary: summaryLine === null ? null : trimDetail(summaryLine),
  };
}

function readmeCandidatePaths(projectRoot: string) {
  return ['README.md', 'README.markdown', 'README.mdown', 'README.txt', 'README']
    .flatMap((name) => [name, name.toLowerCase()])
    .map((name) => path.join(projectRoot, name));
}

async function readReadmeTitle(projectRoot: string) {
  for (const readmePath of readmeCandidatePaths(projectRoot)) {
    try {
      const markdown = await readUtf8FileStrict(readmePath);
      const title = summarizeMarkdown(markdown).title;

      if (title && !isGenericProjectName(title)) {
        return title;
      }
    } catch {
      // README is best-effort metadata for display only; it must not degrade snapshot health.
    }
  }

  return null;
}

function parseGitRemoteRepoName(value: string) {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  try {
    const remoteUrl = new URL(trimmed);
    const segment = remoteUrl.pathname.split('/').filter(Boolean).at(-1);

    return trimProjectName(segment?.replace(/\.git$/iu, '') ?? null);
  } catch {
    const normalized = trimmed
      .replace(/^.+:/u, '')
      .replace(/\\/gu, '/')
      .replace(/\/+$/u, '');
    const segment = normalized.split('/').filter(Boolean).at(-1);

    return trimProjectName(segment?.replace(/\.git$/iu, '') ?? null);
  }
}

function parseGitRemoteOriginName(config: string) {
  const lines = config.split(/\r?\n/u);
  let inOriginSection = false;

  for (const line of lines) {
    if (/^\s*\[/u.test(line)) {
      inOriginSection = /^\s*\[remote\s+"origin"\]\s*$/u.test(line);
      continue;
    }

    if (!inOriginSection) {
      continue;
    }

    const url = line.match(/^\s*url\s*=\s*(?<url>.+?)\s*$/u)?.groups?.url;

    if (url) {
      return parseGitRemoteRepoName(url);
    }
  }

  return null;
}

async function readGitConfigPath(projectRoot: string) {
  const dotGitPath = path.join(projectRoot, '.git');

  try {
    const dotGitStats = await stat(dotGitPath);

    if (dotGitStats.isDirectory()) {
      return path.join(dotGitPath, 'config');
    }

    if (dotGitStats.isFile()) {
      const gitFile = await readUtf8FileStrict(dotGitPath);
      const gitDir = gitFile.match(/^\s*gitdir:\s*(?<gitDir>.+?)\s*$/imu)?.groups?.gitDir;

      if (gitDir) {
        return path.join(path.isAbsolute(gitDir) ? gitDir : path.resolve(projectRoot, gitDir), 'config');
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function readGitRepositoryName(projectRoot: string) {
  const configPath = await readGitConfigPath(projectRoot);

  if (!configPath) {
    return null;
  }

  try {
    const config = await readUtf8FileStrict(configPath);
    const remoteName = parseGitRemoteOriginName(config);

    return remoteName && !isGenericProjectName(remoteName) ? remoteName : trimProjectName(path.basename(projectRoot));
  } catch {
    return trimProjectName(path.basename(projectRoot));
  }
}

async function resolveProjectDisplayName(
  projectRoot: string,
  projectMarkdown: ProjectMarkdownValue | null,
  repoMeta: RepoMetaValue | null,
): Promise<ProjectDisplayName> {
  const readmeTitle = await readReadmeTitle(projectRoot);

  if (readmeTitle) {
    return { name: readmeTitle, source: 'readme' };
  }

  const gitName = await readGitRepositoryName(projectRoot);

  if (gitName) {
    return { name: gitName, source: 'git' };
  }

  const repoName = trimProjectName(repoMeta?.projectName);

  if (repoName && !isGenericProjectName(repoName)) {
    return { name: repoName, source: 'repoMeta' };
  }

  const directoryName = trimProjectName(path.basename(projectRoot));

  if (directoryName) {
    return { name: directoryName, source: 'directory' };
  }

  const projectTitle = trimProjectName(projectMarkdown?.title);

  if (projectTitle && !isGenericProjectName(projectTitle)) {
    return { name: projectTitle, source: 'projectMd' };
  }

  return { name: projectRoot, source: 'directory' };
}

function summarizeStateMarkdown(markdown: string): StateMarkdownValue {
  const summary = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .join(' ');

  return {
    summary: trimDetail(summary.length === 0 ? 'STATE.md was present but empty.' : summary),
  };
}

function sanitizeRepoMeta(record: Record<string, unknown>): RepoMetaValue {
  return {
    projectName: pickString(record, ['projectName', 'name', 'project']),
    currentBranch: pickString(record, ['currentBranch', 'branch', 'headBranch']),
    headSha: pickString(record, ['headSha', 'commitSha', 'headCommit', 'sha']),
    repoFingerprint: pickString(record, [
      'repoFingerprint',
      'repoHash',
      'repositoryHash',
      'gitDirectoryHash',
    ]),
    dirty: pickBoolean(record, ['dirty', 'isDirty', 'hasUncommittedChanges']),
  };
}

function sanitizeAutoLock(record: Record<string, unknown>): AutoLockValue {
  return {
    status: pickString(record, ['status', 'state', 'phase']),
    pid: pickNumber(record, ['pid', 'processId']),
    startedAt: pickString(record, ['startedAt', 'createdAt', 'lockedAt']),
    updatedAt: pickString(record, ['updatedAt', 'heartbeatAt', 'touchedAt']),
  };
}

async function readUtf8FileStrict(filePath: string) {
  const buffer = await readFile(filePath);
  return utf8Decoder.decode(buffer);
}

async function readTextSource<T>(
  filePath: string,
  sourceName: SnapshotSourceName,
  transform: (content: string) => T,
  options: {
    detailLabel: string;
    warnOnMissing: boolean;
    missingState?: SnapshotSourceState;
  },
): Promise<SourceReadResult<T>> {
  try {
    const content = await readUtf8FileStrict(filePath);

    return {
      source: createSource('ok', transform(content)),
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code);

      if (code === 'ENOENT') {
        return toMissingResult(
          sourceName,
          `${options.detailLabel} is missing.`,
          options.warnOnMissing,
          options.missingState,
        );
      }

      if (code === 'EACCES' || code === 'EPERM') {
        return toUnreadableResult(sourceName, `${options.detailLabel} is not readable.`);
      }
    }

    if (error instanceof TypeError) {
      return toMalformedResult(sourceName, `${options.detailLabel} is not valid UTF-8.`);
    }

    return toUnreadableResult(sourceName, `${options.detailLabel} could not be read.`);
  }
}

async function readJsonSource<T>(
  filePath: string,
  sourceName: SnapshotSourceName,
  transform: (record: Record<string, unknown>) => T,
  options: {
    detailLabel: string;
    warnOnMissing: boolean;
    missingState?: SnapshotSourceState;
  },
): Promise<SourceReadResult<T>> {
  const textResult = await readTextSource(filePath, sourceName, (value) => value, options);

  if (textResult.source.state !== 'ok' || textResult.source.value === undefined) {
    return textResult as SourceReadResult<T>;
  }

  try {
    const parsed = JSON.parse(textResult.source.value) as unknown;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return toMalformedResult(sourceName, `${options.detailLabel} must contain a JSON object.`);
    }

    return {
      source: createSource('ok', transform(parsed as Record<string, unknown>)),
    };
  } catch {
    return toMalformedResult(sourceName, `${options.detailLabel} contains malformed JSON.`);
  }
}

function isCompletedStatus(status: string | null) {
  return status !== null && /^(complete|completed|done|succeeded|success)$/iu.test(status.trim());
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }

  if (typeof value !== 'string') {
    return [];
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;

    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  } catch {
    // Fall back to the older comma-separated shape below.
  }

  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function summarizeGsdTask(row: Record<string, unknown>, fallbackId: string): GsdDbTaskSummary {
  return {
    id: pickString(row, ['id', 'taskId', 'task_id', 'key', 'slug']) ?? fallbackId,
    title: pickString(row, ['title', 'name', 'summary', 'description']),
    status: pickString(row, ['status', 'state', 'phase']),
    risk: pickString(row, ['risk', 'priority', 'severity']),
    startedAt: pickWorkflowTimestamp(row, 'started'),
    finishedAt: pickWorkflowTimestamp(row, 'finished'),
  };
}

function workflowParentKey(milestoneId: string | null, sliceId: string) {
  return `${milestoneId ?? ''}\u0000${sliceId}`;
}

function summarizeGsdMilestones(input: {
  milestones: Array<Record<string, unknown>>;
  slices: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
}): GsdDbMilestoneSummary[] {
  const tasksBySlice = new Map<string, GsdDbTaskSummary[]>();

  for (const [index, row] of input.tasks.entries()) {
    const milestoneId = pickString(row, ['milestone_id', 'milestoneId', 'milestone', 'parentMilestoneId']);
    const sliceId = pickString(row, ['slice_id', 'sliceId', 'slice', 'parentSliceId']);

    if (!sliceId) {
      continue;
    }

    const key = workflowParentKey(milestoneId, sliceId);
    const tasks = tasksBySlice.get(key) ?? [];
    tasks.push(summarizeGsdTask(row, `T${String(index + 1).padStart(2, '0')}`));
    tasksBySlice.set(key, tasks);
  }

  const slicesByMilestone = new Map<string, GsdDbSliceSummary[]>();

  for (const [index, row] of input.slices.entries()) {
    const milestoneId = pickString(row, ['milestone_id', 'milestoneId', 'milestone', 'parentMilestoneId']);

    if (!milestoneId) {
      continue;
    }

    const sliceId = pickString(row, ['id', 'sliceId', 'slice_id', 'key', 'slug']) ?? `S${String(index + 1).padStart(2, '0')}`;
    const tasks = tasksBySlice.get(workflowParentKey(milestoneId, sliceId))
      ?? tasksBySlice.get(workflowParentKey(null, sliceId))
      ?? [];
    const slices = slicesByMilestone.get(milestoneId) ?? [];

    slices.push({
      id: sliceId,
      title: pickString(row, ['title', 'name', 'summary', 'description']),
      status: pickString(row, ['status', 'state', 'phase']),
      risk: pickString(row, ['risk', 'priority', 'severity']),
      startedAt: pickWorkflowTimestamp(row, 'started'),
      finishedAt: pickWorkflowTimestamp(row, 'finished'),
      taskCount: tasks.length,
      completedTaskCount: tasks.filter((task) => isCompletedStatus(task.status)).length,
      tasks,
    });
    slicesByMilestone.set(milestoneId, slices);
  }

  return input.milestones.map((row, index) => {
    const milestoneId =
      pickString(row, ['id', 'milestoneId', 'milestone_id', 'key', 'slug']) ?? `M${String(index + 1).padStart(3, '0')}`;
    const slices = slicesByMilestone.get(milestoneId) ?? [];
    const taskCount = slices.reduce((total, slice) => total + slice.taskCount, 0);
    const completedTaskCount = slices.reduce((total, slice) => total + slice.completedTaskCount, 0);

    return {
      id: milestoneId,
      title: pickString(row, ['title', 'name', 'summary', 'description']),
      status: pickString(row, ['status', 'state', 'phase']),
      startedAt: pickWorkflowTimestamp(row, 'started'),
      finishedAt: pickWorkflowTimestamp(row, 'finished'),
      sliceCount: slices.length,
      taskCount,
      completedTaskCount,
      slices,
    };
  });
}

function addGsdSliceDependency(
  dependencies: GsdDbSliceDependencySummary[],
  seen: Set<string>,
  dependency: GsdDbSliceDependencySummary,
) {
  const key = `${dependency.milestoneId}\u0000${dependency.sliceId}\u0000${dependency.dependsOnSliceId}`;

  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  dependencies.push(dependency);
}

function summarizeGsdSliceDependencies(input: {
  slices: Array<Record<string, unknown>>;
  dependencyRows: Array<Record<string, unknown>>;
}): GsdDbSliceDependencySummary[] {
  const dependencies: GsdDbSliceDependencySummary[] = [];
  const seen = new Set<string>();

  for (const row of input.dependencyRows) {
    const milestoneId = pickString(row, ['milestone_id', 'milestoneId', 'milestone', 'parentMilestoneId']);
    const sliceId = pickString(row, ['slice_id', 'sliceId', 'slice', 'id']);
    const dependsOnSliceId = pickString(row, [
      'depends_on_slice_id',
      'dependsOnSliceId',
      'depends_on',
      'dependsOn',
      'dependency_id',
      'dependencyId',
      'from_slice_id',
      'fromSliceId',
    ]);

    if (!milestoneId || !sliceId || !dependsOnSliceId) {
      continue;
    }

    addGsdSliceDependency(dependencies, seen, {
      milestoneId,
      sliceId,
      dependsOnSliceId,
    });
  }

  for (const row of input.slices) {
    const milestoneId = pickString(row, ['milestone_id', 'milestoneId', 'milestone', 'parentMilestoneId']);
    const sliceId = pickString(row, ['id', 'sliceId', 'slice_id', 'key', 'slug']);

    if (!milestoneId || !sliceId) {
      continue;
    }

    for (const dependsOnSliceId of parseStringList(row.depends ?? row.dependencies ?? row.depends_on ?? row.dependsOn)) {
      addGsdSliceDependency(dependencies, seen, {
        milestoneId,
        sliceId,
        dependsOnSliceId,
      });
    }
  }

  return dependencies;
}

function createEmptyMetricsTotals(): GsdMetricsSummaryValue['totals'] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
    toolCalls: 0,
    assistantMessages: 0,
    userMessages: 0,
    apiRequests: 0,
    promptCharCount: 0,
    baselineCharCount: 0,
  };
}

function summarizeGsdMetrics(record: Record<string, unknown>): GsdMetricsSummaryValue {
  const units = Array.isArray(record.units)
    ? record.units.filter((unit): unit is Record<string, unknown> => Boolean(unit) && typeof unit === 'object' && !Array.isArray(unit))
    : [];
  const totals = createEmptyMetricsTotals();
  const unitSummaries = units.map((unit) => {
    const tokens = unit.tokens && typeof unit.tokens === 'object' && !Array.isArray(unit.tokens)
      ? unit.tokens as Record<string, unknown>
      : {};
    const inputTokens = pickFiniteNumber(tokens, ['input', 'inputTokens']) ?? 0;
    const outputTokens = pickFiniteNumber(tokens, ['output', 'outputTokens']) ?? 0;
    const cacheReadTokens = pickFiniteNumber(tokens, ['cacheRead', 'cacheReadTokens']) ?? 0;
    const cacheWriteTokens = pickFiniteNumber(tokens, ['cacheWrite', 'cacheWriteTokens']) ?? 0;
    const totalTokens =
      pickFiniteNumber(tokens, ['total', 'totalTokens'])
      ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    const cost = pickFiniteNumber(unit, ['cost', 'totalCost']) ?? 0;
    const toolCalls = pickFiniteNumber(unit, ['toolCalls']) ?? 0;
    const assistantMessages = pickFiniteNumber(unit, ['assistantMessages']) ?? 0;
    const userMessages = pickFiniteNumber(unit, ['userMessages']) ?? 0;
    const apiRequests = pickFiniteNumber(unit, ['apiRequests']) ?? 0;
    const promptCharCount = pickFiniteNumber(unit, ['promptCharCount']) ?? 0;
    const baselineCharCount = pickFiniteNumber(unit, ['baselineCharCount']) ?? 0;

    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.cacheReadTokens += cacheReadTokens;
    totals.cacheWriteTokens += cacheWriteTokens;
    totals.totalTokens += totalTokens;
    totals.cost += cost;
    totals.toolCalls += toolCalls;
    totals.assistantMessages += assistantMessages;
    totals.userMessages += userMessages;
    totals.apiRequests += apiRequests;
    totals.promptCharCount += promptCharCount;
    totals.baselineCharCount += baselineCharCount;

    return {
      type: pickString(unit, ['type', 'unitType']),
      id: pickString(unit, ['id', 'unitId']),
      model: pickString(unit, ['model']),
      startedAt: pickFiniteNumber(unit, ['startedAt', 'startAt', 'started_at', 'start_at']),
      finishedAt: pickFiniteNumber(unit, [
        'finishedAt',
        'finishAt',
        'completedAt',
        'endedAt',
        'finished_at',
        'finish_at',
        'completed_at',
        'ended_at',
      ]),
      totalTokens,
      cost,
      toolCalls,
      apiRequests,
    };
  });

  return {
    version: pickFiniteNumber(record, ['version']),
    projectStartedAt: pickFiniteNumber(record, ['projectStartedAt', 'projectStartAt', 'startedAt', 'startAt']),
    unitCount: units.length,
    totals,
    units: unitSummaries,
    recentUnits: unitSummaries.slice(-8).reverse(),
  };
}

async function readGsdDbSummary(filePath: string, warnOnMissing: boolean): Promise<SourceReadResult<GsdDbSummaryValue>> {
  try {
    await access(filePath, constants.R_OK);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code);

      if (code === 'ENOENT') {
        return toMissingResult('gsdDb', '.gsd/gsd.db is missing.', warnOnMissing);
      }

      if (code === 'EACCES' || code === 'EPERM') {
        return toUnreadableResult('gsdDb', '.gsd/gsd.db is not readable.');
      }
    }

    return toUnreadableResult('gsdDb', '.gsd/gsd.db could not be inspected.');
  }

  try {
    const database = new DatabaseSync(filePath, { readOnly: true });

    try {
      const tableRows = database
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table'
           ORDER BY name ASC`,
        )
        .all() as unknown as Array<{ name: string }>;

      const tableNames = tableRows.map((row) => row.name);
      const tableNameSet = new Set(tableNames);
      const countIfPresent = (tableName: string) => {
        if (!tableNameSet.has(tableName)) {
          return null;
        }

        const row = database
          .prepare(`SELECT COUNT(*) AS total FROM ${tableName}`)
          .get() as { total: number };

        return row.total;
      };
      const rowsIfPresent = (tableName: 'milestones' | 'slices' | 'tasks' | 'slice_dependencies') => {
        if (!tableNameSet.has(tableName)) {
          return [] as Array<Record<string, unknown>>;
        }

        return database.prepare(`SELECT * FROM ${tableName} LIMIT 80`).all() as unknown as Array<
          Record<string, unknown>
        >;
      };

      return {
        source: createSource('ok', {
          tables: tableNames,
          counts: {
            milestones: countIfPresent('milestones'),
            slices: countIfPresent('slices'),
            tasks: countIfPresent('tasks'),
            sliceDependencies: countIfPresent('slice_dependencies'),
            projects: countIfPresent('projects'),
          },
          milestones: summarizeGsdMilestones({
            milestones: rowsIfPresent('milestones'),
            slices: rowsIfPresent('slices'),
            tasks: rowsIfPresent('tasks'),
          }),
          dependencies: summarizeGsdSliceDependencies({
            slices: rowsIfPresent('slices'),
            dependencyRows: rowsIfPresent('slice_dependencies'),
          }),
        }),
      };
    } finally {
      database.close();
    }
  } catch (error) {
    if (isTransientSqliteReadError(error)) {
      throw new ProjectSnapshotReadError('gsdDb', '.gsd/gsd.db could not be read right now.');
    }

    return toMalformedResult('gsdDb', '.gsd/gsd.db is not a readable SQLite database.');
  }
}

async function isDirectory(candidatePath: string) {
  try {
    return (await stat(candidatePath)).isDirectory();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && String(error.code) === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function isPathWithin(parentPath: string, candidatePath: string) {
  const relativePath = path.relative(parentPath, candidatePath);

  return relativePath.length === 0 || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function findAncestorGsdRoot(projectRoot: string): Promise<string | null> {
  let currentPath = path.dirname(projectRoot);

  while (currentPath !== path.dirname(currentPath)) {
    const candidatePath = path.join(currentPath, '.gsd');

    if (await isDirectory(candidatePath)) {
      return candidatePath;
    }

    currentPath = path.dirname(currentPath);
  }

  const filesystemRootCandidate = path.join(currentPath, '.gsd');

  return (await isDirectory(filesystemRootCandidate)) ? filesystemRootCandidate : null;
}

async function hasRequiredBootstrapEntry(gsdRootPath: string, entry: BootstrapRequiredEntry) {
  try {
    const entryStats = await stat(path.join(gsdRootPath, entry));
    return entry === 'milestones' ? entryStats.isDirectory() : entryStats.isFile();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code);

      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
        return false;
      }
    }

    throw error;
  }
}

export async function classifyBootstrapCompleteness(projectRoot: string): Promise<BootstrapCompleteness> {
  const canonicalProjectRoot = await realpath(projectRoot);
  const projectOwnedGsdPath = path.join(canonicalProjectRoot, '.gsd');
  const ancestorGsdRoot = await findAncestorGsdRoot(canonicalProjectRoot);
  let resolvedGsdRoot: string | null = null;

  if (!(await isDirectory(projectOwnedGsdPath))) {
    if (ancestorGsdRoot !== null) {
      return {
        state: 'ancestor_conflict',
        projectRoot: canonicalProjectRoot,
        gsdRootPath: ancestorGsdRoot,
        detail: `Found ancestor-owned .gsd at ${ancestorGsdRoot}; refusing to treat ${canonicalProjectRoot} as initialized.`,
        presentEntries: [],
        missingEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
        requiredEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
      };
    }

    return {
      state: 'absent',
      projectRoot: canonicalProjectRoot,
      gsdRootPath: null,
      detail: 'No project-owned .gsd directory exists yet.',
      presentEntries: [],
      missingEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
      requiredEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
    };
  }

  try {
    resolvedGsdRoot = await realpath(projectOwnedGsdPath);
  } catch {
    resolvedGsdRoot = projectOwnedGsdPath;
  }

  if (!isPathWithin(canonicalProjectRoot, resolvedGsdRoot)) {
    return {
      state: 'ancestor_conflict',
      projectRoot: canonicalProjectRoot,
      gsdRootPath: resolvedGsdRoot,
      detail: `Project .gsd resolves outside the project root (${resolvedGsdRoot}); refusing to trust ancestor-owned bootstrap state.`,
      presentEntries: [],
      missingEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
      requiredEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
    };
  }

  let presentEntries: string[];

  try {
    presentEntries = (await readdir(projectOwnedGsdPath)).sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code);

      if (code === 'EACCES' || code === 'EPERM') {
        return {
          state: 'partial',
          projectRoot: canonicalProjectRoot,
          gsdRootPath: resolvedGsdRoot,
          detail: 'Project-owned .gsd exists but could not be read.',
          presentEntries: [],
          missingEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
          requiredEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
        };
      }
    }

    throw error;
  }

  const missingEntries: BootstrapRequiredEntry[] = [];

  for (const requiredEntry of BOOTSTRAP_REQUIRED_ENTRIES) {
    if (!(await hasRequiredBootstrapEntry(projectOwnedGsdPath, requiredEntry))) {
      missingEntries.push(requiredEntry);
    }
  }

  if (missingEntries.length > 0) {
    const detail =
      presentEntries.length === 1 && presentEntries[0] === 'notifications.jsonl'
        ? 'Only notifications.jsonl is present; bootstrap is incomplete and must not be treated as initialized.'
        : `Missing bootstrap entries: ${missingEntries.join(', ')}.`;

    return {
      state: 'partial',
      projectRoot: canonicalProjectRoot,
      gsdRootPath: resolvedGsdRoot,
      detail,
      presentEntries,
      missingEntries,
      requiredEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
    };
  }

  return {
    state: 'complete',
    projectRoot: canonicalProjectRoot,
    gsdRootPath: resolvedGsdRoot,
    detail: 'Project-owned .gsd contains the required bootstrap surfaces.',
    presentEntries,
    missingEntries: [],
    requiredEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
  };
}

async function summarizeDirectory(projectRoot: string): Promise<DirectorySummary> {
  const directory = await opendir(projectRoot);
  const sampleEntries: string[] = [];
  let sampleTruncated = false;

  try {
    for await (const entry of directory) {
      if (sampleEntries.length < MAX_DIRECTORY_SAMPLE_ENTRIES) {
        sampleEntries.push(entry.name);
        continue;
      }

      sampleTruncated = true;
      break;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }

  return {
    isEmpty: sampleEntries.length === 0,
    sampleEntries,
    sampleTruncated,
  };
}

function collectWarnings(results: Array<SourceReadResult<unknown>>) {
  return results.flatMap((result) => (result.warning ? [result.warning] : []));
}

export function isProjectPathValidationError(error: unknown): error is ProjectPathValidationError {
  return error instanceof ProjectPathValidationError;
}

export function isProjectSnapshotReadError(error: unknown): error is ProjectSnapshotReadError {
  return error instanceof ProjectSnapshotReadError;
}

export async function canonicalizeProjectPath(requestedPath: string): Promise<CanonicalProjectPath> {
  const trimmedPath = requestedPath.trim();

  if (trimmedPath.length === 0) {
    throw new ProjectPathValidationError('Project path is required.');
  }

  const normalizedPath = path.resolve(trimmedPath);
  let canonicalPath: string;

  try {
    canonicalPath = await realpath(normalizedPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code);

      if (code === 'ENOENT') {
        throw new ProjectPathValidationError('Project path does not exist.');
      }

      if (code === 'ELOOP') {
        throw new ProjectPathValidationError('Project path contains a symlink loop.');
      }

      if (code === 'EACCES' || code === 'EPERM') {
        throw new ProjectPathValidationError('Project path is not readable.');
      }
    }

    throw new ProjectPathValidationError('Project path could not be canonicalized.');
  }

  try {
    const directoryStats = await stat(canonicalPath);

    if (!directoryStats.isDirectory()) {
      throw new ProjectPathValidationError('Project path must resolve to a directory.');
    }

    await access(canonicalPath, constants.R_OK | constants.X_OK);
  } catch (error) {
    if (error instanceof ProjectPathValidationError) {
      throw error;
    }

    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code);

      if (code === 'ENOTDIR') {
        throw new ProjectPathValidationError('Project path must resolve to a directory.');
      }

      if (code === 'EACCES' || code === 'EPERM') {
        throw new ProjectPathValidationError('Project path is not readable.');
      }
    }

    throw new ProjectPathValidationError('Project directory could not be inspected.');
  }

  return {
    requestedPath,
    normalizedPath,
    canonicalPath,
  };
}

export async function withSnapshotTimeout<T>(operation: () => Promise<T>, timeoutMs: number) {
  let timeoutId: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new SnapshotTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export async function buildProjectSnapshot(projectRoot: string): Promise<ProjectSnapshot> {
  const checkedAt = new Date().toISOString();
  let directory: DirectorySummary;

  try {
    await access(projectRoot, constants.R_OK | constants.X_OK);
    const projectRootStats = await stat(projectRoot);

    if (!projectRootStats.isDirectory()) {
      throw new ProjectSnapshotReadError('projectRoot', 'Project root no longer resolves to a directory.');
    }

    directory = await summarizeDirectory(projectRoot);
  } catch (error) {
    if (error instanceof ProjectSnapshotReadError) {
      throw error;
    }

    throw toProjectRootReadError(error);
  }

  const gsdDirectoryPath = path.join(projectRoot, '.gsd');
  let hasGsdDirectory: boolean;

  try {
    hasGsdDirectory = await isDirectory(gsdDirectoryPath);
  } catch (error) {
    throw toProjectRootReadError(error);
  }

  const directorySource = createSource('ok', directory);
  const gsdDirectorySource = hasGsdDirectory
    ? createSource<{ present: true }>('ok', { present: true })
    : createEmptySource<{ present: true }>('missing', '.gsd directory is missing.');

  const gsdIdResult = await readTextSource(
    path.join(projectRoot, '.gsd-id'),
    'gsdId',
    (value) => ({ gsdId: trimDetail(value.trim()) }),
    {
      detailLabel: '.gsd-id',
      warnOnMissing: hasGsdDirectory,
      missingState: hasGsdDirectory ? 'missing' : 'not_applicable',
    },
  );

  if (!hasGsdDirectory) {
    const displayName = await resolveProjectDisplayName(projectRoot, null, null);
    const sources: ProjectSnapshotSources = {
      directory: directorySource,
      gsdDirectory: gsdDirectorySource,
      gsdId: gsdIdResult.source,
      projectMd: createEmptySource<ProjectMarkdownValue>(
        'not_applicable',
        'PROJECT.md is not checked without .gsd.',
      ),
      repoMeta: createEmptySource<RepoMetaValue>(
        'not_applicable',
        'repo-meta.json is not checked without .gsd.',
      ),
      autoLock: createEmptySource<AutoLockValue>(
        'not_applicable',
        'auto.lock is not checked without .gsd.',
      ),
      stateMd: createEmptySource<StateMarkdownValue>(
        'not_applicable',
        'STATE.md is not checked without .gsd.',
      ),
      metricsJson: createEmptySource<GsdMetricsSummaryValue>(
        'not_applicable',
        'metrics.json is not checked without .gsd.',
      ),
      gsdDb: createEmptySource<GsdDbSummaryValue>(
        'not_applicable',
        'gsd.db is not checked without .gsd.',
      ),
    };

    return {
      status: 'uninitialized',
      checkedAt,
      directory,
      identityHints: {
        gsdId: gsdIdResult.source.value?.gsdId ?? null,
        repoFingerprint: null,
        displayName: displayName.name,
        displayNameSource: displayName.source,
      },
      sources,
      warnings: [],
    };
  }

  const projectMdResult = await readTextSource(
    path.join(gsdDirectoryPath, 'PROJECT.md'),
    'projectMd',
    summarizeMarkdown,
    {
      detailLabel: '.gsd/PROJECT.md',
      warnOnMissing: true,
    },
  );
  const repoMetaResult = await readJsonSource(
    path.join(gsdDirectoryPath, 'repo-meta.json'),
    'repoMeta',
    sanitizeRepoMeta,
    {
      detailLabel: '.gsd/repo-meta.json',
      warnOnMissing: true,
    },
  );
  const autoLockResult = await readJsonSource(
    path.join(gsdDirectoryPath, 'auto.lock'),
    'autoLock',
    sanitizeAutoLock,
    {
      detailLabel: '.gsd/auto.lock',
      warnOnMissing: true,
    },
  );
  const stateMdResult = await readTextSource(
    path.join(gsdDirectoryPath, 'STATE.md'),
    'stateMd',
    summarizeStateMarkdown,
    {
      detailLabel: '.gsd/STATE.md',
      warnOnMissing: true,
    },
  );
  const metricsJsonResult = await readJsonSource(
    path.join(gsdDirectoryPath, 'metrics.json'),
    'metricsJson',
    summarizeGsdMetrics,
    {
      detailLabel: '.gsd/metrics.json',
      warnOnMissing: false,
    },
  );
  const gsdDbResult = await readGsdDbSummary(path.join(gsdDirectoryPath, 'gsd.db'), true);
  const displayName = await resolveProjectDisplayName(
    projectRoot,
    projectMdResult.source.value ?? null,
    repoMetaResult.source.value ?? null,
  );

  const warnings = collectWarnings([
    gsdIdResult,
    projectMdResult,
    repoMetaResult,
    autoLockResult,
    stateMdResult,
    metricsJsonResult,
    gsdDbResult,
  ]);

  const sources: ProjectSnapshotSources = {
    directory: directorySource,
    gsdDirectory: gsdDirectorySource,
    gsdId: gsdIdResult.source,
    projectMd: projectMdResult.source,
    repoMeta: repoMetaResult.source,
    autoLock: autoLockResult.source,
    stateMd: stateMdResult.source,
    metricsJson: metricsJsonResult.source,
    gsdDb: gsdDbResult.source,
  };

  return {
    status: warnings.length === 0 ? 'initialized' : 'degraded',
    checkedAt,
    directory,
    identityHints: {
      gsdId: gsdIdResult.source.value?.gsdId ?? null,
      repoFingerprint: repoMetaResult.source.value?.repoFingerprint ?? null,
      displayName: displayName.name,
      displayNameSource: displayName.source,
    },
    sources,
    warnings,
  };
}
