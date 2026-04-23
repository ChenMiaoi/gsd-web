import type {
  ProjectContinuityState,
  ProjectInitJobStage,
  ProjectMonitorHealth,
  ProjectReconcileTrigger,
  ProjectSnapshotStatus,
  ProjectTimelineEntryType,
  SnapshotSourceName,
} from '../shared/contracts.js';

export type Locale = 'en' | 'zh';
export type StreamStatus = 'connecting' | 'connected' | 'disconnected';
export type CountNoun = 'project' | 'warning' | 'entry' | 'milestone' | 'slice' | 'task' | 'unit';

export const LOCALE_STORAGE_KEY = 'gsd-web.locale';

export interface UiCopy {
  languageName: string;
  languageToggleLabel: string;
  localeOptions: Record<Locale, string>;
  app: {
    eyebrow: string;
    title: string;
    lede: string;
    healthRailLabel: string;
    healthRailCopy: string;
    welcomeEyebrow: string;
    welcomeLead: string;
    welcomePreview: string;
  };
  stats: {
    registered: string;
    initialized: string;
    degraded: string;
    uninitialized: string;
    liveStream: string;
    lastSseEvent: string;
    waitingForEvent: string;
  };
  labels: {
    workspacePages: string;
    overview: string;
    details: string;
    portfolio: string;
    projectOverview: string;
    statusBreakdown: string;
    activeProjects: string;
    totalCost: string;
    totalElapsed: string;
    totalWarnings: string;
    projectPath: string;
    newProjectPath: string;
    registeredInventory: string;
    projectDetail: string;
    monitorFreshness: string;
    projectContinuity: string;
    initialization: string;
    directorySummary: string;
    warnings: string;
    recentTimeline: string;
    snapshotSourceStates: string;
    repoMetadata: string;
    workspaceNotes: string;
    gsdMilestones: string;
    dependencies: string;
    metrics: string;
    agent: string;
    changes: string;
    export: string;
    progress: string;
    total: string;
    completed: string;
    source: string;
    slices: string;
    tasks: string;
    units: string;
    tokens: string;
    cost: string;
    toolCalls: string;
    apiRequests: string;
    workflowPhase: string;
    workflowVisualizer: string;
    remainingSlices: string;
    dataLocation: string;
    gsdRoot: string;
    gsdDbPath: string;
    milestoneRail: string;
    criticalPath: string;
    recentCompletedUnits: string;
    terminal: string;
    validationIssues: string;
    registeredPath: string;
    projectId: string;
    lastEvent: string;
    snapshotChecked: string;
    lastAttempted: string;
    lastSuccessful: string;
    lastTrigger: string;
    gsdId: string;
    repoFingerprint: string;
    pathLostAt: string;
    lastRelinked: string;
    previousPath: string;
    continuityChecked: string;
    refreshResult: string;
    snapshotStatus: string;
    warningsAfterRefresh: string;
    refreshEvent: string;
    snapshot: string;
    changed: string;
    event: string;
    project: string;
    branch: string;
    headSha: string;
    dirty: string;
    serverFilesystem: string;
    currentFolder: string;
    folders: string;
    executionStats: string;
    elapsed: string;
    averageTaskDuration: string;
    remainingTasks: string;
    estimatedRemaining: string;
    estimatedFinish: string;
    currentStage: string;
    currentTask: string;
    actualDuration: string;
    firstStarted: string;
    lastFinished: string;
    risk: string;
    modelUsage: string;
    recentAgentUnits: string;
    primaryModel: string;
    averageUnitDuration: string;
    serviceState: string;
  };
  help: {
    registerPanel: string;
    portfolioProjection: string;
    statusBreakdown: string;
    inventoryProjection: string;
    detailProjection: string;
    monitor: string;
    continuity: string;
    initialization: string;
    timeline: string;
    sources: string;
  };
  actions: {
    registerProject: string;
    registering: string;
    clearInput: string;
    refreshInventory: string;
    refreshing: string;
    retryInventory: string;
    reloadDetail: string;
    reloading: string;
    refreshSelected: string;
    relinkProject: string;
    relinking: string;
    clearRelinkPath: string;
    initializeProject: string;
    retryInitialization: string;
    startingInitialization: string;
    refreshingMonitoredDetail: string;
    reloadTimeline: string;
    retryTimeline: string;
    exportSnapshot: string;
    browseFolders: string;
    closePicker: string;
    useCurrentFolder: string;
    openParentFolder: string;
    refreshFolders: string;
    loadingFolders: string;
    enterOverview: string;
    openSelectedProject: string;
  };
  placeholders: {
    projectPath: string;
    movedProjectPath: string;
  };
  empty: {
    inventoryTitle: string;
    inventoryCopy: string;
    detailTitle: string;
    detailCopy: string;
    timeline: string;
    init: string;
  };
  messages: {
    noLastEvent: string;
    notRecorded: string;
    noGsdId: string;
    repoFingerprintUnavailable: string;
    noMissingPath: string;
    noRelink: string;
    noPriorPath: string;
    pathLostTitle: string;
    pathLostCopy: (projectId: string) => string;
    relinkedTitle: string;
    relinkedCopy: (projectId: string) => string;
    initStreamNote: (streamStatus: string) => string;
    unavailable: string;
    directoryEmpty: string;
    directorySamples: string;
    truncated: string;
    noWarnings: string;
    noExtraSourceDetail: string;
    repoMetaUnavailable: string;
    noProjectSummary: string;
    noStateSummary: string;
    noMilestones: string;
    noDependencies: string;
    unknown: string;
    yes: string;
    no: string;
    timelineOnlyState: string;
    noChanges: string;
    validationClear: string;
    terminalIdle: string;
    noFolderEntries: string;
    folderListTruncated: string;
    noExecutionUnits: string;
    estimateUnavailable: string;
    noAgentUnits: string;
    noModelUsage: string;
    selectedFolderHint: string;
  };
  notices: {
    registeredSuccess: (name: string) => string;
    relinkSuccess: (projectId: string, canonicalPath: string) => string;
    reconnecting: string;
    reconnectedWithSelection: string;
    reconnectedInventory: string;
    reconnectFailed: string;
  };
  summaries: {
    monitorHealthy: (snapshotStatus: string, trigger: string) => string;
    monitorDegraded: string;
    monitorReadFailed: string;
    monitorStale: string;
    continuityTracked: string;
  };
  errors: {
    unexpected: string;
    emptyRegisterPath: string;
    duplicateRegisterPath: string;
    detailTimeout: string;
    timelineTimeout: string;
    inventoryTimeout: string;
    registerTimeout: string;
    relinkUnavailable: string;
    emptyRelinkPath: string;
    duplicateRelinkPath: string;
    relinkTimeout: string;
    initTimeout: string;
    refreshTimeout: string;
    folderBrowserTimeout: string;
    projectRouteNotFound: (projectId: string) => string;
  };
  initStageLabels: Record<ProjectInitJobStage, string>;
  sourceLabels: Record<SnapshotSourceName, string>;
  statusLabels: Record<ProjectSnapshotStatus, string>;
  monitorHealthLabels: Record<ProjectMonitorHealth, string>;
  timelineTypeLabels: Record<ProjectTimelineEntryType, string>;
  continuityStateLabels: Record<ProjectContinuityState, string>;
  reconcileTriggerLabels: Record<ProjectReconcileTrigger, string>;
  streamStatusLabels: Record<StreamStatus, string>;
  streamStatusMessages: Record<StreamStatus, string>;
  formatCount: (count: number, noun: CountNoun) => string;
  formatBoolean: (value: boolean) => string;
}

function formatEnglishCount(count: number, noun: CountNoun) {
  const plural: Record<CountNoun, string> = {
    project: 'projects',
    warning: 'warnings',
    entry: 'entries',
    milestone: 'milestones',
    slice: 'slices',
    task: 'tasks',
    unit: 'units',
  };

  return `${count} ${count === 1 ? noun : plural[noun]}`;
}

function formatChineseCount(count: number, noun: CountNoun) {
  const label: Record<CountNoun, string> = {
    project: '个项目',
    warning: '条警告',
    entry: '条记录',
    milestone: '个里程碑',
    slice: '个切片',
    task: '个任务',
    unit: '个单元',
  };

  return `${count} ${label[noun]}`;
}

export const UI_COPY: Record<Locale, UiCopy> = {
  en: {
    languageName: 'English',
    languageToggleLabel: 'Language',
    localeOptions: {
      en: 'EN',
      zh: '中文',
    },
    app: {
      eyebrow: 'LOCAL-FIRST SERVICE SHELL',
      title: 'Project inventory',
      lede:
        'Register local paths, inspect truthful snapshot health, and watch live refresh events land from the same hosted Fastify process.',
      healthRailLabel: 'Operations overview',
      healthRailCopy: 'A dense local console for bootstrap state, continuity, and monitor freshness.',
      welcomeEyebrow: 'Open-source project console',
      welcomeLead:
        'A local-first welcome gate for the GSD project inventory. Enter the overview, then open each project through its own route-backed detail page.',
      welcomePreview: 'Route-backed inventory, live events, and project detail stay shareable from the address bar.',
    },
    stats: {
      registered: 'Registered',
      initialized: 'Initialized',
      degraded: 'Degraded',
      uninitialized: 'Uninitialized',
      liveStream: 'Live stream',
      lastSseEvent: 'Last SSE event',
      waitingForEvent: 'Waiting for the first event envelope.',
    },
    labels: {
      workspacePages: 'Workspace pages',
      overview: 'Overview',
      details: 'Details',
      portfolio: 'Portfolio summary',
      projectOverview: 'Project overview',
      statusBreakdown: 'Status breakdown',
      activeProjects: 'Active projects',
      totalCost: 'Total cost',
      totalElapsed: 'Total elapsed',
      totalWarnings: 'Total warnings',
      projectPath: 'Project path',
      newProjectPath: 'New project path',
      registeredInventory: 'Registered inventory',
      projectDetail: 'Project detail',
      monitorFreshness: 'Monitor freshness',
      projectContinuity: 'Project continuity',
      initialization: 'Initialization',
      directorySummary: 'Directory summary',
      warnings: 'Warnings',
      recentTimeline: 'Recent timeline',
      snapshotSourceStates: 'Snapshot source states',
      repoMetadata: 'Repo metadata',
      workspaceNotes: 'Workspace notes',
      gsdMilestones: 'GSD milestones',
      dependencies: 'Dependencies',
      metrics: 'Metrics',
      agent: 'Agent',
      changes: 'Changes',
      export: 'Export',
      progress: 'Progress',
      total: 'Total',
      completed: 'Completed',
      source: 'Source',
      slices: 'Slices',
      tasks: 'Tasks',
      units: 'Units',
      tokens: 'Tokens',
      cost: 'Cost',
      toolCalls: 'Tool calls',
      apiRequests: 'API requests',
      workflowPhase: 'Phase',
      workflowVisualizer: 'Workflow Visualizer',
      remainingSlices: 'Slices remaining',
      dataLocation: 'Data location',
      gsdRoot: 'GSD root',
      gsdDbPath: 'GSD database',
      milestoneRail: 'Milestones',
      criticalPath: 'Critical path',
      recentCompletedUnits: 'Recent completed units',
      terminal: 'Terminal',
      validationIssues: 'Validation issues',
      registeredPath: 'Registered path',
      projectId: 'Project id',
      lastEvent: 'Last event',
      snapshotChecked: 'Snapshot checked',
      lastAttempted: 'Last attempted',
      lastSuccessful: 'Last successful',
      lastTrigger: 'Last trigger',
      gsdId: 'GSD id',
      repoFingerprint: 'Repo fingerprint',
      pathLostAt: 'Path lost at',
      lastRelinked: 'Last relinked',
      previousPath: 'Previous path',
      continuityChecked: 'Continuity checked',
      refreshResult: 'Refresh result',
      snapshotStatus: 'Snapshot status',
      warningsAfterRefresh: 'Warnings after refresh',
      refreshEvent: 'Refresh event',
      snapshot: 'Snapshot',
      changed: 'Changed',
      event: 'Event',
      project: 'Project',
      branch: 'Branch',
      headSha: 'Head SHA',
      dirty: 'Dirty',
      serverFilesystem: 'Server filesystem',
      currentFolder: 'Current folder',
      folders: 'Folders',
      executionStats: 'Execution stats',
      elapsed: 'Elapsed',
      averageTaskDuration: 'Avg task time',
      remainingTasks: 'Tasks remaining',
      estimatedRemaining: 'Estimated remaining',
      estimatedFinish: 'Estimated finish',
      currentStage: 'Current stage',
      currentTask: 'Current task',
      actualDuration: 'Actual time',
      firstStarted: 'First started',
      lastFinished: 'Last finished',
      risk: 'Risk',
      modelUsage: 'Model usage',
      recentAgentUnits: 'Recent agent units',
      primaryModel: 'Primary model',
      averageUnitDuration: 'Avg unit time',
      serviceState: 'Service state',
    },
    help: {
      registerPanel:
        'Registration stays read-only: the service snapshots the directory, records a stable project id, and leaves the monitored workspace untouched.',
      portfolioProjection:
        'Aggregated cost, elapsed time, and state across every registered project. Select a project to open detail.',
      statusBreakdown: 'Status totals are computed from the current project inventory and metrics snapshots.',
      inventoryProjection: 'Current projection from /api/projects.',
      detailProjection: 'Truthful snapshot from /api/projects/:id plus manual refresh.',
      monitor: 'Service-owned reconcile health that stays distinct from the current snapshot state.',
      continuity: 'Stable identity, explicit path-loss truth, and relink stay attached to the same project record.',
      initialization: 'Explicitly run the supported `/gsd init` flow without leaving this project detail.',
      timeline: 'Persisted project events from registration, refresh, monitoring, path loss, and relink activity.',
      sources: 'Per-source truth from the backend snapshot adapter.',
    },
    actions: {
      registerProject: 'Register project',
      registering: 'Registering...',
      clearInput: 'Clear input',
      refreshInventory: 'Refresh inventory',
      refreshing: 'Refreshing...',
      retryInventory: 'Retry inventory',
      reloadDetail: 'Reload detail',
      reloading: 'Reloading...',
      refreshSelected: 'Refresh selected project',
      relinkProject: 'Relink project',
      relinking: 'Relinking...',
      clearRelinkPath: 'Clear relink path',
      initializeProject: 'Initialize project',
      retryInitialization: 'Retry initialization',
      startingInitialization: 'Starting initialization...',
      refreshingMonitoredDetail: 'Refreshing monitored detail...',
      reloadTimeline: 'Reload timeline',
      retryTimeline: 'Retry timeline',
      exportSnapshot: 'Export snapshot JSON',
      browseFolders: 'Browse folders',
      closePicker: 'Close',
      useCurrentFolder: 'Register this folder',
      openParentFolder: 'Parent',
      refreshFolders: 'Refresh folders',
      loadingFolders: 'Loading folders...',
      enterOverview: 'Enter overview',
      openSelectedProject: 'Open selected project',
    },
    placeholders: {
      projectPath: '/absolute/path/to/project',
      movedProjectPath: '/absolute/path/to/moved/project',
    },
    empty: {
      inventoryTitle: 'No registered projects yet.',
      inventoryCopy: 'Register an empty directory or initialized workspace to see truthful snapshot status.',
      detailTitle: 'No project selected.',
      detailCopy: 'Register or choose a project card to inspect its truthful snapshot detail.',
      timeline: 'No recent timeline entries are persisted for this project yet.',
      init: 'This project will stay uninitialized until you explicitly start the supported bootstrap flow.',
    },
    messages: {
      noLastEvent: 'Waiting for the first project event.',
      notRecorded: 'Not recorded yet.',
      noGsdId: 'No .gsd-id discovered.',
      repoFingerprintUnavailable: 'Not available yet.',
      noMissingPath: 'No missing-path state recorded.',
      noRelink: 'No relink recorded yet.',
      noPriorPath: 'No prior path recorded.',
      pathLostTitle: 'The registered project root is missing.',
      pathLostCopy: (projectId) =>
        `The dashboard is preserving the last good snapshot, latest init job, and recent timeline for ${projectId} until you relink the project to its new path.`,
      relinkedTitle: 'This project was relinked without changing identity.',
      relinkedCopy: (projectId) =>
        `The current snapshot, init history, and persisted timeline remain attached to project id ${projectId}.`,
      initStreamNote: (streamStatus) =>
        `Live init updates are ${streamStatus.toLowerCase()}. Reload detail to inspect persisted job truth while the stream recovers.`,
      unavailable: 'Unavailable',
      directoryEmpty: 'The directory is empty, so the project remains uninitialized.',
      directorySamples: 'Sample entries from the live directory read:',
      truncated: '...truncated',
      noWarnings: 'No degraded or missing-source warnings were emitted.',
      noExtraSourceDetail: 'No extra source detail was emitted.',
      repoMetaUnavailable: 'Repo metadata is unavailable until repo-meta.json parses cleanly.',
      noProjectSummary: 'No project markdown summary available.',
      noStateSummary: 'No state summary available.',
      noMilestones: 'No milestone rows were found in .gsd/gsd.db yet.',
      noDependencies: 'No slice dependencies can be inferred from the current milestone rows.',
      unknown: 'Unknown',
      yes: 'Yes',
      no: 'No',
      timelineOnlyState: 'Timeline-only state',
      noChanges: 'No warning-level changes are visible in the current snapshot.',
      validationClear: 'No validation issues',
      terminalIdle: 'Waiting for next task',
      noFolderEntries: 'No readable child folders were found here.',
      folderListTruncated: 'Folder list was truncated to keep browsing fast.',
      noExecutionUnits: 'No timed GSD execution units were found in metrics.json yet.',
      estimateUnavailable: 'Not enough completed timed units to estimate.',
      noAgentUnits: 'No recent agent units were recorded yet.',
      noModelUsage: 'No model usage has been recorded yet.',
      selectedFolderHint: 'Choose a folder from the service host and use it as the project path.',
    },
    notices: {
      registeredSuccess: (name) => `Registered ${name}.`,
      relinkSuccess: (projectId, canonicalPath) =>
        `Relinked ${projectId} to ${canonicalPath} without creating a new project id.`,
      reconnecting: 'Reconnected. Resyncing inventory, detail, and timeline.',
      reconnectedWithSelection: 'Reconnected and resynced inventory, detail, and timeline without a manual refresh.',
      reconnectedInventory: 'Reconnected and resynced the current inventory without a manual refresh.',
      reconnectFailed:
        'Reconnected, but a JSON resync panel failed. The last good dashboard state stayed visible while you retry.',
    },
    summaries: {
      monitorHealthy: (snapshotStatus, trigger) =>
        `The monitor last confirmed a ${snapshotStatus} snapshot via ${trigger}.`,
      monitorDegraded: 'The monitor is seeing a degraded snapshot. Snapshot warnings remain inspectable below.',
      monitorReadFailed:
        'The latest monitor attempt could not read current project truth, so the last good snapshot remains visible.',
      monitorStale: 'The monitor has not yet recorded a successful reconcile for this project.',
      continuityTracked: 'This project identity is still tracking its current canonical path.',
    },
    errors: {
      unexpected: 'An unexpected dashboard error occurred.',
      emptyRegisterPath: 'Enter a local path before registering a project.',
      duplicateRegisterPath: 'That path is already present in the inventory.',
      detailTimeout: 'Project detail timed out. The last visible snapshot is still shown while you retry.',
      timelineTimeout: 'Project timeline timed out. The last visible timeline is still shown while you retry.',
      inventoryTimeout: 'Project inventory timed out. Retry to keep the current list and detail visible.',
      registerTimeout: 'Project registration timed out. Your current input and inventory remain unchanged.',
      relinkUnavailable: 'Relink is only available after the current project path is reported missing.',
      emptyRelinkPath: 'Enter the project’s new local path before relinking it.',
      duplicateRelinkPath: 'That path is already owned by another tracked project.',
      relinkTimeout:
        'Project relink timed out. The current project detail, init history, and timeline stayed visible while you retry.',
      initTimeout:
        'Project initialization timed out. The current project detail stayed visible, and you can retry when the request resolves.',
      refreshTimeout: 'Project refresh timed out. The last visible snapshot is still shown while you retry.',
      folderBrowserTimeout: 'Server directory browsing timed out. The current path input was not changed.',
      projectRouteNotFound: (projectId) => `No registered project matches route id ${projectId}.`,
    },
    initStageLabels: {
      queued: 'Queued',
      starting: 'Starting',
      initializing: 'Initializing',
      refreshing: 'Refreshing',
      succeeded: 'Succeeded',
      failed: 'Failed',
      timed_out: 'Timed out',
      cancelled: 'Cancelled',
    },
    sourceLabels: {
      directory: 'Directory',
      gsdDirectory: '.gsd directory',
      gsdId: '.gsd-id',
      projectMd: 'PROJECT.md',
      repoMeta: 'repo-meta.json',
      autoLock: 'auto.lock',
      stateMd: 'STATE.md',
      metricsJson: 'metrics.json',
      gsdDb: 'gsd.db',
    },
    statusLabels: {
      uninitialized: 'Uninitialized',
      initialized: 'Initialized',
      degraded: 'Degraded',
    },
    monitorHealthLabels: {
      healthy: 'Healthy',
      degraded: 'Degraded',
      read_failed: 'Read failed',
      stale: 'Stale',
    },
    timelineTypeLabels: {
      registered: 'Registered',
      refreshed: 'Refreshed',
      path_lost: 'Path lost',
      relinked: 'Relinked',
      monitor_degraded: 'Degraded',
      monitor_recovered: 'Recovered',
    },
    continuityStateLabels: {
      tracked: 'Tracked',
      path_lost: 'Path lost',
    },
    reconcileTriggerLabels: {
      register: 'Register',
      manual_refresh: 'Manual refresh',
      init_refresh: 'Init refresh',
      monitor_boot: 'Monitor boot',
      monitor_interval: 'Monitor interval',
      watcher: 'Watcher',
      relink: 'Relink',
    },
    streamStatusLabels: {
      connecting: 'Connecting',
      connected: 'Connected',
      disconnected: 'Disconnected',
    },
    streamStatusMessages: {
      connecting: 'Opening the live stream and waiting for the first server event.',
      connected: 'Live events are connected. Snapshot truth still comes from project JSON and monitor metadata.',
      disconnected: 'Live events dropped. The dashboard keeps the last good state and will resync JSON after reconnect.',
    },
    formatCount: formatEnglishCount,
    formatBoolean: (value) => String(value),
  },
  zh: {
    languageName: '中文',
    languageToggleLabel: '语言',
    localeOptions: {
      en: 'EN',
      zh: '中文',
    },
    app: {
      eyebrow: '本地优先服务面板',
      title: '项目清单',
      lede: '登记本机项目路径，查看真实快照健康度，并在同一个 Fastify 服务中接收实时刷新事件。',
      healthRailLabel: '运行概览',
      healthRailCopy: '面向本地 GSD 工作区的状态、连续性和监控新鲜度控制台。',
      welcomeEyebrow: '开源项目控制台',
      welcomeLead: '本地优先的 GSD 项目清单入口。进入总览后，每个项目都会通过自己的路由打开详情页。',
      welcomePreview: '清单、实时事件和项目详情都绑定到地址栏，刷新或分享链接时仍能回到对应页面。',
    },
    stats: {
      registered: '已登记',
      initialized: '已初始化',
      degraded: '降级',
      uninitialized: '未初始化',
      liveStream: '实时流',
      lastSseEvent: '最近事件',
      waitingForEvent: '正在等待第一个事件包。',
    },
    labels: {
      workspacePages: '工作区页面',
      overview: '总览',
      details: '详情',
      portfolio: '项目总览',
      projectOverview: '项目概览',
      statusBreakdown: '状态分布',
      activeProjects: '活跃项目',
      totalCost: '总成本',
      totalElapsed: '总耗时',
      totalWarnings: '总警告',
      projectPath: '项目路径',
      newProjectPath: '新的项目路径',
      registeredInventory: '已登记清单',
      projectDetail: '项目详情',
      monitorFreshness: '监控新鲜度',
      projectContinuity: '项目连续性',
      initialization: '初始化',
      directorySummary: '目录摘要',
      warnings: '警告',
      recentTimeline: '最近时间线',
      snapshotSourceStates: '快照来源状态',
      repoMetadata: '仓库元数据',
      workspaceNotes: '工作区备注',
      gsdMilestones: 'GSD 里程碑',
      dependencies: '依赖关系',
      metrics: '指标',
      agent: 'Agent',
      changes: '变更',
      export: '导出',
      progress: '进度',
      total: '总计',
      completed: '已完成',
      source: '来源',
      slices: '切片',
      tasks: '任务',
      units: '单元',
      tokens: 'Tokens',
      cost: '成本',
      toolCalls: '工具调用',
      apiRequests: 'API 请求',
      workflowPhase: '阶段',
      workflowVisualizer: '工作流可视化',
      remainingSlices: '剩余切片',
      dataLocation: '数据位置',
      gsdRoot: 'GSD 根目录',
      gsdDbPath: 'GSD 数据库',
      milestoneRail: '里程碑',
      criticalPath: '关键路径',
      recentCompletedUnits: '最近完成单元',
      terminal: '终端',
      validationIssues: '校验问题',
      registeredPath: '登记路径',
      projectId: '项目 ID',
      lastEvent: '最近事件',
      snapshotChecked: '快照检查时间',
      lastAttempted: '最近尝试',
      lastSuccessful: '最近成功',
      lastTrigger: '最近触发',
      gsdId: 'GSD ID',
      repoFingerprint: '仓库指纹',
      pathLostAt: '路径丢失时间',
      lastRelinked: '最近重连',
      previousPath: '先前路径',
      continuityChecked: '连续性检查',
      refreshResult: '刷新结果',
      snapshotStatus: '快照状态',
      warningsAfterRefresh: '刷新后警告',
      refreshEvent: '刷新事件',
      snapshot: '快照',
      changed: '是否变化',
      event: '事件',
      project: '项目',
      branch: '分支',
      headSha: 'Head SHA',
      dirty: '未提交变更',
      serverFilesystem: '服务端文件系统',
      currentFolder: '当前目录',
      folders: '目录',
      executionStats: '执行统计',
      elapsed: '已用时间',
      averageTaskDuration: '平均任务耗时',
      remainingTasks: '剩余任务',
      estimatedRemaining: '预计剩余',
      estimatedFinish: '预计结束',
      currentStage: '当前阶段',
      currentTask: '当前任务',
      actualDuration: '实际耗时',
      firstStarted: '首次开始',
      lastFinished: '最近完成',
      risk: '等级',
      modelUsage: '模型使用',
      recentAgentUnits: '最近 Agent 单元',
      primaryModel: '主要模型',
      averageUnitDuration: '平均单元耗时',
      serviceState: '服务状态',
    },
    help: {
      registerPanel: '登记操作只读执行：服务会扫描目录、记录稳定项目 ID，不会修改被监控的工作区。',
      portfolioProjection: '汇总所有已登记项目的成本、耗时与状态。选择一个项目即可进入详情。',
      statusBreakdown: '状态统计来自当前项目清单和 metrics 快照。',
      inventoryProjection: '来自 /api/projects 的当前投影。',
      detailProjection: '来自 /api/projects/:id 的真实快照，并支持手动刷新。',
      monitor: '服务侧 reconcile 健康度，与当前快照状态分开呈现。',
      continuity: '稳定身份、路径丢失事实和重连记录都会保留在同一个项目记录上。',
      initialization: '无需离开详情页，即可显式运行受支持的 `/gsd init` 流程。',
      timeline: '展示登记、刷新、监控、路径丢失与重连等已持久化项目事件。',
      sources: '后端快照适配器返回的逐来源事实。',
    },
    actions: {
      registerProject: '登记项目',
      registering: '登记中...',
      clearInput: '清空输入',
      refreshInventory: '刷新清单',
      refreshing: '刷新中...',
      retryInventory: '重试清单',
      reloadDetail: '重新加载详情',
      reloading: '加载中...',
      refreshSelected: '刷新选中项目',
      relinkProject: '重连项目',
      relinking: '重连中...',
      clearRelinkPath: '清空重连路径',
      initializeProject: '初始化项目',
      retryInitialization: '重试初始化',
      startingInitialization: '正在启动初始化...',
      refreshingMonitoredDetail: '正在刷新监控详情...',
      reloadTimeline: '重新加载时间线',
      retryTimeline: '重试时间线',
      exportSnapshot: '导出快照 JSON',
      browseFolders: '选择目录',
      closePicker: '关闭',
      useCurrentFolder: '登记此目录',
      openParentFolder: '上一级',
      refreshFolders: '刷新目录',
      loadingFolders: '正在读取目录...',
      enterOverview: '进入总览',
      openSelectedProject: '打开选中项目',
    },
    placeholders: {
      projectPath: '/absolute/path/to/project',
      movedProjectPath: '/absolute/path/to/moved/project',
    },
    empty: {
      inventoryTitle: '还没有登记项目。',
      inventoryCopy: '登记一个空目录或已初始化工作区，即可查看真实快照状态。',
      detailTitle: '未选择项目。',
      detailCopy: '登记或选择一个项目卡片来查看真实快照详情。',
      timeline: '该项目还没有持久化的最近时间线记录。',
      init: '在你显式启动受支持的 bootstrap 流程之前，该项目会保持未初始化状态。',
    },
    messages: {
      noLastEvent: '正在等待第一个项目事件。',
      notRecorded: '尚未记录。',
      noGsdId: '未发现 .gsd-id。',
      repoFingerprintUnavailable: '暂不可用。',
      noMissingPath: '未记录路径丢失状态。',
      noRelink: '尚未记录重连。',
      noPriorPath: '没有先前路径记录。',
      pathLostTitle: '登记的项目根目录当前不可用。',
      pathLostCopy: (projectId) =>
        `面板会为 ${projectId} 保留最近一次良好快照、最新初始化任务和近期时间线，直到你把项目重连到新路径。`,
      relinkedTitle: '该项目已在不改变身份的情况下重连。',
      relinkedCopy: (projectId) => `当前快照、初始化历史和持久化时间线仍然归属于项目 ID ${projectId}。`,
      initStreamNote: (streamStatus) =>
        `实时初始化更新当前为“${streamStatus}”。可重新加载详情查看持久化任务事实，等待事件流恢复。`,
      unavailable: '不可用',
      directoryEmpty: '该目录为空，因此项目仍处于未初始化状态。',
      directorySamples: '实时目录读取的示例条目：',
      truncated: '...已截断',
      noWarnings: '没有产生降级或缺失来源警告。',
      noExtraSourceDetail: '没有额外来源详情。',
      repoMetaUnavailable: 'repo-meta.json 正常解析后才会显示仓库元数据。',
      noProjectSummary: '没有可用的项目 Markdown 摘要。',
      noStateSummary: '没有可用的状态摘要。',
      noMilestones: '.gsd/gsd.db 中暂未发现 milestone 记录。',
      noDependencies: '当前 milestone 记录中还无法推断 slice 依赖。',
      unknown: '未知',
      yes: '是',
      no: '否',
      timelineOnlyState: '仅时间线状态',
      noChanges: '当前快照没有可见的警告级变更。',
      validationClear: '没有校验问题',
      terminalIdle: '等待下一个任务',
      noFolderEntries: '这里没有可读取的子目录。',
      folderListTruncated: '目录列表已截断，以保持浏览速度。',
      noExecutionUnits: 'metrics.json 中还没有可计时的 GSD 执行单元。',
      estimateUnavailable: '已完成的计时单元不足，暂无法估算。',
      noAgentUnits: '还没有记录最近的 Agent 单元。',
      noModelUsage: '还没有记录模型使用情况。',
      selectedFolderHint: '从服务运行机器的文件树中选择目录，并作为项目路径使用。',
    },
    notices: {
      registeredSuccess: (name) => `已登记 ${name}。`,
      relinkSuccess: (projectId, canonicalPath) => `已将 ${projectId} 重连到 ${canonicalPath}，没有创建新的项目 ID。`,
      reconnecting: '已重连。正在同步清单、详情和时间线。',
      reconnectedWithSelection: '已重连并同步清单、详情和时间线，无需手动刷新。',
      reconnectedInventory: '已重连并同步当前清单，无需手动刷新。',
      reconnectFailed: '已重连，但 JSON 同步面板失败。上一次良好面板状态会保持可见，可稍后重试。',
    },
    summaries: {
      monitorHealthy: (snapshotStatus, trigger) => `监控最近通过 ${trigger} 确认了 ${snapshotStatus} 快照。`,
      monitorDegraded: '监控观察到降级快照。你仍可在下方查看快照警告。',
      monitorReadFailed: '最近一次监控尝试无法读取当前项目事实，因此仍保留最近一次良好快照。',
      monitorStale: '该项目还没有记录成功的 reconcile。',
      continuityTracked: '该项目身份仍在跟踪当前规范路径。',
    },
    errors: {
      unexpected: '面板发生了意外错误。',
      emptyRegisterPath: '登记项目之前请输入本地路径。',
      duplicateRegisterPath: '该路径已经在清单中。',
      detailTimeout: '项目详情请求超时。重试期间仍会显示最近可见快照。',
      timelineTimeout: '项目时间线请求超时。重试期间仍会显示最近可见时间线。',
      inventoryTimeout: '项目清单请求超时。可重试以保持当前列表和详情可见。',
      registerTimeout: '项目登记请求超时。当前输入和清单不会改变。',
      relinkUnavailable: '只有当前项目路径被报告为丢失后，才能执行重连。',
      emptyRelinkPath: '重连之前请输入项目新的本地路径。',
      duplicateRelinkPath: '该路径已经被另一个被跟踪项目占用。',
      relinkTimeout: '项目重连请求超时。当前详情、初始化历史和时间线会保持可见，可稍后重试。',
      initTimeout: '项目初始化请求超时。当前项目详情会保持可见，请求完成后可以重试。',
      refreshTimeout: '项目刷新请求超时。重试期间仍会显示最近可见快照。',
      folderBrowserTimeout: '服务端目录浏览超时。当前路径输入不会改变。',
      projectRouteNotFound: (projectId) => `没有已登记项目匹配路由 ID ${projectId}。`,
    },
    initStageLabels: {
      queued: '已排队',
      starting: '启动中',
      initializing: '初始化中',
      refreshing: '刷新中',
      succeeded: '成功',
      failed: '失败',
      timed_out: '超时',
      cancelled: '已取消',
    },
    sourceLabels: {
      directory: '目录',
      gsdDirectory: '.gsd 目录',
      gsdId: '.gsd-id',
      projectMd: 'PROJECT.md',
      repoMeta: 'repo-meta.json',
      autoLock: 'auto.lock',
      stateMd: 'STATE.md',
      metricsJson: 'metrics.json',
      gsdDb: 'gsd.db',
    },
    statusLabels: {
      uninitialized: '未初始化',
      initialized: '已初始化',
      degraded: '降级',
    },
    monitorHealthLabels: {
      healthy: '健康',
      degraded: '降级',
      read_failed: '读取失败',
      stale: '等待刷新',
    },
    timelineTypeLabels: {
      registered: '已登记',
      refreshed: '已刷新',
      path_lost: '路径丢失',
      relinked: '已重连',
      monitor_degraded: '降级',
      monitor_recovered: '已恢复',
    },
    continuityStateLabels: {
      tracked: '跟踪中',
      path_lost: '路径丢失',
    },
    reconcileTriggerLabels: {
      register: '登记',
      manual_refresh: '手动刷新',
      init_refresh: '初始化刷新',
      monitor_boot: '监控启动',
      monitor_interval: '定时监控',
      watcher: '文件监听',
      relink: '重连',
    },
    streamStatusLabels: {
      connecting: '连接中',
      connected: '已连接',
      disconnected: '已断开',
    },
    streamStatusMessages: {
      connecting: '正在打开实时流并等待第一个服务事件。',
      connected: '实时事件已连接。快照事实仍来自项目 JSON 和监控元数据。',
      disconnected: '实时事件已断开。面板保留上一次良好状态，并会在重连后同步 JSON。',
    },
    formatCount: formatChineseCount,
    formatBoolean: (value) => (value ? 'true' : 'false'),
  },
};

export function getInitialLocale(): Locale {
  const storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);

  if (storedLocale === 'en' || storedLocale === 'zh') {
    return storedLocale;
  }

  return window.navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
