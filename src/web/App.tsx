import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';

import { SNAPSHOT_SOURCE_NAMES, type FilesystemDirectoryResponse, type ProjectRecord, type ProjectTimelineResponse } from '../shared/contracts.js';
import {
  LOCALE_STORAGE_KEY,
  UI_COPY,
  getInitialLocale,
  type Locale,
} from './i18n.js';
import {
  APP_PAGES,
  INVENTORY_AUTO_REFRESH_MS,
  ROUTE_BASE_PATH,
  ROUTE_DETAIL_PREFIX,
  ROUTE_OVERVIEW_PATH,
  WORKFLOW_TABS,
  AppPageIcon,
  FolderIcon,
  OpenDetailsIcon,
  WorkflowIcon,
  appPageLabel,
  averageDuration,
  buildPortfolioSummary,
  buildTaskTimelineEntries,
  buildWorkflowExecutionStats,
  clampWarning,
  continuityTone,
  describeContinuityState,
  describeMonitorState,
  describeProject,
  describeTimelineCount,
  findActiveMilestone,
  findActiveSlice,
  findActiveTask,
  formatCompactNumber,
  formatCost,
  formatDuration,
  formatMetricTimestamp,
  formatProjectReconcileTrigger,
  formatRequestError,
  formatTimestamp,
  formatWorkflowStatus,
  getAppRoutePath,
  getCompletedSliceCount,
  getProjectContinuity,
  getRemainingSliceCount,
  getSliceDependencies,
  hasActiveInitJob,
  initButtonLabel,
  isWorkflowStatusActive,
  isWorkflowStatusComplete,
  mergeProjectInitJob,
  normalizePathForComparison,
  orderWorkflowMilestones,
  parseAppRoute,
  parseEventEnvelope,
  parseFilesystemDirectoryResponse,
  parseProjectDetailResponse,
  parseProjectInitEventEnvelope,
  parseProjectMutationResponse,
  parseProjectTimelineResponse,
  parseProjectsResponse,
  requestJson,
  shouldShowInitAction,
  sourceTone,
  statusTone,
  summarizeInitJob,
  timelineTone,
  toExecutionUnit,
  upsertProject,
  workflowTabLabel,
  taskDisplayTitle,
  type AppPage,
  type AppRoute,
  type StreamStatus,
  type StreamResyncStatus,
  type StreamSummary,
  type WorkflowTab,
} from './app/model.js';
import { RuntimeMetricsPanel, WorkflowGraphPanel, WorkflowMilestoneRail } from './components/workflow-panels.js';

export default function App() {
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale());
  const copy = UI_COPY[locale];
  const [appRoute, setAppRoute] = useState<AppRoute>(() => parseAppRoute(window.location.pathname));
  const [activeWorkflowTab, setActiveWorkflowTab] = useState<WorkflowTab>('progress');
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectRecord | null>(null);
  const [projectTimeline, setProjectTimeline] = useState<ProjectTimelineResponse>({
    items: [],
    total: 0,
  });
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [registerPending, setRegisterPending] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerSuccess, setRegisterSuccess] = useState<string | null>(null);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [directoryPicker, setDirectoryPicker] = useState<FilesystemDirectoryResponse | null>(null);
  const [directoryPickerLoading, setDirectoryPickerLoading] = useState(false);
  const [directoryPickerError, setDirectoryPickerError] = useState<string | null>(null);
  const [relinkPath, setRelinkPath] = useState('');
  const [relinkPending, setRelinkPending] = useState(false);
  const [relinkError, setRelinkError] = useState<string | null>(null);
  const [relinkSuccess, setRelinkSuccess] = useState<string | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [initPendingProjectId, setInitPendingProjectId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [initDetailSyncProjectId, setInitDetailSyncProjectId] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');
  const [streamSummary, setStreamSummary] = useState<StreamSummary | null>(null);
  const [streamResyncStatus, setStreamResyncStatus] = useState<StreamResyncStatus>('idle');
  const [streamResyncMessage, setStreamResyncMessage] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const selectedProjectIdRef = useRef<string | null>(null);
  const selectedProjectRef = useRef<ProjectRecord | null>(null);
  const initDetailSyncProjectIdRef = useRef<string | null>(null);
  const inventoryRequestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  const timelineRequestIdRef = useRef(0);
  const shouldResyncOnOpenRef = useRef(false);
  const initialRouteRef = useRef(appRoute);

  const activeAppPage: AppPage | null = appRoute.page === 'welcome' ? null : appRoute.page;

  const navigateToRoute = useCallback((nextRoute: AppRoute, options: { replace?: boolean } = {}) => {
    const nextPath = getAppRoutePath(nextRoute);

    if (window.location.pathname !== nextPath || window.location.search.length > 0 || window.location.hash.length > 0) {
      if (options.replace) {
        window.history.replaceState(null, '', nextPath);
      } else {
        window.history.pushState(null, '', nextPath);
      }
    }

    setAppRoute(nextRoute);
  }, []);

  const handleWorkflowTabSelect = useCallback((tab: WorkflowTab) => {
    setActiveWorkflowTab(tab);
  }, []);

  const handleWorkflowTabsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const currentIndex = WORKFLOW_TABS.indexOf(activeWorkflowTab);
      let nextTab: WorkflowTab | null = null;

      if (event.key === 'ArrowRight') {
        nextTab = WORKFLOW_TABS[(currentIndex + 1) % WORKFLOW_TABS.length] ?? null;
      } else if (event.key === 'ArrowLeft') {
        nextTab = WORKFLOW_TABS[(currentIndex - 1 + WORKFLOW_TABS.length) % WORKFLOW_TABS.length] ?? null;
      } else if (event.key === 'Home') {
        nextTab = WORKFLOW_TABS[0] ?? null;
      } else if (event.key === 'End') {
        nextTab = WORKFLOW_TABS[WORKFLOW_TABS.length - 1] ?? null;
      }

      if (nextTab) {
        event.preventDefault();
        handleWorkflowTabSelect(nextTab);
        window.requestAnimationFrame(() => {
          document.getElementById(`workflow-tab-${nextTab}`)?.focus();
        });
      }
    },
    [activeWorkflowTab, handleWorkflowTabSelect],
  );

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setAppRoute(parseAppRoute(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    document.documentElement.lang = locale === 'zh' ? 'zh-Hans' : 'en';
  }, [locale]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    setRelinkPath('');
    setRelinkError(null);
    setRelinkSuccess(null);
  }, [selectedProjectId]);

  const loadProjectDetail = useCallback(async (projectId: string, fallbackProject?: ProjectRecord | null) => {
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;

    if (fallbackProject && mountedRef.current) {
      setSelectedProject(fallbackProject);
    }

    setDetailLoading(true);

    try {
      const project = await requestJson(
        `/api/projects/${projectId}`,
        {
          headers: {
            accept: 'application/json',
          },
        },
        parseProjectDetailResponse,
        'Project detail',
      );

      if (
        !mountedRef.current
        || selectedProjectIdRef.current !== projectId
        || detailRequestIdRef.current !== requestId
      ) {
        return true;
      }

      setSelectedProject(project);
      setProjects((current) => upsertProject(current, project));
      setProjectTimeline((current) => {
        if (current.items.length > 0) {
          return current;
        }

        return {
          items: project.timeline,
          total: project.timeline.length,
        };
      });
      setDetailError(null);
      return true;
    } catch (error) {
      if (
        !mountedRef.current
        || selectedProjectIdRef.current !== projectId
        || detailRequestIdRef.current !== requestId
      ) {
        return true;
      }

      setDetailError(
        formatRequestError(
          error,
          copy.errors.detailTimeout,
          copy.errors.unexpected,
        ),
      );
      return false;
    } finally {
      if (
        mountedRef.current
        && selectedProjectIdRef.current === projectId
        && detailRequestIdRef.current === requestId
      ) {
        setDetailLoading(false);
      }
    }
  }, [copy.errors.detailTimeout, copy.errors.unexpected]);

  const loadProjectTimeline = useCallback(async (projectId: string) => {
    const requestId = timelineRequestIdRef.current + 1;
    timelineRequestIdRef.current = requestId;

    setTimelineLoading(true);

    try {
      const timeline = await requestJson(
        `/api/projects/${projectId}/timeline`,
        {
          headers: {
            accept: 'application/json',
          },
        },
        (value) => parseProjectTimelineResponse(value, projectId),
        'Project timeline',
      );

      if (
        !mountedRef.current
        || selectedProjectIdRef.current !== projectId
        || timelineRequestIdRef.current !== requestId
      ) {
        return true;
      }

      setProjectTimeline(timeline);
      setTimelineError(null);
      return true;
    } catch (error) {
      if (
        !mountedRef.current
        || selectedProjectIdRef.current !== projectId
        || timelineRequestIdRef.current !== requestId
      ) {
        return true;
      }

      setTimelineError(
        formatRequestError(
          error,
          copy.errors.timelineTimeout,
          copy.errors.unexpected,
        ),
      );
      return false;
    } finally {
      if (
        mountedRef.current
        && selectedProjectIdRef.current === projectId
        && timelineRequestIdRef.current === requestId
      ) {
        setTimelineLoading(false);
      }
    }
  }, [copy.errors.timelineTimeout, copy.errors.unexpected]);

  const syncSelectedProjectPanels = useCallback(
    async (projectId: string, fallbackProject?: ProjectRecord | null) => {
      const [detailOk, timelineOk] = await Promise.all([
        loadProjectDetail(projectId, fallbackProject),
        loadProjectTimeline(projectId),
      ]);

      return detailOk && timelineOk;
    },
    [loadProjectDetail, loadProjectTimeline],
  );

  const syncInitDetailAfterSuccess = useCallback(
    async (projectId: string, fallbackProject: ProjectRecord) => {
      initDetailSyncProjectIdRef.current = projectId;
      setInitDetailSyncProjectId(projectId);

      try {
        await syncSelectedProjectPanels(projectId, fallbackProject);
      } finally {
        initDetailSyncProjectIdRef.current =
          initDetailSyncProjectIdRef.current === projectId ? null : initDetailSyncProjectIdRef.current;

        if (mountedRef.current) {
          setInitDetailSyncProjectId((current) => (current === projectId ? null : current));
        }
      }
    },
    [syncSelectedProjectPanels],
  );

  const syncInventory = useCallback(
    async (
      selectionHint?: string | null,
      options: {
        fallbackToFirstProject?: boolean;
        preserveSelectedDetail?: boolean;
      } = {},
    ) => {
      const requestId = inventoryRequestIdRef.current + 1;
      inventoryRequestIdRef.current = requestId;
      setInventoryLoading(true);

      try {
        const response = await requestJson(
          '/api/projects',
          {
            headers: {
              accept: 'application/json',
            },
          },
          parseProjectsResponse,
          'Project inventory',
        );

        if (!mountedRef.current || inventoryRequestIdRef.current !== requestId) {
          return true;
        }

        setProjects(response.items);
        setInventoryError(null);

        if (response.items.length === 0) {
          selectedProjectIdRef.current = null;
          setSelectedProjectId(null);
          setSelectedProject(null);
          setProjectTimeline({ items: [], total: 0 });
          setDetailError(null);
          setTimelineError(null);
          return true;
        }

        const preferredProjectId = selectionHint ?? selectedProjectIdRef.current;
        const nextProject =
          response.items.find((project) => project.projectId === preferredProjectId)
          ?? (options.fallbackToFirstProject === false ? null : response.items[0])
          ?? null;

        if (!nextProject) {
          selectedProjectIdRef.current = null;
          setSelectedProjectId(null);
          setSelectedProject(null);
          setProjectTimeline({ items: [], total: 0 });
          setDetailError(null);
          setTimelineError(null);
          return true;
        }

        const selectionChanged = selectedProjectIdRef.current !== nextProject.projectId;
        const shouldPreserveSelectedDetail =
          options.preserveSelectedDetail === true
          && !selectionChanged
          && selectedProjectRef.current !== null
          && selectedProjectRef.current.projectId === nextProject.projectId;

        selectedProjectIdRef.current = nextProject.projectId;
        setSelectedProjectId(nextProject.projectId);

        if (shouldPreserveSelectedDetail) {
          return true;
        }

        const fallbackProject =
          selectionChanged || selectedProjectRef.current === null || selectedProjectRef.current.projectId !== nextProject.projectId
            ? nextProject
            : undefined;

        if (fallbackProject) {
          setSelectedProject(fallbackProject);
          setProjectTimeline({ items: [], total: 0 });
          setDetailError(null);
          setTimelineError(null);
        }

        return await syncSelectedProjectPanels(nextProject.projectId, fallbackProject);
      } catch (error) {
        if (!mountedRef.current || inventoryRequestIdRef.current !== requestId) {
          return true;
        }

        setInventoryError(
          formatRequestError(
            error,
            copy.errors.inventoryTimeout,
            copy.errors.unexpected,
          ),
        );
        return false;
      } finally {
        if (mountedRef.current && inventoryRequestIdRef.current === requestId) {
          setInventoryLoading(false);
        }
      }
    },
    [copy.errors.inventoryTimeout, copy.errors.unexpected, syncSelectedProjectPanels],
  );

  const resyncAfterReconnect = useCallback(async () => {
    if (!mountedRef.current) {
      return;
    }

    setStreamResyncStatus('syncing');
    setStreamResyncMessage(copy.notices.reconnecting);

    const success = await syncInventory(selectedProjectIdRef.current);

    if (!mountedRef.current) {
      return;
    }

    if (success) {
      setStreamResyncStatus('idle');
      setStreamResyncMessage(
        selectedProjectIdRef.current
          ? copy.notices.reconnectedWithSelection
          : copy.notices.reconnectedInventory,
      );
      return;
    }

    setStreamResyncStatus('failed');
    setStreamResyncMessage(copy.notices.reconnectFailed);
  }, [
    copy.notices.reconnectedInventory,
    copy.notices.reconnectedWithSelection,
    copy.notices.reconnectFailed,
    copy.notices.reconnecting,
    syncInventory,
  ]);

  useEffect(() => {
    const initialRoute = initialRouteRef.current;
    const initialProjectId = initialRoute.page === 'details' ? initialRoute.projectId : null;

    void syncInventory(initialProjectId, {
      fallbackToFirstProject: initialProjectId === null,
    });
  }, [syncInventory]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void syncInventory(selectedProjectIdRef.current, {
        preserveSelectedDetail: true,
      });
    }, INVENTORY_AUTO_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [syncInventory]);

  useEffect(() => {
    const eventSource = new EventSource('/api/events');

    const handleEnvelope = (event: MessageEvent<string>) => {
      try {
        const raw = JSON.parse(event.data) as unknown;
        const summary = parseEventEnvelope(raw);

        if (!mountedRef.current) {
          return;
        }

        setStreamStatus('connected');
        setStreamSummary(summary);

        if (summary.type === 'project.init.updated') {
          const initEnvelope = parseProjectInitEventEnvelope(raw);

          setProjects((current) =>
            current.map((project) =>
              project.projectId === initEnvelope.projectId ? mergeProjectInitJob(project, initEnvelope) : project,
            ),
          );

          const selectedProject = selectedProjectRef.current;

          if (selectedProject && selectedProject.projectId === initEnvelope.projectId) {
            const mergedProject = mergeProjectInitJob(selectedProject, initEnvelope);
            const alreadySucceeded =
              selectedProject.latestInitJob?.jobId === initEnvelope.payload.job.jobId
              && selectedProject.latestInitJob.stage === 'succeeded';

            setSelectedProject(mergedProject);
            setInitError(null);

            if (initEnvelope.payload.job.stage === 'succeeded' && !alreadySucceeded) {
              void syncInitDetailAfterSuccess(initEnvelope.projectId, mergedProject);
            }
          }

          return;
        }

        if (
          summary.type === 'project.registered'
          || summary.type === 'project.refreshed'
          || summary.type === 'project.relinked'
          || summary.type === 'project.monitor.updated'
        ) {
          const activeSelectedInitJob = selectedProjectRef.current?.latestInitJob ?? null;
          const preserveSelectedDetail =
            summary.type === 'project.refreshed'
            && summary.projectId !== null
            && selectedProjectRef.current?.projectId === summary.projectId
            && (hasActiveInitJob(activeSelectedInitJob) || initDetailSyncProjectIdRef.current === summary.projectId);

          void syncInventory(summary.projectId ?? selectedProjectIdRef.current, {
            preserveSelectedDetail,
          });
        }
      } catch {
        // Ignore unknown or malformed SSE payloads and keep the dashboard usable.
      }
    };

    eventSource.onopen = () => {
      if (!mountedRef.current) {
        return;
      }

      setStreamStatus('connected');

      if (shouldResyncOnOpenRef.current) {
        shouldResyncOnOpenRef.current = false;
        void resyncAfterReconnect();
      }
    };

    eventSource.onerror = () => {
      if (mountedRef.current) {
        shouldResyncOnOpenRef.current = true;
        setStreamStatus('disconnected');
      }
    };

    eventSource.addEventListener('service.ready', handleEnvelope as EventListener);
    eventSource.addEventListener('project.registered', handleEnvelope as EventListener);
    eventSource.addEventListener('project.refreshed', handleEnvelope as EventListener);
    eventSource.addEventListener('project.relinked', handleEnvelope as EventListener);
    eventSource.addEventListener('project.monitor.updated', handleEnvelope as EventListener);
    eventSource.addEventListener('project.init.updated', handleEnvelope as EventListener);

    return () => {
      eventSource.removeEventListener('service.ready', handleEnvelope as EventListener);
      eventSource.removeEventListener('project.registered', handleEnvelope as EventListener);
      eventSource.removeEventListener('project.refreshed', handleEnvelope as EventListener);
      eventSource.removeEventListener('project.relinked', handleEnvelope as EventListener);
      eventSource.removeEventListener('project.monitor.updated', handleEnvelope as EventListener);
      eventSource.removeEventListener('project.init.updated', handleEnvelope as EventListener);
      eventSource.close();
    };
  }, [resyncAfterReconnect, syncInitDetailAfterSuccess, syncInventory]);

  const selectProject = useCallback(
    (project: ProjectRecord, options: { updateRoute?: boolean } = {}) => {
      if (options.updateRoute !== false) {
        navigateToRoute({
          page: 'details',
          projectId: project.projectId,
        });
      }

      selectedProjectIdRef.current = project.projectId;
      setSelectedProjectId(project.projectId);
      setSelectedProject(project);
      setProjectTimeline({ items: [], total: 0 });
      setDetailError(null);
      setTimelineError(null);
      setRefreshError(null);
      setInitError(null);
      setRelinkError(null);
      setRelinkSuccess(null);
      setRelinkPath('');
      setRegisterSuccess(null);
      void syncSelectedProjectPanels(project.projectId, project);
    },
    [navigateToRoute, syncSelectedProjectPanels],
  );

  useEffect(() => {
    if (appRoute.page !== 'details' || inventoryLoading) {
      return;
    }

    const routeProject = projects.find((project) => project.projectId === appRoute.projectId) ?? null;

    if (routeProject) {
      if (selectedProjectIdRef.current !== routeProject.projectId) {
        selectProject(routeProject, { updateRoute: false });
      }

      return;
    }

    selectedProjectIdRef.current = null;
    setSelectedProjectId(null);
    setSelectedProject(null);
    setProjectTimeline({ items: [], total: 0 });
    setDetailError(copy.errors.projectRouteNotFound(appRoute.projectId));
    setTimelineError(null);
  }, [appRoute, copy.errors, inventoryLoading, projects, selectProject]);

  const loadDirectoryPicker = useCallback(
    async (pathHint?: string | null) => {
      const params = new URLSearchParams();
      const trimmedPath = pathHint?.trim() ?? '';

      if (trimmedPath.length > 0) {
        params.set('path', trimmedPath);
      }

      setDirectoryPickerLoading(true);
      setDirectoryPickerError(null);

      try {
        const directory = await requestJson(
          `/api/filesystem/directories${params.size > 0 ? `?${params.toString()}` : ''}`,
          {
            headers: {
              accept: 'application/json',
            },
          },
          parseFilesystemDirectoryResponse,
          'Filesystem directory',
        );

        if (!mountedRef.current) {
          return;
        }

        setDirectoryPicker(directory);
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }

        setDirectoryPickerError(formatRequestError(error, copy.errors.folderBrowserTimeout, copy.errors.unexpected));
      } finally {
        if (mountedRef.current) {
          setDirectoryPickerLoading(false);
        }
      }
    },
    [copy.errors.folderBrowserTimeout, copy.errors.unexpected],
  );

  const submitRegisterPath = useCallback(
    async (rawPath: string, options: { closeDirectoryPickerOnSuccess?: boolean } = {}) => {
      const candidatePath = rawPath.trim();

      if (candidatePath.length === 0) {
        setRegisterError(copy.errors.emptyRegisterPath);
        setRegisterSuccess(null);
        return;
      }

      const duplicateProject = projects.find((project) => {
        const normalizedCandidate = normalizePathForComparison(candidatePath);

        return [project.registeredPath, project.canonicalPath].some(
          (pathValue) => normalizePathForComparison(pathValue) === normalizedCandidate,
        );
      });

      if (duplicateProject) {
        setRegisterError(copy.errors.duplicateRegisterPath);
        setRegisterSuccess(null);
        return;
      }

      setRegisterPending(true);
      setRegisterError(null);
      setRegisterSuccess(null);

      try {
        const response = await requestJson(
          '/api/projects/register',
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ path: candidatePath }),
          },
          parseProjectMutationResponse,
          'Project registration',
        );

        if (!mountedRef.current) {
          return;
        }

        setProjects((current) => upsertProject(current, response.project));
        navigateToRoute({
          page: 'details',
          projectId: response.project.projectId,
        });
        if (options.closeDirectoryPickerOnSuccess) {
          setDirectoryPickerOpen(false);
        }
        selectedProjectIdRef.current = response.project.projectId;
        setSelectedProjectId(response.project.projectId);
        setSelectedProject(response.project);
        setProjectTimeline({ items: [], total: 0 });
        setRegisterSuccess(copy.notices.registeredSuccess(describeProject(response.project)));
        setRelinkPath('');
        setRelinkError(null);
        setRelinkSuccess(null);
        setDetailError(null);
        setTimelineError(null);
        setRefreshError(null);
        setInitError(null);
        void syncSelectedProjectPanels(response.project.projectId, response.project);
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }

        setRegisterError(
          formatRequestError(
            error,
            copy.errors.registerTimeout,
            copy.errors.unexpected,
          ),
        );
      } finally {
        if (mountedRef.current) {
          setRegisterPending(false);
        }
      }
    },
    [
      copy.errors.duplicateRegisterPath,
      copy.errors.emptyRegisterPath,
      copy.errors.registerTimeout,
      copy.errors.unexpected,
      copy.notices,
      navigateToRoute,
      projects,
      syncSelectedProjectPanels,
    ],
  );

  const handleRelinkSelected = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const selected = selectedProjectRef.current;

      if (!selected) {
        return;
      }

      const continuity = getProjectContinuity(selected);

      if (continuity.state !== 'path_lost') {
        setRelinkError(copy.errors.relinkUnavailable);
        setRelinkSuccess(null);
        return;
      }

      const candidatePath = relinkPath.trim();

      if (candidatePath.length === 0) {
        setRelinkError(copy.errors.emptyRelinkPath);
        setRelinkSuccess(null);
        return;
      }

      const duplicateProject = projects.find((project) => {
        if (project.projectId === selected.projectId) {
          return false;
        }

        const normalizedCandidate = normalizePathForComparison(candidatePath);

        return [project.registeredPath, project.canonicalPath].some(
          (pathValue) => normalizePathForComparison(pathValue) === normalizedCandidate,
        );
      });

      if (duplicateProject) {
        setRelinkError(copy.errors.duplicateRelinkPath);
        setRelinkSuccess(null);
        return;
      }

      setRelinkPending(true);
      setRelinkError(null);
      setRelinkSuccess(null);

      try {
        const response = await requestJson(
          `/api/projects/${selected.projectId}/relink`,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ path: candidatePath }),
          },
          parseProjectMutationResponse,
          'Project relink',
        );

        if (!mountedRef.current) {
          return;
        }

        setProjects((current) => upsertProject(current, response.project));
        selectedProjectIdRef.current = response.project.projectId;
        setSelectedProjectId(response.project.projectId);
        setSelectedProject(response.project);
        setRelinkPath('');
        setRelinkSuccess(copy.notices.relinkSuccess(response.project.projectId, response.project.canonicalPath));
        setDetailError(null);
        setTimelineError(null);
        setRefreshError(null);
        setInitError(null);
        void syncSelectedProjectPanels(response.project.projectId, response.project);
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }

        setRelinkError(
          formatRequestError(
            error,
            copy.errors.relinkTimeout,
            copy.errors.unexpected,
          ),
        );
      } finally {
        if (mountedRef.current) {
          setRelinkPending(false);
        }
      }
    },
    [
      copy.errors.duplicateRelinkPath,
      copy.errors.emptyRelinkPath,
      copy.errors.relinkTimeout,
      copy.errors.relinkUnavailable,
      copy.errors.unexpected,
      copy.notices,
      projects,
      relinkPath,
      syncSelectedProjectPanels,
    ],
  );

  const handleInitializeSelected = useCallback(async () => {
    const selected = selectedProjectRef.current;

    if (!selected || !shouldShowInitAction(selected)) {
      return;
    }

    setInitPendingProjectId(selected.projectId);
    setInitError(null);
    setDetailError(null);

    try {
      const response = await requestJson(
        `/api/projects/${selected.projectId}/init`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
          },
        },
        parseProjectMutationResponse,
        'Project initialization',
      );

      if (!mountedRef.current) {
        return;
      }

      setProjects((current) => upsertProject(current, response.project));

      if (selectedProjectIdRef.current === response.project.projectId) {
        setSelectedProject(response.project);
      }
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }

      setInitError(
        formatRequestError(
          error,
          copy.errors.initTimeout,
          copy.errors.unexpected,
        ),
      );
    } finally {
      if (mountedRef.current) {
        setInitPendingProjectId((current) => (current === selected.projectId ? null : current));
      }
    }
  }, [copy.errors.initTimeout, copy.errors.unexpected]);

  const handleRefreshSelected = useCallback(async () => {
    if (!selectedProjectIdRef.current) {
      return;
    }

    setRefreshPending(true);
    setRefreshError(null);

    try {
      const response = await requestJson(
        `/api/projects/${selectedProjectIdRef.current}/refresh`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
          },
        },
        parseProjectMutationResponse,
        'Project refresh',
      );

      if (!mountedRef.current) {
        return;
      }

      setProjects((current) => upsertProject(current, response.project));
      setSelectedProject(response.project);
      setDetailError(null);
      setTimelineError(null);
      setInitError(null);
      void syncSelectedProjectPanels(response.project.projectId);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }

      setRefreshError(
        formatRequestError(
          error,
          copy.errors.refreshTimeout,
          copy.errors.unexpected,
        ),
      );
    } finally {
      if (mountedRef.current) {
        setRefreshPending(false);
      }
    }
  }, [copy.errors.refreshTimeout, copy.errors.unexpected, syncSelectedProjectPanels]);

  const handleExportSelected = useCallback(() => {
    const selected = selectedProjectRef.current;

    if (!selected) {
      return;
    }

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      project: selected,
      timeline: projectTimeline,
    };
    const blob = new Blob([`${JSON.stringify(exportPayload, null, 2)}\n`], {
      type: 'application/json',
    });
    const objectUrl = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = objectUrl;
    anchor.download = `${selected.projectId}-snapshot.json`;
    anchor.click();
    window.URL.revokeObjectURL(objectUrl);
  }, [projectTimeline]);

  const totalProjectsLabel = copy.formatCount(projects.length, 'project');
  const initializedCount = projects.filter((project) => project.snapshot.status === 'initialized').length;
  const degradedCount = projects.filter((project) => project.snapshot.status === 'degraded').length;
  const uninitializedCount = projects.filter((project) => project.snapshot.status === 'uninitialized').length;
  const nowMs = Date.now();
  const portfolioSummary = buildPortfolioSummary(projects, nowMs, copy);
  const selectedInitJob = selectedProject?.latestInitJob ?? null;
  const selectedInitRequestPending =
    selectedProject !== null && initPendingProjectId === selectedProject.projectId;
  const selectedInitSyncingDetail =
    selectedProject !== null && initDetailSyncProjectId === selectedProject.projectId;
  const selectedInitActionVisible = shouldShowInitAction(selectedProject);
  const selectedInitActionDisabled =
    selectedProject === null
      ? true
      : selectedInitRequestPending ||
        selectedInitSyncingDetail ||
        hasActiveInitJob(selectedInitJob);
  const selectedInitSummary = summarizeInitJob(selectedInitJob, copy);
  const selectedMonitorSummary =
    selectedProject === null
      ? null
      : describeMonitorState(selectedProject.monitor, selectedProject.snapshot.status, copy);
  const selectedContinuity = selectedProject === null ? null : getProjectContinuity(selectedProject);
  const selectedContinuitySummary =
    selectedProject === null ? null : describeContinuityState(selectedProject, copy);
  const selectedTimelineCountLabel = describeTimelineCount(projectTimeline.total, copy);
  const selectedGsdDb = selectedProject?.snapshot.sources.gsdDb.value ?? null;
  const selectedMetrics = selectedProject?.snapshot.sources.metricsJson.value ?? null;
  const selectedMilestoneSource = selectedGsdDb?.milestones ?? [];
  const selectedActiveMilestone = findActiveMilestone(selectedMilestoneSource);
  const selectedMilestones = orderWorkflowMilestones(selectedMilestoneSource, selectedActiveMilestone?.id ?? null);
  const selectedSliceDependencies = getSliceDependencies(selectedGsdDb);
  const selectedRemainingSlices = getRemainingSliceCount(selectedMilestones);
  const selectedCompletedSlices = selectedMilestones.reduce(
    (total, milestone) => total + getCompletedSliceCount(milestone),
    0,
  );
  const selectedActiveSlice = findActiveSlice(selectedActiveMilestone);
  const selectedActiveTask = findActiveTask(selectedActiveSlice);
  const selectedExecutionPath =
    selectedActiveMilestone && selectedActiveSlice && selectedActiveTask
      ? `${selectedActiveMilestone.id}/${selectedActiveSlice.id}/${selectedActiveTask.id}`
      : selectedActiveMilestone && selectedActiveSlice
        ? `${selectedActiveMilestone.id}/${selectedActiveSlice.id}`
        : selectedActiveMilestone
          ? selectedActiveMilestone.id
          : selectedProject
            ? describeProject(selectedProject)
            : copy.messages.notRecorded;
  const selectedWorkflowPhase =
    selectedInitJob && hasActiveInitJob(selectedInitJob)
      ? copy.initStageLabels[selectedInitJob.stage]
      : selectedProject
        ? copy.statusLabels[selectedProject.snapshot.status]
        : copy.messages.notRecorded;
  const selectedExecutionStats = buildWorkflowExecutionStats(selectedMilestones, selectedMetrics, nowMs, copy);
  const selectedTaskTimeline = buildTaskTimelineEntries(selectedMilestones, selectedExecutionStats);
  const selectedTaskTimelineCountLabel = copy.formatCount(selectedTaskTimeline.length, 'task');
  const selectedRecentExecutionUnits = (selectedMetrics?.recentUnits ?? []).map(toExecutionUnit);
  const primaryModel = selectedExecutionStats.modelUsage[0]?.model ?? copy.messages.notRecorded;
  const averageUnitDurationMs = averageDuration(selectedExecutionStats.units);
  const detailRouteProjectId = appRoute.page === 'details' ? appRoute.projectId : null;
  const detailRoutePending =
    activeAppPage === 'details'
    && selectedProject === null
    && (inventoryLoading || detailLoading || timelineLoading);
  const detailRouteFallbackMessage =
    detailError
    ?? inventoryError
    ?? (detailRouteProjectId ? copy.errors.projectRouteNotFound(detailRouteProjectId) : copy.empty.detailCopy);
  const routePreviewProject = selectedProject ?? projects.find((project) => project.projectId === selectedProjectId) ?? projects[0] ?? null;
  const routePreviewRow = routePreviewProject
    ? portfolioSummary.rows.find((row) => row.project.projectId === routePreviewProject.projectId) ?? null
    : null;
  const routePreviewHeading = routePreviewProject ? describeProject(routePreviewProject) : copy.labels.projectOverview;
  const routePreviewStage =
    activeAppPage === 'details' ? routePreviewRow?.currentStage ?? selectedWorkflowPhase : copy.labels.projectOverview;
  const routePreviewActionLabel =
    activeAppPage === 'overview' ? copy.actions.openSelectedProject : copy.actions.enterOverview;
  const topbarMarqueeLabel =
    activeAppPage === 'details' ? copy.labels.projectDetail : copy.labels.portfolio;
  const topbarMarqueeHeading =
    activeAppPage === 'details' ? routePreviewHeading : totalProjectsLabel;
  const topbarMarqueeCopy =
    activeAppPage === 'details' ? routePreviewStage : copy.help.portfolioProjection;
  const topbarStageLabel =
    activeAppPage === 'details' ? copy.labels.currentStage : copy.labels.activeProjects;
  const topbarStageValue =
    activeAppPage === 'details' ? routePreviewStage : String(portfolioSummary.activeProjects);
  const topbarStageMeta =
    activeAppPage === 'details' ? routePreviewHeading : `${initializedCount} ${copy.stats.initialized}`;
  const topbarCost = activeAppPage === 'details' ? routePreviewRow?.cost ?? 0 : portfolioSummary.totalCost;
  const topbarTokens =
    activeAppPage === 'details' ? routePreviewRow?.totalTokens ?? 0 : portfolioSummary.totalTokens;
  const switcherProject = selectedProject ?? routePreviewProject;
  const openRegisterDirectoryPicker = () => {
    setRegisterError(null);
    setRegisterSuccess(null);
    setDirectoryPickerOpen(true);
    void loadDirectoryPicker();
  };
  const renderLocaleSwitch = () => (
    <div className="locale-switch" role="group" aria-label={copy.languageToggleLabel}>
      {(['en', 'zh'] as Locale[]).map((option) => (
        <button
          key={option}
          type="button"
          className="locale-switch__option"
          aria-pressed={locale === option}
          onClick={() => {
            setLocale(option);
          }}
        >
          {copy.localeOptions[option]}
        </button>
      ))}
    </div>
  );
  const renderRegisterPanel = () => (
    <div className="register-panel">
      <div>
        <h2>{copy.actions.registerProject}</h2>
        <p>{copy.help.registerPanel}</p>
      </div>

      <div className="field register-panel__field">
        <span>{copy.labels.projectPath}</span>
        <div className="register-panel__path" data-testid="register-selected-path">
          {copy.messages.selectedFolderHint}
        </div>
      </div>

      <div className="register-panel__actions">
        <button
          type="button"
          className="primary-button"
          onClick={openRegisterDirectoryPicker}
          disabled={directoryPickerLoading}
        >
          <FolderIcon />
          <span>{copy.actions.browseFolders}</span>
        </button>
      </div>

      {registerError ? (
        <p className="inline-alert inline-alert--error" role="alert" data-testid="register-error">
          {registerError}
        </p>
      ) : null}

      {registerSuccess ? (
        <p className="inline-alert inline-alert--success" data-testid="register-success">
          {registerSuccess}
        </p>
      ) : null}
    </div>
  );
  const renderProjectSwitcher = () => (
    <section className="project-switcher" aria-labelledby="project-switch-heading">
      <div className="panel-header project-switcher__header">
        <div>
          <h2 id="project-switch-heading">{copy.labels.projectSwitch}</h2>
          <p>{copy.formatCount(projects.length, 'project')}</p>
        </div>
      </div>

      {inventoryError ? (
        <div className="inline-alert inline-alert--error" role="alert" data-testid="inventory-error">
          <p>{inventoryError}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              void syncInventory(selectedProjectIdRef.current);
            }}
          >
            {copy.actions.retryInventory}
          </button>
        </div>
      ) : null}

      {projects.length === 0 ? (
        <div className="empty-state" data-testid="inventory-empty">
          <h3>{copy.empty.inventoryTitle}</h3>
          <p>{copy.empty.inventoryCopy}</p>
        </div>
      ) : (
        <div className="project-switcher__body">
          <div className="project-switcher__current" data-testid="project-switcher-current">
            <span className="eyebrow">{copy.labels.projectDetail}</span>
            <strong data-testid="project-switcher-current-name">
              {switcherProject ? describeProject(switcherProject) : copy.empty.detailTitle}
            </strong>
            <span className="project-switcher__path">
              {switcherProject?.canonicalPath ?? copy.empty.detailCopy}
            </span>
          </div>

          <div className="project-switcher__dots">
            {projects.map((project) => {
              const label = describeProject(project);
              const isSelected = selectedProjectId === project.projectId;

              return (
                <button
                  key={project.projectId}
                  type="button"
                  className="project-switcher__dot"
                  data-status={project.snapshot.status}
                  data-active={isSelected}
                  data-testid={`project-card-${project.projectId}`}
                  aria-label={label}
                  aria-pressed={isSelected}
                  title={label}
                  onClick={() => {
                    selectProject(project);
                  }}
                >
                  <span className="visually-hidden">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
  const renderStreamStrip = () => (
    <div className="stream-strip">
      <div data-testid="stream-status" data-stream-status={streamStatus}>
        <span className="stat-card__label">{copy.stats.liveStream}</span>
        <strong>{copy.streamStatusLabels[streamStatus]}</strong>
        <span>{copy.streamStatusMessages[streamStatus]}</span>
        {streamResyncMessage ? (
          <span
            className="stream-resync-note"
            data-testid="stream-resync-status"
            data-resync-status={streamResyncStatus}
          >
            {streamResyncMessage}
          </span>
        ) : null}
      </div>
      <div data-testid="stream-last-event">
        <span className="stat-card__label">{copy.stats.lastSseEvent}</span>
        {streamSummary ? (
          <>
            <strong>{streamSummary.type}</strong>
            <span>{streamSummary.id}</span>
            <time dateTime={streamSummary.emittedAt}>{formatTimestamp(streamSummary.emittedAt, locale)}</time>
          </>
        ) : (
          <span>{copy.stats.waitingForEvent}</span>
        )}
      </div>
    </div>
  );
  const renderWelcomePage = () => (
    <section className="welcome-page" aria-labelledby="welcome-heading" data-testid="welcome-page">
      <header className="welcome-nav">
        <div>
          <span>{copy.app.eyebrow}</span>
          <strong>gsd-web</strong>
        </div>
        {renderLocaleSwitch()}
      </header>

      <section className="welcome-hero">
        <div className="welcome-copy">
          <p className="eyebrow">{copy.app.welcomeEyebrow}</p>
          <h1 id="welcome-heading">gsd-web</h1>
          <p>{copy.app.welcomeLead}</p>
          <div className="welcome-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                navigateToRoute({ page: 'overview' });
              }}
            >
              {copy.actions.enterOverview}
            </button>
            {routePreviewProject ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  selectProject(routePreviewProject);
                }}
              >
                {copy.actions.openSelectedProject}
              </button>
            ) : null}
          </div>
        </div>

        <div className="welcome-visual" aria-label={copy.labels.workspacePages}>
          <div className="welcome-route-map">
            <span data-active="true">{ROUTE_BASE_PATH}</span>
            <span>{ROUTE_OVERVIEW_PATH}</span>
            <span>
              {routePreviewProject ? getAppRoutePath({ page: 'details', projectId: routePreviewProject.projectId }) : `${ROUTE_BASE_PATH}/${ROUTE_DETAIL_PREFIX}:projectId`}
            </span>
          </div>

          <div className="welcome-stat-grid">
            <div>
              <span className="stat-card__label">{copy.stats.registered}</span>
              <strong>{totalProjectsLabel}</strong>
            </div>
            <div>
              <span className="stat-card__label">{copy.stats.initialized}</span>
              <strong>{initializedCount}</strong>
            </div>
            <div>
              <span className="stat-card__label">{copy.labels.totalCost}</span>
              <strong>{formatCost(portfolioSummary.totalCost, locale)}</strong>
            </div>
            <div data-stream-status={streamStatus}>
              <span className="stat-card__label">{copy.stats.liveStream}</span>
              <strong>{copy.streamStatusLabels[streamStatus]}</strong>
            </div>
          </div>

          <div className="welcome-preview">
            <div>
              <span className="status-pill" data-status="initialized">{initializedCount} {copy.stats.initialized}</span>
              <span className="status-pill" data-status="degraded">{degradedCount} {copy.stats.degraded}</span>
              <span className="status-pill" data-status="uninitialized">{uninitializedCount} {copy.stats.uninitialized}</span>
            </div>
            <strong>{copy.labels.projectOverview}</strong>
            <p>{copy.app.welcomePreview}</p>
          </div>
        </div>
      </section>
    </section>
  );
  const renderAppRail = () => (
    <aside className="app-rail panel" aria-label={copy.labels.workspacePages}>
      <div className="app-rail__brand">
        <div className="app-rail__brand-mark" aria-hidden="true">
          <span />
        </div>
        <div className="app-rail__brand-copy">
          <span className="stat-card__label">{copy.app.welcomeEyebrow}</span>
          <strong>gsd-web</strong>
          <span>{copy.app.title}</span>
        </div>
      </div>

      <div className="app-rail__section">
        <span className="stat-card__label">{copy.labels.workspacePages}</span>
        <div className="app-page-tabs" role="tablist" aria-label={copy.labels.workspacePages}>
          {APP_PAGES.map((page) => (
            <button
              key={page}
              type="button"
              className="app-page-tabs__item"
              role="tab"
              aria-selected={activeAppPage === page}
              aria-controls={`app-page-${page}`}
              data-active={activeAppPage === page}
              onClick={() => {
                if (page === 'overview') {
                  navigateToRoute({ page: 'overview' });
                  return;
                }

                if (routePreviewProject) {
                  selectProject(routePreviewProject);
                  return;
                }

                navigateToRoute({ page: 'overview' });
              }}
            >
              <AppPageIcon page={page} />
              <span>{appPageLabel(page, copy)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="app-rail__status-grid">
        <div className="app-rail__metric" data-stream-status={streamStatus}>
          <span className="stat-card__label">{copy.stats.liveStream}</span>
          <strong>{copy.streamStatusLabels[streamStatus]}</strong>
          <span>{streamSummary?.type ?? copy.stats.waitingForEvent}</span>
        </div>
        <div className="app-rail__metric">
          <span className="stat-card__label">{copy.labels.activeProjects}</span>
          <strong>{portfolioSummary.activeProjects}</strong>
          <span>{initializedCount} {copy.stats.initialized}</span>
        </div>
        <div className="app-rail__metric">
          <span className="stat-card__label">{copy.labels.totalWarnings}</span>
          <strong>{portfolioSummary.totalWarnings}</strong>
          <span>{degradedCount} {copy.stats.degraded}</span>
        </div>
      </div>

      <div className="app-rail__footer">
        {routePreviewProject ? (
          <button
            type="button"
            className="app-rail__project"
            onClick={() => {
              if (activeAppPage === 'overview') {
                selectProject(routePreviewProject);
                return;
              }

              navigateToRoute({ page: 'overview' });
            }}
          >
            <span className="stat-card__label">{routePreviewActionLabel}</span>
            <strong>{routePreviewHeading}</strong>
            <span>{routePreviewStage}</span>
          </button>
        ) : null}
        {renderLocaleSwitch()}
      </div>
    </aside>
  );

  return (
    <main className="app-shell" data-locale={locale}>
      {appRoute.page === 'welcome' ? renderWelcomePage() : (
      <section className="app-frame">
        {renderAppRail()}

        <section className="app-stage">
          <header className="app-topbar panel">
            <div className="app-topbar__title">
              <p className="eyebrow">{copy.app.eyebrow}</p>
              <h1>gsd-web</h1>
              <p className="lede">{copy.app.title}</p>
            </div>

            <div className="app-topbar__marquee">
              <span className="stat-card__label">{topbarMarqueeLabel}</span>
              <strong data-testid="app-topbar-marquee-heading">{topbarMarqueeHeading}</strong>
              <p data-testid="app-topbar-marquee-copy">{topbarMarqueeCopy}</p>
            </div>

            <div className="app-topbar__hud">
              <div className="app-topbar__hud-card" data-stream-status={streamStatus}>
                <span className="stat-card__label">{copy.stats.liveStream}</span>
                <strong>{copy.streamStatusLabels[streamStatus]}</strong>
                <span>
                  {streamSummary ? formatTimestamp(streamSummary.emittedAt, locale) : copy.stats.waitingForEvent}
                </span>
              </div>
              <div className="app-topbar__hud-card">
                <span className="stat-card__label">{topbarStageLabel}</span>
                <strong data-testid="app-topbar-stage-value">{topbarStageValue}</strong>
                <span data-testid="app-topbar-stage-meta">{topbarStageMeta}</span>
              </div>
              <div className="app-topbar__hud-card">
                <span className="stat-card__label">{copy.labels.totalCost}</span>
                <strong data-testid="app-topbar-total-cost">{formatCost(topbarCost, locale)}</strong>
                <span data-testid="app-topbar-total-tokens">
                  {formatCompactNumber(topbarTokens, locale)} {copy.labels.tokens}
                </span>
              </div>
            </div>

          </header>

        {activeAppPage === 'overview' ? (
          <section className="overview-layout app-page" id="app-page-overview" aria-labelledby="overview-heading">
            <section className="overview-hero panel">
              <div className="overview-hero__copy">
                <p className="eyebrow">{copy.app.healthRailLabel}</p>
                <h2 id="overview-heading">{copy.labels.portfolio}</h2>
                <p>{copy.app.healthRailCopy}</p>
              </div>

              <div className="overview-metrics">
                <div className="overview-metric-card" data-testid="inventory-count">
                  <span className="stat-card__label">{copy.stats.registered}</span>
                  <strong>{totalProjectsLabel}</strong>
                  <small>{initializedCount} {copy.stats.initialized}</small>
                </div>
                <div className="overview-metric-card">
                  <span className="stat-card__label">{copy.labels.totalCost}</span>
                  <strong>{formatCost(portfolioSummary.totalCost, locale)}</strong>
                  <small>{copy.formatCount(portfolioSummary.metricsProjects, 'project')}</small>
                </div>
                <div className="overview-metric-card">
                  <span className="stat-card__label">{copy.labels.totalElapsed}</span>
                  <strong>{formatDuration(portfolioSummary.totalElapsedMs, locale, copy.messages.notRecorded)}</strong>
                  <small>{formatCompactNumber(portfolioSummary.totalTokens, locale)} {copy.labels.tokens}</small>
                </div>
                <div className="overview-metric-card">
                  <span className="stat-card__label">{copy.labels.remainingTasks}</span>
                  <strong>{portfolioSummary.remainingTasks}</strong>
                  <small>
                    {portfolioSummary.completedTasks}/{portfolioSummary.totalTasks} {copy.labels.completed}
                  </small>
                </div>
              </div>
            </section>

            <div className="overview-content">
              <section className="overview-board panel" aria-labelledby="overview-projects-heading">
                <div className="panel-header inventory-panel__header">
                  <div>
                    <h2 id="overview-projects-heading">{copy.labels.projectOverview}</h2>
                    <p>{copy.help.portfolioProjection}</p>
                  </div>
                  <div className="detail-header__meta">
                    <span className="status-pill" data-status="initialized">{initializedCount} {copy.stats.initialized}</span>
                    <span className="status-pill" data-status="degraded">{degradedCount} {copy.stats.degraded}</span>
                    <span className="status-pill" data-status="uninitialized">
                      {uninitializedCount} {copy.stats.uninitialized}
                    </span>
                  </div>
                </div>

                {inventoryError ? (
                  <div className="inline-alert inline-alert--error" role="alert" data-testid="inventory-error">
                    <p>{inventoryError}</p>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        void syncInventory(selectedProjectIdRef.current);
                      }}
                    >
                      {copy.actions.retryInventory}
                    </button>
                  </div>
                ) : null}

                {projects.length === 0 ? (
                  <div className="empty-state" data-testid="inventory-empty">
                    <h3>{copy.empty.inventoryTitle}</h3>
                    <p>{copy.empty.inventoryCopy}</p>
                  </div>
                ) : (
                  <div className="overview-project-list">
                    {portfolioSummary.rows.map((row) => (
                      <button
                        key={row.project.projectId}
                        type="button"
                        className="overview-project-row"
                        data-status={row.project.snapshot.status}
                        data-testid={`overview-project-card-${row.project.projectId}`}
                        onClick={() => {
                          selectProject(row.project);
                        }}
                      >
                        <span className="overview-project-row__identity">
                          <strong>{row.label}</strong>
                        </span>

                        <span className="overview-project-row__state">
                          <span className="overview-project-row__meter" aria-hidden="true">
                            <span style={{ width: `${row.progressPercent}%` }} />
                          </span>
                          <span className="overview-project-row__badges">
                            <span className="status-pill" data-status={row.project.snapshot.status}>
                              {copy.statusLabels[row.project.snapshot.status]}
                            </span>
                            <span className="status-pill" data-status={row.project.monitor.health}>
                              {copy.monitorHealthLabels[row.project.monitor.health]}
                            </span>
                            <span className="status-pill" data-status={continuityTone(row.continuity.state)}>
                              {copy.continuityStateLabels[row.continuity.state]}
                            </span>
                          </span>
                        </span>

                        <span className="overview-project-row__facts">
                          <span>
                            <small>{copy.labels.cost}</small>
                            <strong>{formatCost(row.cost, locale)}</strong>
                          </span>
                          <span>
                            <small>{copy.labels.elapsed}</small>
                            <strong>{formatDuration(row.elapsedMs, locale, copy.messages.notRecorded)}</strong>
                          </span>
                          <span>
                            <small>{copy.labels.currentStage}</small>
                            <strong title={row.currentStage}>{row.currentStage}</strong>
                          </span>
                          <span>
                            <small>{copy.labels.estimatedRemaining}</small>
                            <strong>
                              {formatDuration(
                                row.estimatedRemainingMs,
                                locale,
                                copy.messages.estimateUnavailable,
                              )}
                            </strong>
                          </span>
                        </span>

                        <span className="overview-project-row__open">
                          <OpenDetailsIcon />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <aside className="overview-side" aria-label={copy.labels.serviceState}>
                <section className="overview-register panel">
                  {renderRegisterPanel()}
                </section>
                <section className="overview-status panel">
                  <div className="subpanel__header">
                    <h2>{copy.labels.statusBreakdown}</h2>
                    <p>{copy.help.statusBreakdown}</p>
                  </div>
                  <dl className="detail-facts detail-facts--compact">
                    <div>
                      <dt>{copy.labels.activeProjects}</dt>
                      <dd>{portfolioSummary.activeProjects}</dd>
                    </div>
                    <div>
                      <dt>{copy.labels.totalWarnings}</dt>
                      <dd>{portfolioSummary.totalWarnings}</dd>
                    </div>
                    <div>
                      <dt>{copy.labels.apiRequests}</dt>
                      <dd>
                        {formatCompactNumber(
                          portfolioSummary.rows.reduce(
                            (total, row) => total + (row.project.snapshot.sources.metricsJson.value?.totals.apiRequests ?? 0),
                            0,
                          ),
                          locale,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{copy.labels.units}</dt>
                      <dd>{portfolioSummary.rows.reduce((total, row) => total + row.unitCount, 0)}</dd>
                    </div>
                  </dl>
                </section>
                <section className="overview-stream panel">
                  {renderStreamStrip()}
                </section>
              </aside>
            </div>
          </section>
        ) : null}

        {activeAppPage === 'details' ? (
        <section className="workspace-layout app-page detail-workspace" id="app-page-details" aria-labelledby="detail-heading">
        <section className="panel detail-panel" aria-labelledby="detail-heading">
          <h2 id="detail-heading" className="visually-hidden">{copy.labels.workflowVisualizer}</h2>

          <div className="detail-panel__body">
          {detailError ? (
            <p className="inline-alert inline-alert--error" role="alert" data-testid="detail-error">
              {detailError}
            </p>
          ) : null}
          {timelineError ? (
            <div className="inline-alert inline-alert--error" role="alert" data-testid="timeline-error">
              <p>{timelineError}</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  if (selectedProjectIdRef.current) {
                    void loadProjectTimeline(selectedProjectIdRef.current);
                  }
                }}
              >
                {copy.actions.retryTimeline}
              </button>
            </div>
          ) : null}
          {refreshError ? (
            <p className="inline-alert inline-alert--error" role="alert" data-testid="refresh-error">
              {refreshError}
            </p>
          ) : null}
          {initError ? (
            <p className="inline-alert inline-alert--error" role="alert" data-testid="init-error">
              {initError}
            </p>
          ) : null}

          {selectedProject ? (
            <div className="detail-content visualizer-content">
              <div className="visually-hidden">
                <span data-testid="detail-canonical-path">{selectedProject.canonicalPath}</span>
                <span data-testid="detail-status">{copy.statusLabels[selectedProject.snapshot.status]}</span>
                <span data-testid="detail-monitor-health">{copy.monitorHealthLabels[selectedProject.monitor.health]}</span>
                <span data-testid="detail-continuity-state">
                  {copy.continuityStateLabels[selectedContinuity!.state]}
                </span>
                <span data-testid="detail-warning-count">
                  {copy.formatCount(selectedProject.snapshot.warnings.length, 'warning')}
                </span>
                <span data-testid="detail-project-id-value">{selectedProject.projectId}</span>
                <span data-testid="detail-snapshot-checked-at">
                  {formatTimestamp(selectedProject.snapshot.checkedAt, locale)}
                </span>
                <span data-testid="detail-monitor-last-attempted">
                  {selectedProject.monitor.lastAttemptedAt
                    ? formatTimestamp(selectedProject.monitor.lastAttemptedAt, locale)
                    : copy.messages.notRecorded}
                </span>
                <span data-testid="detail-monitor-last-successful">
                  {selectedProject.monitor.lastSuccessfulAt
                    ? formatTimestamp(selectedProject.monitor.lastSuccessfulAt, locale)
                    : copy.messages.notRecorded}
                </span>
                <span data-testid="detail-monitor-last-trigger">
                  {formatProjectReconcileTrigger(selectedProject.monitor.lastTrigger, copy)}
                </span>
                <span data-testid="detail-gsd-id">
                  {selectedProject.snapshot.identityHints.gsdId ?? copy.messages.noGsdId}
                </span>
                {renderStreamStrip()}
              </div>

              {selectedInitJob || selectedContinuity!.state === 'path_lost' || selectedContinuity!.lastRelinkedAt ? (
              <div className="detail-status-grid">
                <section className="subpanel init-panel" data-testid="init-panel">
                  <div className="subpanel__header subpanel__header--actions">
                    <div>
                      <h4>{copy.labels.initialization}</h4>
                      <p>{copy.help.initialization}</p>
                    </div>
                    <div className="panel-header__actions">
                      <span
                        className="status-pill"
                        data-status={selectedInitJob ? statusTone(selectedInitJob.stage) : 'neutral'}
                        data-testid="init-stage-banner"
                      >
                        {selectedInitJob
                          ? Array.from(
                            new Set([
                              ...selectedInitJob.history.map((entry) => copy.initStageLabels[entry.stage]),
                              copy.initStageLabels[selectedInitJob.stage],
                            ]),
                          ).join(' ')
                          : copy.empty.init}
                      </span>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          if (selectedProjectIdRef.current) {
                            void syncSelectedProjectPanels(selectedProjectIdRef.current);
                          }
                        }}
                      >
                        {copy.actions.reloadDetail}
                      </button>
                    </div>
                  </div>

                  {selectedInitJob && streamStatus !== 'connected' && hasActiveInitJob(selectedInitJob) ? (
                    <div className="inline-alert" data-testid="init-stream-note">
                      <p>{copy.messages.initStreamNote(copy.streamStatusLabels[streamStatus])}</p>
                    </div>
                  ) : null}

                  {selectedInitJob?.lastErrorDetail ? (
                    <p className="inline-alert inline-alert--error" data-testid="init-failure-detail">
                      {selectedInitJob.lastErrorDetail}
                    </p>
                  ) : null}

                  {selectedInitJob?.refreshResult ? (
                    <dl className="detail-facts detail-facts--compact" data-testid="init-refresh-result">
                      <div>
                        <dt>{copy.labels.refreshResult}</dt>
                        <dd>{selectedInitJob.refreshResult.detail}</dd>
                      </div>
                      <div>
                        <dt>{copy.labels.snapshotStatus}</dt>
                        <dd>{selectedInitJob.refreshResult.snapshotStatus ?? copy.messages.notRecorded}</dd>
                      </div>
                    </dl>
                  ) : null}

                  {selectedInitJob?.history.length ? (
                    <ol className="timeline-list timeline-list--compact" data-testid="init-history">
                      {selectedInitJob.history.map((entry) => (
                        <li className="timeline-item" data-status={statusTone(entry.stage)} key={entry.id}>
                          <div className="timeline-item__header">
                            <strong>{copy.initStageLabels[entry.stage]}</strong>
                            <time dateTime={entry.emittedAt}>{formatTimestamp(entry.emittedAt, locale)}</time>
                          </div>
                          <p className="timeline-item__detail">{entry.detail}</p>
                          {entry.outputExcerpt ? <p className="inline-code">{clampWarning(entry.outputExcerpt)}</p> : null}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p>{selectedInitSummary ?? copy.empty.init}</p>
                  )}
                </section>

                <section className="subpanel continuity-panel" data-testid="continuity-panel">
                  <div className="subpanel__header">
                    <div>
                      <h4>{copy.labels.projectContinuity}</h4>
                      <p>{copy.help.continuity}</p>
                    </div>
                    <span className="status-pill" data-status={continuityTone(selectedContinuity!.state)}>
                      {copy.continuityStateLabels[selectedContinuity!.state]}
                    </span>
                  </div>

                  <p className="detail-copy__lead">{selectedContinuitySummary}</p>

                  {selectedContinuity!.state === 'path_lost' ? (
                    <div className="inline-alert inline-alert--error" data-testid="continuity-path-lost-alert">
                      <strong>{copy.messages.pathLostTitle}</strong>
                      <p>{copy.messages.pathLostCopy(selectedProject.projectId)}</p>
                    </div>
                  ) : null}

                  {selectedContinuity!.lastRelinkedAt ? (
                    <div className="inline-alert inline-alert--success" data-testid="continuity-relinked-note">
                      <strong>{copy.messages.relinkedTitle}</strong>
                      <p>{copy.messages.relinkedCopy(selectedProject.projectId)}</p>
                    </div>
                  ) : null}

                  {selectedContinuity!.state === 'path_lost' ? (
                    <form className="relink-form" onSubmit={handleRelinkSelected}>
                      <div className="field">
                        <label htmlFor="relink-path-input">{copy.placeholders.movedProjectPath}</label>
                        <input
                          id="relink-path-input"
                          data-testid="relink-path-input"
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={copy.placeholders.movedProjectPath}
                          value={relinkPath}
                          onChange={(nextEvent) => {
                            setRelinkPath(nextEvent.target.value);
                            setRelinkError(null);
                            setRelinkSuccess(null);
                          }}
                        />
                      </div>
                      <div className="register-panel__actions">
                        <button type="submit" className="primary-button" disabled={relinkPending}>
                          {relinkPending ? copy.actions.relinking : copy.actions.relinkProject}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={relinkPending || relinkPath.length === 0}
                          onClick={() => {
                            setRelinkPath('');
                            setRelinkError(null);
                            setRelinkSuccess(null);
                          }}
                        >
                          {copy.actions.clearRelinkPath}
                        </button>
                      </div>
                    </form>
                  ) : null}

                  {relinkError ? (
                    <p className="inline-alert inline-alert--error" role="alert" data-testid="relink-error">
                      {relinkError}
                    </p>
                  ) : null}

                  {relinkSuccess ? (
                    <p className="inline-alert inline-alert--success" data-testid="relink-success">
                      {relinkSuccess}
                    </p>
                  ) : null}
                </section>
              </div>
              ) : null}

              <div className="visualizer-dashboard">
                <div className="visualizer-dashboard__left">
                  <WorkflowGraphPanel
                    milestones={selectedMilestones}
                    dependencies={selectedSliceDependencies}
                    activeMilestoneId={selectedActiveMilestone?.id ?? null}
                    activeSliceId={selectedActiveSlice?.id ?? null}
                    activeTask={selectedActiveTask}
                    copy={copy}
                  />

                  <RuntimeMetricsPanel
                    metrics={selectedMetrics}
                    executionStats={selectedExecutionStats}
                    workflowPhase={selectedWorkflowPhase}
                    locale={locale}
                    copy={copy}
                  />
                </div>

                <div className="visualizer-dashboard__right">
                  <div
                    className="workflow-tabs"
                    aria-label="GSD workflow sections"
                    role="tablist"
                    onKeyDown={handleWorkflowTabsKeyDown}
                  >
                {WORKFLOW_TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className="workflow-tabs__item"
                    id={`workflow-tab-${tab}`}
                    role="tab"
                    aria-selected={activeWorkflowTab === tab}
                    aria-controls={`workflow-panel-${tab}`}
                    aria-current={activeWorkflowTab === tab ? 'page' : undefined}
                    data-active={activeWorkflowTab === tab}
                    tabIndex={activeWorkflowTab === tab ? 0 : -1}
                    onClick={() => {
                      handleWorkflowTabSelect(tab);
                    }}
                  >
                    <WorkflowIcon tab={tab} />
                    <span>{workflowTabLabel(tab, copy)}</span>
                  </button>
                ))}
                  </div>

                  <div className="workflow-pages" data-active-tab={activeWorkflowTab}>
              <section
                className="workflow-page subpanel milestones-panel"
                id="workflow-panel-progress"
                role="tabpanel"
                aria-labelledby="workflow-tab-progress"
                data-testid="milestones-panel"
                hidden={activeWorkflowTab !== 'progress'}
              >
                <WorkflowMilestoneRail
                  milestones={selectedMilestones}
                  dependencies={selectedSliceDependencies}
                  activeMilestoneId={selectedActiveMilestone?.id ?? null}
                  activeSliceId={selectedActiveSlice?.id ?? null}
                  activeTask={selectedActiveTask}
                  validationIssueCount={selectedProject.snapshot.warnings.length}
                  locale={locale}
                  copy={copy}
                  variant="dashboard"
                />
              </section>

              <section
                className="workflow-page subpanel dependencies-panel"
                id="workflow-panel-dependencies"
                role="tabpanel"
                aria-labelledby="workflow-tab-dependencies"
                data-testid="dependencies-panel"
                hidden={activeWorkflowTab !== 'dependencies'}
              >
                <div className="subpanel__header">
                  <h4>{copy.labels.dependencies}</h4>
                  <p>{copy.formatCount(selectedSliceDependencies.length, 'entry')}</p>
                </div>
                {selectedSliceDependencies.length === 0 ? (
                  <p>{copy.messages.noDependencies}</p>
                ) : (
                  <div className="dependency-list dependency-map">
                    {selectedSliceDependencies.map((dependency) => (
                      <article
                        className="dependency-row"
                        key={`${dependency.milestoneId}-${dependency.fromId}-${dependency.toId}`}
                      >
                        <span className="meta-badge dependency-row__milestone">{dependency.milestoneId}</span>
                        <div className="dependency-node dependency-node--from">
                          <span>{copy.labels.source}</span>
                          <strong>{dependency.fromId}</strong>
                          <small>{dependency.fromTitle ?? copy.messages.unknown}</small>
                        </div>
                        <span className="dependency-link" aria-hidden="true">
                          <svg viewBox="0 0 72 20" focusable="false">
                            <path d="M2 10h62" />
                            <path d="m58 4 8 6-8 6" />
                          </svg>
                        </span>
                        <div className="dependency-node dependency-node--to">
                          <span>{copy.labels.tasks}</span>
                          <strong>{dependency.toId}</strong>
                          <small>{dependency.toTitle ?? copy.messages.unknown}</small>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <section
                className="workflow-page subpanel metrics-panel"
                id="workflow-panel-metrics"
                role="tabpanel"
                aria-labelledby="workflow-tab-metrics"
                data-testid="metrics-panel"
                hidden={activeWorkflowTab !== 'metrics'}
              >
                <div className="subpanel__header">
                  <h4>{copy.labels.metrics}</h4>
                  <p>{copy.labels.source}: .gsd/gsd.db + .gsd/metrics.json</p>
                </div>
                <div className="metric-grid">
                  <div>
                    <span className="stat-card__label">{copy.labels.gsdMilestones}</span>
                    <strong>{selectedGsdDb?.counts.milestones ?? 0}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.slices}</span>
                    <strong>{selectedGsdDb?.counts.slices ?? 0}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.tasks}</span>
                    <strong>{selectedGsdDb?.counts.tasks ?? 0}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.completed}</span>
                    <strong>{selectedMilestones.reduce((total, milestone) => total + milestone.completedTaskCount, 0)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.units}</span>
                    <strong>{selectedMetrics?.unitCount ?? 0}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.tokens}</span>
                    <strong>{formatCompactNumber(selectedMetrics?.totals.totalTokens ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.cost}</span>
                    <strong>{formatCost(selectedMetrics?.totals.cost ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.apiRequests}</span>
                    <strong>{formatCompactNumber(selectedMetrics?.totals.apiRequests ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.toolCalls}</span>
                    <strong>{formatCompactNumber(selectedMetrics?.totals.toolCalls ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.dependencies}</span>
                    <strong>{selectedSliceDependencies.length}</strong>
                  </div>
                </div>
              </section>

              <section
                className="workflow-page subpanel timeline-panel"
                id="workflow-panel-timeline"
                role="tabpanel"
                aria-labelledby="workflow-tab-timeline"
                data-testid="timeline-panel"
                hidden={activeWorkflowTab !== 'timeline'}
              >
                <div className="subpanel__header subpanel__header--actions">
                  <div>
                    <h4>{copy.labels.recentTimeline}</h4>
                    <p>{copy.help.timeline}</p>
                  </div>
                  <div className="panel-header__actions">
                    <span className="meta-badge" data-testid="timeline-total">
                      {selectedTaskTimelineCountLabel}
                    </span>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        if (selectedProjectIdRef.current) {
                          void syncSelectedProjectPanels(selectedProjectIdRef.current);
                        }
                      }}
                      disabled={!selectedProjectId || detailLoading || timelineLoading}
                    >
                      {detailLoading || timelineLoading ? copy.actions.reloading : copy.actions.reloadTimeline}
                    </button>
                  </div>
                </div>

                {selectedTaskTimeline.length === 0 ? (
                  <p data-testid="timeline-empty">{copy.empty.timeline}</p>
                ) : null}

                {selectedTaskTimeline.length > 0 ? (
                  <ol className="timeline-list" data-testid="timeline-list">
                    {selectedTaskTimeline.map((entry) => {
                      const taskStatus = formatWorkflowStatus(entry.task.status, copy);
                      const taskTone = statusTone(entry.task.status);
                      const elapsedActiveMs =
                        entry.actualDurationMs
                        ?? (entry.startedAtMs !== null && entry.finishedAtMs === null && isWorkflowStatusActive(entry.task.status)
                          ? Math.max(0, nowMs - entry.startedAtMs)
                          : null);
                      const timelineBudgetMs = (elapsedActiveMs ?? 0) + (entry.estimatedRemainingMs ?? 0);
                      const actualWidthPercent =
                        timelineBudgetMs > 0 && elapsedActiveMs !== null
                          ? Math.min(100, Math.max(6, Math.round((elapsedActiveMs / timelineBudgetMs) * 100)))
                          : isWorkflowStatusComplete(entry.task.status)
                            ? 100
                            : 0;

                      return (
                        <li
                          className="timeline-item timeline-item--task"
                          data-status={taskTone}
                          data-testid="task-timeline-item"
                          key={entry.key}
                        >
                          <div className="timeline-item__header timeline-item__header--task">
                            <div>
                              <span className="meta-badge">{entry.path}</span>
                              <strong>{taskDisplayTitle(entry.task, copy)}</strong>
                            </div>
                            <span className="status-pill" data-status={taskTone}>
                              {taskStatus}
                            </span>
                          </div>

                          <div
                            className="task-timeline__bar"
                            aria-hidden="true"
                            data-complete={isWorkflowStatusComplete(entry.task.status)}
                          >
                            <span style={{ width: `${actualWidthPercent}%` }} />
                          </div>

                          <dl className="task-timeline__meta">
                            <div>
                              <dt>{copy.labels.firstStarted}</dt>
                              <dd>
                                {entry.startedAtMs === null
                                  ? copy.messages.notRecorded
                                  : formatMetricTimestamp(entry.startedAtMs, locale, copy.messages.notRecorded)}
                              </dd>
                            </div>
                            <div>
                              <dt>{copy.labels.lastFinished}</dt>
                              <dd>
                                {entry.finishedAtMs === null
                                  ? isWorkflowStatusActive(entry.task.status)
                                    ? taskStatus
                                    : copy.messages.notRecorded
                                  : formatMetricTimestamp(entry.finishedAtMs, locale, copy.messages.notRecorded)}
                              </dd>
                            </div>
                            <div>
                              <dt>{copy.labels.actualDuration}</dt>
                              <dd>{formatDuration(elapsedActiveMs, locale, copy.messages.notRecorded)}</dd>
                            </div>
                            <div>
                              <dt>{copy.labels.estimatedRemaining}</dt>
                              <dd>{formatDuration(entry.estimatedRemainingMs, locale, copy.messages.estimateUnavailable)}</dd>
                            </div>
                          </dl>
                        </li>
                      );
                    })}
                  </ol>
                ) : null}

                <section className="project-event-log" data-testid="project-event-log">
                  <div className="project-event-log__header">
                    <h5>{copy.labels.project} {copy.labels.event}</h5>
                    <span className="meta-badge" data-testid="project-event-total">
                      {selectedTimelineCountLabel}
                    </span>
                  </div>

                  {projectTimeline.items.length === 0 ? (
                    <p>{copy.messages.noLastEvent}</p>
                  ) : (
                    <ol className="project-event-list" data-testid="project-event-list">
                      {projectTimeline.items.map((entry) => (
                        <li className="timeline-item" data-type={entry.type} key={entry.id}>
                          <div className="timeline-item__header">
                            <strong>{copy.timelineTypeLabels[entry.type]}</strong>
                            <time dateTime={entry.emittedAt}>{formatTimestamp(entry.emittedAt, locale)}</time>
                          </div>

                          <div className="timeline-item__badges">
                            <span className="status-pill" data-status={timelineTone(entry.type)}>
                              {copy.timelineTypeLabels[entry.type]}
                            </span>
                            <span className="status-pill" data-status={entry.snapshotStatus}>
                              {copy.statusLabels[entry.snapshotStatus]}
                            </span>
                            <span className="status-pill" data-status={entry.monitorHealth}>
                              {copy.monitorHealthLabels[entry.monitorHealth]}
                            </span>
                            <span className="meta-badge">
                              {copy.reconcileTriggerLabels[entry.trigger]}
                            </span>
                            <span className="meta-badge">
                              {copy.formatCount(entry.warningCount, 'warning')}
                            </span>
                          </div>

                          <p className="timeline-item__detail">{entry.detail}</p>

                          {entry.error ? (
                            <div className="timeline-item__error inline-alert inline-alert--error">
                              <strong>
                                {entry.error.scope} · {formatTimestamp(entry.error.at, locale)}
                              </strong>
                              <p>{clampWarning(entry.error.message)}</p>
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </section>

              <section
                className="workflow-page workflow-page--stack"
                id="workflow-panel-agent"
                role="tabpanel"
                aria-labelledby="workflow-tab-agent"
                hidden={activeWorkflowTab !== 'agent'}
              >
              <section className="subpanel agent-panel" data-testid="agent-panel">
                <div className="subpanel__header subpanel__header--actions">
                  <div>
                    <h4>{copy.labels.agent}</h4>
                    <p>{copy.labels.source}: .gsd/metrics.json</p>
                  </div>
                  <div className="detail-header__meta">
                    <span className="meta-badge">{copy.labels.primaryModel}: {primaryModel}</span>
                    <span className="meta-badge">{copy.formatCount(selectedExecutionStats.units.length, 'unit')}</span>
                  </div>
                </div>

                <div className="agent-summary-grid">
                  <div>
                    <span className="stat-card__label">{copy.labels.tokens}</span>
                    <strong>{formatCompactNumber(selectedMetrics?.totals.totalTokens ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.cost}</span>
                    <strong>{formatCost(selectedMetrics?.totals.cost ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.toolCalls}</span>
                    <strong>{formatCompactNumber(selectedMetrics?.totals.toolCalls ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.apiRequests}</span>
                    <strong>{formatCompactNumber(selectedMetrics?.totals.apiRequests ?? 0, locale)}</strong>
                  </div>
                  <div>
                    <span className="stat-card__label">{copy.labels.averageUnitDuration}</span>
                    <strong>{formatDuration(averageUnitDurationMs, locale, copy.messages.notRecorded)}</strong>
                  </div>
                </div>

                <div className="agent-usage-layout">
                  <section>
                    <h5>{copy.labels.modelUsage}</h5>
                    {selectedExecutionStats.modelUsage.length === 0 ? (
                      <p>{copy.messages.noModelUsage}</p>
                    ) : (
                      <div className="model-usage-list">
                        {selectedExecutionStats.modelUsage.map((model) => (
                          <article className="model-usage-row" key={model.model}>
                            <div>
                              <strong>{model.model}</strong>
                              <span>{model.unitCount} {copy.labels.units}</span>
                            </div>
                            <span>{formatCompactNumber(model.totalTokens, locale)} {copy.labels.tokens}</span>
                            <span>{formatCost(model.cost, locale)}</span>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                  <section>
                    <h5>{copy.labels.recentAgentUnits}</h5>
                    {selectedRecentExecutionUnits.length === 0 ? (
                      <p>{copy.messages.noAgentUnits}</p>
                    ) : (
                      <ol className="agent-unit-list">
                        {selectedRecentExecutionUnits.map((unit) => (
                          <li key={unit.key}>
                            <div>
                              <strong>{unit.id ?? unit.type ?? copy.messages.unknown}</strong>
                              <span>{unit.model ?? copy.messages.unknown}</span>
                            </div>
                            <span>{formatDuration(unit.durationMs, locale, copy.messages.notRecorded)}</span>
                            <span>{formatCompactNumber(unit.totalTokens, locale)} {copy.labels.tokens}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                </div>
              </section>

              <section
                className="subpanel monitor-panel"
                data-testid="monitor-panel"
              >
                <div className="subpanel__header">
                  <div>
                    <h4>{copy.labels.monitorFreshness}</h4>
                    <p>{copy.help.monitor}</p>
                  </div>
                  <div className="detail-header__meta detail-header__meta--monitor">
                    <span className="status-pill" data-status={selectedProject.monitor.health}>
                      {copy.monitorHealthLabels[selectedProject.monitor.health]}
                    </span>
                    <span className="meta-badge">{formatProjectReconcileTrigger(selectedProject.monitor.lastTrigger, copy)}</span>
                  </div>
                </div>

                <p className="detail-copy__lead" data-testid="monitor-summary-copy">
                  {selectedMonitorSummary}
                </p>

                {selectedProject.monitor.lastError ? (
                  <div className="inline-alert inline-alert--error monitor-alert" data-testid="monitor-last-error">
                    <strong>
                      {selectedProject.monitor.lastError.scope} at {formatTimestamp(selectedProject.monitor.lastError.at, locale)}
                    </strong>
                    <p>{clampWarning(selectedProject.monitor.lastError.message)}</p>
                  </div>
                ) : null}
              </section>
              </section>

              <section
                className="workflow-page workflow-page--stack"
                id="workflow-panel-changes"
                role="tabpanel"
                aria-labelledby="workflow-tab-changes"
                hidden={activeWorkflowTab !== 'changes'}
              >
              <section className="subpanel" data-testid="detail-directory">
                <h4>{copy.labels.directorySummary}</h4>
                {selectedProject.snapshot.directory.isEmpty ? (
                  <p>{copy.messages.directoryEmpty}</p>
                ) : (
                  <>
                    <p>{copy.messages.directorySamples}</p>
                    <ul className="tag-list">
                      {selectedProject.snapshot.directory.sampleEntries.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                      {selectedProject.snapshot.directory.sampleTruncated ? <li>{copy.messages.truncated}</li> : null}
                    </ul>
                  </>
                )}
              </section>

              <section className="subpanel" data-testid="warning-list">
                <h4>{copy.labels.warnings}</h4>
                {selectedProject.snapshot.warnings.length === 0 ? (
                  <p>{copy.messages.noWarnings}</p>
                ) : (
                  <ul className="warning-list">
                    {selectedProject.snapshot.warnings.map((warning, index) => (
                      <li key={`${warning.source}-${warning.code}-${index}`}>
                        <strong>{copy.sourceLabels[warning.source]}</strong>
                        <span className="warning-code">{warning.code}</span>
                        <span title={warning.message}>{clampWarning(warning.message)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section
                className="subpanel source-grid"
                data-testid="source-grid"
              >
                <div className="subpanel__header">
                  <h4>{copy.labels.snapshotSourceStates}</h4>
                  <p>{copy.help.sources}</p>
                </div>
                <div className="source-grid__rows">
                  {SNAPSHOT_SOURCE_NAMES.map((sourceName) => {
                    const source = selectedProject.snapshot.sources[sourceName];

                    return (
                      <article
                        key={sourceName}
                        className="source-row"
                        data-source-state={source.state}
                        data-testid={`source-${sourceName}`}
                      >
                        <div>
                          <strong>{copy.sourceLabels[sourceName]}</strong>
                          <p>{source.detail ?? copy.messages.noExtraSourceDetail}</p>
                        </div>
                        <span className="status-pill status-pill--source" data-status={sourceTone(source.state)}>
                          {source.state}
                        </span>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="subpanel" data-testid="repo-meta-section">
                <h4>{copy.labels.repoMetadata}</h4>
                {selectedProject.snapshot.sources.repoMeta.value ? (
                  <dl className="detail-facts detail-facts--compact">
                    <div>
                      <dt>{copy.labels.project}</dt>
                      <dd>{selectedProject.snapshot.sources.repoMeta.value.projectName ?? copy.messages.unknown}</dd>
                    </div>
                    <div>
                      <dt>{copy.labels.branch}</dt>
                      <dd>{selectedProject.snapshot.sources.repoMeta.value.currentBranch ?? copy.messages.unknown}</dd>
                    </div>
                    <div>
                      <dt>{copy.labels.headSha}</dt>
                      <dd>{selectedProject.snapshot.sources.repoMeta.value.headSha ?? copy.messages.unknown}</dd>
                    </div>
                    <div>
                      <dt>{copy.labels.dirty}</dt>
                      <dd>
                        {selectedProject.snapshot.sources.repoMeta.value.dirty === null
                          ? copy.messages.unknown
                          : copy.formatBoolean(selectedProject.snapshot.sources.repoMeta.value.dirty)}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p>{copy.messages.repoMetaUnavailable}</p>
                )}
              </section>

              <section className="subpanel">
                <h4>{copy.labels.workspaceNotes}</h4>
                <div className="detail-copy">
                  <p>
                    <strong>PROJECT.md:</strong>{' '}
                    {selectedProject.snapshot.sources.projectMd.value?.summary ??
                      selectedProject.snapshot.sources.projectMd.detail ??
                      copy.messages.noProjectSummary}
                  </p>
                  <p>
                    <strong>STATE.md:</strong>{' '}
                    {selectedProject.snapshot.sources.stateMd.value?.summary ??
                      selectedProject.snapshot.sources.stateMd.detail ??
                      copy.messages.noStateSummary}
                  </p>
                </div>
              </section>
              </section>

              <section
                className="workflow-page subpanel export-panel"
                id="workflow-panel-export"
                role="tabpanel"
                aria-labelledby="workflow-tab-export"
                data-testid="export-panel"
                hidden={activeWorkflowTab !== 'export'}
              >
                <div className="subpanel__header subpanel__header--actions">
                  <div>
                    <h4>{copy.labels.export}</h4>
                    <p>{copy.labels.dataLocation}</p>
                  </div>
                  <button type="button" className="primary-button" onClick={handleExportSelected}>
                    <WorkflowIcon tab="export" />
                    <span>{copy.actions.exportSnapshot}</span>
                  </button>
                </div>

                <dl className="detail-facts detail-facts--compact">
                  <div>
                    <dt>{copy.labels.projectId}</dt>
                    <dd>{selectedProject.projectId}</dd>
                  </div>
                  <div>
                    <dt>{copy.labels.registeredPath}</dt>
                    <dd>{selectedProject.registeredPath}</dd>
                  </div>
                  <div>
                    <dt>{copy.labels.gsdRoot}</dt>
                    <dd>{selectedProject.dataLocation.gsdRootPath}</dd>
                  </div>
                  <div>
                    <dt>{copy.labels.gsdDbPath}</dt>
                    <dd>{selectedProject.dataLocation.gsdDbPath}</dd>
                  </div>
                </dl>
              </section>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div
              className="empty-state"
              data-testid={detailRoutePending ? 'detail-route-loading' : 'detail-route-fallback'}
            >
              <h3>{detailRoutePending ? copy.actions.reloading : copy.empty.detailTitle}</h3>
              <p>
                {detailRoutePending
                  ? detailRouteProjectId
                    ? `${copy.labels.projectDetail}: ${detailRouteProjectId}`
                    : copy.empty.detailCopy
                  : detailRouteFallbackMessage}
              </p>
              <div className="register-panel__actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={detailRoutePending}
                  onClick={() => {
                    void syncInventory(detailRouteProjectId ?? selectedProjectIdRef.current, {
                      fallbackToFirstProject: detailRouteProjectId === null,
                    });
                  }}
                >
                  {detailRoutePending ? copy.actions.reloading : copy.actions.retryInventory}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    navigateToRoute({ page: 'overview' });
                  }}
                >
                  {copy.actions.enterOverview}
                </button>
              </div>
            </div>
          )}
          </div>
          <div className="terminal-dock">
            <div className="terminal-dock__status">
              <strong>{copy.labels.terminal}</strong>
              <span aria-hidden="true">^</span>
              <p>
                {selectedProject
                  ? `${copy.messages.terminalIdle} · ${selectedProject.dataLocation.gsdDbPath}`
                  : copy.messages.terminalIdle}
              </p>
            </div>
            {selectedProject ? (
              <div className="terminal-dock__actions">
                {selectedInitActionVisible ? (
                  <button
                    type="button"
                    className="secondary-button"
                    data-testid="init-action"
                    onClick={() => {
                      void handleInitializeSelected();
                    }}
                    disabled={selectedInitActionDisabled}
                  >
                    {initButtonLabel(
                      selectedProject,
                      {
                        requestPending: selectedInitRequestPending,
                        syncingDetail: selectedInitSyncingDetail,
                      },
                      copy,
                    )}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={selectedInitActionVisible ? 'secondary-button' : 'primary-button'}
                  onClick={() => {
                    void handleRefreshSelected();
                  }}
                  disabled={!selectedProjectId || refreshPending}
                >
                  {refreshPending ? copy.actions.refreshing : copy.actions.refreshSelected}
                </button>
              </div>
            ) : null}
          </div>
        </section>
        </section>
        ) : null}
        </section>
      </section>
      )}

      {directoryPickerOpen ? (
        <div className="directory-picker-backdrop" role="presentation">
          <section
            className="directory-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="directory-picker-heading"
            data-testid="directory-picker"
          >
            <div className="directory-picker__header">
              <div>
                <p className="eyebrow">{copy.labels.serverFilesystem}</p>
                <h2 id="directory-picker-heading">{copy.actions.browseFolders}</h2>
                <p>{copy.messages.selectedFolderHint}</p>
              </div>
              <button
                type="button"
                className="secondary-button secondary-button--icon"
                onClick={() => {
                  setDirectoryPickerOpen(false);
                }}
              >
                <span>{copy.actions.closePicker}</span>
              </button>
            </div>

            <div className="directory-picker__toolbar">
              <div>
                <span className="stat-card__label">{copy.labels.currentFolder}</span>
                <strong>{directoryPicker?.path ?? copy.messages.notRecorded}</strong>
              </div>
              <div className="directory-picker__actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!directoryPicker?.parentPath || directoryPickerLoading}
                  onClick={() => {
                    void loadDirectoryPicker(directoryPicker?.parentPath ?? null);
                  }}
                >
                  {copy.actions.openParentFolder}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={directoryPickerLoading}
                  onClick={() => {
                    void loadDirectoryPicker(directoryPicker?.path ?? null);
                  }}
                >
                  {directoryPickerLoading ? copy.actions.loadingFolders : copy.actions.refreshFolders}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!directoryPicker || registerPending}
                  onClick={() => {
                    if (directoryPicker) {
                      void submitRegisterPath(directoryPicker.path, {
                        closeDirectoryPickerOnSuccess: true,
                      });
                    }
                  }}
                >
                  <FolderIcon />
                  <span>{registerPending ? copy.actions.registering : copy.actions.useCurrentFolder}</span>
                </button>
              </div>
            </div>

            <div className="directory-picker__browser">
              {registerError ? (
                <p className="inline-alert inline-alert--error" role="alert" data-testid="directory-register-error">
                  {registerError}
                </p>
              ) : null}

              {directoryPickerError ? (
                <p className="inline-alert inline-alert--error" role="alert">
                  {directoryPickerError}
                </p>
              ) : null}

              {directoryPickerLoading && !directoryPicker ? (
                <p className="directory-picker__empty">{copy.actions.loadingFolders}</p>
              ) : directoryPicker && directoryPicker.entries.length > 0 ? (
                <ul className="directory-picker__list">
                  {directoryPicker.entries.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        className="directory-picker__entry"
                        onClick={() => {
                          void loadDirectoryPicker(entry.path);
                        }}
                      >
                        <FolderIcon />
                        <span>{entry.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="directory-picker__empty">{copy.messages.noFolderEntries}</p>
              )}
            </div>

            {directoryPicker?.truncated ? (
              <p className="directory-picker__note">{copy.messages.folderListTruncated}</p>
            ) : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
