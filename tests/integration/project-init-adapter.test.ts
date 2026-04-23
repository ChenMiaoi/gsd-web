import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { runOfficialGsdInit, type InitStageUpdate } from '../../src/server/init-jobs.js';
import { classifyBootstrapCompleteness } from '../../src/server/snapshots.js';
import {
  createBootstrapCompleteGsdDirectory,
  createEmptyProject,
  createExternalInitProject,
  createPartialBootstrapProject,
  createTempWorkspace,
} from '../helpers/project-fixtures.js';

const cleanupTasks: Array<() => Promise<void>> = [];
const shouldRunOfficialGsdAdapterSmoke =
  process.env.GSD_INIT_ADAPTER_E2E === '1' || Boolean(process.env.GSD_BIN_PATH?.trim());

function isPathWithin(parentPath: string, candidatePath: string) {
  const relativePath = path.relative(parentPath, candidatePath);

  return relativePath.length === 0 || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const cleanup = cleanupTasks.pop();

    if (cleanup) {
      await cleanup();
    }
  }
});

describe('official /gsd init adapter', () => {
  test.skipIf(!shouldRunOfficialGsdAdapterSmoke)(
    'drives the supported default init wizard in an external temp project and proves bootstrap completeness',
    async () => {
      const { workspace, projectRoot } = await createExternalInitProject('real-init-project');
      const stageUpdates: InitStageUpdate[] = [];

      cleanupTasks.push(workspace.cleanup);

      expect(isPathWithin(process.cwd(), projectRoot)).toBe(false);

      const result = await runOfficialGsdInit(projectRoot, {
        timeoutMs: 180_000,
        bootstrapTimeoutMs: 20_000,
        onStage: (update) => {
          stageUpdates.push(update);
        },
      });

      expect(result.outcome).toBe('completed');
      expect(result.stage).toBe('completed');
      expect(result.bootstrap.state).toBe('complete');
      expect(result.bootstrap.missingEntries).toEqual([]);
      expect(result.promptHistory.map((prompt) => prompt.promptId)).toEqual(
        expect.arrayContaining([
          'project_setup',
          'workflow_mode',
          'git_settings',
          'project_instructions',
          'advanced_settings',
          'essential_skills',
          'review_preferences',
        ]),
      );
      expect(stageUpdates.map((update) => update.stage)).toEqual(
        expect.arrayContaining([
          'starting',
          'project_setup',
          'workflow_mode',
          'git_settings',
          'project_instructions',
          'advanced_settings',
          'essential_skills',
          'review_preferences',
          'verifying_bootstrap',
          'completed',
        ]),
      );
      expect(result.outputExcerpt.length).toBeGreaterThan(0);
      expect(result.outputExcerpt.length).toBeLessThanOrEqual(1_200);

      const gsdEntries = await readdir(path.join(projectRoot, '.gsd'));
      expect(gsdEntries).toEqual(
        expect.arrayContaining(['STATE.md', 'PREFERENCES.md', 'gsd.db', 'milestones', 'notifications.jsonl']),
      );
    },
    210_000,
  );

  test('classifies notification-only .gsd state as partial instead of initialized', async () => {
    const workspace = await createTempWorkspace('gsd-web-init-partial-');

    cleanupTasks.push(workspace.cleanup);

    const projectRoot = await createPartialBootstrapProject(workspace.root, 'partial-project', {
      notificationLines: ['{"event":"created"}'],
    });
    const classification = await classifyBootstrapCompleteness(projectRoot);

    expect(classification.state).toBe('partial');
    expect(classification.presentEntries).toEqual(['notifications.jsonl']);
    expect(classification.missingEntries).toEqual(
      expect.arrayContaining(['STATE.md', 'PREFERENCES.md', 'gsd.db', 'milestones']),
    );
    expect(classification.detail).toMatch(/notifications\.jsonl/i);
  });

  test('fails closed when an ancestor-owned .gsd shadows the target project', async () => {
    const workspace = await createTempWorkspace('gsd-web-init-ancestor-');

    cleanupTasks.push(workspace.cleanup);

    await createBootstrapCompleteGsdDirectory(workspace.root);
    const projectRoot = await createEmptyProject(workspace.root, 'nested-project');

    const classification = await classifyBootstrapCompleteness(projectRoot);

    expect(classification.state).toBe('ancestor_conflict');
    expect(classification.gsdRootPath).toBe(path.join(workspace.root, '.gsd'));

    const result = await runOfficialGsdInit(projectRoot, {
      timeoutMs: 15_000,
    });

    expect(result.outcome).toBe('failed');
    expect(result.bootstrap.state).toBe('ancestor_conflict');
    expect(result.errorDetail).toMatch(/ancestor-owned/i);
  });
});
