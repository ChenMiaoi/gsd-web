import type {
  ProjectEventEnvelope,
  ProjectEventPayload,
  ProjectEventType,
} from '../shared/contracts.js';

export const DEFAULT_SLACK_EVENT_TYPES: readonly ProjectEventType[] = [
  'project.registered',
  'project.refreshed',
  'project.deleted',
  'project.relinked',
  'project.monitor.updated',
  'project.init.updated',
];

const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';
const DEFAULT_SLACK_TIMEOUT_MS = 5_000;

export interface SlackNotifierConfig {
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
  publicBaseUrl?: string;
  eventTypes: readonly ProjectEventType[];
  timeoutMs: number;
}

export interface SlackNotificationSignal {
  event: 'slack_notification';
  phase: 'enabled' | 'sent' | 'failed';
  eventId?: string;
  eventType?: ProjectEventType;
  target: 'webhook' | 'bot';
  detail?: string;
}

export interface SlackNotifierOptions {
  fetchImpl?: typeof fetch;
  signalSink?: (signal: SlackNotificationSignal) => void;
}

export interface SlackNotifierFileConfig {
  enabled?: boolean;
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
  events?: readonly ProjectEventType[];
  timeoutMs?: number;
}

export class SlackNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackNotificationError';
  }
}

function readTrimmedEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();

  return value && value.length > 0 ? value : undefined;
}

function validateSlackEventTypes(values: readonly string[]) {
  if (values.length === 0) {
    throw new Error('Slack event configuration must include at least one event type when set.');
  }

  const validEventTypes = new Set<ProjectEventType>([
    'service.ready',
    ...DEFAULT_SLACK_EVENT_TYPES,
  ]);
  const invalid = values.find((value) => !validEventTypes.has(value as ProjectEventType));

  if (invalid) {
    throw new Error(`Unsupported Slack event type: ${invalid}`);
  }

  return values as readonly ProjectEventType[];
}

function parseSlackEventTypes(rawValue: string | undefined, fileValue?: readonly ProjectEventType[]) {
  if (rawValue === undefined) {
    if (fileValue !== undefined) {
      return validateSlackEventTypes(fileValue);
    }

    return DEFAULT_SLACK_EVENT_TYPES;
  }

  const values = rawValue
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return validateSlackEventTypes(values);
}

function resolveSlackTimeoutMs(env: NodeJS.ProcessEnv, fileValue?: number) {
  const rawValue = readTrimmedEnv(env, 'GSD_WEB_SLACK_TIMEOUT_MS');

  if (rawValue === undefined) {
    if (fileValue !== undefined && (!Number.isInteger(fileValue) || fileValue <= 0)) {
      throw new Error('Slack timeoutMs must be a positive integer.');
    }

    return fileValue ?? DEFAULT_SLACK_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('GSD_WEB_SLACK_TIMEOUT_MS must be a positive integer.');
  }

  return parsed;
}

function normalizeOptionalConfigString(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function resolveSlackNotifierConfig(
  env: NodeJS.ProcessEnv = process.env,
  fileConfig: SlackNotifierFileConfig | null = null,
  publicBaseUrlFromFile?: string,
): SlackNotifierConfig | null {
  const envWebhookUrl = readTrimmedEnv(env, 'GSD_WEB_SLACK_WEBHOOK_URL');
  const envBotToken = readTrimmedEnv(env, 'GSD_WEB_SLACK_BOT_TOKEN');
  const envChannelId = readTrimmedEnv(env, 'GSD_WEB_SLACK_CHANNEL_ID');
  const hasEnvDeliveryConfig = envWebhookUrl !== undefined || envBotToken !== undefined || envChannelId !== undefined;

  if (fileConfig?.enabled === false && !hasEnvDeliveryConfig) {
    return null;
  }

  const webhookUrl = envWebhookUrl ?? normalizeOptionalConfigString(fileConfig?.webhookUrl);
  const botToken = envBotToken ?? normalizeOptionalConfigString(fileConfig?.botToken);
  const channelId = envChannelId ?? normalizeOptionalConfigString(fileConfig?.channelId);
  const publicBaseUrl = readTrimmedEnv(env, 'GSD_WEB_PUBLIC_URL') ?? normalizeOptionalConfigString(publicBaseUrlFromFile);
  const eventTypes = parseSlackEventTypes(readTrimmedEnv(env, 'GSD_WEB_SLACK_EVENTS'), fileConfig?.events);
  const timeoutMs = resolveSlackTimeoutMs(env, fileConfig?.timeoutMs);

  if (fileConfig?.enabled === false && webhookUrl === undefined && botToken === undefined && channelId === undefined) {
    return null;
  }

  if (webhookUrl === undefined && botToken === undefined && channelId === undefined) {
    if (fileConfig?.enabled === true) {
      throw new Error('Slack config is enabled but no webhookUrl or bot token/channel pair is configured.');
    }

    return null;
  }

  if (webhookUrl !== undefined) {
    return {
      webhookUrl,
      ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
      eventTypes,
      timeoutMs,
    };
  }

  if (botToken === undefined || channelId === undefined) {
    throw new Error('Slack bot notifications require both GSD_WEB_SLACK_BOT_TOKEN and GSD_WEB_SLACK_CHANNEL_ID.');
  }

  return {
    botToken,
    channelId,
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    eventTypes,
    timeoutMs,
  };
}

function asRecord(value: ProjectEventPayload): Record<string, unknown> {
  return value && typeof value === 'object' ? value as unknown as Record<string, unknown> : {};
}

function pickString(record: Record<string, unknown>, key: string) {
  const value = record[key];

  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function pickNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatProjectLabel(event: ProjectEventEnvelope) {
  const payload = asRecord(event.payload);
  const canonicalPath = pickString(payload, 'canonicalPath');
  const projectId = event.projectId ?? pickString(payload, 'projectId');

  if (canonicalPath) {
    return canonicalPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? canonicalPath;
  }

  return projectId ?? 'project';
}

function formatEventTitle(event: ProjectEventEnvelope) {
  const projectLabel = formatProjectLabel(event);

  switch (event.type) {
    case 'project.registered':
      return `Registered ${projectLabel}`;
    case 'project.refreshed':
      return `Refreshed ${projectLabel}`;
    case 'project.deleted':
      return `Deleted ${projectLabel}`;
    case 'project.relinked':
      return `Relinked ${projectLabel}`;
    case 'project.monitor.updated':
      return `Monitor updated for ${projectLabel}`;
    case 'project.init.updated':
      return `Initialization updated for ${projectLabel}`;
    case 'service.ready':
      return 'gsd-web is ready';
    default:
      return event.type;
  }
}

function normalizeBaseUrl(publicBaseUrl: string | undefined) {
  return publicBaseUrl?.replace(/\/+$/u, '');
}

function buildProjectUrl(publicBaseUrl: string | undefined, event: ProjectEventEnvelope) {
  const projectId = event.projectId ?? pickString(asRecord(event.payload), 'projectId');
  const baseUrl = normalizeBaseUrl(publicBaseUrl);

  if (!baseUrl || !projectId) {
    return null;
  }

  return `${baseUrl}/lazy/employee-${encodeURIComponent(projectId)}`;
}

function buildFieldLines(event: ProjectEventEnvelope) {
  const payload = asRecord(event.payload);
  const lines = [
    `Event: ${event.type}`,
    `Time: ${event.emittedAt}`,
  ];
  const snapshotStatus = pickString(payload, 'snapshotStatus');
  const warningCount = pickNumber(payload, 'warningCount');
  const trigger = pickString(payload, 'trigger');
  const monitor = payload.monitor && typeof payload.monitor === 'object'
    ? payload.monitor as Record<string, unknown>
    : null;
  const monitorHealth = monitor ? pickString(monitor, 'health') : null;
  const job = payload.job && typeof payload.job === 'object' ? payload.job as Record<string, unknown> : null;
  const jobStage = job ? pickString(job, 'stage') : null;

  if (snapshotStatus) {
    lines.push(`Snapshot: ${snapshotStatus}`);
  }

  if (monitorHealth) {
    lines.push(`Monitor: ${monitorHealth}`);
  }

  if (jobStage) {
    lines.push(`Init: ${jobStage}`);
  }

  if (warningCount !== null) {
    lines.push(`Warnings: ${warningCount}`);
  }

  if (trigger) {
    lines.push(`Trigger: ${trigger}`);
  }

  return lines;
}

export function buildSlackMessage(event: ProjectEventEnvelope, publicBaseUrl?: string) {
  const title = formatEventTitle(event);
  const projectUrl = buildProjectUrl(publicBaseUrl, event);
  const fieldText = buildFieldLines(event).join('\n');
  const titleText = projectUrl ? `<${projectUrl}|${title}>` : title;
  const text = `${title}\n${fieldText}`;

  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${titleText}*\n${fieldText}`,
        },
      },
    ],
  };
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);
  timeout.unref?.();

  try {
    return await fetchImpl(url, {
      ...init,
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export class SlackNotifier {
  private readonly eventTypes: ReadonlySet<ProjectEventType>;
  private readonly fetchImpl: typeof fetch;
  private readonly target: 'webhook' | 'bot';

  constructor(
    private readonly config: SlackNotifierConfig,
    private readonly options: SlackNotifierOptions = {},
  ) {
    this.eventTypes = new Set(config.eventTypes);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.target = config.webhookUrl ? 'webhook' : 'bot';
    this.options.signalSink?.({
      event: 'slack_notification',
      phase: 'enabled',
      target: this.target,
    });
  }

  async notify(event: ProjectEventEnvelope) {
    if (!this.eventTypes.has(event.type)) {
      return;
    }

    try {
      await this.postMessage(buildSlackMessage(event, this.config.publicBaseUrl));
      this.options.signalSink?.({
        event: 'slack_notification',
        phase: 'sent',
        eventId: event.id,
        eventType: event.type,
        target: this.target,
      });
    } catch (error) {
      this.options.signalSink?.({
        event: 'slack_notification',
        phase: 'failed',
        eventId: event.id,
        eventType: event.type,
        target: this.target,
        detail: error instanceof Error ? error.message : 'Slack notification failed.',
      });
    }
  }

  private async postMessage(message: ReturnType<typeof buildSlackMessage>) {
    if (this.config.webhookUrl) {
      const response = await fetchWithTimeout(
        this.fetchImpl,
        this.config.webhookUrl,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(message),
        },
        this.config.timeoutMs,
      );

      if (!response.ok) {
        throw new SlackNotificationError(`Slack webhook returned HTTP ${response.status}.`);
      }

      return;
    }

    if (!this.config.botToken || !this.config.channelId) {
      throw new SlackNotificationError('Slack bot token and channel id are required.');
    }

    const response = await fetchWithTimeout(
      this.fetchImpl,
      SLACK_POST_MESSAGE_URL,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: this.config.channelId,
          text: message.text,
          blocks: message.blocks,
          unfurl_links: false,
          unfurl_media: false,
        }),
      },
      this.config.timeoutMs,
    );

    if (!response.ok) {
      throw new SlackNotificationError(`Slack API returned HTTP ${response.status}.`);
    }

    const payload = await response.json() as unknown;

    if (!payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) {
      const error = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : 'unknown_error';

      throw new SlackNotificationError(`Slack API rejected the message: ${error}`);
    }
  }
}
