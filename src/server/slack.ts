import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  GsdDbMilestoneSummary,
  ProjectEventEnvelope,
  ProjectEventPayload,
  ProjectEventType,
  ProjectRecord,
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
const DEFAULT_SLACK_TIMEOUT_MS = 5_000;
const DEFAULT_SLACK_STATUS_INTERVAL_MS = 60_000;
const DEFAULT_SLACK_STATUS_IMMEDIATE_MIN_INTERVAL_MS = 5_000;

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

export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
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

function buildProjectDetailUrl(publicBaseUrl: string | undefined, projectId: string) {
  const baseUrl = normalizeBaseUrl(publicBaseUrl);

  return baseUrl ? `${baseUrl}/lazy/employee-${encodeURIComponent(projectId)}` : null;
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
  } satisfies SlackMessage;
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

function normalizeWorkflowTimestamp(value: string | number | null) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }

    const parsedDate = Date.parse(value);

    return Number.isFinite(parsedDate) ? parsedDate : null;
  }

  return null;
}

function isWorkflowComplete(status: string | null | undefined) {
  return /^(done|completed|complete|succeeded|success|finished|closed)$/iu.test(status?.trim() ?? '');
}

function isWorkflowActive(status: string | null | undefined) {
  return /^(active|running|executing|in_progress|in-progress|current)$/iu.test(status?.trim() ?? '');
}

export function hasRunningProject(project: ProjectRecord) {
  if (project.latestInitJob !== null && !isProjectInitJobTerminalStage(project.latestInitJob.stage)) {
    return true;
  }

  if (isWorkflowActive(project.snapshot.sources.autoLock.value?.status)) {
    return true;
  }

  return summarizeMilestones(project.snapshot.sources.gsdDb.value?.milestones ?? []).activeLabel !== null;
}

export function hasAnyRunningProject(projects: ProjectRecord[]) {
  return projects.some((project) => hasRunningProject(project));
}

function summarizeMilestones(milestones: GsdDbMilestoneSummary[]) {
  let totalTasks = 0;
  let completedTasks = 0;
  let activeLabel: string | null = null;
  const completedDurations: number[] = [];

  for (const milestone of milestones) {
    for (const slice of milestone.slices) {
      const sliceActive = isWorkflowActive(slice.status);

      for (const task of slice.tasks) {
        totalTasks += 1;

        if (isWorkflowComplete(task.status)) {
          completedTasks += 1;
        }

        const startedAt = normalizeWorkflowTimestamp(task.startedAt);
        const finishedAt = normalizeWorkflowTimestamp(task.finishedAt);

        if (startedAt !== null && finishedAt !== null && finishedAt >= startedAt) {
          completedDurations.push(finishedAt - startedAt);
        }

        if (!activeLabel && (isWorkflowActive(task.status) || sliceActive || isWorkflowActive(milestone.status))) {
          activeLabel = `${milestone.id}/${slice.id}/${task.id}`;
        }
      }

      if (!activeLabel && sliceActive) {
        activeLabel = `${milestone.id}/${slice.id}`;
      }
    }

    if (!activeLabel && isWorkflowActive(milestone.status)) {
      activeLabel = milestone.id;
    }
  }

  const averageCompletedDurationMs = completedDurations.length > 0
    ? completedDurations.reduce((total, value) => total + value, 0) / completedDurations.length
    : null;

  return {
    totalTasks,
    completedTasks,
    remainingTasks: Math.max(0, totalTasks - completedTasks),
    activeLabel,
    averageCompletedDurationMs,
  };
}

function buildProgressBar(percent: number) {
  const normalized = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round(normalized / 10);

  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${normalized}%`;
}

function summarizeProjectStatus(project: ProjectRecord, nowMs: number) {
  const milestones = project.snapshot.sources.gsdDb.value?.milestones ?? [];
  const workflow = summarizeMilestones(milestones);
  const metrics = project.snapshot.sources.metricsJson.value ?? null;
  const progressPercent = workflow.totalTasks > 0
    ? (workflow.completedTasks / workflow.totalTasks) * 100
    : project.snapshot.status === 'initialized'
      ? 100
      : 0;
  const estimatedRemainingMs =
    workflow.remainingTasks === 0
      ? 0
      : workflow.averageCompletedDurationMs === null
        ? null
        : workflow.averageCompletedDurationMs * workflow.remainingTasks;

  return {
    label: projectDisplayName(project),
    progressPercent,
    progressBar: buildProgressBar(progressPercent),
    completedTasks: workflow.completedTasks,
    totalTasks: workflow.totalTasks,
    remainingTasks: workflow.remainingTasks,
    currentStage: workflow.activeLabel ?? project.latestInitJob?.stage ?? project.snapshot.status,
    health: project.monitor.health,
    snapshotStatus: project.snapshot.status,
    warningCount: project.snapshot.warnings.length,
    cost: metrics?.totals.cost ?? 0,
    totalTokens: metrics?.totals.totalTokens ?? 0,
    estimatedRemainingMs,
    eta: formatEta(estimatedRemainingMs, nowMs),
  };
}

function pickCurrentProject(projects: ProjectRecord[], nowMs: number) {
  const ranked = projects
    .map((project) => ({ project, summary: summarizeProjectStatus(project, nowMs) }))
    .sort((first, second) => {
      const healthRank = (summary: ReturnType<typeof summarizeProjectStatus>) =>
        summary.health === 'healthy' ? 2 : summary.health === 'stale' ? 1 : 0;
      const firstActive = first.summary.remainingTasks > 0 || first.project.latestInitJob !== null ? 0 : 1;
      const secondActive = second.summary.remainingTasks > 0 || second.project.latestInitJob !== null ? 0 : 1;

      return (
        firstActive - secondActive
        || healthRank(first.summary) - healthRank(second.summary)
        || second.summary.warningCount - first.summary.warningCount
        || second.summary.cost - first.summary.cost
        || first.summary.label.localeCompare(second.summary.label)
      );
    });

  return ranked[0] ?? null;
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
    return {
      text: 'GSD status: no projects registered.',
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
    } satisfies SlackMessage;
  }

  const project = current.project;
  const summary = current.summary;
  const detailUrl = buildProjectDetailUrl(publicBaseUrl, project.projectId);
  const title = detailUrl ? `<${detailUrl}|${summary.label}>` : summary.label;
  const topProjects = projects
    .map((candidate) => ({ project: candidate, summary: summarizeProjectStatus(candidate, nowMs) }))
    .sort((first, second) => second.summary.cost - first.summary.cost || first.summary.label.localeCompare(second.summary.label))
    .slice(0, 4)
    .map(({ summary: row }) => `• *${row.label}* ${Math.round(row.progressPercent)}% · ${row.health} · ${formatUsd(row.cost)}`);

  return {
    text: `GSD status: ${summary.label} ${Math.round(summary.progressPercent)}%, ${summary.health}, ${formatUsd(summary.cost)}, ETA ${summary.eta}`,
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
          text: `*Current project:* ${title}\n${summary.progressBar}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Health*\n${summary.health}` },
          { type: 'mrkdwn', text: `*Snapshot*\n${summary.snapshotStatus}` },
          { type: 'mrkdwn', text: `*Current*\n${summary.currentStage}` },
          { type: 'mrkdwn', text: `*Tasks*\n${summary.completedTasks}/${summary.totalTasks || 'unknown'}` },
          { type: 'mrkdwn', text: `*Cost*\n${formatUsd(summary.cost)}` },
          { type: 'mrkdwn', text: `*ETA*\n${summary.eta}` },
        ],
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Portfolio*\n${projects.length} projects` },
          { type: 'mrkdwn', text: `*Attention*\n${unhealthyCount} unhealthy, ${warningCount} warnings` },
          { type: 'mrkdwn', text: `*Total cost*\n${formatUsd(totalCost)}` },
          { type: 'mrkdwn', text: `*Tokens*\n${formatCompactInteger(totalTokens)}` },
        ],
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
            text: `Updated ${new Date(nowMs).toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            })}`,
          },
        ],
      },
    ],
  } satisfies SlackMessage;
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
  return (
    project.snapshot.identityHints.displayName
    ?? project.snapshot.sources.repoMeta.value?.projectName
    ?? project.snapshot.sources.projectMd.value?.title
    ?? project.canonicalPath.split(/[\\/]/u).filter(Boolean).at(-1)
    ?? project.projectId
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

    return {
      response_type: 'ephemeral',
      text: project
        ? formatProjectDetail(project, publicBaseUrl)
        : `No registered project matched "${query}".`,
    };
  }

  if (action === 'status' || action === 'projects') {
    return {
      response_type: 'ephemeral',
      text: formatProjectsSummary(projects, publicBaseUrl),
    };
  }

  return {
    response_type: 'ephemeral',
    text: `Unknown gsd-web command: ${action}\nTry /gsd help.`,
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

  async sendStatus(projects: ProjectRecord[], nowMs: number = Date.now()) {
    if (!hasAnyRunningProject(projects)) {
      return false;
    }

    await this.postMessage(buildSlackStatusMessage(projects, this.config.publicBaseUrl, nowMs));
    return true;
  }

  private async postMessage(message: SlackMessage) {
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
