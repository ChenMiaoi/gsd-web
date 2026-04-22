import { type CSSProperties, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

type HealthResponse = {
  service: string;
  status: 'ok';
  checkedAt: string;
  database: {
    connected: boolean;
    fileName: string;
    schemaVersion: string;
  };
  assets: {
    available: boolean;
    directoryName: string;
  };
  projects: {
    total: number;
  };
};

type ProjectsResponse = {
  items: [];
  total: number;
};

const cardStyle = {
  border: '1px solid rgba(148, 163, 184, 0.35)',
  borderRadius: '1rem',
  padding: '1rem 1.25rem',
  background: 'rgba(15, 23, 42, 0.72)',
  boxShadow: '0 18px 40px rgba(15, 23, 42, 0.24)',
} satisfies CSSProperties;

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [projects, setProjects] = useState<ProjectsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [healthResponse, projectsResponse] = await Promise.all([
          fetch('/api/health'),
          fetch('/api/projects'),
        ]);

        if (!healthResponse.ok) {
          throw new Error(`Health request failed with ${healthResponse.status}`);
        }

        if (!projectsResponse.ok) {
          throw new Error(`Projects request failed with ${projectsResponse.status}`);
        }

        const [nextHealth, nextProjects] = await Promise.all([
          healthResponse.json() as Promise<HealthResponse>,
          projectsResponse.json() as Promise<ProjectsResponse>,
        ]);

        if (!cancelled) {
          setHealth(nextHealth);
          setProjects(nextProjects);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Unknown service error');
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      style={{
        minHeight: '100vh',
        margin: 0,
        padding: '2rem',
        background:
          'radial-gradient(circle at top, rgba(59, 130, 246, 0.25), transparent 35%), #020617',
        color: '#e2e8f0',
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <section
        style={{
          maxWidth: '900px',
          margin: '0 auto',
          display: 'grid',
          gap: '1rem',
        }}
      >
        <header style={cardStyle}>
          <p style={{ margin: 0, color: '#93c5fd', fontWeight: 700, letterSpacing: '0.04em' }}>
            LOCAL-FIRST SERVICE SHELL
          </p>
          <h1 style={{ marginBottom: '0.5rem' }}>gsd-web is ready for inventory and snapshot work.</h1>
          <p style={{ margin: 0, color: '#cbd5e1', lineHeight: 1.6 }}>
            This bootstrap shell proves one Fastify process can host the dashboard, JSON API,
            placeholder SSE contract, and SQLite-backed health status.
          </p>
        </header>

        <section style={{ ...cardStyle, display: 'grid', gap: '0.75rem' }}>
          <h2 style={{ margin: 0 }}>Shell status</h2>
          {error ? (
            <p style={{ margin: 0, color: '#fca5a5' }}>{error}</p>
          ) : health ? (
            <>
              <p style={{ margin: 0 }}>
                Service <strong>{health.service}</strong> reports <strong>{health.status}</strong>.
              </p>
              <ul style={{ margin: 0, paddingLeft: '1.25rem', lineHeight: 1.8 }}>
                <li>SQLite connected: {String(health.database.connected)}</li>
                <li>Database file: {health.database.fileName}</li>
                <li>Schema version: {health.database.schemaVersion}</li>
                <li>Built assets available: {String(health.assets.available)}</li>
                <li>Registered projects: {projects?.total ?? health.projects.total}</li>
              </ul>
            </>
          ) : (
            <p style={{ margin: 0 }}>Loading live service status…</p>
          )}
        </section>

        <section style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Next slice targets</h2>
          <ol style={{ marginBottom: 0, paddingLeft: '1.25rem', lineHeight: 1.8 }}>
            <li>Persist the registry and truthful project snapshot contracts.</li>
            <li>Publish inspectable event envelopes from the real refresh path.</li>
            <li>Replace this shell with the hosted registration and detail dashboard.</li>
          </ol>
        </section>
      </section>
    </main>
  );
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Missing #root mount node for gsd-web shell');
}

createRoot(rootElement).render(<App />);
