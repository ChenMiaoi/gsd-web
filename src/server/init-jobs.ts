import { spawn } from 'node:child_process';

import {
  classifyBootstrapCompleteness,
  type BootstrapCompleteness,
  type BootstrapCompletenessState,
} from './snapshots.js';

export const DEFAULT_INIT_TIMEOUT_MS = 180_000;
export const DEFAULT_BOOTSTRAP_VERIFICATION_TIMEOUT_MS = 12_000;
export const DEFAULT_BOOTSTRAP_POLL_INTERVAL_MS = 250;
export const MAX_INIT_OUTPUT_EXCERPT_LENGTH = 1_200;

const DEFAULT_GSD_BIN_PATH = process.env.GSD_BIN_PATH?.trim() || 'gsd';
const DEFAULT_PYTHON_BIN_PATH = 'python3';

export type InitJobStage =
  | 'queued'
  | 'starting'
  | 'project_setup'
  | 'workflow_mode'
  | 'git_settings'
  | 'project_instructions'
  | 'advanced_settings'
  | 'essential_skills'
  | 'review_preferences'
  | 'verifying_bootstrap'
  | 'completed'
  | 'failed'
  | 'timed_out';

export type InitPromptAction = 'accept_recommended' | 'skip_optional_step';

export interface InitPromptMatch {
  promptId: string;
  heading: string;
  stage: Exclude<InitJobStage, 'queued' | 'starting' | 'verifying_bootstrap' | 'completed' | 'failed' | 'timed_out'>;
  action: InitPromptAction;
  matchedAt: string;
}

export interface InitStageUpdate {
  stage: InitJobStage;
  matchedPrompt: InitPromptMatch | null;
  excerpt: string;
  detail: string;
  emittedAt: string;
}

export interface RunOfficialInitOptions {
  gsdBinPath?: string;
  pythonBinPath?: string;
  timeoutMs?: number;
  bootstrapTimeoutMs?: number;
  bootstrapPollIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
  onStage?: (update: InitStageUpdate) => void;
}

export interface InitRunResult {
  outcome: 'completed' | 'failed' | 'timed_out';
  stage: InitJobStage;
  bootstrap: BootstrapCompleteness;
  promptHistory: InitPromptMatch[];
  lastMatchedPrompt: InitPromptMatch | null;
  outputExcerpt: string;
  errorDetail: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface InitPromptDefinition {
  id: string;
  heading: string;
  stage: InitPromptMatch['stage'];
  action: InitPromptAction;
  send: string;
}

interface DriverStageEvent {
  type: 'stage';
  stage: InitPromptMatch['stage'];
  detail: string;
  excerpt: string;
  matchedPrompt: {
    promptId: string;
    heading: string;
    action: InitPromptAction;
    matchedAt: string;
  };
}

interface DriverResultEvent {
  type: 'result';
  status: 'success' | 'failed' | 'timed_out';
  detail: string;
  excerpt: string;
  lastHeading: string | null;
  exitCode: number | null;
  signal: string | null;
}

type DriverEvent = DriverStageEvent | DriverResultEvent;

const INIT_PROMPTS: InitPromptDefinition[] = [
  {
    id: 'project_setup',
    heading: 'GSD — Project Setup',
    stage: 'project_setup',
    action: 'accept_recommended',
    send: '\r',
  },
  {
    id: 'workflow_mode',
    heading: 'GSD — Workflow Mode',
    stage: 'workflow_mode',
    action: 'accept_recommended',
    send: '\r',
  },
  {
    id: 'git_settings',
    heading: 'GSD — Git Settings',
    stage: 'git_settings',
    action: 'accept_recommended',
    send: '\r',
  },
  {
    id: 'project_instructions',
    heading: 'GSD — Project Instructions',
    stage: 'project_instructions',
    action: 'accept_recommended',
    send: '\r',
  },
  {
    id: 'advanced_settings',
    heading: 'GSD — Advanced Settings',
    stage: 'advanced_settings',
    action: 'accept_recommended',
    send: '\r',
  },
  {
    id: 'essential_skills',
    heading: 'GSD — Install Essential Skills',
    stage: 'essential_skills',
    action: 'skip_optional_step',
    send: '2',
  },
  {
    id: 'review_preferences',
    heading: 'GSD — Review All Preferences (Optional)',
    stage: 'review_preferences',
    action: 'accept_recommended',
    send: '\r',
  },
];

const PTY_DRIVER_SCRIPT = String.raw`
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time

ANSI_RE = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')
OSC_RE = re.compile(r'\x1b\].*?(?:\x07|\x1b\\)')
HEADING_RE = re.compile(r'^\s*✓\s+(GSD — [^\n\r]+)', re.MULTILINE)


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def strip_ansi(text):
    return OSC_RE.sub('', ANSI_RE.sub('', text))


def trim_excerpt(text, max_len):
    normalized = text.strip()
    if len(normalized) <= max_len:
        return normalized
    return normalized[-max_len:]


def terminate_process(proc):
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=3)


def main():
    config = json.load(sys.stdin)
    env = config['env']
    prompts = config['prompts']
    known_headings = {prompt['heading'] for prompt in prompts}
    success_markers = config['successMarkers']
    ready_markers = config['readyMarkers']
    max_excerpt = config['maxExcerptLength']
    post_success_delay_seconds = config['postSuccessDelayMs'] / 1000.0
    start_sequence = config['startSequence']
    send_delay = config['startSequenceDelayMs'] / 1000.0
    timeout_seconds = config['timeoutMs'] / 1000.0

    try:
        master, slave = pty.openpty()
        process = subprocess.Popen(
            config['command'],
            cwd=config['cwd'],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env=env,
            text=False,
            close_fds=True,
        )
        os.close(slave)
    except FileNotFoundError as error:
        emit({
            'type': 'result',
            'status': 'failed',
            'detail': f'Missing executable for init driver: {error.filename}',
            'excerpt': '',
            'lastHeading': None,
            'exitCode': None,
            'signal': None,
        })
        return 1

    raw_buffer = bytearray()
    seen_prompts = set()
    open_sequence_sent = False
    start_time = time.time()
    last_heading = None

    try:
        while True:
            if time.time() - start_time > timeout_seconds:
                terminate_process(process)
                emit({
                    'type': 'result',
                    'status': 'timed_out',
                    'detail': f'Init wizard exceeded {config["timeoutMs"]}ms.',
                    'excerpt': trim_excerpt(strip_ansi(raw_buffer.decode("utf-8", "ignore")), max_excerpt),
                    'lastHeading': last_heading,
                    'exitCode': process.returncode,
                    'signal': None,
                })
                return 0

            ready, _, _ = select.select([master], [], [], 0.2)

            if master in ready:
                try:
                    chunk = os.read(master, 8192)
                except OSError:
                    chunk = b''

                if chunk:
                    raw_buffer.extend(chunk)
                    if len(raw_buffer) > 65536:
                        del raw_buffer[:-32768]

                cleaned = strip_ansi(raw_buffer.decode('utf-8', 'ignore'))
                excerpt = trim_excerpt(cleaned, max_excerpt)
                headings = HEADING_RE.findall(cleaned)
                if headings:
                    last_heading = headings[-1]

                if not open_sequence_sent and (time.time() - start_time > 1.5 or any(marker in cleaned for marker in ready_markers)):
                    for piece in start_sequence:
                        os.write(master, piece.encode('utf-8'))
                        time.sleep(send_delay)
                    open_sequence_sent = True

                if 'GSD — Already Initialized' in cleaned:
                    terminate_process(process)
                    emit({
                        'type': 'result',
                        'status': 'failed',
                        'detail': 'Official init reported an already-initialized project before bootstrap verification.',
                        'excerpt': excerpt,
                        'lastHeading': 'GSD — Already Initialized',
                        'exitCode': process.returncode,
                        'signal': None,
                    })
                    return 0

                for heading in headings:
                    if heading not in known_headings and not any(marker in cleaned for marker in success_markers):
                        terminate_process(process)
                        emit({
                            'type': 'result',
                            'status': 'failed',
                            'detail': f'Unsupported init prompt: {heading}',
                            'excerpt': excerpt,
                            'lastHeading': heading,
                            'exitCode': process.returncode,
                            'signal': None,
                        })
                        return 0

                for prompt in prompts:
                    if prompt['id'] in seen_prompts:
                        continue
                    if prompt['heading'] not in cleaned:
                        continue

                    os.write(master, prompt['send'].encode('utf-8'))
                    seen_prompts.add(prompt['id'])
                    emit({
                        'type': 'stage',
                        'stage': prompt['stage'],
                        'detail': f'Matched {prompt["heading"]} and sent the supported default response.',
                        'excerpt': excerpt,
                        'matchedPrompt': {
                            'promptId': prompt['id'],
                            'heading': prompt['heading'],
                            'action': prompt['action'],
                            'matchedAt': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()),
                        },
                    })
                    time.sleep(0.2)
                    break

                if any(marker in cleaned for marker in success_markers):
                    success_deadline = time.time() + post_success_delay_seconds

                    while time.time() < success_deadline and process.poll() is None:
                        ready_after_success, _, _ = select.select([master], [], [], 0.1)

                        if master not in ready_after_success:
                            continue

                        try:
                            trailing_chunk = os.read(master, 8192)
                        except OSError:
                            trailing_chunk = b''

                        if not trailing_chunk:
                            continue

                        raw_buffer.extend(trailing_chunk)
                        if len(raw_buffer) > 65536:
                            del raw_buffer[:-32768]

                    cleaned = strip_ansi(raw_buffer.decode('utf-8', 'ignore'))
                    excerpt = trim_excerpt(cleaned, max_excerpt)
                    headings = HEADING_RE.findall(cleaned)
                    if headings:
                        last_heading = headings[-1]

                    terminate_process(process)
                    emit({
                        'type': 'result',
                        'status': 'success',
                        'detail': 'Official init completed its supported default wizard path.',
                        'excerpt': excerpt,
                        'lastHeading': last_heading,
                        'exitCode': process.returncode,
                        'signal': None,
                    })
                    return 0

            if process.poll() is not None:
                cleaned = strip_ansi(raw_buffer.decode('utf-8', 'ignore'))
                emit({
                    'type': 'result',
                    'status': 'failed',
                    'detail': 'Official init exited before bootstrap success was observed.',
                    'excerpt': trim_excerpt(cleaned, max_excerpt),
                    'lastHeading': last_heading,
                    'exitCode': process.returncode,
                    'signal': None,
                })
                return 0
    finally:
        try:
            os.close(master)
        except OSError:
            pass


if __name__ == '__main__':
    raise SystemExit(main())
`;

function trimOutputExcerpt(excerpt: string) {
  const normalized = excerpt.trim();

  return normalized.length <= MAX_INIT_OUTPUT_EXCERPT_LENGTH
    ? normalized
    : normalized.slice(-MAX_INIT_OUTPUT_EXCERPT_LENGTH);
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function sanitizeInitEnvironment(projectRoot: string, extraEnv: NodeJS.ProcessEnv | undefined) {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    PWD: projectRoot,
  };

  delete merged.GSD_PROJECT_ROOT;

  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as NodeJS.ProcessEnv;
}

function emitStage(
  options: RunOfficialInitOptions,
  stage: InitJobStage,
  excerpt: string,
  detail: string,
  matchedPrompt: InitPromptMatch | null,
) {
  options.onStage?.({
    stage,
    matchedPrompt,
    excerpt: trimOutputExcerpt(excerpt),
    detail,
    emittedAt: new Date().toISOString(),
  });
}

function toFailedResult(
  stage: InitJobStage,
  bootstrap: BootstrapCompleteness,
  outputExcerpt: string,
  errorDetail: string,
  promptHistory: InitPromptMatch[],
  exitCode: number | null = null,
  signal: NodeJS.Signals | null = null,
): InitRunResult {
  return {
    outcome: stage === 'timed_out' ? 'timed_out' : 'failed',
    stage,
    bootstrap,
    promptHistory,
    lastMatchedPrompt: promptHistory.at(-1) ?? null,
    outputExcerpt: trimOutputExcerpt(outputExcerpt),
    errorDetail,
    exitCode,
    signal,
  };
}

async function waitForBootstrapCompleteness(
  projectRoot: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<BootstrapCompleteness> {
  const deadline = Date.now() + timeoutMs;
  let lastClassification = await classifyBootstrapCompleteness(projectRoot);

  while (Date.now() < deadline) {
    if (lastClassification.state === 'complete') {
      return lastClassification;
    }

    await sleep(pollIntervalMs);
    lastClassification = await classifyBootstrapCompleteness(projectRoot);
  }

  return lastClassification;
}

async function runPtyInitDriver(
  projectRoot: string,
  options: RunOfficialInitOptions,
): Promise<{
  promptHistory: InitPromptMatch[];
  result: DriverResultEvent;
}> {
  const pythonBinPath = options.pythonBinPath?.trim() || DEFAULT_PYTHON_BIN_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  const child = spawn(pythonBinPath, ['-u', '-c', PTY_DRIVER_SCRIPT], {
    cwd: projectRoot,
    env: sanitizeInitEnvironment(projectRoot, options.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const config = {
    command: [options.gsdBinPath?.trim() || DEFAULT_GSD_BIN_PATH],
    cwd: projectRoot,
    env: sanitizeInitEnvironment(projectRoot, options.env),
    prompts: INIT_PROMPTS,
    successMarkers: [
      'Project initialized — run /gsd to continue setup',
      'GSD initialized. Starting your first milestone',
    ],
    readyMarkers: ['No project loaded — run /gsd to start', '/gsd to begin'],
    startSequence: ['/', 'g', 'sd init', '\r'],
    startSequenceDelayMs: 150,
    postSuccessDelayMs: 3_000,
    maxExcerptLength: MAX_INIT_OUTPUT_EXCERPT_LENGTH,
    timeoutMs,
  };

  child.stdin.end(`${JSON.stringify(config)}\n`);

  const promptHistory: InitPromptMatch[] = [];
  let stderrBuffer = '';
  let stdoutBuffer = '';
  let parsedResult: DriverResultEvent | null = null;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;

    while (stdoutBuffer.includes('\n')) {
      const newlineIndex = stdoutBuffer.indexOf('\n');
      const rawLine = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      if (rawLine.length === 0) {
        continue;
      }

      const event = JSON.parse(rawLine) as DriverEvent;

      if (event.type === 'stage') {
        const prompt = INIT_PROMPTS.find((candidate) => candidate.id === event.matchedPrompt.promptId);

        if (!prompt) {
          continue;
        }

        const matchedPrompt: InitPromptMatch = {
          promptId: prompt.id,
          heading: prompt.heading,
          stage: prompt.stage,
          action: prompt.action,
          matchedAt: event.matchedPrompt.matchedAt,
        };

        promptHistory.push(matchedPrompt);
        emitStage(options, prompt.stage, event.excerpt, event.detail, matchedPrompt);
        continue;
      }

      parsedResult = event;
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk;
  });

  const exitState = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        code,
        signal,
      });
    });
  });

  const driverResult = parsedResult as DriverResultEvent | null;

  if (driverResult !== null) {
    return {
      promptHistory,
      result: {
        ...driverResult,
        exitCode: driverResult.exitCode ?? exitState.code,
        signal: (driverResult.signal as NodeJS.Signals | null) ?? exitState.signal,
      },
    };
  }

  return {
    promptHistory,
    result: {
      type: 'result',
      status: 'failed',
      detail:
        stderrBuffer.trim().length > 0
          ? `Init PTY driver failed: ${stderrBuffer.trim()}`
          : 'Init PTY driver exited without a structured result.',
      excerpt: '',
      lastHeading: null,
      exitCode: exitState.code,
      signal: exitState.signal,
    },
  };
}

function describeBlockedBootstrap(state: BootstrapCompletenessState) {
  switch (state) {
    case 'complete':
      return 'Project already contains a bootstrap-complete .gsd directory.';
    case 'partial':
      return 'Project already contains a partial .gsd bootstrap surface; retry from a clean workspace.';
    case 'ancestor_conflict':
      return 'Project is shadowed by an ancestor-owned .gsd directory.';
    case 'absent':
    default:
      return 'Project does not have bootstrap state yet.';
  }
}

export async function runOfficialGsdInit(projectRoot: string, options: RunOfficialInitOptions = {}): Promise<InitRunResult> {
  const initialBootstrap = await classifyBootstrapCompleteness(projectRoot);

  if (initialBootstrap.state !== 'absent') {
    const stage = initialBootstrap.state === 'partial' ? 'failed' : 'failed';
    const errorDetail = `${describeBlockedBootstrap(initialBootstrap.state)} ${initialBootstrap.detail}`;

    emitStage(options, stage, '', errorDetail, null);

    return toFailedResult(stage, initialBootstrap, '', errorDetail, []);
  }

  emitStage(options, 'starting', '', 'Launching the official gsd init wizard through a PTY driver.', null);

  const driverRun = await runPtyInitDriver(projectRoot, options);
  const outputExcerpt = driverRun.result.excerpt;

  if (driverRun.result.status === 'timed_out') {
    const timedOutBootstrap = await classifyBootstrapCompleteness(projectRoot);
    const errorDetail = driverRun.result.detail;

    emitStage(options, 'timed_out', outputExcerpt, errorDetail, driverRun.promptHistory.at(-1) ?? null);

    return toFailedResult(
      'timed_out',
      timedOutBootstrap,
      outputExcerpt,
      errorDetail,
      driverRun.promptHistory,
      driverRun.result.exitCode,
      driverRun.result.signal as NodeJS.Signals | null,
    );
  }

  if (driverRun.result.status !== 'success') {
    const failedBootstrap = await classifyBootstrapCompleteness(projectRoot);
    const errorDetail = driverRun.result.detail;

    emitStage(options, 'failed', outputExcerpt, errorDetail, driverRun.promptHistory.at(-1) ?? null);

    return toFailedResult(
      'failed',
      failedBootstrap,
      outputExcerpt,
      errorDetail,
      driverRun.promptHistory,
      driverRun.result.exitCode,
      driverRun.result.signal as NodeJS.Signals | null,
    );
  }

  emitStage(
    options,
    'verifying_bootstrap',
    outputExcerpt,
    'Official init reported success; verifying bootstrap completeness before promotion.',
    driverRun.promptHistory.at(-1) ?? null,
  );

  const bootstrap = await waitForBootstrapCompleteness(
    projectRoot,
    options.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_VERIFICATION_TIMEOUT_MS,
    options.bootstrapPollIntervalMs ?? DEFAULT_BOOTSTRAP_POLL_INTERVAL_MS,
  );

  if (bootstrap.state !== 'complete') {
    const errorDetail = `Bootstrap completeness gate blocked success: ${bootstrap.detail}`;

    emitStage(options, 'failed', outputExcerpt, errorDetail, driverRun.promptHistory.at(-1) ?? null);

    return toFailedResult(
      'failed',
      bootstrap,
      outputExcerpt,
      errorDetail,
      driverRun.promptHistory,
      driverRun.result.exitCode,
      driverRun.result.signal as NodeJS.Signals | null,
    );
  }

  emitStage(options, 'completed', outputExcerpt, bootstrap.detail, driverRun.promptHistory.at(-1) ?? null);

  return {
    outcome: 'completed',
    stage: 'completed',
    bootstrap,
    promptHistory: driverRun.promptHistory,
    lastMatchedPrompt: driverRun.promptHistory.at(-1) ?? null,
    outputExcerpt: trimOutputExcerpt(outputExcerpt),
    errorDetail: null,
    exitCode: driverRun.result.exitCode,
    signal: driverRun.result.signal as NodeJS.Signals | null,
  };
}
