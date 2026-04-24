import { describe, expect, test } from 'vitest';

import {
  calculateTaskProgressPercent,
  calculateTimeProgressPercent,
  selectOverviewProgressPercent,
} from '../../src/web/app/model.js';

describe('overview progress selection', () => {
  test('prefers the more conservative time-based percentage when time lags task completion', () => {
    const taskProgressPercent = calculateTaskProgressPercent(10, 7);
    const timeProgressPercent = calculateTimeProgressPercent(10, 900, 600);

    expect(taskProgressPercent).toBe(70);
    expect(timeProgressPercent).toBe(60);
    expect(
      selectOverviewProgressPercent({
        taskProgressPercent,
        timeProgressPercent,
        fallbackPercent: 0,
      }),
    ).toEqual({
      progressPercent: 60,
      progressSource: 'time',
    });
  });

  test('prefers the more conservative task-based percentage when task completion lags time', () => {
    const taskProgressPercent = calculateTaskProgressPercent(10, 6);
    const timeProgressPercent = calculateTimeProgressPercent(10, 700, 300);

    expect(taskProgressPercent).toBe(60);
    expect(timeProgressPercent).toBe(70);
    expect(
      selectOverviewProgressPercent({
        taskProgressPercent,
        timeProgressPercent,
        fallbackPercent: 0,
      }),
    ).toEqual({
      progressPercent: 60,
      progressSource: 'task',
    });
  });

  test('falls back cleanly when no workflow estimate is available', () => {
    expect(calculateTaskProgressPercent(0, 0)).toBeNull();
    expect(calculateTimeProgressPercent(0, null, 0)).toBeNull();
    expect(
      selectOverviewProgressPercent({
        taskProgressPercent: null,
        timeProgressPercent: null,
        fallbackPercent: 100,
      }),
    ).toEqual({
      progressPercent: 100,
      progressSource: 'fallback',
    });
  });
});
