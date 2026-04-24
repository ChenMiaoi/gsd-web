import { access, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { afterEach, describe, expect, test } from 'vitest';

import { RotatingLogStream } from '../../src/server/log-rotation.js';
import { createTempWorkspace } from '../helpers/project-fixtures.js';

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const cleanup = cleanupTasks.pop();

    if (cleanup) {
      await cleanup();
    }
  }
});

async function expectMissing(filePath: string) {
  await expect(access(filePath)).rejects.toThrow();
}

describe('rotating log stream', () => {
  test('archives a stale active log on startup, compresses it, and continues writing to the active file', async () => {
    const workspace = await createTempWorkspace('gsd-web-log-rotation-');
    const logDir = path.join(workspace.root, 'logs');
    const activeLogPath = path.join(logDir, 'gsd-web.log');
    const archivedLogPath = path.join(logDir, 'gsd-web-2026-04-22.log.gz');
    const staleDate = new Date(2026, 3, 22, 12, 30, 0);
    const currentDate = new Date(2026, 3, 24, 8, 0, 0);

    cleanupTasks.push(workspace.cleanup);

    await mkdir(logDir, { recursive: true });
    await writeFile(activeLogPath, '{"event":"yesterday"}\n');
    await utimes(activeLogPath, staleDate, staleDate);

    const stream = new RotatingLogStream({
      filePath: activeLogPath,
      retentionDays: 7,
      maxFileSizeBytes: 1024,
      now: () => currentDate,
    });

    await stream.initialize();
    stream.write('{"event":"today"}\n');
    await stream.close();

    expect(await readFile(activeLogPath, 'utf8')).toContain('"event":"today"');
    expect(gunzipSync(await readFile(archivedLogPath)).toString('utf8')).toContain('"event":"yesterday"');
    await expectMissing(path.join(logDir, 'gsd-web-2026-04-22.log'));
  });

  test('removes archives older than the retention window and keeps recent ones', async () => {
    const workspace = await createTempWorkspace('gsd-web-log-retention-');
    const logDir = path.join(workspace.root, 'logs');
    const activeLogPath = path.join(logDir, 'gsd-web.log');
    const expiredArchivePath = path.join(logDir, 'gsd-web-2026-04-15.log.gz');
    const retainedArchivePath = path.join(logDir, 'gsd-web-2026-04-17.log.gz');
    const currentDate = new Date(2026, 3, 24, 8, 0, 0);

    cleanupTasks.push(workspace.cleanup);

    await mkdir(logDir, { recursive: true });
    await writeFile(expiredArchivePath, gzipSync('expired\n'));
    await writeFile(retainedArchivePath, gzipSync('retained\n'));

    const stream = new RotatingLogStream({
      filePath: activeLogPath,
      retentionDays: 7,
      maxFileSizeBytes: 1024,
      now: () => currentDate,
    });

    await stream.initialize();
    await stream.close();

    await expectMissing(expiredArchivePath);
    expect(gunzipSync(await readFile(retainedArchivePath)).toString('utf8')).toBe('retained\n');
  });

  test('splits same-day logs by size without overwriting prior archives', async () => {
    const workspace = await createTempWorkspace('gsd-web-log-size-');
    const logDir = path.join(workspace.root, 'logs');
    const activeLogPath = path.join(logDir, 'gsd-web.log');
    const currentDate = new Date(2026, 3, 24, 8, 0, 0);

    cleanupTasks.push(workspace.cleanup);

    await mkdir(logDir, { recursive: true });

    const stream = new RotatingLogStream({
      filePath: activeLogPath,
      retentionDays: 7,
      maxFileSizeBytes: 10,
      now: () => currentDate,
    });

    await stream.initialize();
    stream.write('line-one\n');
    stream.write('line-two\n');
    stream.write('line-three\n');
    await stream.close();

    expect(gunzipSync(await readFile(path.join(logDir, 'gsd-web-2026-04-24.log.gz'))).toString('utf8')).toBe('line-one\n');
    expect(gunzipSync(await readFile(path.join(logDir, 'gsd-web-2026-04-24-1.log.gz'))).toString('utf8')).toBe('line-two\n');
    expect(await readFile(activeLogPath, 'utf8')).toBe('line-three\n');
  });
});
