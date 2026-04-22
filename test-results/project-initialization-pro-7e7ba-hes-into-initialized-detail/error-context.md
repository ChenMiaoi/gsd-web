# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: project-initialization.spec.ts >> project initialization dashboard flow >> keeps the same project visible through queued-to-succeeded init progress and refreshes into initialized detail
- Location: tests/e2e/project-initialization.spec.ts:267:3

# Error details

```
Error: expect(locator).toBeDisabled() failed

Locator: getByTestId('init-action')
Expected: disabled
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeDisabled" with timeout 10000ms
  - waiting for getByTestId('init-action')

```

# Page snapshot

```yaml
- main [ref=e3]:
  - generic [ref=e4]:
    - generic [ref=e5]:
      - paragraph [ref=e6]: LOCAL-FIRST SERVICE SHELL
      - heading "Project inventory" [level=1] [ref=e7]
      - paragraph [ref=e8]: Register local paths, inspect truthful snapshot health, and watch live refresh events land from the same hosted Fastify process.
    - generic [ref=e9]:
      - generic [ref=e10]:
        - generic [ref=e11]: Registered
        - strong [ref=e12]: 1 project
      - generic [ref=e13]:
        - generic [ref=e14]: Live stream
        - strong [ref=e15]: Disconnected
        - generic [ref=e16]: Live events dropped. The dashboard keeps the last good state and will resync JSON after reconnect.
      - generic [ref=e17]:
        - generic [ref=e18]: Last SSE event
        - strong [ref=e19]: project.init.updated
        - generic [ref=e20]: evt_9
        - time [ref=e21]: Apr 23, 2026, 2:58 AM
  - generic [ref=e23]:
    - generic [ref=e24]:
      - heading "Register a local project path" [level=2] [ref=e25]
      - paragraph [ref=e26]: "Registration stays read-only: the service snapshots the directory, records a stable project id, and leaves the monitored workspace untouched."
    - generic [ref=e27]:
      - generic [ref=e28]: Project path
      - textbox "Project path" [ref=e29]:
        - /placeholder: /absolute/path/to/project
    - generic [ref=e30]:
      - button "Register project" [ref=e31] [cursor=pointer]
      - button "Clear input" [disabled] [ref=e32]
    - paragraph [ref=e33]: Registered browser-init-success.
  - generic [ref=e34]:
    - region "Registered inventory" [ref=e35]:
      - generic [ref=e36]:
        - generic [ref=e37]:
          - heading "Registered inventory" [level=2] [ref=e38]
          - paragraph [ref=e39]: Current projection from /api/projects.
        - button "Refresh inventory" [ref=e40] [cursor=pointer]
      - list [ref=e41]:
        - listitem [ref=e42]:
          - button "prj_f40b304e-7c4e-43cc-a753-f06c75d796ef Initialized Project /tmp/gsd-web-init-browser-NsEmYv/browser-init-success Initialized Healthy 0 warnings The monitor last confirmed a initialized snapshot via Watcher. Succeeded Initialization completed and refresh observed a truthful initialized snapshot. Apr 23, 2026, 2:58 AM" [pressed] [ref=e43] [cursor=pointer]:
            - generic [ref=e44]: prj_f40b304e-7c4e-43cc-a753-f06c75d796ef
            - strong [ref=e45]: Initialized Project
            - generic [ref=e46]: /tmp/gsd-web-init-browser-NsEmYv/browser-init-success
            - generic [ref=e47]:
              - generic [ref=e48]: Initialized
              - generic [ref=e49]: Healthy
              - generic [ref=e50]: 0 warnings
            - paragraph [ref=e51]: The monitor last confirmed a initialized snapshot via Watcher.
            - generic [ref=e52]:
              - generic [ref=e53]: Succeeded
              - generic [ref=e54]: Initialization completed and refresh observed a truthful initialized snapshot.
            - time [ref=e55]: Apr 23, 2026, 2:58 AM
    - region "Project detail" [ref=e56]:
      - generic [ref=e57]:
        - generic [ref=e58]:
          - heading "Project detail" [level=2] [ref=e59]
          - paragraph [ref=e60]: Truthful snapshot from /api/projects/:id plus manual refresh.
        - generic [ref=e61]:
          - button "Reload detail" [ref=e62] [cursor=pointer]
          - button "Refresh selected project" [ref=e63] [cursor=pointer]
      - generic [ref=e64]:
        - generic [ref=e65]:
          - generic [ref=e66]:
            - paragraph [ref=e67]: prj_f40b304e-7c4e-43cc-a753-f06c75d796ef
            - heading "Initialized Project" [level=3] [ref=e68]
            - paragraph [ref=e69]: /tmp/gsd-web-init-browser-NsEmYv/browser-init-success
          - generic [ref=e70]:
            - generic [ref=e71]: Initialized
            - generic [ref=e72]: Healthy
            - generic [ref=e73]: 0 warnings
        - generic [ref=e74]:
          - generic [ref=e75]:
            - term [ref=e76]: Registered path
            - definition [ref=e77]: /tmp/gsd-web-init-browser-NsEmYv/browser-init-success
          - generic [ref=e78]:
            - term [ref=e79]: Project id
            - definition [ref=e80]: prj_f40b304e-7c4e-43cc-a753-f06c75d796ef
          - generic [ref=e81]:
            - term [ref=e82]: Last event
            - definition [ref=e83]: evt_9
          - generic [ref=e84]:
            - term [ref=e85]: Snapshot checked
            - definition [ref=e86]:
              - time [ref=e87]: Apr 23, 2026, 2:58 AM
          - generic [ref=e88]:
            - term [ref=e89]: Last attempted
            - definition [ref=e90]:
              - time [ref=e91]: Apr 23, 2026, 2:58 AM
          - generic [ref=e92]:
            - term [ref=e93]: Last successful
            - definition [ref=e94]:
              - time [ref=e95]: Apr 23, 2026, 2:58 AM
          - generic [ref=e96]:
            - term [ref=e97]: Last trigger
            - definition [ref=e98]: Watcher
          - generic [ref=e99]:
            - term [ref=e100]: GSD id
            - definition [ref=e101]: gsd-browser-init-success
          - generic [ref=e102]:
            - term [ref=e103]: Repo fingerprint
            - definition [ref=e104]: browser-init-success-fingerprint
        - generic [ref=e105]:
          - generic [ref=e106]:
            - generic [ref=e107]:
              - heading "Monitor freshness" [level=4] [ref=e108]
              - paragraph [ref=e109]: Service-owned reconcile health that stays distinct from the current snapshot state.
            - generic [ref=e110]:
              - generic [ref=e111]: Healthy
              - generic [ref=e112]: Watcher
          - paragraph [ref=e113]: The monitor last confirmed a initialized snapshot via Watcher.
        - generic [ref=e114]:
          - generic [ref=e115]:
            - generic [ref=e116]:
              - heading "Initialization" [level=4] [ref=e117]
              - paragraph [ref=e118]: "Explicitly run the supported `/gsd init` flow without leaving this project detail."
            - generic [ref=e119]: Succeeded
          - generic [ref=e120]:
            - generic [ref=e121]:
              - generic [ref=e122]: Succeeded
              - generic [ref=e123]: Updated Apr 23, 2026, 2:58 AM
            - paragraph [ref=e124]: Initialization completed and refresh observed a truthful initialized snapshot.
            - generic [ref=e125]:
              - generic [ref=e126]:
                - term [ref=e127]: Refresh result
                - definition [ref=e128]: Initialization completed and refresh observed a truthful initialized snapshot.
              - generic [ref=e129]:
                - term [ref=e130]: Snapshot status
                - definition [ref=e131]: initialized
              - generic [ref=e132]:
                - term [ref=e133]: Warnings after refresh
                - definition [ref=e134]: 0 warnings
              - generic [ref=e135]:
                - term [ref=e136]: Refresh event
                - definition [ref=e137]: evt_8
            - generic [ref=e138]: Official init completed through the supported dashboard path.
            - list [ref=e139]:
              - listitem [ref=e140]:
                - generic [ref=e141]:
                  - generic [ref=e142]: Queued
                  - time [ref=e143]: Apr 23, 2026, 2:58 AM
                - paragraph [ref=e144]: Initialization request accepted and queued.
              - listitem [ref=e145]:
                - generic [ref=e146]:
                  - generic [ref=e147]: Starting
                  - time [ref=e148]: Apr 23, 2026, 2:58 AM
                - paragraph [ref=e149]: Launching the official init wizard.
              - listitem [ref=e150]:
                - generic [ref=e151]:
                  - generic [ref=e152]: Initializing
                  - time [ref=e153]: Apr 23, 2026, 2:58 AM
                - paragraph [ref=e154]: Accepted the supported Project Setup step.
              - listitem [ref=e155]:
                - generic [ref=e156]:
                  - generic [ref=e157]: Initializing
                  - time [ref=e158]: Apr 23, 2026, 2:58 AM
                - paragraph [ref=e159]: Verified the bootstrap-complete .gsd surface.
              - listitem [ref=e160]:
                - generic [ref=e161]:
                  - generic [ref=e162]: Refreshing
                  - time [ref=e163]: Apr 23, 2026, 2:58 AM
                - paragraph [ref=e164]: Bootstrap completeness was proven; refreshing the monitored project snapshot.
              - listitem [ref=e165]:
                - generic [ref=e166]:
                  - generic [ref=e167]: Succeeded
                  - time [ref=e168]: Apr 23, 2026, 2:58 AM
                - paragraph [ref=e169]: Initialization completed and refresh observed a truthful initialized snapshot.
        - generic [ref=e170]:
          - heading "Directory summary" [level=4] [ref=e171]
          - paragraph [ref=e172]: "Sample entries from the live directory read:"
          - list [ref=e173]:
            - listitem [ref=e174]: .gsd-id
            - listitem [ref=e175]: .gsd
        - generic [ref=e176]:
          - heading "Warnings" [level=4] [ref=e177]
          - paragraph [ref=e178]: No degraded or missing-source warnings were emitted.
        - generic [ref=e179]:
          - generic [ref=e180]:
            - generic [ref=e181]:
              - heading "Recent timeline" [level=4] [ref=e182]
              - paragraph [ref=e183]: "Persisted recent monitor and refresh history from `/api/projects/:id/timeline`."
            - generic [ref=e184]:
              - generic [ref=e185]: 2 entries
              - button "Reload timeline" [ref=e186] [cursor=pointer]
          - list [ref=e187]:
            - listitem [ref=e188]:
              - generic [ref=e189]:
                - generic [ref=e190]:
                  - generic [ref=e191]: Refreshed
                  - generic [ref=e192]: Healthy
                  - generic [ref=e193]: Init refresh
                - time [ref=e194]: Apr 23, 2026, 2:58 AM
              - paragraph [ref=e195]: Reconciled the project via init refresh and observed a initialized snapshot.
              - generic [ref=e196]:
                - generic [ref=e197]:
                  - term [ref=e198]: Snapshot
                  - definition [ref=e199]: Initialized
                - generic [ref=e200]:
                  - term [ref=e201]: Warnings
                  - definition [ref=e202]: 0 warnings
                - generic [ref=e203]:
                  - term [ref=e204]: Changed
                  - definition [ref=e205]: "Yes"
                - generic [ref=e206]:
                  - term [ref=e207]: Event
                  - definition [ref=e208]: evt_8
            - listitem [ref=e209]:
              - generic [ref=e210]:
                - generic [ref=e211]:
                  - generic [ref=e212]: Registered
                  - generic [ref=e213]: Healthy
                  - generic [ref=e214]: Register
                - time [ref=e215]: Apr 23, 2026, 2:58 AM
              - paragraph [ref=e216]: Registered project with a truthful uninitialized snapshot.
              - generic [ref=e217]:
                - generic [ref=e218]:
                  - term [ref=e219]: Snapshot
                  - definition [ref=e220]: Uninitialized
                - generic [ref=e221]:
                  - term [ref=e222]: Warnings
                  - definition [ref=e223]: 0 warnings
                - generic [ref=e224]:
                  - term [ref=e225]: Changed
                  - definition [ref=e226]: "Yes"
                - generic [ref=e227]:
                  - term [ref=e228]: Event
                  - definition [ref=e229]: evt_2
        - generic [ref=e230]:
          - generic [ref=e231]:
            - heading "Snapshot source states" [level=4] [ref=e232]
            - paragraph [ref=e233]: Per-source truth from the backend snapshot adapter.
          - generic [ref=e234]:
            - article [ref=e235]:
              - generic [ref=e236]:
                - strong [ref=e237]: Directory
                - paragraph [ref=e238]: No extra source detail was emitted.
              - generic [ref=e239]: ok
            - article [ref=e240]:
              - generic [ref=e241]:
                - strong [ref=e242]: .gsd directory
                - paragraph [ref=e243]: No extra source detail was emitted.
              - generic [ref=e244]: ok
            - article [ref=e245]:
              - generic [ref=e246]:
                - strong [ref=e247]: .gsd-id
                - paragraph [ref=e248]: No extra source detail was emitted.
              - generic [ref=e249]: ok
            - article [ref=e250]:
              - generic [ref=e251]:
                - strong [ref=e252]: PROJECT.md
                - paragraph [ref=e253]: No extra source detail was emitted.
              - generic [ref=e254]: ok
            - article [ref=e255]:
              - generic [ref=e256]:
                - strong [ref=e257]: repo-meta.json
                - paragraph [ref=e258]: No extra source detail was emitted.
              - generic [ref=e259]: ok
            - article [ref=e260]:
              - generic [ref=e261]:
                - strong [ref=e262]: auto.lock
                - paragraph [ref=e263]: No extra source detail was emitted.
              - generic [ref=e264]: ok
            - article [ref=e265]:
              - generic [ref=e266]:
                - strong [ref=e267]: STATE.md
                - paragraph [ref=e268]: No extra source detail was emitted.
              - generic [ref=e269]: ok
            - article [ref=e270]:
              - generic [ref=e271]:
                - strong [ref=e272]: gsd.db
                - paragraph [ref=e273]: No extra source detail was emitted.
              - generic [ref=e274]: ok
        - generic [ref=e275]:
          - heading "Repo metadata" [level=4] [ref=e276]
          - generic [ref=e277]:
            - generic [ref=e278]:
              - term [ref=e279]: Project
              - definition [ref=e280]: browser-init-success
            - generic [ref=e281]:
              - term [ref=e282]: Branch
              - definition [ref=e283]: main
            - generic [ref=e284]:
              - term [ref=e285]: Head SHA
              - definition [ref=e286]: feedbeef1234567
            - generic [ref=e287]:
              - term [ref=e288]: Dirty
              - definition [ref=e289]: "false"
        - generic [ref=e290]:
          - heading "Workspace notes" [level=4] [ref=e291]
          - generic [ref=e292]:
            - paragraph [ref=e293]:
              - strong [ref=e294]: "PROJECT.md:"
              - text: Bootstrapped by the dashboard browser fixture.
            - paragraph [ref=e295]:
              - strong [ref=e296]: "STATE.md:"
              - text: "# State Bootstrap complete fixture."
```

# Test source

```ts
  187 |     outputExcerpt: 'Official init completed through the supported dashboard path.',
  188 |     errorDetail: null,
  189 |     exitCode: 0,
  190 |     signal: null,
  191 |   };
  192 | }
  193 | 
  194 | function buildTimedOutResult(projectRoot: string): InitRunResult {
  195 |   return {
  196 |     outcome: 'timed_out',
  197 |     stage: 'timed_out',
  198 |     bootstrap: {
  199 |       state: 'absent',
  200 |       projectRoot,
  201 |       gsdRootPath: null,
  202 |       detail: 'No project-owned .gsd directory exists yet.',
  203 |       presentEntries: [],
  204 |       missingEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
  205 |       requiredEntries: [...BOOTSTRAP_REQUIRED_ENTRIES],
  206 |     },
  207 |     promptHistory: [],
  208 |     lastMatchedPrompt: null,
  209 |     outputExcerpt: 'Timed out while waiting for the wizard to finish.',
  210 |     errorDetail: 'Init wizard exceeded the configured timeout.',
  211 |     exitCode: null,
  212 |     signal: null,
  213 |   };
  214 | }
  215 | 
  216 | function createSteppedSuccessfulInitRunner(): ProjectInitRunner {
  217 |   return async (projectRoot, options) => {
  218 |     emitStage(options, {
  219 |       stage: 'starting',
  220 |       matchedPrompt: null,
  221 |       excerpt: 'Launching init',
  222 |       detail: 'Launching the official init wizard.',
  223 |       emittedAt: new Date().toISOString(),
  224 |     });
  225 |     await sleep(80);
  226 | 
  227 |     emitStage(options, {
  228 |       stage: 'project_setup',
  229 |       matchedPrompt: null,
  230 |       excerpt: 'Project Setup',
  231 |       detail: 'Accepted the supported Project Setup step.',
  232 |       emittedAt: new Date().toISOString(),
  233 |     });
  234 |     await sleep(80);
  235 | 
  236 |     await materializeInitializedBootstrap(projectRoot);
  237 | 
  238 |     emitStage(options, {
  239 |       stage: 'verifying_bootstrap',
  240 |       matchedPrompt: null,
  241 |       excerpt: 'Verifying bootstrap',
  242 |       detail: 'Verified the bootstrap-complete .gsd surface.',
  243 |       emittedAt: new Date().toISOString(),
  244 |     });
  245 |     await sleep(80);
  246 | 
  247 |     return buildCompletedResult(projectRoot);
  248 |   };
  249 | }
  250 | 
  251 | function createTimedOutInitRunner(): ProjectInitRunner {
  252 |   return async (projectRoot, options) => {
  253 |     emitStage(options, {
  254 |       stage: 'starting',
  255 |       matchedPrompt: null,
  256 |       excerpt: 'Launching init',
  257 |       detail: 'Launching the official init wizard.',
  258 |       emittedAt: new Date().toISOString(),
  259 |     });
  260 |     await sleep(120);
  261 | 
  262 |     return buildTimedOutResult(projectRoot);
  263 |   };
  264 | }
  265 | 
  266 | test.describe('project initialization dashboard flow', () => {
  267 |   test('keeps the same project visible through queued-to-succeeded init progress and refreshes into initialized detail', async ({
  268 |     page,
  269 |   }) => {
  270 |     const harness = await createHarness(createSteppedSuccessfulInitRunner());
  271 |     const projectPath = await createEmptyProject(harness.workspace.root, 'browser-init-success');
  272 | 
  273 |     try {
  274 |       await page.goto(harness.baseUrl);
  275 | 
  276 |       await page.getByLabel('Project path').fill(projectPath);
  277 |       await page.getByRole('button', { name: 'Register project' }).click();
  278 | 
  279 |       await expect(page.getByTestId('detail-status')).toContainText('Uninitialized');
  280 |       await expect(page.getByTestId('detail-canonical-path')).toHaveText(projectPath);
  281 |       await expect(page.getByTestId('init-action')).toContainText('Initialize project');
  282 | 
  283 |       await page.getByTestId('init-action').click();
  284 | 
  285 |       await expect(page.getByTestId('detail-canonical-path')).toHaveText(projectPath);
  286 |       await expect(page.getByTestId('init-stage-banner')).toContainText('Queued');
> 287 |       await expect(page.getByTestId('init-action')).toBeDisabled();
      |                                                     ^ Error: expect(locator).toBeDisabled() failed
  288 | 
  289 |       await expect(page.getByTestId('init-history')).toContainText('Queued');
  290 |       await expect(page.getByTestId('init-history')).toContainText('Starting');
  291 |       await expect(page.getByTestId('init-history')).toContainText('Initializing');
  292 |       await expect(page.getByTestId('init-history')).toContainText('Refreshing');
  293 |       await expect(page.getByTestId('init-history')).toContainText('Succeeded');
  294 |       await expect(page.getByTestId('init-stage-banner')).toContainText('Succeeded');
  295 |       await expect(page.getByTestId('init-refresh-result')).toContainText('initialized');
  296 |       await expect(page.getByTestId('detail-status')).toContainText('Initialized');
  297 |       await expect(page.getByTestId('detail-gsd-id')).toContainText('gsd-browser-init-success');
  298 |       await expect(page.getByTestId('init-action')).toHaveCount(0);
  299 |     } finally {
  300 |       await harness.cleanup();
  301 |     }
  302 |   });
  303 | 
  304 |   test('falls back to persisted job truth when SSE disconnects and keeps the same project retryable after failure', async ({
  305 |     page,
  306 |   }) => {
  307 |     const harness = await createHarness(createTimedOutInitRunner());
  308 |     const projectPath = await createEmptyProject(harness.workspace.root, 'browser-init-timeout');
  309 | 
  310 |     try {
  311 |       await page.route('**/api/events', async (route) => {
  312 |         await route.abort('failed');
  313 |       });
  314 | 
  315 |       await page.goto(harness.baseUrl);
  316 |       await expect(page.getByTestId('stream-status')).toContainText('Disconnected');
  317 | 
  318 |       await page.getByLabel('Project path').fill(projectPath);
  319 |       await page.getByRole('button', { name: 'Register project' }).click();
  320 | 
  321 |       await expect(page.getByTestId('detail-status')).toContainText('Uninitialized');
  322 |       await expect(page.getByTestId('detail-canonical-path')).toHaveText(projectPath);
  323 | 
  324 |       await page.getByTestId('init-action').click();
  325 | 
  326 |       await expect(page.getByTestId('init-stage-banner')).toContainText('Queued');
  327 |       await expect(page.getByTestId('init-stream-note')).toContainText('Reload detail');
  328 |       await expect(page.getByTestId('init-action')).toBeDisabled();
  329 | 
  330 |       const timedOutProject = await waitForProject(
  331 |         harness.baseUrl,
  332 |         projectPath,
  333 |         (project) => project.latestInitJob?.stage === 'timed_out',
  334 |       );
  335 | 
  336 |       expect(timedOutProject.latestInitJob?.lastErrorDetail).toContain('configured timeout');
  337 | 
  338 |       await page.getByRole('button', { name: 'Reload detail' }).click();
  339 | 
  340 |       await expect(page.getByTestId('detail-status')).toContainText('Uninitialized');
  341 |       await expect(page.getByTestId('detail-canonical-path')).toHaveText(projectPath);
  342 |       await expect(page.getByTestId('init-stage-banner')).toContainText('Timed out');
  343 |       await expect(page.getByTestId('init-failure-detail')).toContainText('configured timeout');
  344 |       await expect(page.getByTestId('init-history')).toContainText('Timed out');
  345 |       await expect(page.getByTestId('init-action')).toContainText('Retry initialization');
  346 |       await expect(page.getByTestId('init-action')).toBeEnabled();
  347 |     } finally {
  348 |       await harness.cleanup();
  349 |     }
  350 |   });
  351 | 
  352 |   test('preserves the last good detail when the post-success detail refresh is malformed, then recovers on retry', async ({
  353 |     page,
  354 |   }) => {
  355 |     const harness = await createHarness(createSteppedSuccessfulInitRunner());
  356 |     const projectPath = await createEmptyProject(harness.workspace.root, 'browser-init-malformed');
  357 | 
  358 |     try {
  359 |       await page.goto(harness.baseUrl);
  360 | 
  361 |       await page.getByLabel('Project path').fill(projectPath);
  362 |       await page.getByRole('button', { name: 'Register project' }).click();
  363 | 
  364 |       await expect(page.getByTestId('detail-status')).toContainText('Uninitialized');
  365 |       await expect(page.getByTestId('detail-canonical-path')).toHaveText(projectPath);
  366 | 
  367 |       const project = await getProjectByCanonicalPath(harness.baseUrl, projectPath);
  368 |       let interceptedDetailLoads = 0;
  369 | 
  370 |       await page.route(
  371 |         `**/api/projects/${project.projectId}*`,
  372 |         async (route) => {
  373 |           interceptedDetailLoads += 1;
  374 |           await route.fulfill({
  375 |             status: 200,
  376 |             contentType: 'application/json',
  377 |             body: JSON.stringify({
  378 |               projectId: project.projectId,
  379 |               registeredPath: project.registeredPath,
  380 |               canonicalPath: project.canonicalPath,
  381 |               createdAt: project.createdAt,
  382 |               updatedAt: project.updatedAt,
  383 |               lastEventId: project.lastEventId,
  384 |               latestInitJob: project.latestInitJob,
  385 |             }),
  386 |           });
  387 |         },
```