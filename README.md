# gsd-web

`gsd-web` is a local-first dashboard for GSD workspaces. It registers projects on your machine, watches their `.gsd` state, keeps a durable SQLite registry, and renders a React interface for project inventory, continuity, initialization, workflow progress, metrics, and timeline events.

The project is designed for contributors who need to run the service locally, inspect project state safely, and extend the dashboard without changing the GSD workspace format.

## What It Does

- Registers local project paths and assigns each project a stable `projectId`.
- Reads `.gsd` bootstrap artifacts in a read-only snapshot pass.
- Classifies projects as `initialized`, `uninitialized`, or `degraded`.
- Tracks path loss, recovery, relinking, refreshes, and monitor health.
- Starts supported `gsd init` flows from the browser UI.
- Streams project events to the UI with Server-Sent Events.
- Visualizes milestones, slices, tasks, dependencies, runtime metrics, model usage, and timeline activity.
- Supports English and Chinese UI copy.

## Requirements

- Node.js `>=24.0.0`
- npm
- Optional, for browser-triggered initialization:
  - `gsd`
  - `python3`

Node 24 is required because the server uses modern Node APIs, including the built-in SQLite binding.

## Quick Start

Install dependencies and build both the browser and server bundles:

```bash
npm install
npm run build
npm run start
```

Then open:

```text
http://127.0.0.1:3000
```

For local development, run the TypeScript server directly:

```bash
npm run dev
```

The development server still serves the built browser bundle. Run `npm run build:web` after changing frontend code.

When installed as a package, the CLI entrypoint is:

```bash
gsd-web
```

## Using The Dashboard

1. Open the welcome page.
2. Enter the project overview.
3. Register an absolute local project path.
4. Select a project to inspect its snapshot, monitor state, continuity, initialization job, workspace notes, source health, workflow data, metrics, and event history.
5. If a project path moves or disappears, use the relink flow to point the existing project record at the new path.

The dashboard keeps the last known good project information in the registry, so path loss does not erase the project from the inventory.

## Browser Routes

| Route | Purpose |
| --- | --- |
| `/lazy` | Welcome page |
| `/lazy/all` | Project overview |
| `/lazy/<projectId>` | Project detail |

The server returns the React shell for deep links, so refreshes and direct project URLs work.

The `/lazy` base path is intentional: the dashboard is for avoiding manual status checks by letting automated monitoring keep watch.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP listen host |
| `PORT` | `3000` | HTTP listen port |
| `GSD_WEB_HOME` | `~/.gsd-web` | Runtime home |
| `GSD_WEB_DATABASE_PATH` | `~/.gsd-web/data/gsd-web.sqlite` | Registry database |
| `GSD_WEB_LOG_DIR` | `~/.gsd-web/logs` | Log directory |
| `GSD_WEB_LOG_FILE` | `~/.gsd-web/logs/gsd-web.log` | JSONL service log |
| `GSD_WEB_LOG_LEVEL` | `info` | Service log level |
| `GSD_WEB_CLIENT_DIST_DIR` | packaged browser build | Static frontend directory |
| `GSD_BIN_PATH` | `gsd` | Executable used by the init runner |

Example:

```bash
PORT=3001 GSD_BIN_PATH=/path/to/gsd gsd-web
```

## Architecture

The code is split into a few layers:

- **HTTP service**: creates the Fastify app, serves static frontend assets, exposes health checks, and wires routes.
- **Registry database**: owns SQLite persistence for projects, snapshots, monitor state, init jobs, and timeline entries.
- **Snapshot reader**: inspects GSD workspace artifacts without mutating the project directory.
- **Reconciler and monitor**: refresh project records, detect path continuity changes, and publish timeline events.
- **Project routes**: handle registration, refresh, relink, initialization, timeline reads, and directory browsing.
- **Shared contracts**: define the server-to-browser response and event shapes.
- **Browser app model**: validates API responses, formats state, derives portfolio summaries, and calculates workflow metrics.
- **Browser components**: render the application shell and reusable workflow visualizations.

This keeps IO, persistence, contracts, derived view data, and UI rendering separate enough that a contributor can change one layer without rewriting the others.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Service health and schema version |
| `GET` | `/api/projects` | Registered project inventory |
| `POST` | `/api/projects/register` | Register a local project path |
| `GET` | `/api/projects/<projectId>` | Project detail with recent timeline |
| `GET` | `/api/projects/<projectId>/timeline` | Project timeline |
| `POST` | `/api/projects/<projectId>/refresh` | Force a snapshot refresh |
| `POST` | `/api/projects/<projectId>/init` | Start supported GSD initialization |
| `POST` | `/api/projects/<projectId>/relink` | Attach a lost project record to a new path |
| `GET` | `/api/filesystem/directories` | Browse server-side directories for registration |
| `GET` | `/api/events` | Server-Sent Events stream |

Example registration:

```bash
curl -X POST http://127.0.0.1:3000/api/projects/register \
  -H 'content-type: application/json' \
  -d '{"path":"/absolute/path/to/project"}'
```

Example event stream:

```bash
curl -N http://127.0.0.1:3000/api/events
```

## Snapshot Model

A project without a `.gsd` directory is `uninitialized`.

A project with complete and readable GSD bootstrap data is `initialized`.

A project with missing, unreadable, or malformed GSD data is `degraded`. The snapshot includes warnings for each affected source so the UI can show what needs attention.

The reader checks directory presence, project identity, repository metadata, lock state, state notes, runtime metrics, and workflow database summaries where available.

## Development

```bash
npm run clean
npm run build
npm run build:web
npm run build:server
npm run dev
npm test
npm run test:e2e
```

Before opening a pull request, run:

```bash
npm run build
npm test
npm run test:e2e
```

GitHub Actions runs the same build, integration test, and browser test checks on pushes and pull requests.

## Contribution Notes

- Keep server responses and browser parsers aligned with the shared contracts.
- Prefer read-only project inspection unless a route explicitly performs a user-requested action.
- Preserve existing project IDs during refresh and relink flows.
- Add integration tests for server behavior and Playwright tests for user-visible workflows.
- Keep browser view logic in derived model helpers when it is shared across panels.
