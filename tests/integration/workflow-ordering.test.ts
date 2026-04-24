import { describe, expect, test } from 'vitest';

import type { GsdDbMilestoneSummary, GsdDbSliceSummary, GsdDbTaskSummary } from '../../src/shared/contracts.js';
import {
  findActiveMilestone,
  findActiveSlice,
  findActiveTask,
  orderWorkflowMilestones,
  orderWorkflowSlices,
  orderWorkflowTasks,
} from '../../src/web/app/model.js';

function task(id: string, status = 'pending'): GsdDbTaskSummary {
  return {
    id,
    title: id,
    status,
    risk: null,
    startedAt: null,
    finishedAt: null,
  };
}

function slice(id: string, tasks: GsdDbTaskSummary[], status = 'pending'): GsdDbSliceSummary {
  return {
    id,
    title: id,
    status,
    risk: null,
    startedAt: null,
    finishedAt: null,
    taskCount: tasks.length,
    completedTaskCount: tasks.filter((entry) => entry.status === 'complete').length,
    tasks,
  };
}

function milestone(id: string, slices: GsdDbSliceSummary[], status = 'pending'): GsdDbMilestoneSummary {
  return {
    id,
    title: id,
    status,
    startedAt: null,
    finishedAt: null,
    sliceCount: slices.length,
    taskCount: slices.reduce((total, entry) => total + entry.taskCount, 0),
    completedTaskCount: slices.reduce((total, entry) => total + entry.completedTaskCount, 0),
    slices,
  };
}

describe('workflow focus ordering', () => {
  test('keeps all-pending slices and tasks in execution order', () => {
    const slices = [
      slice('S01', [task('T01'), task('T02')]),
      slice('S02', [task('T03')]),
      slice('S03', [task('T04')]),
    ];

    expect(orderWorkflowSlices(slices, null).map((entry) => entry.id)).toEqual(['S01', 'S02', 'S03']);
    expect(orderWorkflowTasks(slices[0]!.tasks, null).map((entry) => entry.id)).toEqual(['T01', 'T02']);
    expect(findActiveSlice(milestone('M001', slices))?.id).toBe('S01');
    expect(findActiveTask(slices[0]!)?.id).toBe('T01');
  });

  test('orders unfinished items ascending and completed items descending', () => {
    const milestoneSlices = [
      slice('S01', [task('T01', 'complete')], 'complete'),
      slice('S02', [task('T02', 'pending')], 'pending'),
      slice('S03', [task('T03', 'active')], 'pending'),
      slice('S04', [task('T04', 'complete')], 'complete'),
    ];
    const milestones = [
      milestone('M001', [slice('S01', [task('T01', 'complete')], 'complete')], 'complete'),
      milestone('M002', [slice('S01', [task('T01', 'pending')], 'pending')], 'pending'),
      milestone('M003', [slice('S01', [task('T01', 'active')], 'pending')], 'pending'),
      milestone('M004', [slice('S01', [task('T01', 'complete')], 'complete')], 'complete'),
    ];

    expect(orderWorkflowMilestones(milestones, null).map((entry) => entry.id)).toEqual(['M002', 'M003', 'M004', 'M001']);
    expect(orderWorkflowSlices(milestoneSlices, null).map((entry) => entry.id)).toEqual(['S02', 'S03', 'S04', 'S01']);
    expect(orderWorkflowTasks([
      task('T01', 'complete'),
      task('T02', 'pending'),
      task('T03', 'active'),
      task('T04', 'complete'),
    ], null).map((entry) => entry.id)).toEqual(['T02', 'T03', 'T04', 'T01']);
    expect(findActiveMilestone(milestones)?.id).toBe('M003');
    expect(findActiveSlice(milestone('M100', milestoneSlices))?.id).toBe('S03');
    expect(findActiveTask(milestoneSlices[2]!)?.id).toBe('T03');
  });
});
