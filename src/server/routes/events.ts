import type { FastifyInstance } from 'fastify';
import type { Socket } from 'node:net';

import type { ProjectEventEnvelope } from '../../shared/contracts.js';
import type { RegistryDatabase } from '../db.js';

const HEARTBEAT_INTERVAL_MS = 15_000;

function serializeSseEvent(event: ProjectEventEnvelope) {
  return [
    `id: ${event.id}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
}

function parseEventId(candidate: string | undefined) {
  if (!candidate || candidate.trim().length === 0) {
    return 0;
  }

  const match = /^evt_(\d+)$/u.exec(candidate.trim());
  const sequence = match?.[1];

  return sequence ? Number.parseInt(sequence, 10) : null;
}

export class EventHub {
  private readonly subscribers = new Set<(event: ProjectEventEnvelope) => void>();

  constructor(private readonly registry: RegistryDatabase) {}

  subscribe(subscriber: (event: ProjectEventEnvelope) => void) {
    this.subscribers.add(subscriber);

    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  broadcast(event: ProjectEventEnvelope) {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  listEventsAfter(sequence: number) {
    return this.registry.listEventsAfter(sequence);
  }

  close() {
    this.subscribers.clear();
  }
}

export async function registerEventsRoute(
  app: FastifyInstance,
  options: {
    registry: RegistryDatabase;
    eventHub: EventHub;
  },
) {
  app.get<{ Querystring: { lastEventId?: string } }>('/api/events', async (request, reply) => {
    const requestedLastEventId =
      typeof request.query.lastEventId === 'string'
        ? request.query.lastEventId
        : typeof request.headers['last-event-id'] === 'string'
          ? request.headers['last-event-id']
          : undefined;

    const parsedLastEventSequence = parseEventId(requestedLastEventId);

    if (parsedLastEventSequence === null) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'lastEventId must use the evt_<number> format.',
        statusCode: 400,
        code: 'invalid_last_event_id',
      });
    }

    const replay = options.registry.getEventReplayBatch(parsedLastEventSequence);
    const headers: Record<string, string> = {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
      'x-gsd-replay-gap-detected': replay.replayGapDetected ? '1' : '0',
      'x-gsd-retained-events': String(replay.window.retainedEvents),
    };

    if (replay.window.earliestRetainedEventId) {
      headers['x-gsd-earliest-retained-event-id'] = replay.window.earliestRetainedEventId;
    }

    if (replay.window.latestRetainedEventId) {
      headers['x-gsd-latest-retained-event-id'] = replay.window.latestRetainedEventId;
    }

    reply.hijack();
    reply.raw.writeHead(200, headers);
    reply.raw.flushHeaders?.();

    for (const event of replay.items) {
      reply.raw.write(serializeSseEvent(event));
    }

    const unsubscribe = options.eventHub.subscribe((event) => {
      reply.raw.write(serializeSseEvent(event));
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(`: keepalive ${Date.now()}\n\n`);
    }, HEARTBEAT_INTERVAL_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    const socket = reply.raw.socket as Socket | null;
    socket?.on('close', cleanup);
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);

    return reply;
  });

  return [
    {
      method: 'GET' as const,
      route: '/api/events',
    },
  ];
}
