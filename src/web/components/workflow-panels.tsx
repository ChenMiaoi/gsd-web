import { useCallback, useEffect, useRef, useState } from 'react';

import type { GsdDbMilestoneSummary, GsdDbTaskSummary, GsdMetricsSummaryValue } from '../../shared/contracts.js';
import type { Locale, UiCopy } from '../i18n.js';
import {
  WORKFLOW_GRAPH_BASE_HEIGHT,
  WORKFLOW_GRAPH_BASE_WIDTH,
  WORKFLOW_GRAPH_MAX_ZOOM,
  WORKFLOW_GRAPH_MIN_ZOOM,
  WORKFLOW_GRAPH_ROW_HEIGHT,
  WORKFLOW_GRAPH_ZOOM_STEP,
  ZoomInIcon,
  ZoomOutIcon,
  ResetZoomIcon,
  buildSparklinePoints,
  buildWorkflowGraphConnectorPath,
  clampRecentUnits,
  findActiveTask,
  formatRiskLevel,
  formatWorkflowStatus,
  formatCompactNumber,
  formatDuration,
  formatTimestamp,
  getMilestoneProgress,
  getMilestoneProgressPercent,
  getSliceProgressPercent,
  getSliceRiskLevel,
  getWorkflowFocus,
  isWorkflowStatusComplete,
  milestoneTitle,
  orderWorkflowMilestones,
  orderWorkflowSlices,
  orderWorkflowTasks,
  sentenceCaseTitle,
  sliceTitle,
  statusTone,
  taskDisplayTitle,
  useDragScrollViewport,
  workflowSliceKey,
  type SliceDependencyView,
  type WorkflowExecutionStats,
  type WorkflowGraphConnector,
} from '../app/model.js';

export function WorkflowGraphPanel({
  milestones,
  dependencies,
  activeMilestoneId,
  activeSliceId,
  activeTask,
  copy,
}: {
  milestones: GsdDbMilestoneSummary[];
  dependencies: SliceDependencyView[];
  activeMilestoneId: string | null;
  activeSliceId: string | null;
  activeTask: GsdDbTaskSummary | null;
  copy: UiCopy;
}) {
  const { focusedMilestone, focusedSlice, focusedTask } = getWorkflowFocus(
    milestones,
    activeMilestoneId,
    activeSliceId,
    activeTask,
  );
  const visibleMilestones = milestones;
  const visibleSlices = focusedMilestone?.slices ?? [];
  const visibleTasks = focusedSlice?.tasks ?? [];
  const activePath = [focusedMilestone?.id, focusedSlice?.id, focusedTask?.id]
    .filter((segment): segment is string => Boolean(segment))
    .join(' -> ');
  const visibleDependencies =
    focusedMilestone === null
      ? dependencies
      : dependencies.filter((dependency) => dependency.milestoneId === focusedMilestone.id);
  const graphHeight = Math.max(
    WORKFLOW_GRAPH_BASE_HEIGHT,
    Math.max(visibleMilestones.length, visibleSlices.length, visibleTasks.length, 3) * WORKFLOW_GRAPH_ROW_HEIGHT,
  );
  const graphCanvasRef = useRef<HTMLDivElement | null>(null);
  const activeMilestoneNodeRef = useRef<HTMLLIElement | null>(null);
  const activeSliceNodeRef = useRef<HTMLLIElement | null>(null);
  const activeTaskNodeRef = useRef<HTMLLIElement | null>(null);
  const [connectors, setConnectors] = useState<{
    milestoneToSlice: WorkflowGraphConnector | null;
    sliceToTask: WorkflowGraphConnector | null;
  }>({
    milestoneToSlice: null,
    sliceToTask: null,
  });
  const setActiveMilestoneNodeRef = useCallback((node: HTMLLIElement | null) => {
    activeMilestoneNodeRef.current = node;
  }, []);
  const setActiveSliceNodeRef = useCallback((node: HTMLLIElement | null) => {
    activeSliceNodeRef.current = node;
  }, []);
  const setActiveTaskNodeRef = useCallback((node: HTMLLIElement | null) => {
    activeTaskNodeRef.current = node;
  }, []);
  const graphViewport = useDragScrollViewport({
    contentWidth: WORKFLOW_GRAPH_BASE_WIDTH,
    contentHeight: graphHeight,
    initialZoom: 1,
    minZoom: WORKFLOW_GRAPH_MIN_ZOOM,
    maxZoom: WORKFLOW_GRAPH_MAX_ZOOM,
    zoomStep: WORKFLOW_GRAPH_ZOOM_STEP,
  });
  const graphWidth = WORKFLOW_GRAPH_BASE_WIDTH * graphViewport.zoom;
  const graphScaledHeight = graphHeight * graphViewport.zoom;

  useEffect(() => {
    const canvas = graphCanvasRef.current;

    if (!canvas) {
      return undefined;
    }

    const measureConnectors = () => {
      const canvasRect = canvas.getBoundingClientRect();
      const measure = (from: HTMLElement | null, to: HTMLElement | null) => {
        if (!from || !to) {
          return null;
        }

        const fromRect = from.getBoundingClientRect();
        const toRect = to.getBoundingClientRect();

        return {
          x1: fromRect.right - canvasRect.left,
          y1: fromRect.top - canvasRect.top + fromRect.height / 2,
          x2: toRect.left - canvasRect.left,
          y2: toRect.top - canvasRect.top + toRect.height / 2,
        };
      };

      setConnectors({
        milestoneToSlice: measure(activeMilestoneNodeRef.current, activeSliceNodeRef.current),
        sliceToTask:
          focusedTask !== null
            ? measure(activeSliceNodeRef.current, activeTaskNodeRef.current)
            : null,
      });
    };

    const frameId = window.requestAnimationFrame(() => {
      measureConnectors();
    });
    const handleResize = () => {
      measureConnectors();
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', handleResize);
    };
  }, [
    focusedMilestone?.id,
    focusedSlice?.id,
    focusedTask?.id,
    graphHeight,
    graphViewport.zoom,
    visibleMilestones.length,
    visibleSlices.length,
    visibleTasks.length,
  ]);

  return (
    <section className="dashboard-panel workflow-graph-panel" data-testid="workflow-graph-panel">
      <div className="dashboard-panel__header dashboard-panel__header--graph">
        <div className="dashboard-panel__copy">
          <h4>{copy.labels.workflowVisualizer}</h4>
          <p>
            {copy.labels.criticalPath}: <span className="inline-code">{activePath || copy.messages.notRecorded}</span>
          </p>
        </div>
        <div className="detail-header__meta">
          <span className="meta-badge">{copy.formatCount(milestones.length, 'milestone')}</span>
          <span className="meta-badge">
            {copy.formatCount(focusedMilestone?.sliceCount ?? 0, 'slice')}
          </span>
          <span className="meta-badge">
            {copy.formatCount(focusedMilestone?.taskCount ?? 0, 'task')}
          </span>
        </div>
      </div>

      {milestones.length === 0 ? (
        <p>{copy.messages.noMilestones}</p>
      ) : (
        <>
          <div className="workflow-graph__stage">
            <div className="workflow-graph__toolbar">
              <p className="workflow-graph__hint">{copy.messages.dragGraphHint}</p>

              <div className="workflow-graph__controls">
                <span className="meta-badge">{graphViewport.zoomPercentage}%</span>
                <button
                  type="button"
                  className="secondary-button secondary-button--icon"
                  aria-label={copy.actions.zoomOutGraph}
                  title={copy.actions.zoomOutGraph}
                  disabled={!graphViewport.canZoom || graphViewport.zoom <= WORKFLOW_GRAPH_MIN_ZOOM}
                  onClick={() => {
                    graphViewport.zoomOut();
                  }}
                >
                  <ZoomOutIcon />
                </button>
                <button
                  type="button"
                  className="secondary-button secondary-button--icon"
                  aria-label={copy.actions.zoomInGraph}
                  title={copy.actions.zoomInGraph}
                  disabled={!graphViewport.canZoom || graphViewport.zoom >= WORKFLOW_GRAPH_MAX_ZOOM}
                  onClick={() => {
                    graphViewport.zoomIn();
                  }}
                >
                  <ZoomInIcon />
                </button>
                <button
                  type="button"
                  className="secondary-button secondary-button--icon"
                  aria-label={copy.actions.resetGraphZoom}
                  title={copy.actions.resetGraphZoom}
                  disabled={graphViewport.zoom === 1}
                  onClick={() => {
                    graphViewport.resetZoom();
                  }}
                >
                  <ResetZoomIcon />
                </button>
              </div>
            </div>

            <div
              ref={graphViewport.viewportRef}
              className="workflow-graph__viewport"
              data-draggable={graphViewport.canPan}
              data-dragging={graphViewport.isDragging}
              data-testid="workflow-graph-viewport"
              onPointerDown={graphViewport.handlePointerDown}
              onPointerMove={graphViewport.handlePointerMove}
              onPointerUp={graphViewport.handlePointerUp}
              onPointerCancel={graphViewport.handlePointerCancel}
              onWheel={graphViewport.handleWheel}
            >
              <div
                ref={graphCanvasRef}
                className="workflow-graph__canvas"
                style={{
                  width: `${graphWidth}px`,
                  height: `${graphScaledHeight}px`,
                }}
              >
                <svg
                  className="workflow-graph__overlay"
                  aria-hidden="true"
                  viewBox={`0 0 ${graphWidth} ${graphScaledHeight}`}
                >
                  <defs>
                    <linearGradient id="workflow-graph-connector-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="rgba(255, 83, 207, 0.94)" />
                      <stop offset="100%" stopColor="rgba(66, 221, 255, 0.96)" />
                    </linearGradient>
                    <marker
                      id="workflow-graph-arrowhead"
                      markerWidth="10"
                      markerHeight="10"
                      refX="8"
                      refY="3.5"
                      orient="auto"
                    >
                      <path d="M0 0 8 3.5 0 7z" fill="rgba(66, 221, 255, 0.96)" />
                    </marker>
                  </defs>

                  {connectors.milestoneToSlice ? (
                    <path
                      className="workflow-graph__connector-path"
                      d={buildWorkflowGraphConnectorPath(connectors.milestoneToSlice)}
                      markerEnd="url(#workflow-graph-arrowhead)"
                    />
                  ) : null}

                  {connectors.sliceToTask ? (
                    <path
                      className="workflow-graph__connector-path"
                      d={buildWorkflowGraphConnectorPath(connectors.sliceToTask)}
                      markerEnd="url(#workflow-graph-arrowhead)"
                    />
                  ) : null}
                </svg>

                <div
                  className="workflow-graph"
                  style={{
                    width: `${WORKFLOW_GRAPH_BASE_WIDTH}px`,
                    height: `${graphHeight}px`,
                    transform: `scale(${graphViewport.zoom})`,
                  }}
                >
                  <section className="workflow-graph__column">
                    <span className="workflow-graph__label">{copy.labels.gsdMilestones}</span>
                    <ol className="workflow-graph__stack">
                      {visibleMilestones.map((milestone) => {
                        const isActive = milestone.id === focusedMilestone?.id;

                        return (
                          <li
                            className="workflow-graph__node"
                            data-active={isActive}
                            data-status={statusTone(milestone.status)}
                            key={milestone.id}
                            ref={isActive ? setActiveMilestoneNodeRef : undefined}
                          >
                            <span className="workflow-graph__node-id">{milestone.id}</span>
                          </li>
                        );
                      })}
                    </ol>
                  </section>

                  <div className="workflow-graph__connector" aria-hidden="true" />

                  <section className="workflow-graph__column">
                    <span className="workflow-graph__label">{copy.labels.slices}</span>
                    <ol className="workflow-graph__stack">
                      {visibleSlices.length === 0 ? (
                        <li className="workflow-graph__node workflow-graph__node--empty" data-status="neutral">
                          <span className="workflow-graph__node-id">--</span>
                        </li>
                      ) : (
                        visibleSlices.map((slice) => {
                          const isActive = slice.id === focusedSlice?.id;

                          return (
                            <li
                              className="workflow-graph__node"
                              data-active={isActive}
                              data-status={statusTone(slice.status)}
                              key={`${focusedMilestone?.id ?? 'milestone'}-${slice.id}`}
                              ref={isActive ? setActiveSliceNodeRef : undefined}
                            >
                              <span className="workflow-graph__node-id">{slice.id}</span>
                            </li>
                          );
                        })
                      )}
                    </ol>
                  </section>

                  <div className="workflow-graph__connector" aria-hidden="true" />

                  <section className="workflow-graph__column">
                    <span className="workflow-graph__label">{copy.labels.tasks}</span>
                    <ol className="workflow-graph__stack">
                      {visibleTasks.length === 0 ? (
                        <li className="workflow-graph__node workflow-graph__node--empty" data-status="neutral">
                          <span className="workflow-graph__node-id">--</span>
                        </li>
                      ) : (
                        visibleTasks.map((task) => {
                          const isActive = task.id === focusedTask?.id;

                          return (
                            <li
                              className="workflow-graph__node"
                              data-active={isActive}
                              data-status={isActive ? 'active' : statusTone(task.status)}
                              key={`${focusedSlice?.id ?? 'slice'}-${task.id}`}
                              ref={isActive ? setActiveTaskNodeRef : undefined}
                            >
                              <span className="workflow-graph__node-id">{task.id}</span>
                            </li>
                          );
                        })
                      )}
                    </ol>
                  </section>
                </div>
              </div>
            </div>
          </div>

          <div className="workflow-graph__dependencies">
            <span className="workflow-graph__dependencies-label">{copy.labels.dependencies}</span>
            {visibleDependencies.length === 0 ? (
              <span className="workflow-graph__dependency-pill">
                {copy.messages.noDependencies}
              </span>
            ) : (
              visibleDependencies.map((dependency) => (
                <span
                  className="workflow-graph__dependency-pill"
                  key={`${dependency.milestoneId}-${dependency.fromId}-${dependency.toId}`}
                >
                  {dependency.fromId} -&gt; {dependency.toId}
                </span>
              ))
            )}
            <span className="workflow-graph__dependencies-count">
              {copy.formatCount(visibleDependencies.length, 'entry')}
            </span>
          </div>
        </>
      )}
    </section>
  );
}

export function RuntimeMetricsPanel({
  metrics,
  executionStats,
  workflowPhase,
  locale,
  copy,
}: {
  metrics: GsdMetricsSummaryValue | null;
  executionStats: WorkflowExecutionStats;
  workflowPhase: string;
  locale: Locale;
  copy: UiCopy;
}) {
  const chartUnits = clampRecentUnits(executionStats.units, 9);
  const durationSeries = chartUnits.map((unit) => Math.max(0, unit.durationMs ?? 0));
  const tokenSeries = chartUnits.map((unit) => Math.max(0, unit.totalTokens));
  const activitySeries = chartUnits.map((unit) => Math.max(0, unit.toolCalls + unit.apiRequests));
  const hasChartData = durationSeries.length > 0;

  return (
    <section className="dashboard-panel runtime-metrics-panel" data-testid="runtime-metrics-dashboard">
      <div className="dashboard-panel__header">
        <div className="dashboard-panel__copy">
          <h4>{copy.labels.metrics}</h4>
          <p>{copy.labels.source}: .gsd/metrics.json</p>
        </div>
        <div className="detail-header__meta">
          <span className="meta-badge">{copy.formatCount(executionStats.remainingTasks, 'task')}</span>
          <span className="meta-badge">
            {formatDuration(executionStats.estimatedRemainingMs, locale, copy.messages.estimateUnavailable)}
          </span>
        </div>
      </div>

      <div className="runtime-metrics-panel__stats">
        <div>
          <span className="stat-card__label">{copy.labels.elapsed}</span>
          <strong>{formatDuration(executionStats.elapsedMs, locale, copy.messages.notRecorded)}</strong>
        </div>
        <div>
          <span className="stat-card__label">{copy.labels.units}</span>
          <strong>{executionStats.units.length}</strong>
        </div>
        <div>
          <span className="stat-card__label">{copy.labels.tokens}</span>
          <strong>{formatCompactNumber(metrics?.totals.totalTokens ?? 0, locale)}</strong>
        </div>
        <div>
          <span className="stat-card__label">{copy.labels.apiRequests}</span>
          <strong>{formatCompactNumber(metrics?.totals.apiRequests ?? 0, locale)}</strong>
        </div>
      </div>

      <div className="runtime-metrics-panel__chart-shell">
        {hasChartData ? (
          <svg
            className="runtime-metrics-panel__chart"
            viewBox="0 0 420 180"
            role="img"
            aria-label={copy.labels.metrics}
          >
            <defs>
              <linearGradient id="runtimeAreaGradient" x1="0%" x2="0%" y1="0%" y2="100%">
                <stop offset="0%" stopColor="rgba(255, 83, 207, 0.26)" />
                <stop offset="100%" stopColor="rgba(255, 83, 207, 0)" />
              </linearGradient>
            </defs>

            {['25%', '50%', '75%'].map((label, index) => (
              <line
                key={label}
                className="runtime-metrics-panel__grid-line"
                x1="0"
                x2="420"
                y1={40 + index * 35}
                y2={40 + index * 35}
              />
            ))}

            <polyline
              className="runtime-metrics-panel__series runtime-metrics-panel__series--duration"
              points={buildSparklinePoints(durationSeries, 420, 180)}
            />
            <polyline
              className="runtime-metrics-panel__series runtime-metrics-panel__series--tokens"
              points={buildSparklinePoints(tokenSeries, 420, 180)}
            />
            <polyline
              className="runtime-metrics-panel__series runtime-metrics-panel__series--activity"
              points={buildSparklinePoints(activitySeries, 420, 180)}
            />
          </svg>
        ) : (
          <p className="runtime-metrics-panel__empty">{copy.messages.noExecutionUnits}</p>
        )}

        <div className="runtime-metrics-panel__legend">
          <span data-series="duration">{copy.labels.actualDuration}</span>
          <span data-series="tokens">{copy.labels.tokens}</span>
          <span data-series="activity">{copy.labels.toolCalls}</span>
        </div>
      </div>

      <div className="runtime-metrics-panel__footer">
        <div>
          <span className="stat-card__label">{copy.labels.currentStage}</span>
          <strong>{workflowPhase}</strong>
        </div>
        <div>
          <span className="stat-card__label">{copy.labels.averageTaskDuration}</span>
          <strong>{formatDuration(executionStats.averageTaskDurationMs, locale, copy.messages.notRecorded)}</strong>
        </div>
        <div>
          <span className="stat-card__label">{copy.labels.estimatedFinish}</span>
          <strong>
            {executionStats.estimatedFinishAtMs === null
              ? copy.messages.estimateUnavailable
              : formatTimestamp(new Date(executionStats.estimatedFinishAtMs).toISOString(), locale)}
          </strong>
        </div>
      </div>
    </section>
  );
}

export function WorkflowMilestoneRail({
  milestones,
  dependencies,
  activeMilestoneId,
  activeSliceId,
  activeTask,
  validationIssueCount,
  locale,
  copy,
  variant = 'rail',
}: {
  milestones: GsdDbMilestoneSummary[];
  dependencies: SliceDependencyView[];
  activeMilestoneId: string | null;
  activeSliceId: string | null;
  activeTask: GsdDbTaskSummary | null;
  validationIssueCount: number;
  locale: Locale;
  copy: UiCopy;
  variant?: 'rail' | 'dashboard';
}) {
  const orderedMilestones = orderWorkflowMilestones(milestones, activeMilestoneId);
  const { focusedMilestone, focusedSlice, focusedTask } = getWorkflowFocus(
    orderedMilestones,
    activeMilestoneId,
    activeSliceId,
    activeTask,
  );
  const dependencyLookup = new Map(
    dependencies.map((dependency) => [workflowSliceKey(dependency.milestoneId, dependency.toId), dependency]),
  );
  const focusedPath =
    focusedMilestone !== null && focusedSlice !== null && focusedTask !== null
      ? `${focusedMilestone.id} -> ${focusedSlice.id} -> ${focusedTask.id}`
      : focusedMilestone !== null && focusedSlice !== null
        ? `${focusedMilestone.id} -> ${focusedSlice.id}`
        : focusedMilestone?.id ?? copy.messages.notRecorded;

  return (
    <aside
      className={`milestone-rail ${variant === 'dashboard' ? 'milestone-rail--dashboard' : ''}`}
      aria-label={variant === 'dashboard' ? copy.labels.progress : copy.labels.milestoneRail}
    >
      <div className="milestone-rail__header">
        <div>
          <span className="stat-card__label">
            {variant === 'dashboard' ? copy.labels.progress : copy.labels.milestoneRail}
          </span>
          <strong>{copy.formatCount(orderedMilestones.length, 'milestone')}</strong>
        </div>
        {variant === 'dashboard' ? <span className="meta-badge">{focusedPath}</span> : null}
      </div>

      {orderedMilestones.length === 0 ? (
        <p className="milestone-rail__empty">{copy.messages.noMilestones}</p>
      ) : (
        <div className="milestone-focus">
          <div className="milestone-focus__body" data-testid="milestone-focus-panel">
            {orderedMilestones.map((milestone) => {
              const milestoneExpanded = focusedMilestone?.id === milestone.id;
              const milestoneProgress = getMilestoneProgress(milestone);
              const milestoneProgressPercent = getMilestoneProgressPercent(milestone);
              const milestoneSlices = orderWorkflowSlices(
                milestone.slices,
                milestoneExpanded ? focusedSlice?.id ?? null : null,
              );
              const milestonePath =
                milestoneExpanded && focusedSlice !== null && focusedTask !== null
                  ? `${milestone.id} -> ${focusedSlice.id} -> ${focusedTask.id}`
                  : milestoneExpanded && focusedSlice !== null
                    ? `${milestone.id} -> ${focusedSlice.id}`
                    : milestone.id;

              return (
                <details
                  className="milestone-focus__milestone"
                  data-active={milestoneExpanded}
                  data-status={statusTone(milestone.status)}
                  data-testid="milestone-focus-milestone"
                  key={milestone.id}
                  open={milestoneExpanded}
                >
                  <summary className="milestone-focus__summary">
                    <div className="milestone-focus__summary-header">
                      <div className="milestone-focus__summary-title">
                        <span className="meta-badge workflow-id-badge" data-level="milestone">
                          {milestone.id}
                        </span>
                        <strong>{milestoneTitle(milestone)}</strong>
                      </div>
                      <span className="status-pill" data-status={statusTone(milestone.status)}>
                        {formatWorkflowStatus(milestone.status, copy)}
                      </span>
                    </div>

                    <div className="milestone-focus__summary-meter" aria-hidden="true">
                      <span style={{ width: `${milestoneProgressPercent}%` }} />
                    </div>

                    <div className="milestone-focus__summary-meta">
                      <span>
                        {milestoneProgress.completed}/{milestoneProgress.total} {copy.labels.completed}
                      </span>
                      <span>{copy.formatCount(milestone.sliceCount, 'slice')}</span>
                      <span>
                        {milestone.completedTaskCount}/{milestone.taskCount} {copy.labels.tasks}
                      </span>
                    </div>

                    <div className="milestone-focus__summary-path">
                      <span className="stat-card__label">{copy.labels.criticalPath}</span>
                      <strong>{milestonePath}</strong>
                    </div>
                  </summary>

                  {milestoneSlices.length > 0 ? (
                    <div className="milestone-focus__slice-stack">
                      {milestoneSlices.map((slice) => {
                        const sliceActive = milestoneExpanded && focusedSlice?.id === slice.id;
                        const sliceCurrentTask = sliceActive ? activeTask : findActiveTask(slice);
                        const slicePercent = getSliceProgressPercent(slice);
                        const sliceRiskLevel = getSliceRiskLevel(slice);
                        const dependency = dependencyLookup.get(workflowSliceKey(milestone.id, slice.id)) ?? null;
                        const orderedTasks = orderWorkflowTasks(
                          slice.tasks,
                          sliceCurrentTask?.id ?? null,
                        );

                        return (
                          <details
                            className="milestone-focus__slice"
                            data-active={sliceActive}
                            data-status={statusTone(slice.status)}
                            data-risk={sliceRiskLevel}
                            data-testid="milestone-focus-slice"
                            key={`${milestone.id}-${slice.id}`}
                            open={sliceActive}
                          >
                            <summary className="milestone-focus__slice-summary">
                              <div className="milestone-focus__slice-header">
                                <span className="meta-badge workflow-id-badge" data-level="slice">
                                  {slice.id}
                                </span>
                                <span className="status-pill" data-status={statusTone(slice.status)}>
                                  {formatWorkflowStatus(slice.status, copy)}
                                </span>
                                <span className="meta-badge" data-risk={sliceRiskLevel}>
                                  {copy.labels.risk}: {formatRiskLevel(sliceRiskLevel, copy)}
                                </span>
                              </div>

                              <strong>{sentenceCaseTitle(sliceTitle(slice))}</strong>

                              <div className="milestone-focus__slice-meter" aria-hidden="true">
                                <span style={{ width: `${slicePercent}%` }} />
                              </div>

                              <div className="milestone-focus__slice-meta">
                                <span>
                                  {slice.completedTaskCount}/{slice.taskCount} {copy.labels.tasks}
                                </span>
                                {dependency ? <span>{dependency.fromId} -&gt; {slice.id}</span> : <span>{milestone.id} -&gt; {slice.id}</span>}
                              </div>

                              {sliceCurrentTask ? (
                                <span className="milestone-focus__current">
                                  {copy.labels.currentTask}: {sliceCurrentTask.id}
                                </span>
                              ) : null}
                            </summary>

                            {orderedTasks.length > 0 ? (
                              <ol className="milestone-focus__task-list">
                                {orderedTasks.map((task) => {
                                  const taskCurrent = sliceCurrentTask?.id === task.id;

                                  return (
                                    <li
                                      className="milestone-focus__task"
                                      data-current={taskCurrent}
                                      data-status={taskCurrent ? 'active' : statusTone(task.status)}
                                      key={`${slice.id}-${task.id}`}
                                    >
                                      <div className="milestone-focus__task-main">
                                        <span
                                          className="status-dot"
                                          data-status={taskCurrent ? 'active' : statusTone(task.status)}
                                        />
                                        <strong className="workflow-id-badge" data-level="task">
                                          {task.id}
                                        </strong>
                                        <span>{taskDisplayTitle(task, copy)}</span>
                                      </div>
                                      <span
                                        className="status-pill"
                                        data-status={taskCurrent ? 'active' : statusTone(task.status)}
                                      >
                                        {taskCurrent ? copy.labels.currentTask : formatWorkflowStatus(task.status, copy)}
                                      </span>
                                    </li>
                                  );
                                })}
                              </ol>
                            ) : null}
                          </details>
                        );
                      })}
                    </div>
                  ) : null}
                </details>
              );
            })}
          </div>
        </div>
      )}

      <div className="validation-dock">
        <strong>{copy.formatCount(validationIssueCount, 'warning')}</strong>
        <span>{validationIssueCount === 0 ? copy.messages.validationClear : copy.labels.validationIssues}</span>
      </div>
    </aside>
  );
}
