#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createApp,
  resolveDefaultPaths,
  type CreateAppOptions,
  type GsdWebApp,
  type RuntimeSignal,
} from './app.js';

export interface StartServerOptions extends CreateAppOptions {
  host?: string;
  port?: number;
  printBanner?: boolean;
}

export interface CliListenOptions {
  host?: string;
  port?: number;
}

export type CompletionShell = 'bash' | 'zsh' | 'fish';

export interface CliInvocation {
  command: string;
  daemonChild: boolean;
  listenOptions: CliListenOptions;
  completionShell?: CompletionShell;
}

interface DaemonState {
  pid: number;
  address: string;
  startedAt: string;
  runtimeDir: string;
  databasePath: string;
  logFilePath: string | null;
  logRetentionDays: number | null;
  logMaxFileSizeBytes: number | null;
}

interface DaemonPaths {
  runtimeDir: string;
  pidFilePath: string;
}

const DAEMON_CHILD_FLAG = '--daemon-child';
const STOP_TIMEOUT_MS = 8_000;
const START_TIMEOUT_MS = 8_000;
const CLI_COMMANDS = ['start', 'stop', 'reload', 'restart', 'status', 'serve', 'completion', 'help'] as const;
const CLI_OPTIONS = ['--host', '--port', '--help', '-h'] as const;
const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;

function isEntrypoint() {
  if (process.argv[1] === undefined) {
    return false;
  }

  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

function resolvePort(candidate: number | string | undefined): number {
  const fallbackPort = 3000;

  if (candidate === undefined) {
    return fallbackPort;
  }

  const parsedPort = typeof candidate === 'number' ? candidate : /^\d+$/.test(candidate) ? Number(candidate) : Number.NaN;

  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
    throw new Error(`Invalid PORT value: ${candidate}`);
  }

  return parsedPort;
}

function resolveHost(candidate: string): string;
function resolveHost(candidate: undefined): undefined;
function resolveHost(candidate: string | undefined): string | undefined;
function resolveHost(candidate: string | undefined): string | undefined {
  if (candidate === undefined) {
    return undefined;
  }

  const host = candidate.trim();

  if (host.length === 0) {
    throw new Error('Invalid HOST value: host must not be empty');
  }

  return host;
}

function parseCompletionShell(candidate: string): CompletionShell {
  if ((COMPLETION_SHELLS as readonly string[]).includes(candidate)) {
    return candidate as CompletionShell;
  }

  throw new Error(`Unsupported completion shell: ${candidate}`);
}

function parseCliListenValue(args: string[], index: number, option: string): { value: string; nextIndex: number } {
  const arg = args[index]!;
  const inlineValuePrefix = `${option}=`;

  if (arg.startsWith(inlineValuePrefix)) {
    return {
      value: arg.slice(inlineValuePrefix.length),
      nextIndex: index + 1,
    };
  }

  const value = args[index + 1];

  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${option}`);
  }

  return {
    value,
    nextIndex: index + 2,
  };
}

export function parseCliInvocation(argv: string[]): CliInvocation {
  const args = argv.filter((arg) => arg !== DAEMON_CHILD_FLAG);
  const daemonChild = argv.includes(DAEMON_CHILD_FLAG);
  const listenOptions: CliListenOptions = {};
  let command: string | null = null;
  let completionShell: CompletionShell | null = null;
  let index = 0;

  while (index < args.length) {
    const arg = args[index]!;

    if (arg === '--host' || arg.startsWith('--host=')) {
      const parsed = parseCliListenValue(args, index, '--host');
      listenOptions.host = resolveHost(parsed.value);
      index = parsed.nextIndex;
      continue;
    }

    if (arg === '--port' || arg.startsWith('--port=')) {
      const parsed = parseCliListenValue(args, index, '--port');
      listenOptions.port = resolvePort(parsed.value);
      index = parsed.nextIndex;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      if (command !== null) {
        throw new Error(`Unexpected argument: ${arg}`);
      }

      command = 'help';
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (command !== null) {
      if (command === 'completion' && completionShell === null) {
        completionShell = parseCompletionShell(arg);
        index += 1;
        continue;
      }

      throw new Error(`Unexpected argument: ${arg}`);
    }

    command = arg;
    index += 1;
  }

  return {
    command: command ?? 'start',
    daemonChild,
    listenOptions,
    ...(completionShell === null ? {} : { completionShell }),
  };
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

  console.info(formatLogPolicySummary(paths.logPolicy.retentionDays, paths.logPolicy.maxFileSizeBytes));
}

function formatLogSize(maxFileSizeBytes: number) {
  const sizeInMiB = maxFileSizeBytes / (1024 * 1024);

  return Number.isInteger(sizeInMiB) ? `${sizeInMiB} MiB` : `${sizeInMiB.toFixed(1)} MiB`;
}

function formatLogPolicySummary(logRetentionDays: number | null, logMaxFileSizeBytes: number | null) {
  if (logRetentionDays === null || logMaxFileSizeBytes === null) {
    return 'log policy: daily rotation, gzip archives, retention unknown, max active file unknown';
  }

  return `log policy: daily rotation, gzip archives, ${logRetentionDays}-day retention, ${formatLogSize(logMaxFileSizeBytes)} max active file`;
}

function printHelp() {
  console.info(`Usage: gsd-web [command] [options]

Commands:
  start       Start gsd-web in the background (default)
  stop        Stop the background gsd-web process
  reload      Restart the background gsd-web process
  restart     Alias for reload
  status      Show whether the background process is running
  serve       Run in the foreground
  completion  Generate a shell completion script
  help        Show this help

Options:
  --host <host>   HTTP listen host (default: HOST or 127.0.0.1)
  --port <port>   HTTP listen port (default: PORT or 3000)

Environment:
  HOST, PORT, GSD_WEB_HOME, GSD_WEB_DATABASE_PATH, GSD_WEB_LOG_DIR,
  GSD_WEB_LOG_FILE, GSD_WEB_LOG_RETENTION_DAYS, GSD_WEB_LOG_MAX_SIZE_MB,
  GSD_WEB_CLIENT_DIST_DIR, GSD_WEB_CONFIG_PATH, GSD_WEB_PUBLIC_URL,
  GSD_WEB_SLACK_WEBHOOK_URL, GSD_WEB_SLACK_BOT_TOKEN,
  GSD_WEB_SLACK_CHANNEL_ID, GSD_WEB_SLACK_SIGNING_SECRET,
  GSD_WEB_SLACK_EVENTS, GSD_WEB_SLACK_STATUS_REPORT,
  GSD_WEB_SLACK_STATUS_INTERVAL_MS, GSD_WEB_SLACK_STATUS_IMMEDIATE_MIN_INTERVAL_MS,
  GSD_WEB_SLACK_TIMEOUT_MS, GSD_BIN_PATH`);
}

function buildBashCompletionScript() {
  const commands = CLI_COMMANDS.join(' ');
  const options = CLI_OPTIONS.join(' ');
  const shells = COMPLETION_SHELLS.join(' ');

  return `# bash completion for gsd-web
_gsd_web_completion() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
    --host|--port)
      return 0
      ;;
  esac

  if [[ "\${COMP_WORDS[1]}" == "completion" && "$COMP_CWORD" -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "${shells}" -- "$cur") )
    return 0
  fi

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "${options}" -- "$cur") )
    return 0
  fi

  if [[ "$COMP_CWORD" -le 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands} ${options}" -- "$cur") )
  fi
}

complete -F _gsd_web_completion gsd-web`;
}

function buildZshCompletionScript() {
  return `#compdef gsd-web

_gsd_web() {
  local -a commands shells
  commands=(
    'start:Start gsd-web in the background'
    'stop:Stop the background gsd-web process'
    'reload:Restart the background gsd-web process'
    'restart:Alias for reload'
    'status:Show whether the background process is running'
    'serve:Run in the foreground'
    'completion:Generate a shell completion script'
    'help:Show help'
  )
  shells=('bash:Bash' 'zsh:Zsh' 'fish:Fish')

  _arguments \\
    '--host[HTTP listen host]:host:' \\
    '--port[HTTP listen port]:port:' \\
    '(-h --help)'{-h,--help}'[Show help]' \\
    '1:command:->command' \\
    '2::shell:->shell'

  case "$state" in
    command)
      _describe 'command' commands
      ;;
    shell)
      if [[ "$words[2]" == "completion" ]]; then
        _describe 'shell' shells
      fi
      ;;
  esac
}

_gsd_web "$@"`;
}

function buildFishCompletionScript() {
  return `# fish completion for gsd-web
complete -c gsd-web -f
complete -c gsd-web -n '__fish_use_subcommand' -a 'start' -d 'Start gsd-web in the background'
complete -c gsd-web -n '__fish_use_subcommand' -a 'stop' -d 'Stop the background gsd-web process'
complete -c gsd-web -n '__fish_use_subcommand' -a 'reload' -d 'Restart the background gsd-web process'
complete -c gsd-web -n '__fish_use_subcommand' -a 'restart' -d 'Alias for reload'
complete -c gsd-web -n '__fish_use_subcommand' -a 'status' -d 'Show whether the background process is running'
complete -c gsd-web -n '__fish_use_subcommand' -a 'serve' -d 'Run in the foreground'
complete -c gsd-web -n '__fish_use_subcommand' -a 'completion' -d 'Generate a shell completion script'
complete -c gsd-web -n '__fish_use_subcommand' -a 'help' -d 'Show help'
complete -c gsd-web -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
complete -c gsd-web -l host -d 'HTTP listen host' -r
complete -c gsd-web -l port -d 'HTTP listen port' -r
complete -c gsd-web -s h -l help -d 'Show help'`;
}

export function buildCompletionScript(shell: CompletionShell) {
  switch (shell) {
    case 'bash':
      return buildBashCompletionScript();
    case 'zsh':
      return buildZshCompletionScript();
    case 'fish':
      return buildFishCompletionScript();
  }
}

function printCompletionUsage() {
  console.info(`Usage: gsd-web completion <shell>

Shells:
  bash
  zsh
  fish`);
}

function getDaemonPaths(): DaemonPaths {
  const defaults = resolveDefaultPaths(import.meta.url);

  return {
    runtimeDir: defaults.runtimeDir,
    pidFilePath: path.join(defaults.runtimeDir, 'gsd-web.pid'),
  };
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    return code === 'EPERM';
  }
}

async function readDaemonState(pidFilePath: string): Promise<DaemonState | null> {
  try {
    const rawState = (await readFile(pidFilePath, 'utf8')).trim();

    if (rawState.length === 0) {
      return null;
    }

    const parsed = JSON.parse(rawState) as Partial<DaemonState>;

    const pid = parsed.pid;

    if (!Number.isInteger(pid)) {
      return null;
    }

    const logRetentionDays = parsed.logRetentionDays;
    const logMaxFileSizeBytes = parsed.logMaxFileSizeBytes;

    return {
      pid: pid!,
      address: typeof parsed.address === 'string' ? parsed.address : 'unknown',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : 'unknown',
      runtimeDir: typeof parsed.runtimeDir === 'string' ? parsed.runtimeDir : path.dirname(pidFilePath),
      databasePath: typeof parsed.databasePath === 'string' ? parsed.databasePath : 'unknown',
      logFilePath: typeof parsed.logFilePath === 'string' ? parsed.logFilePath : null,
      logRetentionDays: typeof logRetentionDays === 'number' && Number.isInteger(logRetentionDays) ? logRetentionDays : null,
      logMaxFileSizeBytes:
        typeof logMaxFileSizeBytes === 'number' && Number.isInteger(logMaxFileSizeBytes) ? logMaxFileSizeBytes : null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function removeDaemonState(pidFilePath: string) {
  await rm(pidFilePath, { force: true });
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForDaemonState(pidFilePath: string, timeoutMs: number): Promise<DaemonState | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await readDaemonState(pidFilePath);

    if (state && isProcessRunning(state.pid)) {
      return state;
    }

    await sleep(100);
  }

  return null;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }

    await sleep(100);
  }

  return !isProcessRunning(pid);
}

function getListeningAddress(app: GsdWebApp): string {
  const address = app.server.address() as AddressInfo | string | null;

  if (typeof address === 'string') {
    return address;
  }

  if (!address) {
    return 'unknown';
  }

  const host = address.address.includes(':') ? `[${address.address}]` : address.address;

  return `http://${host}:${address.port}`;
}

async function writeDaemonState(app: GsdWebApp, address: string, pidFilePath: string) {
  const paths = app.gsdWebPaths;
  const state: DaemonState = {
    pid: process.pid,
    address,
    startedAt: new Date().toISOString(),
    runtimeDir: paths.runtimeDir,
    databasePath: paths.databasePath,
    logFilePath: paths.activeLogFilePath,
    logRetentionDays: paths.logPolicy.retentionDays,
    logMaxFileSizeBytes: paths.logPolicy.maxFileSizeBytes,
  };

  await mkdir(path.dirname(pidFilePath), { recursive: true });
  await writeFile(pidFilePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function installShutdownHandlers(app: GsdWebApp, pidFilePath: string | null) {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    try {
      await app.close();

      if (pidFilePath) {
        await removeDaemonState(pidFilePath);
      }
    } catch (error) {
      console.error(`Failed to stop gsd-web after ${signal}.`);
      console.error(error);
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

export async function startServer(options: StartServerOptions = {}) {
  const app = (await createApp(options)) as GsdWebApp;
  const host = options.host ?? resolveHost(process.env.HOST) ?? '127.0.0.1';
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

async function runForeground(options: { daemonChild?: boolean } & CliListenOptions = {}) {
  const daemonPaths = options.daemonChild ? getDaemonPaths() : null;
  const startOptions: StartServerOptions = {
    printBanner: !options.daemonChild,
  };

  if (options.host !== undefined) {
    startOptions.host = options.host;
  }

  if (options.port !== undefined) {
    startOptions.port = options.port;
  }

  const app = await startServer(startOptions);
  const address = getListeningAddress(app);

  installShutdownHandlers(app, daemonPaths?.pidFilePath ?? null);

  if (daemonPaths) {
    await writeDaemonState(app, address, daemonPaths.pidFilePath);
  }
}

async function startDaemon(options: CliListenOptions = {}): Promise<number> {
  const daemonPaths = getDaemonPaths();
  const existingState = await readDaemonState(daemonPaths.pidFilePath);

  if (existingState && isProcessRunning(existingState.pid)) {
    console.info(`gsd-web is already running (pid ${existingState.pid}) at ${existingState.address}`);
    return 0;
  }

  if (existingState) {
    await removeDaemonState(daemonPaths.pidFilePath);
  }

  await mkdir(daemonPaths.runtimeDir, { recursive: true });

  const childEnv = {
    ...process.env,
    ...(options.host === undefined ? {} : { HOST: options.host }),
    ...(options.port === undefined ? {} : { PORT: String(options.port) }),
  };
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', DAEMON_CHILD_FLAG], {
    detached: true,
    env: childEnv,
    stdio: 'ignore',
  });

  child.unref();

  const state = await waitForDaemonState(daemonPaths.pidFilePath, START_TIMEOUT_MS);

  if (!state) {
    console.error('Timed out waiting for gsd-web to start in the background.');
    console.error(`Check logs under ${daemonPaths.runtimeDir}.`);
    return 1;
  }

  console.info(`gsd-web started in the background (pid ${state.pid}) at ${state.address}`);
  console.info(`data: ${state.databasePath}`);

  if (state.logFilePath) {
    console.info(`logs: ${state.logFilePath}`);
  }

  console.info(formatLogPolicySummary(state.logRetentionDays, state.logMaxFileSizeBytes));

  return 0;
}

async function stopDaemon(options: { quiet?: boolean } = {}): Promise<number> {
  const daemonPaths = getDaemonPaths();
  const state = await readDaemonState(daemonPaths.pidFilePath);

  if (!state || !isProcessRunning(state.pid)) {
    await removeDaemonState(daemonPaths.pidFilePath);

    if (!options.quiet) {
      console.info('gsd-web is not running.');
    }

    return 0;
  }

  if (state.pid === process.pid) {
    console.error('Refusing to stop the current gsd-web CLI process from its own pid file.');
    return 1;
  }

  process.kill(state.pid, 'SIGTERM');

  if (!(await waitForProcessExit(state.pid, STOP_TIMEOUT_MS))) {
    console.error(`Timed out waiting for gsd-web pid ${state.pid} to stop.`);
    return 1;
  }

  await removeDaemonState(daemonPaths.pidFilePath);

  if (!options.quiet) {
    console.info(`gsd-web stopped (pid ${state.pid}).`);
  }

  return 0;
}

async function reloadDaemon(options: CliListenOptions = {}): Promise<number> {
  const stopCode = await stopDaemon({ quiet: true });

  if (stopCode !== 0) {
    return stopCode;
  }

  return startDaemon(options);
}

async function printStatus(): Promise<number> {
  const daemonPaths = getDaemonPaths();
  const state = await readDaemonState(daemonPaths.pidFilePath);

  if (!state || !isProcessRunning(state.pid)) {
    await removeDaemonState(daemonPaths.pidFilePath);
    console.info('gsd-web is stopped.');
    return 1;
  }

  console.info(`gsd-web is running (pid ${state.pid}) at ${state.address}`);
  console.info(`started: ${state.startedAt}`);
  console.info(`data: ${state.databasePath}`);

  if (state.logFilePath) {
    console.info(`logs: ${state.logFilePath}`);
  }

  console.info(formatLogPolicySummary(state.logRetentionDays, state.logMaxFileSizeBytes));

  return 0;
}

export async function runCli(argv: string[]): Promise<number> {
  try {
    const { command, daemonChild, listenOptions, completionShell } = parseCliInvocation(argv);

    switch (command) {
      case 'start':
        return daemonChild
          ? (await runForeground({ daemonChild: true, ...listenOptions }), 0)
          : startDaemon(listenOptions);
      case 'serve':
        await runForeground({ daemonChild, ...listenOptions });
        return 0;
      case 'stop':
        return stopDaemon();
      case 'reload':
      case 'restart':
        return reloadDaemon(listenOptions);
      case 'status':
        return printStatus();
      case 'completion':
        if (completionShell === undefined) {
          printCompletionUsage();
          return 1;
        }

        console.info(buildCompletionScript(completionShell));
        return 0;
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        return 0;
      default:
        console.error(`Unknown gsd-web command: ${command}`);
        printHelp();
        return 1;
    }
  } catch (error) {
    console.error('gsd-web command failed.');
    console.error(error);
    return 1;
  }
}

if (isEntrypoint()) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
