import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { access, constants, opendir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

import type {
  AutoLockValue,
  DirectorySummary,
  GsdDbSummaryValue,
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

function pickBoolean(record: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'boolean') {
      return value;
    }
  }

  return null;
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
           ORDER BY name ASC
           LIMIT 10`,
        )
        .all() as unknown as Array<{ name: string }>;

      const tableNames = tableRows.map((row) => row.name);
      const countIfPresent = (tableName: string) => {
        if (!tableNames.includes(tableName)) {
          return null;
        }

        const row = database
          .prepare(`SELECT COUNT(*) AS total FROM ${tableName}`)
          .get() as { total: number };

        return row.total;
      };

      return {
        source: createSource('ok', {
          tables: tableNames,
          counts: {
            milestones: countIfPresent('milestones'),
            slices: countIfPresent('slices'),
            tasks: countIfPresent('tasks'),
            projects: countIfPresent('projects'),
          },
        }),
      };
    } finally {
      database.close();
    }
  } catch {
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
  const directory = await summarizeDirectory(projectRoot);
  const gsdDirectoryPath = path.join(projectRoot, '.gsd');
  const hasGsdDirectory = await isDirectory(gsdDirectoryPath);

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
  const gsdDbResult = await readGsdDbSummary(path.join(gsdDirectoryPath, 'gsd.db'), true);

  const warnings = collectWarnings([
    gsdIdResult,
    projectMdResult,
    repoMetaResult,
    autoLockResult,
    stateMdResult,
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
    gsdDb: gsdDbResult.source,
  };

  return {
    status: warnings.length === 0 ? 'initialized' : 'degraded',
    checkedAt,
    directory,
    identityHints: {
      gsdId: gsdIdResult.source.value?.gsdId ?? null,
      repoFingerprint: repoMetaResult.source.value?.repoFingerprint ?? null,
    },
    sources,
    warnings,
  };
}
