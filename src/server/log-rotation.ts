import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { access, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export const DEFAULT_LOG_RETENTION_DAYS = 7;
export const DEFAULT_LOG_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export interface RotatingLogStreamOptions {
  filePath: string;
  retentionDays?: number;
  maxFileSizeBytes?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

interface ArchivedLogFile {
  path: string;
  compressed: boolean;
  dateKey: string;
}

function padDatePart(value: number) {
  return String(value).padStart(2, '0');
}

function toDateKey(value: Date) {
  return `${value.getFullYear()}-${padDatePart(value.getMonth() + 1)}-${padDatePart(value.getDate())}`;
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class RotatingLogStream {
  private readonly filePath: string;
  private readonly directoryPath: string;
  private readonly archiveName: string;
  private readonly archiveExtension: string;
  private readonly archivePattern: RegExp;
  private readonly retentionDays: number;
  private readonly maxFileSizeBytes: number;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private writeChain = Promise.resolve();
  private maintenanceChain = Promise.resolve();
  private currentStream: WriteStream | null = null;
  private currentDateKey: string | null = null;
  private currentSize = 0;
  private closed = false;

  constructor(options: RotatingLogStreamOptions) {
    this.filePath = path.resolve(options.filePath);
    this.directoryPath = path.dirname(this.filePath);

    const parsedPath = path.parse(this.filePath);
    this.archiveName = parsedPath.name;
    this.archiveExtension = parsedPath.ext;
    this.archivePattern = new RegExp(
      `^${escapeRegExp(this.archiveName)}-(\\d{4}-\\d{2}-\\d{2})(?:-(\\d+))?${escapeRegExp(this.archiveExtension)}(?:\\.gz)?$`,
    );
    this.retentionDays = options.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_LOG_MAX_FILE_SIZE_BYTES;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? ((error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`[gsd-web] log rotation failed: ${message}\n`);
    });

    if (!Number.isInteger(this.retentionDays) || this.retentionDays < 0) {
      throw new Error('Log retention days must be a non-negative integer');
    }

    if (!Number.isInteger(this.maxFileSizeBytes) || this.maxFileSizeBytes <= 0) {
      throw new Error('Log max file size must be a positive integer');
    }
  }

  async initialize() {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = this.performInitialization();
    return this.initializePromise;
  }

  write(message: string) {
    if (this.closed) {
      return;
    }

    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await this.initialize();
        await this.writeEntry(message);
      })
      .catch((error) => {
        this.onError(error);
      });
  }

  async close() {
    this.closed = true;

    await this.initialize().catch((error) => {
      this.onError(error);
    });
    await this.writeChain.catch((error) => {
      this.onError(error);
    });
    await this.closeCurrentStream();
    await this.maintenanceChain.catch((error) => {
      this.onError(error);
    });
  }

  private async performInitialization() {
    if (this.initialized) {
      return;
    }

    await mkdir(this.directoryPath, { recursive: true });

    const now = this.now();
    const todayKey = toDateKey(now);
    const activeFileStats = await stat(this.filePath).catch(() => null);

    this.currentDateKey = activeFileStats && activeFileStats.size > 0 ? toDateKey(activeFileStats.mtime) : todayKey;
    this.currentSize = activeFileStats?.size ?? 0;
    this.currentStream = createWriteStream(this.filePath, { flags: 'a' });

    if (
      activeFileStats
      && activeFileStats.size > 0
      && (this.currentDateKey !== todayKey || activeFileStats.size >= this.maxFileSizeBytes)
    ) {
      await this.rotateActiveFile(todayKey);
    }

    this.scheduleMaintenance();
    await this.maintenanceChain;

    this.initialized = true;
  }

  private async writeEntry(message: string) {
    const currentDateKey = toDateKey(this.now());
    const messageSize = Buffer.byteLength(message);

    if (
      this.currentSize > 0
      && (this.currentDateKey !== currentDateKey || this.currentSize + messageSize > this.maxFileSizeBytes)
    ) {
      await this.rotateActiveFile(currentDateKey);
    } else if (this.currentDateKey === null) {
      this.currentDateKey = currentDateKey;
    }

    if (this.currentStream === null) {
      this.currentStream = createWriteStream(this.filePath, { flags: 'a' });
    }

    await new Promise<void>((resolve, reject) => {
      this.currentStream!.write(message, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.currentDateKey = currentDateKey;
    this.currentSize += messageSize;
  }

  private async rotateActiveFile(nextDateKey: string) {
    const archiveDateKey = this.currentDateKey ?? nextDateKey;
    const shouldArchive = this.currentSize > 0 && await pathExists(this.filePath);

    await this.closeCurrentStream();

    if (shouldArchive) {
      const archivePath = await this.resolveArchivePath(archiveDateKey);
      await rename(this.filePath, archivePath);
    }

    this.currentStream = createWriteStream(this.filePath, { flags: 'a' });
    this.currentDateKey = nextDateKey;
    this.currentSize = 0;
    this.scheduleMaintenance();
  }

  private scheduleMaintenance() {
    this.maintenanceChain = this.maintenanceChain
      .catch(() => undefined)
      .then(() => this.performMaintenance())
      .catch((error) => {
        this.onError(error);
      });
  }

  private async performMaintenance() {
    const archiveFiles = await this.listArchiveFiles();

    for (const archiveFile of archiveFiles) {
      if (!archiveFile.compressed) {
        await this.compressArchive(archiveFile.path);
      }
    }

    const expirationThreshold = toDateKey(addDays(startOfDay(this.now()), -this.retentionDays));
    const compressedArchives = await this.listArchiveFiles();

    for (const archiveFile of compressedArchives) {
      if (archiveFile.dateKey < expirationThreshold) {
        await rm(archiveFile.path, { force: true });
      }
    }
  }

  private async listArchiveFiles(): Promise<ArchivedLogFile[]> {
    const directoryEntries = await readdir(this.directoryPath, { withFileTypes: true });
    const archiveFiles: ArchivedLogFile[] = [];

    for (const directoryEntry of directoryEntries) {
      if (!directoryEntry.isFile()) {
        continue;
      }

      const match = this.archivePattern.exec(directoryEntry.name);

      if (!match) {
        continue;
      }

      archiveFiles.push({
        path: path.join(this.directoryPath, directoryEntry.name),
        compressed: directoryEntry.name.endsWith('.gz'),
        dateKey: match[1]!,
      });
    }

    archiveFiles.sort((left, right) => left.path.localeCompare(right.path));
    return archiveFiles;
  }

  private async resolveArchivePath(dateKey: string) {
    for (let suffix = 0; ; suffix += 1) {
      const label = suffix === 0 ? dateKey : `${dateKey}-${suffix}`;
      const candidate = path.join(this.directoryPath, `${this.archiveName}-${label}${this.archiveExtension}`);

      if (!await pathExists(candidate) && !await pathExists(`${candidate}.gz`)) {
        return candidate;
      }
    }
  }

  private async compressArchive(archivePath: string) {
    const compressedPath = `${archivePath}.gz`;

    if (await pathExists(compressedPath)) {
      await rm(archivePath, { force: true });
      return;
    }

    try {
      await pipeline(
        createReadStream(archivePath),
        createGzip(),
        createWriteStream(compressedPath),
      );
      await rm(archivePath, { force: true });
    } catch (error) {
      await rm(compressedPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async closeCurrentStream() {
    const stream = this.currentStream;

    if (stream === null) {
      return;
    }

    this.currentStream = null;

    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject);
      stream.end(() => {
        stream.off('error', reject);
        resolve();
      });
    });
  }
}
