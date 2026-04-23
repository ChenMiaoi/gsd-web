#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp, type CreateAppOptions, type GsdWebApp, type RuntimeSignal } from './app.js';

export interface StartServerOptions extends CreateAppOptions {
  host?: string;
  port?: number;
  printBanner?: boolean;
}

function isEntrypoint() {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function resolvePort(candidate: number | string | undefined): number {
  const fallbackPort = 3000;

  if (candidate === undefined) {
    return fallbackPort;
  }

  const parsedPort = typeof candidate === 'number' ? candidate : Number.parseInt(candidate, 10);

  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
    throw new Error(`Invalid PORT value: ${candidate}`);
  }

  return parsedPort;
}

function emitStartSignal(
  app: GsdWebApp,
  logSink: CreateAppOptions['logSink'],
  signal: Extract<RuntimeSignal, { event: 'service_start' }>,
) {
  logSink?.(signal);
  app.log.info(signal, 'Started gsd-web service shell');
}

function printStartBanner(app: GsdWebApp, address: string) {
  const paths = app.gsdWebPaths;

  console.info(`gsd-web is running at ${address}`);
  console.info(`data: ${paths.databasePath}`);

  if (paths.activeLogFilePath) {
    console.info(`logs: ${paths.activeLogFilePath}`);
  }
}

export async function startServer(options: StartServerOptions = {}) {
  const app = (await createApp(options)) as GsdWebApp;
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? resolvePort(process.env.PORT);

  try {
    const address = await app.listen({ host, port });

    emitStartSignal(app, options.logSink, {
      event: 'service_start',
      address,
      host,
      port,
    });
    if (options.printBanner) {
      printStartBanner(app, address);
    }

    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (isEntrypoint()) {
  startServer({ printBanner: true }).catch((error) => {
    console.error('Failed to start gsd-web service shell.');
    console.error(error);
    process.exitCode = 1;
  });
}
