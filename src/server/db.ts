import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type {
  ProjectEventEnvelope,
  ProjectEventPayload,
  ProjectEventType,
  ProjectRecord,
  ProjectSnapshot,
  ProjectSnapshotEventPayload,
  ServiceReadyEventPayload,
} from '../shared/contracts.js';

export const REGISTRY_SCHEMA_VERSION = '2';

interface ProjectRow {
  project_id: string;
  registered_path: string;
  canonical_path: string;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
  last_event_sequence: number | null;
}

interface EventRow {
  sequence: number;
  event_type: ProjectEventType;
  project_id: string | null;
  emitted_at: string;
  payload_json: string;
}

export interface RegisterProjectInput {
  projectId?: string;
  registeredPath: string;
  canonicalPath: string;
  snapshot: ProjectSnapshot;
  eventPayload: ProjectSnapshotEventPayload;
}

export interface RefreshProjectInput {
  projectId: string;
  snapshot: ProjectSnapshot;
  eventPayload: ProjectSnapshotEventPayload;
}

export class DuplicateProjectError extends Error {
  readonly canonicalPath: string;

  constructor(canonicalPath: string) {
    super(`Project path is already registered: ${canonicalPath}`);
    this.name = 'DuplicateProjectError';
    this.canonicalPath = canonicalPath;
  }
}

export class ProjectNotFoundError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`Unknown project id: ${projectId}`);
    this.name = 'ProjectNotFoundError';
    this.projectId = projectId;
  }
}

function createProjectId() {
  return `prj_${randomUUID()}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error
    && (/SQLITE_CONSTRAINT/i.test(error.message) || /UNIQUE constraint failed/i.test(error.message))
    && /projects\.canonical_path/i.test(error.message)
  );
}

function parseProjectRow(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.project_id,
    registeredPath: row.registered_path,
    canonicalPath: row.canonical_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEventId: row.last_event_sequence === null ? null : `evt_${row.last_event_sequence}`,
    snapshot: JSON.parse(row.snapshot_json) as ProjectSnapshot,
  };
}

function parseEventRow<TPayload extends ProjectEventPayload>(row: EventRow): ProjectEventEnvelope<TPayload> {
  return {
    id: `evt_${row.sequence}`,
    sequence: row.sequence,
    type: row.event_type,
    emittedAt: row.emitted_at,
    projectId: row.project_id,
    payload: JSON.parse(row.payload_json) as TPayload,
  };
}

export class RegistryDatabase {
  private readonly database: DatabaseSync;

  constructor(private readonly databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.initializeSchema();
  }

  close() {
    this.database.close();
  }

  getDatabasePath() {
    return this.databasePath;
  }

  getProjectCount() {
    const row = this.database
      .prepare('SELECT COUNT(*) AS total FROM projects')
      .get() as { total: number };

    return row.total;
  }

  listProjects(): ProjectRecord[] {
    const rows = this.database
      .prepare(
        `SELECT
          project_id,
          registered_path,
          canonical_path,
          snapshot_json,
          created_at,
          updated_at,
          last_event_sequence
        FROM projects
        ORDER BY created_at ASC, project_id ASC`,
      )
      .all() as unknown as ProjectRow[];

    return rows.map((row) => parseProjectRow(row));
  }

  getProjectById(projectId: string): ProjectRecord | null {
    const row = this.database
      .prepare(
        `SELECT
          project_id,
          registered_path,
          canonical_path,
          snapshot_json,
          created_at,
          updated_at,
          last_event_sequence
        FROM projects
        WHERE project_id = ?`,
      )
      .get(projectId) as ProjectRow | undefined;

    return row ? parseProjectRow(row) : null;
  }

  getProjectByCanonicalPath(canonicalPath: string): ProjectRecord | null {
    const row = this.database
      .prepare(
        `SELECT
          project_id,
          registered_path,
          canonical_path,
          snapshot_json,
          created_at,
          updated_at,
          last_event_sequence
        FROM projects
        WHERE canonical_path = ?`,
      )
      .get(canonicalPath) as ProjectRow | undefined;

    return row ? parseProjectRow(row) : null;
  }

  registerProject(input: RegisterProjectInput): {
    project: ProjectRecord;
    event: ProjectEventEnvelope<ProjectSnapshotEventPayload>;
  } {
    const now = input.snapshot.checkedAt;
    const projectId = input.projectId ?? createProjectId();
    const snapshotJson = JSON.stringify(input.snapshot);

    this.begin();

    try {
      this.database
        .prepare(
          `INSERT INTO projects (
            project_id,
            registered_path,
            canonical_path,
            snapshot_json,
            created_at,
            updated_at,
            last_event_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(projectId, input.registeredPath, input.canonicalPath, snapshotJson, now, now);

      const event = this.insertEvent('project.registered', projectId, now, input.eventPayload);

      this.database
        .prepare('UPDATE projects SET last_event_sequence = ? WHERE project_id = ?')
        .run(event.sequence, projectId);

      this.commit();

      return {
        project: this.requireProject(projectId),
        event,
      };
    } catch (error) {
      this.rollback();

      if (isUniqueConstraintError(error)) {
        throw new DuplicateProjectError(input.canonicalPath);
      }

      throw error;
    }
  }

  refreshProject(input: RefreshProjectInput): {
    project: ProjectRecord;
    event: ProjectEventEnvelope<ProjectSnapshotEventPayload>;
  } {
    const existing = this.getProjectById(input.projectId);

    if (!existing) {
      throw new ProjectNotFoundError(input.projectId);
    }

    const now = input.snapshot.checkedAt;
    const snapshotJson = JSON.stringify(input.snapshot);

    this.begin();

    try {
      const updateResult = this.database
        .prepare(
          `UPDATE projects
          SET snapshot_json = ?, updated_at = ?
          WHERE project_id = ?`,
        )
        .run(snapshotJson, now, input.projectId);

      if (Number(updateResult.changes) !== 1) {
        throw new ProjectNotFoundError(input.projectId);
      }

      const event = this.insertEvent('project.refreshed', input.projectId, now, input.eventPayload);

      this.database
        .prepare('UPDATE projects SET last_event_sequence = ? WHERE project_id = ?')
        .run(event.sequence, input.projectId);

      this.commit();

      return {
        project: this.requireProject(input.projectId),
        event,
      };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  appendServiceReadyEvent(payload: ServiceReadyEventPayload, emittedAt: string = new Date().toISOString()) {
    return this.insertEvent('service.ready', null, emittedAt, payload);
  }

  listEventsAfter(sequence: number, limit: number = 100): ProjectEventEnvelope[] {
    const rows = this.database
      .prepare(
        `SELECT
          sequence,
          event_type,
          project_id,
          emitted_at,
          payload_json
        FROM project_events
        WHERE sequence > ?
        ORDER BY sequence ASC
        LIMIT ?`,
      )
      .all(sequence, limit) as unknown as EventRow[];

    return rows.map((row) => parseEventRow(row));
  }

  private initializeSchema() {
    this.database.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS service_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        registered_path TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_event_sequence INTEGER,
        FOREIGN KEY(last_event_sequence) REFERENCES project_events(sequence)
      );

      CREATE TABLE IF NOT EXISTS project_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        project_id TEXT,
        emitted_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );

      CREATE INDEX IF NOT EXISTS idx_projects_canonical_path ON projects(canonical_path);
      CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);
      CREATE INDEX IF NOT EXISTS idx_project_events_project_id ON project_events(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_events_emitted_at ON project_events(emitted_at);
    `);

    const upsertMetadata = this.database.prepare(`
      INSERT INTO service_metadata (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    upsertMetadata.run('schemaVersion', REGISTRY_SCHEMA_VERSION);
    upsertMetadata.run('lastBootedAt', new Date().toISOString());
  }

  private insertEvent<TPayload extends ProjectEventPayload>(
    eventType: ProjectEventType,
    projectId: string | null,
    emittedAt: string,
    payload: TPayload,
  ): ProjectEventEnvelope<TPayload> {
    const result = this.database
      .prepare(
        `INSERT INTO project_events (
          event_type,
          project_id,
          emitted_at,
          payload_json
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(eventType, projectId, emittedAt, JSON.stringify(payload));

    const sequence = Number(result.lastInsertRowid);

    return {
      id: `evt_${sequence}`,
      sequence,
      type: eventType,
      emittedAt,
      projectId,
      payload,
    };
  }

  private requireProject(projectId: string): ProjectRecord {
    const project = this.getProjectById(projectId);

    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }

    return project;
  }

  private begin() {
    this.database.exec('BEGIN IMMEDIATE');
  }

  private commit() {
    this.database.exec('COMMIT');
  }

  private rollback() {
    try {
      this.database.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors when no transaction is active.
    }
  }
}
