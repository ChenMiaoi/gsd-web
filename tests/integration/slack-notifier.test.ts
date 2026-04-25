import { describe, expect, test, vi } from 'vitest';

import type { ProjectEventEnvelope, ProjectSnapshotEventPayload } from '../../src/shared/contracts.js';
import {
  SlackNotifier,
  buildSlackMessage,
  resolveSlackNotifierConfig,
  type SlackNotificationSignal,
} from '../../src/server/slack.js';

function createProjectEvent(
  overrides: Partial<ProjectEventEnvelope<ProjectSnapshotEventPayload>> = {},
): ProjectEventEnvelope<ProjectSnapshotEventPayload> {
  return {
    id: 'evt_1',
    sequence: 1,
    type: 'project.refreshed',
    emittedAt: '2026-04-26T01:00:00.000Z',
    projectId: 'prj_test',
    payload: {
      projectId: 'prj_test',
      canonicalPath: '/workspace/demo-project',
      snapshotStatus: 'initialized',
      warningCount: 0,
      warnings: [],
      sourceStates: {
        directory: 'ok',
        gsdDirectory: 'ok',
        gsdId: 'ok',
        projectMd: 'ok',
        repoMeta: 'ok',
        autoLock: 'ok',
        stateMd: 'ok',
        metricsJson: 'ok',
        gsdDb: 'ok',
      },
      changed: true,
      checkedAt: '2026-04-26T01:00:00.000Z',
      trigger: 'manual_refresh',
      monitor: {
        health: 'healthy',
        lastAttemptedAt: '2026-04-26T01:00:00.000Z',
        lastSuccessfulAt: '2026-04-26T01:00:00.000Z',
        lastTrigger: 'manual_refresh',
        lastError: null,
      },
    },
    ...overrides,
  };
}

describe('Slack notifier', () => {
  test('resolves disabled and bot-token Slack configuration from environment', () => {
    expect(resolveSlackNotifierConfig({})).toBeNull();

    expect(() =>
      resolveSlackNotifierConfig({
        GSD_WEB_SLACK_BOT_TOKEN: 'xoxb-token',
      }),
    ).toThrow(/both GSD_WEB_SLACK_BOT_TOKEN and GSD_WEB_SLACK_CHANNEL_ID/i);

    expect(
      resolveSlackNotifierConfig({
        GSD_WEB_SLACK_BOT_TOKEN: 'xoxb-token',
        GSD_WEB_SLACK_CHANNEL_ID: 'C123',
        GSD_WEB_SLACK_EVENTS: 'project.init.updated,project.monitor.updated',
        GSD_WEB_SLACK_TIMEOUT_MS: '2500',
      }),
    ).toMatchObject({
      botToken: 'xoxb-token',
      channelId: 'C123',
      eventTypes: ['project.init.updated', 'project.monitor.updated'],
      timeoutMs: 2500,
    });
  });

  test('uses config-file Slack values and lets environment variables override them', () => {
    expect(
      resolveSlackNotifierConfig(
        {},
        {
          enabled: false,
          webhookUrl: 'https://hooks.slack.com/services/disabled',
        },
      ),
    ).toBeNull();

    expect(
      resolveSlackNotifierConfig(
        {},
        {
          enabled: true,
          webhookUrl: 'https://hooks.slack.com/services/from-file',
          events: ['project.refreshed'],
          timeoutMs: 3000,
        },
        'https://gsd.example.test',
      ),
    ).toMatchObject({
      webhookUrl: 'https://hooks.slack.com/services/from-file',
      publicBaseUrl: 'https://gsd.example.test',
      eventTypes: ['project.refreshed'],
      timeoutMs: 3000,
    });

    expect(
      resolveSlackNotifierConfig(
        {
          GSD_WEB_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/from-env',
          GSD_WEB_SLACK_EVENTS: 'project.init.updated',
        },
        {
          webhookUrl: 'https://hooks.slack.com/services/from-file',
          events: ['project.refreshed'],
        },
      ),
    ).toMatchObject({
      webhookUrl: 'https://hooks.slack.com/services/from-env',
      eventTypes: ['project.init.updated'],
    });

    expect(() => resolveSlackNotifierConfig({}, { enabled: true })).toThrow(/enabled but no webhookUrl/i);
  });

  test('builds Slack messages with project detail links when a public URL is configured', () => {
    const message = buildSlackMessage(createProjectEvent(), 'https://gsd.example.test/');

    expect(message.text).toContain('Refreshed demo-project');
    expect(message.text).toContain('Snapshot: initialized');
    expect(message.text).toContain('Monitor: healthy');
    expect(JSON.stringify(message.blocks)).toContain('https://gsd.example.test/lazy/employee-prj_test');
  });

  test('posts selected project events through an incoming webhook', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    const signals: SlackNotificationSignal[] = [];
    const notifier = new SlackNotifier(
      {
        webhookUrl: 'https://hooks.slack.com/services/test',
        publicBaseUrl: 'https://gsd.example.test',
        eventTypes: ['project.refreshed'],
        timeoutMs: 1_000,
      },
      {
        fetchImpl,
        signalSink: (signal) => signals.push(signal),
      },
    );

    await notifier.notify(createProjectEvent());
    await notifier.notify(createProjectEvent({ id: 'evt_2', sequence: 2, type: 'service.ready' } as ProjectEventEnvelope));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://hooks.slack.com/services/test');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      text: expect.stringContaining('Refreshed demo-project'),
    });
    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'enabled', target: 'webhook' }),
        expect.objectContaining({ phase: 'sent', eventId: 'evt_1', target: 'webhook' }),
      ]),
    );
  });

  test('posts bot-token notifications with channel and bearer authentication', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );
    const notifier = new SlackNotifier(
      {
        botToken: 'xoxb-token',
        channelId: 'C123',
        eventTypes: ['project.refreshed'],
        timeoutMs: 1_000,
      },
      { fetchImpl },
    );

    await notifier.notify(createProjectEvent());

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer xoxb-token',
        }),
      }),
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      channel: 'C123',
      text: expect.stringContaining('Refreshed demo-project'),
    });
  });

  test('reports Slack delivery failures without throwing into the event stream', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );
    const signals: SlackNotificationSignal[] = [];
    const notifier = new SlackNotifier(
      {
        botToken: 'xoxb-token',
        channelId: 'C123',
        eventTypes: ['project.refreshed'],
        timeoutMs: 1_000,
      },
      {
        fetchImpl,
        signalSink: (signal) => signals.push(signal),
      },
    );

    await expect(notifier.notify(createProjectEvent())).resolves.toBeUndefined();
    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'failed',
          eventId: 'evt_1',
          detail: expect.stringContaining('channel_not_found'),
        }),
      ]),
    );
  });
});
