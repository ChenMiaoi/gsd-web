import { execFileSync } from 'node:child_process';

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

const [packResult] = JSON.parse(output);

if (!packResult || !Array.isArray(packResult.files)) {
  throw new Error('npm pack did not return a file list.');
}

const files = new Set(packResult.files.map((file) => file.path));
const requiredFiles = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/server/server/index.js',
  'dist/server/server/index.d.ts',
  'dist/server/shared/contracts.js',
  'dist/web/index.html',
  'docs/assets/gsd-web-detail-01.png',
  'docs/assets/gsd-web-detail-02.png',
  'docs/assets/gsd-web-overview-01.png',
  'docs/assets/gsd-web-overview-02.png',
];
const forbiddenPrefixes = ['src/', 'tests/', '.github/', '.gsd', 'test-results/', 'playwright-report/'];

for (const requiredFile of requiredFiles) {
  if (!files.has(requiredFile)) {
    throw new Error(`npm package is missing required file: ${requiredFile}`);
  }
}

for (const file of files) {
  if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
    throw new Error(`npm package includes development-only file: ${file}`);
  }
}

console.info(`npm package dry-run passed: ${packResult.name}@${packResult.version} (${files.size} files).`);
