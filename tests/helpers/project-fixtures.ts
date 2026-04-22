import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface TestWorkspace {
  root: string;
  cleanup: () => Promise<void>;
}

export interface InitializedProjectOptions {
  createGsdDirectory?: boolean;
  gsdIdContent?: string | Uint8Array | null;
  projectMdContent?: string | Uint8Array | null;
  repoMetaContent?: Record<string, unknown> | string | Uint8Array | null;
  autoLockContent?: Record<string, unknown> | string | Uint8Array | null;
  stateMdContent?: string | Uint8Array | null;
  gsdDbMode?: 'valid' | 'corrupt' | 'missing';
}

function toJsonString(value: Record<string, unknown>) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeMaybeFile(filePath: string, value: string | Uint8Array | null | undefined) {
  if (value === null || value === undefined) {
    return;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value);
}

async function createValidGsdDb(filePath: string) {
  const database = new DatabaseSync(filePath);

  try {
    database.exec(`
      CREATE TABLE milestones (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE slices (id TEXT PRIMARY KEY, milestone_id TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, slice_id TEXT NOT NULL, status TEXT NOT NULL);

      INSERT INTO milestones (id, status) VALUES ('M001', 'active');
      INSERT INTO slices (id, milestone_id, status) VALUES ('S01', 'M001', 'active');
      INSERT INTO tasks (id, slice_id, status) VALUES ('T01', 'S01', 'complete');
      INSERT INTO tasks (id, slice_id, status) VALUES ('T02', 'S01', 'active');
    `);
  } finally {
    database.close();
  }
}

export async function createTempWorkspace(prefix: string = 'gsd-web-project-'): Promise<TestWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));

  return {
    root,
    cleanup: async () => {
      await chmod(root, 0o755).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function writeClientShell(workspaceRoot: string, title: string = 'GSD Web Test Shell') {
  const clientDistDir = path.join(workspaceRoot, 'web-dist');

  await mkdir(path.join(clientDistDir, 'assets'), { recursive: true });
  await writeFile(
    path.join(clientDistDir, 'index.html'),
    [
      '<!doctype html>',
      '<html lang="en">',
      `  <head><meta charset="utf-8" /><title>${title}</title></head>`,
      '  <body>',
      `    <div id="root">${title}</div>`,
      '  </body>',
      '</html>',
    ].join('\n'),
  );
  await writeFile(path.join(clientDistDir, 'assets', 'main.js'), 'console.log("gsd-web shell");\n');

  return clientDistDir;
}

export async function createEmptyProject(workspaceRoot: string, projectName: string) {
  const projectRoot = path.join(workspaceRoot, projectName);

  await mkdir(projectRoot, { recursive: true });

  return projectRoot;
}

export async function createExternalInitProject(projectName: string) {
  const workspace = await createTempWorkspace('gsd-web-init-');
  const projectRoot = await createEmptyProject(workspace.root, projectName);

  return {
    workspace,
    projectRoot,
  };
}

export async function createPartialBootstrapProject(
  workspaceRoot: string,
  projectName: string,
  options: {
    notificationLines?: string[];
  } = {},
) {
  const projectRoot = await createEmptyProject(workspaceRoot, projectName);
  const gsdRoot = path.join(projectRoot, '.gsd');
  const notificationLines = options.notificationLines ?? [];

  await mkdir(gsdRoot, { recursive: true });
  await writeFile(
    path.join(gsdRoot, 'notifications.jsonl'),
    notificationLines.map((line) => `${line.trimEnd()}\n`).join(''),
  );

  return projectRoot;
}

export async function createBootstrapCompleteGsdDirectory(projectRoot: string) {
  const gsdRoot = path.join(projectRoot, '.gsd');

  await mkdir(path.join(gsdRoot, 'milestones'), { recursive: true });
  await mkdir(path.join(gsdRoot, 'runtime'), { recursive: true });
  await writeFile(path.join(gsdRoot, 'STATE.md'), '# State\n\nBootstrap complete fixture.\n');
  await writeFile(path.join(gsdRoot, 'PREFERENCES.md'), '# Preferences\n\nUsing fixture defaults.\n');
  await writeFile(path.join(gsdRoot, 'CODEBASE.md'), '# Codebase\n\nIndexed fixture.\n');
  await writeFile(path.join(gsdRoot, 'notifications.jsonl'), '');
  await createValidGsdDb(path.join(gsdRoot, 'gsd.db'));

  return gsdRoot;
}

export async function createInitializedProject(
  workspaceRoot: string,
  projectName: string,
  options: InitializedProjectOptions = {},
) {
  const projectRoot = path.join(workspaceRoot, projectName);
  const gsdRoot = path.join(projectRoot, '.gsd');
  const createGsdDirectory = options.createGsdDirectory ?? true;
  const gsdIdContent = options.gsdIdContent === undefined ? `gsd-${projectName}` : options.gsdIdContent;
  const projectMdContent =
    options.projectMdContent === undefined
      ? '# Project Snapshot Fixture\n\nThis project mimics a GSD workspace.\n'
      : options.projectMdContent;
  const repoMetaContent =
    options.repoMetaContent === undefined
      ? {
          projectName,
          currentBranch: 'main',
          headSha: 'abc1234def5678',
          repoFingerprint: `${projectName}-fingerprint`,
          dirty: false,
        }
      : options.repoMetaContent;
  const autoLockContent =
    options.autoLockContent === undefined
      ? {
          status: 'idle',
          pid: 4242,
          startedAt: '2026-04-22T10:00:00.000Z',
          updatedAt: '2026-04-22T10:05:00.000Z',
        }
      : options.autoLockContent;
  const stateMdContent =
    options.stateMdContent === undefined
      ? '# State\n\nHealthy fixture state for integration coverage.\n'
      : options.stateMdContent;
  const gsdDbMode = options.gsdDbMode ?? 'valid';

  await mkdir(projectRoot, { recursive: true });

  if (createGsdDirectory) {
    await mkdir(gsdRoot, { recursive: true });
  }

  await writeMaybeFile(path.join(projectRoot, '.gsd-id'), gsdIdContent);
  await writeMaybeFile(path.join(gsdRoot, 'PROJECT.md'), projectMdContent);

  if (repoMetaContent !== null) {
    await writeMaybeFile(
      path.join(gsdRoot, 'repo-meta.json'),
      typeof repoMetaContent === 'string' || repoMetaContent instanceof Uint8Array
        ? repoMetaContent
        : toJsonString(repoMetaContent),
    );
  }

  if (autoLockContent !== null) {
    await writeMaybeFile(
      path.join(gsdRoot, 'auto.lock'),
      typeof autoLockContent === 'string' || autoLockContent instanceof Uint8Array
        ? autoLockContent
        : toJsonString(autoLockContent),
    );
  }

  await writeMaybeFile(path.join(gsdRoot, 'STATE.md'), stateMdContent);

  if (gsdDbMode === 'valid') {
    await createValidGsdDb(path.join(gsdRoot, 'gsd.db'));
  } else if (gsdDbMode === 'corrupt') {
    await writeFile(path.join(gsdRoot, 'gsd.db'), 'this is not sqlite\n');
  }

  return projectRoot;
}

export async function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  content: string | Uint8Array,
) {
  const filePath = path.join(projectRoot, relativePath);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);

  return filePath;
}

export async function writeRepoMeta(
  projectRoot: string,
  value: Record<string, unknown> | string | Uint8Array,
) {
  return writeProjectFile(
    projectRoot,
    '.gsd/repo-meta.json',
    typeof value === 'string' || value instanceof Uint8Array ? value : toJsonString(value),
  );
}

export async function applyProjectMutationsBurst(
  projectRoot: string,
  mutations: Array<{
    relativePath: string;
    content: string | Uint8Array;
  }>,
  options: {
    delayMs?: number;
  } = {},
) {
  const delayMs = options.delayMs ?? 0;

  for (const mutation of mutations) {
    await writeProjectFile(projectRoot, mutation.relativePath, mutation.content);

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function createUnreadableProject(workspaceRoot: string, projectName: string) {
  const projectRoot = path.join(workspaceRoot, projectName);

  await mkdir(projectRoot, { recursive: true });
  await chmod(projectRoot, 0o000);

  return {
    projectRoot,
    restore: async () => {
      await chmod(projectRoot, 0o755);
    },
  };
}

export async function createSymlinkLoop(workspaceRoot: string, symlinkName: string) {
  const symlinkPath = path.join(workspaceRoot, symlinkName);

  await symlink(symlinkPath, symlinkPath);

  return symlinkPath;
}
