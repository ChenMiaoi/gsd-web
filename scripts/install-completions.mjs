#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const supportedShells = ['bash', 'zsh', 'fish'];

function isTruthy(value) {
  return /^(1|true|yes|on)$/iu.test(value ?? '');
}

function shouldInstall() {
  if (isTruthy(process.env.GSD_WEB_SKIP_COMPLETION_INSTALL)) {
    return false;
  }

  return process.env.npm_config_global === 'true' || isTruthy(process.env.GSD_WEB_INSTALL_COMPLETIONS);
}

function completionHome() {
  return process.env.GSD_WEB_COMPLETION_HOME?.trim() || homedir();
}

function resolveRequestedShells() {
  const configured = process.env.GSD_WEB_COMPLETION_SHELLS?.trim();

  if (!configured) {
    return supportedShells;
  }

  return configured
    .split(',')
    .map((shell) => shell.trim())
    .filter((shell) => supportedShells.includes(shell));
}

function completionPaths(shell, homeDirectory) {
  const prefix = process.env.npm_config_prefix?.trim();

  switch (shell) {
    case 'bash':
      return [
        ...(prefix ? [path.join(prefix, 'share', 'bash-completion', 'completions', 'gsd-web')] : []),
        path.join(
          process.env.XDG_DATA_HOME?.trim() || path.join(homeDirectory, '.local', 'share'),
          'bash-completion',
          'completions',
          'gsd-web',
        ),
      ];
    case 'zsh':
      return [
        ...(prefix ? [path.join(prefix, 'share', 'zsh', 'site-functions', '_gsd-web')] : []),
        path.join(process.env.ZDOTDIR?.trim() || path.join(homeDirectory, '.zsh'), 'completions', '_gsd-web'),
      ];
    case 'fish':
      return [
        ...(prefix ? [path.join(prefix, 'share', 'fish', 'vendor_completions.d', 'gsd-web.fish')] : []),
        path.join(
          process.env.XDG_CONFIG_HOME?.trim() || path.join(homeDirectory, '.config'),
          'fish',
          'completions',
          'gsd-web.fish',
        ),
      ];
    default:
      throw new Error(`Unsupported completion shell: ${shell}`);
  }
}

async function loadCompletionBuilder() {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const moduleUrl = pathToFileURL(path.join(packageRoot, 'dist/server/server/index.js')).href;
  const cliModule = await import(moduleUrl);

  if (typeof cliModule.buildCompletionScript !== 'function') {
    throw new Error('Compiled gsd-web CLI does not export buildCompletionScript.');
  }

  return cliModule.buildCompletionScript;
}

async function installCompletions() {
  if (!shouldInstall()) {
    return;
  }

  const buildCompletionScript = await loadCompletionBuilder();
  const homeDirectory = completionHome();
  const installedPaths = [];
  const failedPaths = [];

  for (const shell of resolveRequestedShells()) {
    const script = `${buildCompletionScript(shell)}\n`;

    for (const targetPath of completionPaths(shell, homeDirectory)) {
      try {
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, script, 'utf8');
        installedPaths.push(targetPath);
      } catch (error) {
        failedPaths.push(`${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (installedPaths.length > 0) {
    console.info(`gsd-web installed shell completions:\n${installedPaths.map((filePath) => `  ${filePath}`).join('\n')}`);
  } else if (failedPaths.length > 0) {
    throw new Error(`no completion files could be written; ${failedPaths.join('; ')}`);
  }
}

installCompletions().catch((error) => {
  console.warn(`gsd-web could not install shell completions: ${error instanceof Error ? error.message : String(error)}`);
});
