import { createHmac } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import type { ProjectEventEnvelope, ProjectRecord, ProjectSnapshotEventPayload } from '../../src/shared/contracts.js';
import {
  SlackNotifier,
  buildGsdWebMetricsSnapshot,
  buildSlackCommandResponse,
  buildSlackMessage,
  buildSlackStatusMessage,
  hasAnyRunningProject,
  parseSlackCommandPayload,
  parseSlackPolledCommand,
  resolveSlackNotifierConfig,
  shouldSendImmediateStatusReport,
  verifySlackRequest,
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

function createProjectRecord(): ProjectRecord {
  const event = createProjectEvent();

  return {
    projectId: 'prj_test',
    registeredPath: '/workspace/demo-project',
    canonicalPath: '/workspace/demo-project',
    createdAt: '2026-04-26T01:00:00.000Z',
    updatedAt: '2026-04-26T01:00:00.000Z',
    lastEventId: 'evt_1',
    snapshot: {
      status: 'initialized',
      checkedAt: event.payload.checkedAt,
      directory: {
        isEmpty: false,
        sampleEntries: ['.gsd'],
        sampleTruncated: false,
      },
      identityHints: {
        gsdId: 'gsd-demo',
        repoFingerprint: null,
        displayName: 'demo-project',
        displayNameSource: 'directory',
      },
      sources: {
        directory: { state: 'ok', value: { isEmpty: false, sampleEntries: ['.gsd'], sampleTruncated: false } },
        gsdDirectory: { state: 'ok', value: { present: true } },
        gsdId: { state: 'ok', value: { gsdId: 'gsd-demo' } },
        projectMd: { state: 'missing' },
        repoMeta: { state: 'missing' },
        autoLock: { state: 'missing' },
        stateMd: { state: 'missing' },
        metricsJson: { state: 'missing' },
        gsdDb: { state: 'missing' },
      },
      warnings: [],
    },
    monitor: event.payload.monitor,
    dataLocation: {
      projectRoot: '/workspace/demo-project',
      gsdRootPath: '/workspace/demo-project/.gsd',
      gsdDbPath: '/workspace/demo-project/.gsd/gsd.db',
      statePath: '/workspace/demo-project/.gsd/STATE.md',
      persistenceScope: 'project',
    },
    latestInitJob: null,
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
        GSD_WEB_SLACK_COMMAND_POLLING: 'true',
        GSD_WEB_SLACK_COMMAND_POLL_INTERVAL_MS: '3000',
        GSD_WEB_SLACK_COMMAND_PREFIX: 'g',
      }),
    ).toMatchObject({
      botToken: 'xoxb-token',
      channelId: 'C123',
      eventTypes: ['project.init.updated', 'project.monitor.updated'],
      timeoutMs: 2500,
      commandPollingEnabled: true,
      commandPollIntervalMs: 3000,
      commandPrefix: 'g',
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

    expect(resolveSlackNotifierConfig({}, { enabled: true, signingSecret: 'secret' })).toBeNull();
  });

  test('verifies and parses Slack slash command requests', () => {
    const timestamp = '1777132800';
    const rawBody = 'command=%2Fgsd&text=project%20demo&user_id=U123&channel_id=C123';
    const signature = `v0=${createHmac('sha256', 'secret').update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;

    expect(
      verifySlackRequest({
        signingSecret: 'secret',
        rawBody,
        timestamp,
        signature,
        nowMs: 1_777_132_800_000,
      }),
    ).toBe(true);
    expect(
      verifySlackRequest({
        signingSecret: 'wrong',
        rawBody,
        timestamp,
        signature,
        nowMs: 1_777_132_800_000,
      }),
    ).toBe(false);
    expect(parseSlackCommandPayload(rawBody)).toMatchObject({
      command: '/gsd',
      text: 'project demo',
      userId: 'U123',
      channelId: 'C123',
    });
    expect(parseSlackPolledCommand('gsd project demo', 'gsd')).toMatchObject({
      command: 'gsd',
      text: 'project demo',
    });
    expect(parseSlackPolledCommand('hello gsd status', 'gsd')).toBeNull();
  });

  test('builds Slack slash command status and project responses', () => {
    const project = createProjectRecord();
    const status = buildSlackCommandResponse(
      { command: '/gsd', text: 'status', userId: 'U123', channelId: 'C123', responseUrl: null },
      [project],
      'https://gsd.example.test',
    );
    const detail = buildSlackCommandResponse(
      { command: '/gsd', text: 'project demo', userId: 'U123', channelId: 'C123', responseUrl: null },
      [project],
      'https://gsd.example.test',
    );

    expect(status.text).toContain('GSD projects: 1 total');
    expect(status.text).toContain('demo-project');
    expect(status.blocks).toBeDefined();
    expect(detail.text).toContain('prj_test');
    expect(detail.text).toContain('https://gsd.example.test/lazy/employee-prj_test');
    expect(detail.blocks).toBeDefined();
  });

  test('builds a formatted recurring Slack status report', () => {
    const project = createProjectRecord();
    const message = buildSlackStatusMessage([project], 'https://gsd.example.test', 1_777_132_800_000);
    const metrics = buildGsdWebMetricsSnapshot([project], 'https://gsd.example.test', 1_777_132_800_000);

    expect(message.text).toContain('GSD status: demo-project');
    expect(message.text).toContain('healthy');
    expect(metrics.projects[0]).toMatchObject({
      projectId: 'prj_test',
      label: 'demo-project',
      progressPercent: 100,
      threadKey: 'project:prj_test',
    });
    expect(JSON.stringify(message.blocks)).toContain('Current project');
    expect(JSON.stringify(message.blocks)).toContain('Estimated finish');
    expect(JSON.stringify(message.blocks)).toContain('ETA');
    expect(JSON.stringify(message.blocks)).toContain('https://gsd.example.test/lazy/employee-prj_test');
    expect(message.blocks.some((block) => block.type === 'section' && 'fields' in block)).toBe(false);
  });

  test('aligns Slack status progress and ETA with metrics-backed gsd-web overview data', () => {
    const nowMs = 1_777_132_800_000;
    const project = createProjectRecord();

    project.snapshot.sources.gsdDb = {
      state: 'ok',
      value: {
        tables: ['milestones', 'slices', 'tasks'],
        counts: {
          milestones: 1,
          slices: 1,
          tasks: 2,
          sliceDependencies: 0,
          projects: null,
        },
        dependencies: [],
        milestones: [
          {
            id: 'M001',
            title: 'Metrics-backed milestone',
            status: 'active',
            startedAt: nowMs - 600_000,
            finishedAt: null,
            sliceCount: 1,
            taskCount: 2,
            completedTaskCount: 1,
            slices: [
              {
                id: 'S001',
                title: 'Metrics-backed slice',
                status: 'active',
                risk: null,
                startedAt: nowMs - 600_000,
                finishedAt: null,
                taskCount: 2,
                completedTaskCount: 1,
                tasks: [
                  {
                    id: 'T001',
                    title: 'Completed task',
                    status: 'done',
                    risk: null,
                    startedAt: nowMs - 600_000,
                    finishedAt: nowMs,
                  },
                  {
                    id: 'T002',
                    title: 'Active task',
                    status: 'active',
                    risk: null,
                    startedAt: nowMs,
                    finishedAt: null,
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    project.snapshot.sources.metricsJson = {
      state: 'ok',
      value: {
        version: 1,
        projectStartedAt: nowMs - 60_000,
        unitCount: 1,
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 100,
          cost: 1,
          toolCalls: 0,
          assistantMessages: 0,
          userMessages: 0,
          apiRequests: 1,
          promptCharCount: 0,
          baselineCharCount: 0,
        },
        units: [
          {
            type: 'task',
            id: 'session-1',
            model: 'test-model',
            startedAt: nowMs - 60_000,
            finishedAt: nowMs,
            totalTokens: 100,
            cost: 1,
            toolCalls: 0,
            apiRequests: 1,
          },
        ],
        recentUnits: [],
      },
    };

    const message = buildSlackStatusMessage([project], 'https://gsd.example.test', nowMs);
    const blocks = JSON.stringify(message.blocks);

    expect(blocks).toContain('Progress 9%');
    expect(blocks).toContain('Estimated finish');
    expect(blocks).toContain('(10m)');
    expect(message.threadKey).toBe('slice:prj_test:M001/S001');
  });

  test('skips recurring Slack status delivery when no project is running', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    const notifier = new SlackNotifier(
      {
        webhookUrl: 'https://hooks.slack.com/services/test',
        eventTypes: ['project.refreshed'],
        timeoutMs: 1_000,
        statusReportEnabled: true,
      },
      { fetchImpl },
    );

    const project = createProjectRecord();

    await expect(notifier.sendStatus([project], 1_777_132_800_000)).resolves.toBe(false);
    expect(hasAnyRunningProject([project])).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('sends recurring Slack status delivery while a project is running', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    const notifier = new SlackNotifier(
      {
        webhookUrl: 'https://hooks.slack.com/services/test',
        eventTypes: ['project.refreshed'],
        timeoutMs: 1_000,
        statusReportEnabled: true,
      },
      { fetchImpl },
    );
    const project = createProjectRecord();

    project.snapshot.sources.autoLock = {
      state: 'ok',
      value: {
        status: 'running',
        pid: 4242,
        startedAt: '2026-04-26T01:00:00.000Z',
        updatedAt: '2026-04-26T01:01:00.000Z',
      },
    };

    await expect(notifier.sendStatus([project], 1_777_132_800_000)).resolves.toBe(true);
    expect(hasAnyRunningProject([project])).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('detects project events that should trigger immediate status reports', () => {
    expect(shouldSendImmediateStatusReport(createProjectEvent())).toBe(true);
    expect(shouldSendImmediateStatusReport(createProjectEvent({
      payload: {
        ...createProjectEvent().payload,
        changed: false,
        warningCount: 0,
      },
    }))).toBe(false);
    expect(shouldSendImmediateStatusReport({
      ...createProjectEvent(),
      type: 'project.monitor.updated',
      payload: {
        projectId: 'prj_test',
        canonicalPath: '/workspace/demo-project',
        snapshotStatus: 'initialized',
        warningCount: 0,
        trigger: 'watcher',
        previousHealth: 'healthy',
        monitor: {
          health: 'degraded',
          lastAttemptedAt: '2026-04-26T01:00:00.000Z',
          lastSuccessfulAt: '2026-04-26T01:00:00.000Z',
          lastTrigger: 'watcher',
          lastError: null,
        },
      },
    })).toBe(true);
  });

  test('builds Slack messages with project detail links when a public URL is configured', () => {
    const message = buildSlackMessage(createProjectEvent(), 'https://gsd.example.test/');

    expect(message.text).toContain('Refreshed demo-project');
    expect(message.text).toContain('Snapshot: initialized');
    expect(message.text).toContain('Monitor: healthy');
    expect(JSON.stringify(message.blocks)).toContain('https://gsd.example.test/lazy/employee-prj_test');
    expect(message.attachments?.[0]?.color).toBe('#2e90fa');
    expect(message.threadKey).toBe('project:prj_test');
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
      attachments: [
        expect.objectContaining({
          color: '#2e90fa',
        }),
      ],
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
      attachments: [
        expect.objectContaining({
          color: '#2e90fa',
        }),
      ],
    });
  });

  test('threads repeated bot-token notifications by project', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: '1777132800.000100' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: '1777132801.000200' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }));
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
    await notifier.notify(createProjectEvent({ id: 'evt_2', sequence: 2 }));

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).not.toHaveProperty('thread_ts');
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      thread_ts: '1777132800.000100',
    });
  });

  test('polls bot-token command messages and replies in the command thread', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        messages: [
          {
            ts: '1777132801.000200',
            text: 'not a command',
            user: 'U123',
          },
          {
            ts: '1777132800.000100',
            text: 'gsd status',
            user: 'U123',
          },
          {
            ts: '1777132799.000100',
            text: 'gsd status',
            bot_id: 'B123',
          },
        ],
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: '1777132802.000300' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }));
    const notifier = new SlackNotifier(
      {
        botToken: 'xoxb-token',
        channelId: 'C123',
        eventTypes: ['project.refreshed'],
        timeoutMs: 1_000,
      },
      { fetchImpl },
    );

    const messages = await notifier.fetchCommandMessages('1777132800.000000');
    const command = parseSlackPolledCommand(messages[0]!.text, 'gsd');

    expect(fetchImpl.mock.calls[0]?.[0]).toContain('https://slack.com/api/conversations.history');
    expect(messages.map((message) => message.ts)).toEqual(['1777132800.000100', '1777132801.000200']);
    expect(command?.text).toBe('status');

    await notifier.replyToCommand(buildSlackCommandResponse(command!, [createProjectRecord()], 'https://gsd.example.test'), messages[0]!.ts);

    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      channel: 'C123',
      thread_ts: '1777132800.000100',
      text: expect.stringContaining('GSD projects: 1 total'),
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
