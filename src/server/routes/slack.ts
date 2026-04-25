import type { FastifyInstance } from 'fastify';

import type { RegistryDatabase } from '../db.js';
import {
  buildSlackCommandResponse,
  parseSlackCommandPayload,
  verifySlackRequest,
  type SlackCommandConfig,
} from '../slack.js';

function getHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export async function registerSlackRoutes(
  app: FastifyInstance,
  options: {
    registry: RegistryDatabase;
    commandConfig: SlackCommandConfig | null;
  },
) {
  app.post<{ Body: string }>('/api/slack/commands', async (request, reply) => {
    if (!options.commandConfig) {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'Slack slash commands are not configured.',
        statusCode: 503,
        code: 'slack_commands_not_configured',
      });
    }

    const rawBody = typeof request.body === 'string' ? request.body : '';
    const verified = verifySlackRequest({
      signingSecret: options.commandConfig.signingSecret,
      rawBody,
      timestamp: getHeaderValue(request.headers['x-slack-request-timestamp']),
      signature: getHeaderValue(request.headers['x-slack-signature']),
    });

    if (!verified) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Slack request signature verification failed.',
        statusCode: 401,
        code: 'invalid_slack_signature',
      });
    }

    const payload = parseSlackCommandPayload(rawBody);

    return reply
      .type('application/json; charset=utf-8')
      .send(buildSlackCommandResponse(payload, options.registry.listProjects(), options.commandConfig.publicBaseUrl));
  });

  return [
    {
      method: 'POST' as const,
      route: '/api/slack/commands',
    },
  ];
}
