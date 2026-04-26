import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  GsdDbMilestoneSummary,
  GsdDbSliceSummary,
  GsdDbTaskSummary,
  GsdMetricsSummaryValue,
  ProjectEventEnvelope,
  ProjectEventPayload,
  ProjectEventType,
  ProjectInitJob,
  ProjectRecord,
  ProjectSnapshotStatus,
} from '../shared/contracts.js';
import { isProjectInitJobTerminalStage } from '../shared/contracts.js';

export const DEFAULT_SLACK_EVENT_TYPES: readonly ProjectEventType[] = [
  'project.registered',
  'project.refreshed',
  'project.deleted',
  'project.relinked',
  'project.monitor.updated',
  'project.init.updated',
];

const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';
const SLACK_CONVERSATIONS_HISTORY_URL = 'https://slack.com/api/conversations.history';
const DEFAULT_SLACK_TIMEOUT_MS = 5_000;
const DEFAULT_SLACK_STATUS_INTERVAL_MS = 60_000;
const DEFAULT_SLACK_STATUS_IMMEDIATE_MIN_INTERVAL_MS = 5_000;
const DEFAULT_SLACK_COMMAND_POLL_INTERVAL_MS = 5_000;
const DEFAULT_SLACK_COMMAND_PREFIX = 'gsd';

export type SlackBlock =
  | {
      type: 'header';
      text: {
        type: 'plain_text';
        text: string;
        emoji?: boolean;
      };
    }
  | {
      type: 'section';
      text?: {
        type: 'mrkdwn';
        text: string;
      };
      fields?: Array<{
        type: 'mrkdwn';
        text: string;
      }>;
    }
  | {
      type: 'context';
      elements: Array<{
        type: 'mrkdwn';
        text: string;
      }>;
    }
  | {
      type: 'divider';
    };

export interface SlackAttachment {
  color: string;
  blocks: SlackBlock[];
}

export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
  attachments?: SlackAttachment[];
  threadKey?: string;
}

export interface SlackNotifierConfig {
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
  signingSecret?: string;
  publicBaseUrl?: string;
  eventTypes: readonly ProjectEventType[];
  timeoutMs: number;
  statusReportEnabled?: boolean;
  statusIntervalMs?: number;
  statusImmediateMinIntervalMs?: number;
  commandPollingEnabled?: boolean;
  commandPollIntervalMs?: number;
  commandPrefix?: string;
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
  signingSecret?: string;
  events?: readonly ProjectEventType[];
  timeoutMs?: number;
  statusReportEnabled?: boolean;
  statusIntervalMs?: number;
  statusImmediateMinIntervalMs?: number;
  commandPollingEnabled?: boolean;
  commandPollIntervalMs?: number;
  commandPrefix?: string;
}

export interface SlackCommandConfig {
  signingSecret: string;
  publicBaseUrl?: string;
}

export interface SlackCommandPayload {
  command: string;
  text: string;
  userId: string | null;
  channelId: string | null;
  responseUrl: string | null;
}

export interface SlackCommandResponse {
  response_type: 'ephemeral' | 'in_channel';
  text: string;
  blocks?: SlackBlock[];
}

export interface SlackPolledCommandMessage {
  ts: string;
  text: string;
  userId: string | null;
}

export interface GsdWebProjectMetrics {
  projectId: string;
  label: string;
  registeredPath: string;
  canonicalPath: string;
  detailUrl: string | null;
  snapshotStatus: ProjectSnapshotStatus;
  monitorHealth: ProjectRecord['monitor']['health'];
  currentStage: string;
  progressPercent: number;
  completedTasks: number;
  totalTasks: number;
  remainingTasks: number;
  estimatedRemainingMs: number | null;
  estimatedFinish: string;
  cost: number;
  totalTokens: number;
  warningCount: number;
  warnings: ProjectRecord['snapshot']['warnings'];
  sourceStates: Record<string, string>;
  monitorLastError: ProjectRecord['monitor']['lastError'];
  latestInitJob: ProjectRecord['latestInitJob'];
  metricsAvailable: boolean;
  gsdDbAvailable: boolean;
  threadKey: string;
  dataLocation: ProjectRecord['dataLocation'];
  updatedAt: string;
}

export interface GsdWebMetricsSnapshot {
  generatedAt: string;
  portfolio: {
    projectCount: number;
    unhealthyCount: number;
    warningCount: number;
    totalCost: number;
    totalTokens: number;
    completedTasks: number;
    totalTasks: number;
    remainingTasks: number;
  };
  projects: GsdWebProjectMetrics[];
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

function resolveSlackStatusIntervalMs(env: NodeJS.ProcessEnv, fileValue?: number) {
  const rawValue = readTrimmedEnv(env, 'GSD_WEB_SLACK_STATUS_INTERVAL_MS');

  if (rawValue === undefined) {
    if (fileValue !== undefined && (!Number.isInteger(fileValue) || fileValue <= 0)) {
      throw new Error('Slack statusIntervalMs must be a positive integer.');
    }

    return fileValue ?? DEFAULT_SLACK_STATUS_INTERVAL_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('GSD_WEB_SLACK_STATUS_INTERVAL_MS must be a positive integer.');
  }

  return parsed;
}

function resolveSlackStatusImmediateMinIntervalMs(env: NodeJS.ProcessEnv, fileValue?: number) {
  const rawValue = readTrimmedEnv(env, 'GSD_WEB_SLACK_STATUS_IMMEDIATE_MIN_INTERVAL_MS');

  if (rawValue === undefined) {
    if (fileValue !== undefined && (!Number.isInteger(fileValue) || fileValue < 0)) {
      throw new Error('Slack statusImmediateMinIntervalMs must be a non-negative integer.');
    }

    return fileValue ?? DEFAULT_SLACK_STATUS_IMMEDIATE_MIN_INTERVAL_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('GSD_WEB_SLACK_STATUS_IMMEDIATE_MIN_INTERVAL_MS must be a non-negative integer.');
  }

  return parsed;
}

function resolveSlackCommandPollIntervalMs(env: NodeJS.ProcessEnv, fileValue?: number) {
  const rawValue = readTrimmedEnv(env, 'GSD_WEB_SLACK_COMMAND_POLL_INTERVAL_MS');

  if (rawValue === undefined) {
    if (fileValue !== undefined && (!Number.isInteger(fileValue) || fileValue <= 0)) {
      throw new Error('Slack commandPollIntervalMs must be a positive integer.');
    }

    return fileValue ?? DEFAULT_SLACK_COMMAND_POLL_INTERVAL_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('GSD_WEB_SLACK_COMMAND_POLL_INTERVAL_MS must be a positive integer.');
  }

  return parsed;
}

function resolveSlackCommandPrefix(env: NodeJS.ProcessEnv, fileValue?: string) {
  const value = readTrimmedEnv(env, 'GSD_WEB_SLACK_COMMAND_PREFIX') ?? normalizeOptionalConfigString(fileValue);

  return value ?? DEFAULT_SLACK_COMMAND_PREFIX;
}

function resolveOptionalEnvBoolean(env: NodeJS.ProcessEnv, name: string) {
  const value = readTrimmedEnv(env, name)?.toLowerCase();

  if (value === undefined) {
    return undefined;
  }

  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }

  throw new Error(`${name} must be a boolean value.`);
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
  const signingSecret =
    readTrimmedEnv(env, 'GSD_WEB_SLACK_SIGNING_SECRET') ?? normalizeOptionalConfigString(fileConfig?.signingSecret);
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
  const statusReportEnabled =
    resolveOptionalEnvBoolean(env, 'GSD_WEB_SLACK_STATUS_REPORT')
    ?? fileConfig?.statusReportEnabled
    ?? false;
  const statusIntervalMs = resolveSlackStatusIntervalMs(env, fileConfig?.statusIntervalMs);
  const statusImmediateMinIntervalMs = resolveSlackStatusImmediateMinIntervalMs(
    env,
    fileConfig?.statusImmediateMinIntervalMs,
  );
  const commandPollingEnabled =
    resolveOptionalEnvBoolean(env, 'GSD_WEB_SLACK_COMMAND_POLLING')
    ?? fileConfig?.commandPollingEnabled
    ?? false;
  const commandPollIntervalMs = resolveSlackCommandPollIntervalMs(env, fileConfig?.commandPollIntervalMs);
  const commandPrefix = resolveSlackCommandPrefix(env, fileConfig?.commandPrefix);

  if (fileConfig?.enabled === false && webhookUrl === undefined && botToken === undefined && channelId === undefined) {
    return null;
  }

  if (webhookUrl === undefined && botToken === undefined && channelId === undefined) {
    return null;
  }

  if (webhookUrl !== undefined) {
    return {
      webhookUrl,
      ...(signingSecret === undefined ? {} : { signingSecret }),
      ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
      eventTypes,
      timeoutMs,
      statusReportEnabled,
      statusIntervalMs,
      statusImmediateMinIntervalMs,
      commandPollingEnabled,
      commandPollIntervalMs,
      commandPrefix,
    };
  }

  if (botToken === undefined || channelId === undefined) {
    throw new Error('Slack bot notifications require both GSD_WEB_SLACK_BOT_TOKEN and GSD_WEB_SLACK_CHANNEL_ID.');
  }

  return {
    botToken,
    channelId,
    ...(signingSecret === undefined ? {} : { signingSecret }),
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    eventTypes,
    timeoutMs,
    statusReportEnabled,
    statusIntervalMs,
    statusImmediateMinIntervalMs,
    commandPollingEnabled,
    commandPollIntervalMs,
    commandPrefix,
  };
}

function payloadRecord(event: ProjectEventEnvelope) {
  return asRecord(event.payload);
}

export function shouldSendImmediateStatusReport(event: ProjectEventEnvelope) {
  const payload = payloadRecord(event);

  switch (event.type) {
    case 'project.registered':
    case 'project.deleted':
    case 'project.relinked':
      return true;
    case 'project.refreshed':
      return payload.changed === true || Number(payload.warningCount ?? 0) > 0;
    case 'project.monitor.updated': {
      const monitor = payload.monitor && typeof payload.monitor === 'object'
        ? payload.monitor as { health?: unknown }
        : null;
      const previousHealth = typeof payload.previousHealth === 'string' ? payload.previousHealth : null;
      const nextHealth = typeof monitor?.health === 'string' ? monitor.health : null;

      return previousHealth !== nextHealth || nextHealth !== 'healthy';
    }
    case 'project.init.updated': {
      const job = payload.job && typeof payload.job === 'object'
        ? payload.job as { stage?: unknown }
        : null;
      const stage = typeof job?.stage === 'string' ? job.stage : null;

      return stage === 'succeeded' || stage === 'failed' || stage === 'timed_out' || stage === 'cancelled';
    }
    default:
      return false;
  }
}

export function resolveSlackCommandConfig(
  env: NodeJS.ProcessEnv = process.env,
  fileConfig: SlackNotifierFileConfig | null = null,
  publicBaseUrlFromFile?: string,
): SlackCommandConfig | null {
  const signingSecret =
    readTrimmedEnv(env, 'GSD_WEB_SLACK_SIGNING_SECRET') ?? normalizeOptionalConfigString(fileConfig?.signingSecret);
  const publicBaseUrl = readTrimmedEnv(env, 'GSD_WEB_PUBLIC_URL') ?? normalizeOptionalConfigString(publicBaseUrlFromFile);

  if (signingSecret === undefined) {
    return null;
  }

  return {
    signingSecret,
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
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

function escapeSlackText(value: string) {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function compactText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/gu, ' ').trim();

  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...` : normalized;
}

function formatStatusLabel(value: string) {
  return value.replace(/_/gu, ' ');
}

function formatAttentionLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function withSlackColor(message: Omit<SlackMessage, 'attachments'>, color: string): SlackMessage {
  return {
    ...message,
    attachments: [
      {
        color,
        blocks: message.blocks,
      },
    ],
  };
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

function eventProjectId(event: ProjectEventEnvelope) {
  return event.projectId ?? pickString(asRecord(event.payload), 'projectId');
}

function buildProjectDetailUrl(publicBaseUrl: string | undefined, projectId: string) {
  const baseUrl = normalizeBaseUrl(publicBaseUrl);

  return baseUrl ? `${baseUrl}/lazy/employee-${encodeURIComponent(projectId)}` : null;
}

function slackEventColor(event: ProjectEventEnvelope) {
  const payload = asRecord(event.payload);
  const warningCount = pickNumber(payload, 'warningCount') ?? 0;
  const monitor = payload.monitor && typeof payload.monitor === 'object'
    ? payload.monitor as Record<string, unknown>
    : null;
  const monitorHealth = monitor ? pickString(monitor, 'health') : null;
  const job = payload.job && typeof payload.job === 'object' ? payload.job as Record<string, unknown> : null;
  const jobStage = job ? pickString(job, 'stage') : null;

  if (event.type === 'project.deleted' || jobStage === 'failed' || jobStage === 'timed_out' || monitorHealth === 'read_failed') {
    return '#d92d20';
  }

  if (warningCount > 0 || monitorHealth === 'degraded' || monitorHealth === 'stale' || jobStage === 'cancelled') {
    return '#f79009';
  }

  if (event.type === 'project.registered' || event.type === 'project.relinked' || jobStage === 'succeeded') {
    return '#12b76a';
  }

  if (event.type === 'project.init.updated') {
    return '#7a5af8';
  }

  return '#2e90fa';
}

function buildEventDetailLines(event: ProjectEventEnvelope) {
  const payload = asRecord(event.payload);
  const lines: string[] = [];
  const snapshotStatus = pickString(payload, 'snapshotStatus');
  const warningCount = pickNumber(payload, 'warningCount');
  const monitor = payload.monitor && typeof payload.monitor === 'object'
    ? payload.monitor as Record<string, unknown>
    : null;
  const monitorHealth = monitor ? pickString(monitor, 'health') : null;
  const job = payload.job && typeof payload.job === 'object' ? payload.job as Record<string, unknown> : null;
  const jobStage = job ? pickString(job, 'stage') : null;

  if (snapshotStatus) {
    lines.push(`Snapshot ${formatStatusLabel(snapshotStatus)}`);
  }

  if (monitorHealth) {
    lines.push(`Monitor ${formatStatusLabel(monitorHealth)}`);
  }

  if (jobStage) {
    lines.push(`Init ${formatStatusLabel(jobStage)}`);
  }

  if (warningCount !== null) {
    lines.push(formatAttentionLabel(warningCount, 'warning'));
  }

  return lines;
}

function buildEventMetaLines(event: ProjectEventEnvelope) {
  const trigger = pickString(asRecord(event.payload), 'trigger');

  return [
    event.type,
    event.emittedAt,
    ...(trigger ? [`trigger ${trigger}`] : []),
  ];
}

function buildEventFallbackLines(event: ProjectEventEnvelope) {
  return buildEventDetailLines(event)
    .map((line) => {
      if (line.startsWith('Snapshot ')) {
        return line.replace(/^Snapshot /u, 'Snapshot: ');
      }

      if (line.startsWith('Monitor ')) {
        return line.replace(/^Monitor /u, 'Monitor: ');
      }

      if (line.startsWith('Init ')) {
        return line.replace(/^Init /u, 'Init: ');
      }

      if (/^\d+ warnings?$/u.test(line)) {
        return `Warnings: ${line.split(' ', 1)[0]}`;
      }

      return line;
    });
}

export function buildSlackMessage(event: ProjectEventEnvelope, publicBaseUrl?: string) {
  const title = formatEventTitle(event);
  const projectUrl = buildProjectUrl(publicBaseUrl, event);
  const projectId = eventProjectId(event);
  const detailLines = buildEventDetailLines(event);
  const detailText = detailLines.length > 0 ? detailLines.join(' · ') : 'Project event received.';
  const titleText = projectUrl ? `<${projectUrl}|${escapeSlackText(title)}>` : escapeSlackText(title);
  const text = `${title}\n${buildEventFallbackLines(event).join('\n')}`;

  return withSlackColor({
    text,
    ...(projectId ? { threadKey: `project:${projectId}` } : {}),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${titleText}*\n${escapeSlackText(detailText)}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: escapeSlackText(buildEventMetaLines(event).join(' · ')),
          },
        ],
      },
    ],
  } satisfies Omit<SlackMessage, 'attachments'>, slackEventColor(event));
}

function buildMobileSummaryBlock(title: string, lines: string[]) {
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [`*${escapeSlackText(title)}*`, ...lines.map((line) => escapeSlackText(line))].join('\n'),
    },
  } satisfies SlackBlock;
}

function buildLinkedTitle(url: string | null, label: string) {
  return url ? `<${url}|${escapeSlackText(label)}>` : escapeSlackText(label);
}

function buildSlackProgressLine(progressPercent: number) {
  return `Progress ${Math.round(progressPercent)}%`;
}

function buildProjectStatusLines(summary: ReturnType<typeof summarizeProjectStatus>) {
  return [
    buildSlackProgressLine(summary.progressPercent),
    `Current ${formatStatusLabel(compactText(summary.currentStage, 80))}`,
    `Estimated finish ${summary.eta}`,
    `Health ${formatStatusLabel(summary.health)} · Snapshot ${formatStatusLabel(summary.snapshotStatus)}`,
    `Tasks ${summary.completedTasks}/${summary.totalTasks || 'unknown'}`,
    `Cost ${formatUsd(summary.cost)} · Warnings ${summary.warningCount}`,
  ];
}

function slackStatusColor(summary: ReturnType<typeof summarizeProjectStatus>, warningCount: number) {
  if (summary.health === 'read_failed' || summary.snapshotStatus === 'degraded') {
    return '#d92d20';
  }

  if (summary.health === 'degraded' || summary.health === 'stale' || warningCount > 0) {
    return '#f79009';
  }

  if (summary.remainingTasks === 0) {
    return '#12b76a';
  }

  return '#2e90fa';
}

function buildCommandBlocksFromText(title: string, body: string) {
  const bodyLines = body.split('\n').filter((line) => line.trim().length > 0);

  return [
    buildMobileSummaryBlock(title, bodyLines.slice(0, 12)),
  ];
}

function buildProjectDetailBlocks(project: ProjectRecord, publicBaseUrl?: string) {
  const name = projectDisplayName(project);
  const detailUrl = buildProjectDetailUrl(publicBaseUrl, project.projectId);
  const title = buildLinkedTitle(detailUrl, name);
  const lines = [
    `Project ${project.projectId}`,
    `Snapshot ${formatStatusLabel(project.snapshot.status)} · Monitor ${formatStatusLabel(project.monitor.health)}`,
    `Warnings ${project.snapshot.warnings.length}`,
    `Path ${project.canonicalPath}`,
    project.latestInitJob
      ? `Init ${formatStatusLabel(project.latestInitJob.stage)} · ${project.latestInitJob.updatedAt}`
      : 'Init no job',
    ...(project.monitor.lastError ? [`Monitor error ${compactText(project.monitor.lastError.message, 180)}`] : []),
  ];
  const warningLines = project.snapshot.warnings
    .slice(0, 3)
    .map((warning) => `${warning.source}: ${compactText(warning.message, 160)}`);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${title}*\n${lines.map((line) => escapeSlackText(line)).join('\n')}`,
      },
    },
    ...(warningLines.length > 0 ? [buildMobileSummaryBlock('Warnings', warningLines)] : []),
  ] satisfies SlackBlock[];
}

function buildProjectsSummaryBlocks(projects: ProjectRecord[], publicBaseUrl?: string) {
  if (projects.length === 0) {
    return [
      buildMobileSummaryBlock('GSD Projects', ['No projects are registered in gsd-web yet.']),
    ];
  }

  const initialized = projects.filter((project) => project.snapshot.status === 'initialized').length;
  const degraded = projects.filter((project) => project.snapshot.status === 'degraded').length;
  const uninitialized = projects.filter((project) => project.snapshot.status === 'uninitialized').length;
  const unhealthy = projects.filter((project) => project.monitor.health !== 'healthy').length;
  const projectLines = projects.slice(0, 6).map((project) => {
    const name = projectDisplayName(project);
    const detailUrl = buildProjectDetailUrl(publicBaseUrl, project.projectId);
    const label = buildLinkedTitle(detailUrl, name);
    const initStage = project.latestInitJob ? ` · init ${formatStatusLabel(project.latestInitJob.stage)}` : '';

    return `${label}: ${formatStatusLabel(project.snapshot.status)} · ${formatStatusLabel(project.monitor.health)} · ${formatAttentionLabel(project.snapshot.warnings.length, 'warning')}${initStage}`;
  });

  if (projects.length > projectLines.length) {
    projectLines.push(`...and ${projects.length - projectLines.length} more`);
  }

  return [
    buildMobileSummaryBlock('GSD Projects', [
      `${projects.length} total · ${initialized} initialized · ${degraded} degraded · ${uninitialized} uninitialized`,
      `Monitor attention ${unhealthy}`,
    ]),
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: projectLines.join('\n'),
      },
    },
  ] satisfies SlackBlock[];
}

function formatMetricsProjectLine(project: GsdWebProjectMetrics) {
  const label = project.detailUrl ? `<${project.detailUrl}|${project.label}>` : project.label;

  return `${label}: ${project.progressPercent}% · ${formatStatusLabel(project.monitorHealth)} · ETA ${project.estimatedFinish} · ${formatUsd(project.cost)}`;
}

function formatMetricsSummary(snapshot: GsdWebMetricsSnapshot) {
  if (snapshot.projects.length === 0) {
    return 'No projects are registered in gsd-web yet.';
  }

  return [
    `GSD projects: ${snapshot.portfolio.projectCount} total, ${snapshot.portfolio.remainingTasks} remaining tasks.`,
    `Attention: ${snapshot.portfolio.unhealthyCount} unhealthy, ${snapshot.portfolio.warningCount} warnings.`,
    `Cost: ${formatUsd(snapshot.portfolio.totalCost)}, tokens: ${formatCompactInteger(snapshot.portfolio.totalTokens)}.`,
    '',
    ...snapshot.projects.slice(0, 8).map(formatMetricsProjectLine),
    ...(snapshot.projects.length > 8 ? [`...and ${snapshot.projects.length - 8} more`] : []),
  ].join('\n');
}

function buildMetricsSummaryBlocks(snapshot: GsdWebMetricsSnapshot) {
  if (snapshot.projects.length === 0) {
    return [
      buildMobileSummaryBlock('GSD Projects', ['No projects are registered in gsd-web yet.']),
    ];
  }

  return [
    buildMobileSummaryBlock('GSD Projects', [
      `${snapshot.portfolio.projectCount} total · ${snapshot.portfolio.remainingTasks} remaining tasks`,
      `${formatAttentionLabel(snapshot.portfolio.unhealthyCount, 'unhealthy project')} · ${formatAttentionLabel(snapshot.portfolio.warningCount, 'warning')}`,
      `${formatUsd(snapshot.portfolio.totalCost)} · ${formatCompactInteger(snapshot.portfolio.totalTokens)} tokens`,
    ]),
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: snapshot.projects.slice(0, 8).map(formatMetricsProjectLine).join('\n'),
      },
    },
  ] satisfies SlackBlock[];
}

function formatProjectMetricsDetail(project: GsdWebProjectMetrics) {
  const title = project.detailUrl ? `<${project.detailUrl}|${project.label}>` : project.label;
  const warningLines = project.warnings.slice(0, 5).map((warning) => `${warning.source}: ${warning.message}`);

  return [
    `*${title}*`,
    `Project: ${project.projectId}`,
    `Progress: ${project.progressPercent}%`,
    `Current: ${project.currentStage}`,
    `Estimated finish: ${project.estimatedFinish}`,
    `Tasks: ${project.completedTasks}/${project.totalTasks || 'unknown'} (${project.remainingTasks} remaining)`,
    `Health: ${project.monitorHealth}`,
    `Snapshot: ${project.snapshotStatus}`,
    `Cost: ${formatUsd(project.cost)}`,
    `Tokens: ${formatCompactInteger(project.totalTokens)}`,
    `Warnings: ${project.warningCount}`,
    `Path: ${project.canonicalPath}`,
    ...(warningLines.length > 0 ? ['', '*Warnings*', ...warningLines] : []),
  ].join('\n');
}

function buildProjectMetricsDetailBlocks(project: GsdWebProjectMetrics) {
  const title = project.detailUrl ? `<${project.detailUrl}|${escapeSlackText(project.label)}>` : escapeSlackText(project.label);
  const warningLines = project.warnings.slice(0, 3).map((warning) => `${warning.source}: ${compactText(warning.message, 160)}`);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${title}*`,
          ...[
            `Progress ${project.progressPercent}% · ETA ${project.estimatedFinish}`,
            `Current ${project.currentStage}`,
            `Tasks ${project.completedTasks}/${project.totalTasks || 'unknown'} · ${project.remainingTasks} remaining`,
            `Health ${formatStatusLabel(project.monitorHealth)} · Snapshot ${formatStatusLabel(project.snapshotStatus)}`,
            `Cost ${formatUsd(project.cost)} · ${formatCompactInteger(project.totalTokens)} tokens`,
            `Warnings ${project.warningCount}`,
          ].map((line) => escapeSlackText(line)),
        ].join('\n'),
      },
    },
    ...(warningLines.length > 0 ? [buildMobileSummaryBlock('Warnings', warningLines)] : []),
  ] satisfies SlackBlock[];
}

function formatUsd(value: number) {
  if (!Number.isFinite(value)) {
    return '$0.00';
  }

  return `$${value.toFixed(value >= 10 ? 2 : 4).replace(/0+$/u, '').replace(/\.$/u, '')}`;
}

function formatCompactInteger(value: number) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '0';
}

function formatDuration(ms: number | null) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return 'unknown';
  }

  if (ms < 60_000) {
    return '<1m';
  }

  const minutes = Math.round(ms / 60_000);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 48) {
    return `${hours}h`;
  }

  return `${Math.round(hours / 24)}d`;
}

function formatEta(ms: number | null, nowMs: number) {
  if (ms === null) {
    return 'unknown';
  }

  if (ms <= 0) {
    return 'done';
  }

  return `${new Date(nowMs + ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })} (${formatDuration(ms)})`;
}

type ExecutionUnitView = {
  key: string;
  type: string | null;
  id: string | null;
  model: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  durationMs: number | null;
  totalTokens: number;
  cost: number;
  toolCalls: number;
  apiRequests: number;
  milestoneId: string | null;
  sliceId: string | null;
  taskId: string | null;
};

type ExecutionAggregate = {
  unitCount: number;
  totalDurationMs: number;
  firstStartedAtMs: number | null;
  lastFinishedAtMs: number | null;
};

type SlackWorkflowStats = {
  elapsedMs: number | null;
  totalTasks: number;
  completedTasks: number;
  remainingTasks: number;
  estimatedRemainingMs: number | null;
};

function normalizeMetricTimestamp(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value < 10_000_000_000 ? value * 1000 : value;
}

function normalizeWorkflowTimestamp(value: string | number | null) {
  if (value === null) {
    return null;
  }

  if (typeof value === 'number') {
    return normalizeMetricTimestamp(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return normalizeMetricTimestamp(parsed);
    }

    const parsedDate = Date.parse(value);

    return Number.isFinite(parsedDate) ? parsedDate : null;
  }

  return null;
}

function isWorkflowComplete(status: string | null | undefined) {
  return /^(complete|completed|done|succeeded|success)$/iu.test(status?.trim() ?? '');
}

function isWorkflowActive(status: string | null | undefined) {
  return /^(active|running|executing|in_progress|in-progress|current)$/iu.test(status?.trim() ?? '');
}

function workflowTaskKey(milestoneId: string, sliceId: string, taskId: string) {
  return `${milestoneId}/${sliceId}/${taskId}`;
}

function workflowSliceKey(milestoneId: string, sliceId: string) {
  return `${milestoneId}/${sliceId}`;
}

function getWorkflowEntityDurationMs(entity: {
  startedAt: string | number | null;
  finishedAt: string | number | null;
}) {
  const startedAtMs = normalizeWorkflowTimestamp(entity.startedAt);
  const finishedAtMs = normalizeWorkflowTimestamp(entity.finishedAt);

  return startedAtMs !== null && finishedAtMs !== null && finishedAtMs >= startedAtMs
    ? finishedAtMs - startedAtMs
    : null;
}

function averageNumbers(values: number[]) {
  const usableValues = values.filter((value) => Number.isFinite(value) && value > 0);

  return usableValues.length === 0
    ? null
    : usableValues.reduce((total, value) => total + value, 0) / usableValues.length;
}

function parseUnitIdentity(id: string | null) {
  const parts = id?.split(/[/:>\s]+/u).filter(Boolean) ?? [];
  const findId = (pattern: RegExp) => {
    const match = parts.find((part) => pattern.test(part));

    return match ? match.toUpperCase() : null;
  };

  return {
    milestoneId: findId(/^m\d+/iu),
    sliceId: findId(/^s\d+/iu),
    taskId: findId(/^t\d+/iu),
  };
}

function toExecutionUnit(unit: GsdMetricsSummaryValue['recentUnits'][number], index: number): ExecutionUnitView {
  const startedAtMs = normalizeMetricTimestamp(unit.startedAt);
  const finishedAtMs = normalizeMetricTimestamp(unit.finishedAt);
  const durationMs =
    startedAtMs !== null && finishedAtMs !== null && finishedAtMs >= startedAtMs
      ? finishedAtMs - startedAtMs
      : null;
  const identity = parseUnitIdentity(unit.id);

  return {
    key: `${unit.id ?? 'unit'}-${index}`,
    type: unit.type,
    id: unit.id,
    model: unit.model,
    startedAtMs,
    finishedAtMs,
    durationMs,
    totalTokens: unit.totalTokens,
    cost: unit.cost,
    toolCalls: unit.toolCalls,
    apiRequests: unit.apiRequests,
    ...identity,
  };
}

function createAggregate(): ExecutionAggregate {
  return {
    unitCount: 0,
    totalDurationMs: 0,
    firstStartedAtMs: null,
    lastFinishedAtMs: null,
  };
}

function addUnitToAggregate(aggregate: ExecutionAggregate, unit: ExecutionUnitView) {
  aggregate.unitCount += 1;

  if (unit.durationMs !== null) {
    aggregate.totalDurationMs += unit.durationMs;
  }

  if (unit.startedAtMs !== null) {
    aggregate.firstStartedAtMs =
      aggregate.firstStartedAtMs === null
        ? unit.startedAtMs
        : Math.min(aggregate.firstStartedAtMs, unit.startedAtMs);
  }

  if (unit.finishedAtMs !== null) {
    aggregate.lastFinishedAtMs =
      aggregate.lastFinishedAtMs === null
        ? unit.finishedAtMs
        : Math.max(aggregate.lastFinishedAtMs, unit.finishedAtMs);
  }
}

function addUnitToAggregateMap(map: Map<string, ExecutionAggregate>, key: string | null, unit: ExecutionUnitView) {
  if (!key) {
    return;
  }

  const aggregate = map.get(key) ?? createAggregate();

  addUnitToAggregate(aggregate, unit);
  map.set(key, aggregate);
}

function averageDuration(units: ExecutionUnitView[]) {
  return averageNumbers(units
    .map((unit) => unit.durationMs)
    .filter((duration): duration is number => duration !== null && duration > 0));
}

function getAggregateDuration(aggregate: ExecutionAggregate | undefined) {
  return aggregate && aggregate.totalDurationMs > 0 ? aggregate.totalDurationMs : null;
}

function getObservedSliceDurationMs(
  milestoneId: string,
  slice: GsdDbSliceSummary,
  sliceStats: Map<string, ExecutionAggregate>,
) {
  return getAggregateDuration(sliceStats.get(workflowSliceKey(milestoneId, slice.id)))
    ?? getWorkflowEntityDurationMs(slice);
}

function getObservedTaskDurationMs(
  milestoneId: string,
  sliceId: string,
  task: GsdDbTaskSummary,
  taskStats: Map<string, ExecutionAggregate>,
) {
  return getAggregateDuration(taskStats.get(workflowTaskKey(milestoneId, sliceId, task.id)))
    ?? getWorkflowEntityDurationMs(task);
}

function collectSliceDurationSamples(
  milestones: GsdDbMilestoneSummary[],
  sliceStats: Map<string, ExecutionAggregate>,
) {
  const completedDurations: number[] = [];
  const observedDurations: number[] = [];

  for (const milestone of milestones) {
    for (const slice of milestone.slices) {
      const duration = getObservedSliceDurationMs(milestone.id, slice, sliceStats);

      if (duration === null || duration <= 0) {
        continue;
      }

      observedDurations.push(duration);

      if (isWorkflowComplete(slice.status)) {
        completedDurations.push(duration);
      }
    }
  }

  return completedDurations.length > 0 ? completedDurations : observedDurations;
}

function collectTaskDurationSamples(
  milestones: GsdDbMilestoneSummary[],
  taskStats: Map<string, ExecutionAggregate>,
) {
  const completedDurations: number[] = [];
  const observedDurations: number[] = [];
  const inferredCompletedDurations: number[] = [];
  const inferredObservedDurations: number[] = [];
  const addInferredTaskDuration = (target: number[], durationMs: number | null, taskCount: number) => {
    if (durationMs !== null && durationMs > 0 && taskCount > 0) {
      target.push(durationMs / taskCount);
    }
  };

  for (const milestone of milestones) {
    for (const slice of milestone.slices) {
      for (const task of slice.tasks) {
        const duration = getObservedTaskDurationMs(milestone.id, slice.id, task, taskStats);

        if (duration === null || duration <= 0) {
          continue;
        }

        observedDurations.push(duration);

        if (isWorkflowComplete(task.status)) {
          completedDurations.push(duration);
        }
      }

      const sliceDuration = getWorkflowEntityDurationMs(slice);
      const inferredSliceTaskCount = slice.completedTaskCount > 0 ? slice.completedTaskCount : slice.taskCount;

      addInferredTaskDuration(
        isWorkflowComplete(slice.status) ? inferredCompletedDurations : inferredObservedDurations,
        sliceDuration,
        inferredSliceTaskCount,
      );
    }

    const milestoneDuration = getWorkflowEntityDurationMs(milestone);
    const inferredMilestoneTaskCount = milestone.completedTaskCount > 0
      ? milestone.completedTaskCount
      : milestone.taskCount;

    addInferredTaskDuration(
      isWorkflowComplete(milestone.status) ? inferredCompletedDurations : inferredObservedDurations,
      milestoneDuration,
      inferredMilestoneTaskCount,
    );
  }

  if (completedDurations.length > 0) {
    return completedDurations;
  }

  if (observedDurations.length > 0) {
    return observedDurations;
  }

  return inferredCompletedDurations.length > 0 ? inferredCompletedDurations : inferredObservedDurations;
}

function estimateTaskRemainingDuration(
  task: GsdDbTaskSummary,
  observedDurationMs: number | null,
  averageTaskDurationMs: number | null,
  nowMs: number,
) {
  if (isWorkflowComplete(task.status)) {
    return 0;
  }

  if (averageTaskDurationMs === null) {
    return null;
  }

  const startedAtMs = normalizeWorkflowTimestamp(task.startedAt);
  const elapsedActiveMs =
    observedDurationMs === null
    && isWorkflowActive(task.status)
    && startedAtMs !== null
    && nowMs >= startedAtMs
      ? nowMs - startedAtMs
      : null;

  return Math.max(0, averageTaskDurationMs - (observedDurationMs ?? elapsedActiveMs ?? 0));
}

function estimateSliceRemainingDuration(
  slice: GsdDbSliceSummary,
  observedDurationMs: number | null,
  averageSliceDurationMs: number | null,
  nowMs: number,
) {
  if (isWorkflowComplete(slice.status)) {
    return 0;
  }

  if (averageSliceDurationMs === null) {
    return null;
  }

  const startedAtMs = normalizeWorkflowTimestamp(slice.startedAt);
  const elapsedActiveMs =
    observedDurationMs === null
    && isWorkflowActive(slice.status)
    && startedAtMs !== null
    && nowMs >= startedAtMs
      ? nowMs - startedAtMs
      : null;

  return Math.max(0, averageSliceDurationMs - (observedDurationMs ?? elapsedActiveMs ?? 0));
}

function addNullableDuration(first: number | null, second: number | null) {
  return first === null || second === null ? null : first + second;
}

function buildTotalEstimatedRemainingMs(
  milestones: GsdDbMilestoneSummary[],
  sliceStats: Map<string, ExecutionAggregate>,
  taskStats: Map<string, ExecutionAggregate>,
  averageTaskDurationMs: number | null,
  averageSliceDurationMs: number | null,
  nowMs: number,
) {
  let totalEstimatedRemainingMs: number | null = 0;

  for (const milestone of milestones) {
    let milestoneRemainingMs: number | null = 0;

    for (const slice of milestone.slices) {
      let sliceRemainingMs: number | null = 0;

      if (slice.tasks.length === 0) {
        sliceRemainingMs = estimateSliceRemainingDuration(
          slice,
          getObservedSliceDurationMs(milestone.id, slice, sliceStats),
          averageSliceDurationMs,
          nowMs,
        );
      } else {
        for (const task of slice.tasks) {
          const taskRemainingMs = estimateTaskRemainingDuration(
            task,
            getObservedTaskDurationMs(milestone.id, slice.id, task, taskStats),
            averageTaskDurationMs,
            nowMs,
          );

          sliceRemainingMs = addNullableDuration(sliceRemainingMs, taskRemainingMs);
        }
      }

      milestoneRemainingMs = addNullableDuration(milestoneRemainingMs, sliceRemainingMs);
    }

    totalEstimatedRemainingMs = addNullableDuration(totalEstimatedRemainingMs, milestoneRemainingMs);
  }

  return totalEstimatedRemainingMs;
}

function getCompletedTaskCount(milestones: GsdDbMilestoneSummary[]) {
  return milestones.reduce((total, milestone) => total + milestone.completedTaskCount, 0);
}

function getRemainingWorkflowUnitCount(milestones: GsdDbMilestoneSummary[]) {
  return milestones.reduce(
    (milestoneTotal, milestone) =>
      milestoneTotal
      + milestone.slices.reduce((sliceTotal, slice) => {
        if (isWorkflowComplete(slice.status)) {
          return sliceTotal;
        }

        const remainingMaterializedTasks = slice.tasks.filter((task) => !isWorkflowComplete(task.status)).length;

        return sliceTotal + (slice.tasks.length === 0 ? 1 : remainingMaterializedTasks);
      }, 0),
    0,
  );
}

function buildSlackWorkflowStats(
  milestones: GsdDbMilestoneSummary[],
  metrics: GsdMetricsSummaryValue | null,
  nowMs: number,
): SlackWorkflowStats {
  const units = (metrics?.units ?? metrics?.recentUnits ?? []).map(toExecutionUnit);
  const sliceStats = new Map<string, ExecutionAggregate>();
  const taskStats = new Map<string, ExecutionAggregate>();

  for (const unit of units) {
    addUnitToAggregateMap(
      sliceStats,
      unit.milestoneId && unit.sliceId ? `${unit.milestoneId}/${unit.sliceId}` : null,
      unit,
    );
    addUnitToAggregateMap(
      taskStats,
      unit.milestoneId && unit.sliceId && unit.taskId
        ? `${unit.milestoneId}/${unit.sliceId}/${unit.taskId}`
        : null,
      unit,
    );
  }

  const totalTasks = milestones.reduce((total, milestone) => total + milestone.taskCount, 0);
  const completedTasks = getCompletedTaskCount(milestones);
  const remainingTasks = getRemainingWorkflowUnitCount(milestones);
  const taskUnits = units.filter((unit) => unit.taskId !== null);
  const averageTaskDurationMs =
    averageNumbers(collectTaskDurationSamples(milestones, taskStats))
    ?? averageDuration(taskUnits.length > 0 ? taskUnits : units);
  const averageSliceDurationMs =
    averageNumbers(collectSliceDurationSamples(milestones, sliceStats))
    ?? averageDuration(units.filter((unit) => unit.sliceId !== null));
  const unitDurationsMs = units.reduce(
    (total, unit) => total + (unit.durationMs === null ? 0 : Math.max(0, unit.durationMs)),
    0,
  );
  const entityDurationsMs = milestones.reduce((milestoneTotal, milestone) => {
    const taskDurationMs = milestone.slices.reduce(
      (sliceTotal, slice) =>
        sliceTotal
        + slice.tasks.reduce((taskTotal, task) => taskTotal + (getWorkflowEntityDurationMs(task) ?? 0), 0),
      0,
    );

    if (taskDurationMs > 0) {
      return milestoneTotal + taskDurationMs;
    }

    const sliceDurationMs = milestone.slices.reduce(
      (sliceTotal, slice) => sliceTotal + (getWorkflowEntityDurationMs(slice) ?? 0),
      0,
    );

    return milestoneTotal + (sliceDurationMs > 0 ? sliceDurationMs : getWorkflowEntityDurationMs(milestone) ?? 0);
  }, 0);
  const estimatedRemainingMs = remainingTasks === 0
    ? 0
    : buildTotalEstimatedRemainingMs(
        milestones,
        sliceStats,
        taskStats,
        averageTaskDurationMs,
        averageSliceDurationMs,
        nowMs,
      );

  return {
    elapsedMs: unitDurationsMs > 0 ? unitDurationsMs : entityDurationsMs > 0 ? entityDurationsMs : null,
    totalTasks,
    completedTasks,
    remainingTasks,
    estimatedRemainingMs,
  };
}

function calculateTaskProgressPercent(totalTasks: number, completedTasks: number) {
  if (!Number.isFinite(totalTasks) || totalTasks <= 0) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round((Math.max(0, Math.min(totalTasks, completedTasks)) / totalTasks) * 100)));
}

function calculateTimeProgressPercent(
  totalTasks: number,
  elapsedMs: number | null,
  estimatedRemainingMs: number | null,
) {
  if (!Number.isFinite(totalTasks) || totalTasks <= 0 || estimatedRemainingMs === null || !Number.isFinite(estimatedRemainingMs)) {
    return null;
  }

  const normalizedElapsedMs = elapsedMs === null || !Number.isFinite(elapsedMs) ? 0 : Math.max(0, elapsedMs);
  const normalizedRemainingMs = Math.max(0, estimatedRemainingMs);
  const totalProjectedMs = normalizedElapsedMs + normalizedRemainingMs;

  if (totalProjectedMs === 0) {
    return 100;
  }

  return Math.max(0, Math.min(100, Math.round((normalizedElapsedMs / totalProjectedMs) * 100)));
}

function selectOverviewProgressPercent(input: {
  taskProgressPercent: number | null;
  timeProgressPercent: number | null;
  fallbackPercent: number;
}) {
  if (input.taskProgressPercent !== null && input.timeProgressPercent !== null) {
    return input.timeProgressPercent < input.taskProgressPercent
      ? input.timeProgressPercent
      : input.taskProgressPercent;
  }

  return input.taskProgressPercent
    ?? input.timeProgressPercent
    ?? Math.max(0, Math.min(100, Math.round(input.fallbackPercent)));
}

function compareWorkflowSequenceOrder(
  firstIndex: number,
  secondIndex: number,
  firstStatus: string | null,
  secondStatus: string | null,
) {
  const firstComplete = isWorkflowComplete(firstStatus);
  const secondComplete = isWorkflowComplete(secondStatus);

  if (firstComplete !== secondComplete) {
    return firstComplete ? 1 : -1;
  }

  return firstComplete ? secondIndex - firstIndex : firstIndex - secondIndex;
}

function orderWorkflowMilestones(milestones: GsdDbMilestoneSummary[]) {
  return milestones
    .map((milestone, index) => ({ milestone, index }))
    .sort((first, second) => compareWorkflowSequenceOrder(
      first.index,
      second.index,
      first.milestone.status,
      second.milestone.status,
    ))
    .map((entry) => entry.milestone);
}

function orderWorkflowSlices(slices: GsdDbSliceSummary[]) {
  return slices
    .map((slice, index) => ({ slice, index }))
    .sort((first, second) => compareWorkflowSequenceOrder(
      first.index,
      second.index,
      first.slice.status,
      second.slice.status,
    ))
    .map((entry) => entry.slice);
}

function orderWorkflowTasks(tasks: GsdDbTaskSummary[]) {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((first, second) => compareWorkflowSequenceOrder(
      first.index,
      second.index,
      first.task.status,
      second.task.status,
    ))
    .map((entry) => entry.task);
}

function getCompletedSliceCount(milestone: GsdDbMilestoneSummary) {
  return milestone.slices.filter((slice) => isWorkflowComplete(slice.status)).length;
}

function isMilestoneEffectivelyComplete(milestone: GsdDbMilestoneSummary) {
  if (isWorkflowComplete(milestone.status)) {
    return true;
  }

  if (milestone.sliceCount > 0) {
    return getCompletedSliceCount(milestone) >= milestone.sliceCount;
  }

  return milestone.taskCount > 0 && milestone.completedTaskCount >= milestone.taskCount;
}

function isSliceWorkflowActive(slice: GsdDbSliceSummary) {
  return isWorkflowActive(slice.status) || slice.tasks.some((task) => isWorkflowActive(task.status));
}

function isMilestoneWorkflowActive(milestone: GsdDbMilestoneSummary) {
  return isWorkflowActive(milestone.status) || milestone.slices.some((slice) => isSliceWorkflowActive(slice));
}

function findActiveMilestone(milestones: GsdDbMilestoneSummary[]) {
  return milestones.find((milestone) => isMilestoneWorkflowActive(milestone))
    ?? orderWorkflowMilestones(milestones).find((milestone) => !isMilestoneEffectivelyComplete(milestone))
    ?? null;
}

function findActiveSlice(milestone: GsdDbMilestoneSummary | null) {
  if (!milestone) {
    return null;
  }

  return milestone.slices.find((slice) => isSliceWorkflowActive(slice))
    ?? orderWorkflowSlices(milestone.slices).find((slice) => !isWorkflowComplete(slice.status))
    ?? null;
}

function findActiveTask(slice: GsdDbSliceSummary | null) {
  if (!slice) {
    return null;
  }

  return slice.tasks.find((task) => isWorkflowActive(task.status))
    ?? orderWorkflowTasks(slice.tasks).find((task) => !isWorkflowComplete(task.status))
    ?? null;
}

function hasActiveInitJob(job: ProjectInitJob | null): job is ProjectInitJob {
  return job !== null && !isProjectInitJobTerminalStage(job.stage);
}

function describeCurrentStage(project: ProjectRecord, activeMilestone: GsdDbMilestoneSummary | null) {
  const initJob = project.latestInitJob;

  if (hasActiveInitJob(initJob)) {
    return `Initialization: ${initJob.stage}`;
  }

  const activeSlice = findActiveSlice(activeMilestone);
  const activeTask = findActiveTask(activeSlice);

  if (activeTask && activeSlice && activeMilestone) {
    return `${activeMilestone.id}/${activeSlice.id}/${activeTask.id}`;
  }

  if (activeSlice && activeMilestone) {
    return `${activeMilestone.id}/${activeSlice.id}`;
  }

  if (activeMilestone) {
    return activeMilestone.id;
  }

  return project.snapshot.status;
}

function workflowThreadKey(project: ProjectRecord, activeMilestone: GsdDbMilestoneSummary | null) {
  const activeSlice = findActiveSlice(activeMilestone);

  if (activeMilestone && activeSlice) {
    return `slice:${project.projectId}:${activeMilestone.id}/${activeSlice.id}`;
  }

  if (activeMilestone) {
    return `milestone:${project.projectId}:${activeMilestone.id}`;
  }

  return `project:${project.projectId}`;
}

export function hasRunningProject(project: ProjectRecord) {
  if (hasActiveInitJob(project.latestInitJob)) {
    return true;
  }

  if (isWorkflowActive(project.snapshot.sources.autoLock.value?.status)) {
    return true;
  }

  return findActiveMilestone(project.snapshot.sources.gsdDb.value?.milestones ?? []) !== null;
}

export function hasAnyRunningProject(projects: ProjectRecord[]) {
  return projects.some((project) => hasRunningProject(project));
}

function buildProgressBar(percent: number) {
  const normalized = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round(normalized / 10);

  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${normalized}%`;
}

function summarizeProjectStatus(project: ProjectRecord, nowMs: number) {
  const milestoneSource = project.snapshot.sources.gsdDb.value?.milestones ?? [];
  const activeMilestone = findActiveMilestone(milestoneSource);
  const milestones = orderWorkflowMilestones(milestoneSource);
  const metrics = project.snapshot.sources.metricsJson.value ?? null;
  const workflow = buildSlackWorkflowStats(milestones, metrics, nowMs);
  const taskProgressPercent = calculateTaskProgressPercent(workflow.totalTasks, workflow.completedTasks);
  const timeProgressPercent = calculateTimeProgressPercent(
    workflow.totalTasks,
    workflow.elapsedMs,
    workflow.estimatedRemainingMs,
  );
  const progressPercent = selectOverviewProgressPercent({
    taskProgressPercent,
    timeProgressPercent,
    fallbackPercent: project.snapshot.status === 'initialized' ? 100 : 0,
  });

  return {
    label: projectDisplayName(project),
    progressPercent,
    progressBar: buildProgressBar(progressPercent),
    completedTasks: workflow.completedTasks,
    totalTasks: workflow.totalTasks,
    remainingTasks: workflow.remainingTasks,
    currentStage: describeCurrentStage(project, activeMilestone),
    health: project.monitor.health,
    snapshotStatus: project.snapshot.status,
    warningCount: project.snapshot.warnings.length,
    cost: metrics?.totals.cost ?? 0,
    totalTokens: metrics?.totals.totalTokens ?? 0,
    estimatedRemainingMs: workflow.estimatedRemainingMs,
    eta: formatEta(workflow.estimatedRemainingMs, nowMs),
    threadKey: workflowThreadKey(project, activeMilestone),
  };
}

function compareProjectStatusRows(
  first: { project: ProjectRecord; summary: ReturnType<typeof summarizeProjectStatus> },
  second: { project: ProjectRecord; summary: ReturnType<typeof summarizeProjectStatus> },
) {
  const statusRank: Record<ProjectSnapshotStatus, number> = {
    degraded: 0,
    uninitialized: 1,
    initialized: 2,
  };
  const firstRank = statusRank[first.project.snapshot.status];
  const secondRank = statusRank[second.project.snapshot.status];

  if (firstRank !== secondRank) {
    return firstRank - secondRank;
  }

  return second.summary.cost - first.summary.cost || first.summary.label.localeCompare(second.summary.label);
}

function pickCurrentProject(projects: ProjectRecord[], nowMs: number) {
  const ranked = projects
    .map((project) => ({ project, summary: summarizeProjectStatus(project, nowMs) }))
    .sort(compareProjectStatusRows);

  return ranked[0] ?? null;
}

export function buildGsdWebMetricsSnapshot(
  projects: ProjectRecord[],
  publicBaseUrl?: string,
  nowMs: number = Date.now(),
): GsdWebMetricsSnapshot {
  const ranked = projects
    .map((project) => ({ project, summary: summarizeProjectStatus(project, nowMs) }))
    .sort(compareProjectStatusRows);
  const projectMetrics = ranked.map(({ project, summary }) => ({
    projectId: project.projectId,
    label: summary.label,
    registeredPath: project.registeredPath,
    canonicalPath: project.canonicalPath,
    detailUrl: buildProjectDetailUrl(publicBaseUrl, project.projectId),
    snapshotStatus: summary.snapshotStatus,
    monitorHealth: summary.health,
    currentStage: summary.currentStage,
    progressPercent: Math.round(summary.progressPercent),
    completedTasks: summary.completedTasks,
    totalTasks: summary.totalTasks,
    remainingTasks: summary.remainingTasks,
    estimatedRemainingMs: summary.estimatedRemainingMs,
    estimatedFinish: summary.eta,
    cost: summary.cost,
    totalTokens: summary.totalTokens,
    warningCount: summary.warningCount,
    warnings: project.snapshot.warnings,
    sourceStates: Object.fromEntries(
      Object.entries(project.snapshot.sources).map(([name, source]) => [name, source.state]),
    ),
    monitorLastError: project.monitor.lastError,
    latestInitJob: project.latestInitJob,
    metricsAvailable: project.snapshot.sources.metricsJson.value !== undefined,
    gsdDbAvailable: project.snapshot.sources.gsdDb.value !== undefined,
    threadKey: summary.threadKey,
    dataLocation: project.dataLocation,
    updatedAt: project.updatedAt,
  } satisfies GsdWebProjectMetrics));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    portfolio: {
      projectCount: projectMetrics.length,
      unhealthyCount: projectMetrics.filter((project) => project.monitorHealth !== 'healthy').length,
      warningCount: projectMetrics.reduce((total, project) => total + project.warningCount, 0),
      totalCost: projectMetrics.reduce((total, project) => total + project.cost, 0),
      totalTokens: projectMetrics.reduce((total, project) => total + project.totalTokens, 0),
      completedTasks: projectMetrics.reduce((total, project) => total + project.completedTasks, 0),
      totalTasks: projectMetrics.reduce((total, project) => total + project.totalTasks, 0),
      remainingTasks: projectMetrics.reduce((total, project) => total + project.remainingTasks, 0),
    },
    projects: projectMetrics,
  };
}

export function buildSlackStatusMessage(projects: ProjectRecord[], publicBaseUrl?: string, nowMs: number = Date.now()) {
  const current = pickCurrentProject(projects, nowMs);
  const totalCost = projects.reduce((total, project) => total + (project.snapshot.sources.metricsJson.value?.totals.cost ?? 0), 0);
  const totalTokens = projects.reduce(
    (total, project) => total + (project.snapshot.sources.metricsJson.value?.totals.totalTokens ?? 0),
    0,
  );
  const unhealthyCount = projects.filter((project) => project.monitor.health !== 'healthy').length;
  const warningCount = projects.reduce((total, project) => total + project.snapshot.warnings.length, 0);

  if (!current) {
    return withSlackColor({
      text: 'GSD status: no projects registered.',
      threadKey: 'status',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: 'GSD Status',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'No projects are registered in gsd-web yet.',
          },
        },
      ],
    } satisfies Omit<SlackMessage, 'attachments'>, '#667085');
  }

  const project = current.project;
  const summary = current.summary;
  const detailUrl = buildProjectDetailUrl(publicBaseUrl, project.projectId);
  const title = buildLinkedTitle(detailUrl, summary.label);
  const topProjects = projects
    .map((candidate) => ({ project: candidate, summary: summarizeProjectStatus(candidate, nowMs) }))
    .sort(compareProjectStatusRows)
    .slice(0, 3)
    .map(({ project: rowProject, summary: row }) => {
      const candidateUrl = buildProjectDetailUrl(publicBaseUrl, rowProject.projectId);
      const label = buildLinkedTitle(candidateUrl, row.label);

      return `${label}: ${Math.round(row.progressPercent)}% · ETA ${row.eta} · ${formatUsd(row.cost)}`;
    });
  const updatedAt = new Date(nowMs).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return withSlackColor({
    text: `GSD status: ${summary.label} ${Math.round(summary.progressPercent)}%, ${summary.health}, ${formatUsd(summary.cost)}, ETA ${summary.eta}`,
    threadKey: summary.threadKey,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'GSD Status',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Current project:* ${title}\n${buildProjectStatusLines(summary).map((line) => escapeSlackText(line)).join('\n')}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '*Portfolio*',
            `${projects.length} projects · ${formatAttentionLabel(unhealthyCount, 'unhealthy project')}`,
            `${formatAttentionLabel(warningCount, 'warning')} · ${formatUsd(totalCost)} total cost`,
            `${formatCompactInteger(totalTokens)} tokens`,
          ].map((line) => escapeSlackText(line)).join('\n'),
        },
      },
      ...(topProjects.length > 0
        ? [
            { type: 'divider' as const },
            {
              type: 'section' as const,
              text: {
                type: 'mrkdwn' as const,
                text: `*Projects*\n${topProjects.join('\n')}`,
              },
            },
          ]
        : []),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: escapeSlackText(`Updated ${updatedAt}`),
          },
        ],
      },
    ],
  } satisfies Omit<SlackMessage, 'attachments'>, slackStatusColor(summary, warningCount));
}

export function parseSlackCommandPayload(rawBody: string): SlackCommandPayload {
  const form = new URLSearchParams(rawBody);

  return {
    command: form.get('command') ?? '',
    text: form.get('text')?.trim() ?? '',
    userId: form.get('user_id'),
    channelId: form.get('channel_id'),
    responseUrl: form.get('response_url'),
  };
}

export function parseSlackPolledCommand(text: string, prefix: string): SlackCommandPayload | null {
  const normalizedPrefix = prefix.trim();

  if (normalizedPrefix.length === 0) {
    return null;
  }

  const trimmed = text.trim();
  const escapedPrefix = normalizedPrefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = trimmed.match(new RegExp(`^${escapedPrefix}(?:\\s+(.+))?$`, 'iu'));

  if (!match) {
    return null;
  }

  return {
    command: normalizedPrefix,
    text: match[1]?.trim() ?? 'status',
    userId: null,
    channelId: null,
    responseUrl: null,
  };
}

export function verifySlackRequest(input: {
  signingSecret: string;
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowMs?: number;
}) {
  if (!input.timestamp || !/^\d+$/u.test(input.timestamp) || !input.signature) {
    return false;
  }

  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const requestSeconds = Number.parseInt(input.timestamp, 10);

  if (Math.abs(nowSeconds - requestSeconds) > 60 * 5) {
    return false;
  }

  const baseString = `v0:${input.timestamp}:${input.rawBody}`;
  const expected = `v0=${createHmac('sha256', input.signingSecret).update(baseString).digest('hex')}`;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(input.signature, 'utf8');

  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function projectDisplayName(project: ProjectRecord) {
  const trimDisplayName = (value: string | null | undefined) => {
    const trimmed = value?.trim();

    return trimmed && trimmed.length > 0 ? trimmed : null;
  };
  const isGenericDisplayName = (value: string | null | undefined) => {
    const normalized = value?.trim().toLowerCase().replace(/[\s_-]+/gu, ' ') ?? '';

    return normalized === 'project' || normalized === 'untitled project' || normalized === 'project snapshot fixture';
  };
  const projectTitle = trimDisplayName(project.snapshot.sources.projectMd.value?.title);
  const hintedName = trimDisplayName(project.snapshot.identityHints.displayName);
  const repoName = trimDisplayName(project.snapshot.sources.repoMeta.value?.projectName);
  const directoryName = trimDisplayName(project.canonicalPath.split(/[\\/]/u).filter(Boolean).at(-1));
  const gsdId = trimDisplayName(project.snapshot.identityHints.gsdId);

  return (
    (projectTitle && !isGenericDisplayName(projectTitle) ? projectTitle : null)
    ?? (hintedName && !isGenericDisplayName(hintedName) ? hintedName : null)
    ?? (repoName && !isGenericDisplayName(repoName) ? repoName : null)
    ?? directoryName
    ?? gsdId
    ?? project.canonicalPath
  );
}

function summarizeProjectLine(project: ProjectRecord, publicBaseUrl?: string) {
  const name = projectDisplayName(project);
  const detailUrl = buildProjectDetailUrl(publicBaseUrl, project.projectId);
  const label = detailUrl ? `<${detailUrl}|${name}>` : name;
  const initStage = project.latestInitJob ? `, init ${project.latestInitJob.stage}` : '';

  return `• ${label}: ${project.snapshot.status}, monitor ${project.monitor.health}, ${project.snapshot.warnings.length} warnings${initStage}`;
}

function formatProjectsSummary(projects: ProjectRecord[], publicBaseUrl?: string) {
  if (projects.length === 0) {
    return 'No projects are registered in gsd-web yet.';
  }

  const initialized = projects.filter((project) => project.snapshot.status === 'initialized').length;
  const degraded = projects.filter((project) => project.snapshot.status === 'degraded').length;
  const uninitialized = projects.filter((project) => project.snapshot.status === 'uninitialized').length;
  const unhealthy = projects.filter((project) => project.monitor.health !== 'healthy').length;
  const lines = projects
    .slice(0, 8)
    .map((project) => summarizeProjectLine(project, publicBaseUrl));

  if (projects.length > lines.length) {
    lines.push(`• ...and ${projects.length - lines.length} more`);
  }

  return [
    `GSD projects: ${projects.length} total (${initialized} initialized, ${degraded} degraded, ${uninitialized} uninitialized).`,
    `Monitor attention: ${unhealthy}.`,
    '',
    ...lines,
  ].join('\n');
}

function normalizeQuery(value: string) {
  return value.trim().toLowerCase();
}

function findProject(projects: ProjectRecord[], query: string) {
  const normalizedQuery = normalizeQuery(query);

  if (normalizedQuery.length === 0) {
    return null;
  }

  return projects.find((project) => {
    const candidates = [
      project.projectId,
      projectDisplayName(project),
      project.canonicalPath,
      project.registeredPath,
      project.canonicalPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? '',
    ];

    return candidates.some((candidate) => normalizeQuery(candidate).includes(normalizedQuery));
  }) ?? null;
}

function formatProjectDetail(project: ProjectRecord, publicBaseUrl?: string) {
  const name = projectDisplayName(project);
  const detailUrl = buildProjectDetailUrl(publicBaseUrl, project.projectId);
  const title = detailUrl ? `<${detailUrl}|${name}>` : name;
  const timeline = project.latestInitJob
    ? `Init: ${project.latestInitJob.stage} (${project.latestInitJob.updatedAt})`
    : 'Init: no job';
  const monitorError = project.monitor.lastError ? `Monitor error: ${project.monitor.lastError.message}` : null;
  const warningLines = project.snapshot.warnings.slice(0, 5).map((warning) => `• ${warning.source}: ${warning.message}`);

  return [
    `*${title}*`,
    `Project: ${project.projectId}`,
    `Snapshot: ${project.snapshot.status}`,
    `Monitor: ${project.monitor.health}`,
    `Warnings: ${project.snapshot.warnings.length}`,
    `Path: ${project.canonicalPath}`,
    timeline,
    ...(monitorError ? [monitorError] : []),
    ...(warningLines.length > 0 ? ['', '*Warnings*', ...warningLines] : []),
  ].join('\n');
}

export function buildSlackCommandResponse(
  payload: SlackCommandPayload,
  projects: ProjectRecord[],
  publicBaseUrl?: string,
): SlackCommandResponse {
  const [action = 'status', ...args] = payload.text.split(/\s+/u).filter(Boolean);
  const query = args.join(' ');
  const metrics = buildGsdWebMetricsSnapshot(projects, publicBaseUrl);

  if (action === 'help') {
    return {
      response_type: 'ephemeral',
      text: 'gsd-web Slack commands',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              '*gsd-web commands*',
              '`/gsd` or `/gsd status` - show project summary',
              '`/gsd projects` - list registered projects',
              '`/gsd project <id|name|path>` - show one project',
            ].join('\n'),
          },
        },
      ],
    };
  }

  if (action === 'project' || (action === 'status' && query.length > 0)) {
    const project = findProject(projects, action === 'project' ? query : query);
    const projectMetrics = project
      ? metrics.projects.find((entry) => entry.projectId === project.projectId) ?? null
      : null;

    return {
      response_type: 'ephemeral',
      text: projectMetrics
        ? formatProjectMetricsDetail(projectMetrics)
        : `No registered project matched "${query}".`,
      blocks: projectMetrics
        ? buildProjectMetricsDetailBlocks(projectMetrics)
        : buildCommandBlocksFromText('Project not found', `No registered project matched "${query}".`),
    };
  }

  if (action === 'status' || action === 'projects') {
    const text = formatMetricsSummary(metrics);

    return {
      response_type: 'ephemeral',
      text,
      blocks: buildMetricsSummaryBlocks(metrics),
    };
  }

  return {
    response_type: 'ephemeral',
    text: `Unknown gsd-web command: ${action}\nTry /gsd help.`,
    blocks: buildCommandBlocksFromText('Unknown command', `Unknown gsd-web command: ${action}\nTry /gsd help.`),
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
  private readonly threadTimestamps = new Map<string, string>();

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

  async sendStatus(projects: ProjectRecord[], nowMs: number = Date.now()) {
    if (!hasAnyRunningProject(projects)) {
      return false;
    }

    await this.postMessage(buildSlackStatusMessage(projects, this.config.publicBaseUrl, nowMs));
    return true;
  }

  async fetchCommandMessages(oldestTs: string): Promise<SlackPolledCommandMessage[]> {
    if (!this.config.botToken || !this.config.channelId) {
      throw new SlackNotificationError('Slack command polling requires bot token and channel id.');
    }

    const url = new URL(SLACK_CONVERSATIONS_HISTORY_URL);

    url.searchParams.set('channel', this.config.channelId);
    url.searchParams.set('oldest', oldestTs);
    url.searchParams.set('inclusive', 'false');
    url.searchParams.set('limit', '20');

    const response = await fetchWithTimeout(
      this.fetchImpl,
      url.toString(),
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.config.botToken}`,
        },
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

      throw new SlackNotificationError(`Slack API rejected the command poll: ${error}`);
    }

    const messages = Array.isArray((payload as { messages?: unknown }).messages)
      ? (payload as { messages: unknown[] }).messages
      : [];

    return messages
      .map((message) => {
        if (!message || typeof message !== 'object') {
          return null;
        }

        const record = message as Record<string, unknown>;

        if (typeof record.ts !== 'string' || typeof record.text !== 'string' || typeof record.bot_id === 'string') {
          return null;
        }

        return {
          ts: record.ts,
          text: record.text,
          userId: typeof record.user === 'string' ? record.user : null,
        } satisfies SlackPolledCommandMessage;
      })
      .filter((message): message is SlackPolledCommandMessage => message !== null)
      .sort((first, second) => Number(first.ts) - Number(second.ts));
  }

  async replyToCommand(response: SlackCommandResponse, threadTs: string) {
    await this.postMessage(
      {
        text: response.text,
        blocks: response.blocks ?? [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: escapeSlackText(response.text),
            },
          },
        ],
      },
      threadTs,
    );
  }

  private async postMessage(message: SlackMessage, threadTsOverride?: string) {
    const bodyBlocks = message.attachments ? {} : { blocks: message.blocks };
    const bodyAttachments = message.attachments ? { attachments: message.attachments } : {};

    if (this.config.webhookUrl) {
      const response = await fetchWithTimeout(
        this.fetchImpl,
        this.config.webhookUrl,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            text: message.text,
            ...bodyBlocks,
            ...bodyAttachments,
          }),
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

    const threadTs = threadTsOverride ?? (message.threadKey ? this.threadTimestamps.get(message.threadKey) : undefined);
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
          ...bodyBlocks,
          ...bodyAttachments,
          ...(threadTs ? { thread_ts: threadTs } : {}),
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

    if (message.threadKey && !threadTsOverride && !threadTs && typeof (payload as { ts?: unknown }).ts === 'string') {
      this.threadTimestamps.set(message.threadKey, (payload as { ts: string }).ts);
    }
  }
}
