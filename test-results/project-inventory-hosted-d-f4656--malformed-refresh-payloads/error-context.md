# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: project-inventory.spec.ts >> hosted dashboard inventory flow >> surfaces disconnected SSE state, truncates oversized warnings, and fails fast on malformed refresh payloads
- Location: tests/e2e/project-inventory.spec.ts:216:3

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: getByTestId('detail-status')
Expected substring: "Degraded"
Received string:    "Initialized"
Timeout: 10000ms

Call log:
  - Expect "toContainText" with timeout 10000ms
  - waiting for getByTestId('detail-status')
    13 × locator resolved to <span class="status-pill" data-status="initialized" data-testid="detail-status">Initialized</span>
       - unexpected value "Initialized"

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
        - generic [ref=e19]: Waiting for the first event envelope.
  - generic [ref=e21]:
    - generic [ref=e22]:
      - heading "Register a local project path" [level=2] [ref=e23]
      - paragraph [ref=e24]: "Registration stays read-only: the service snapshots the directory, records a stable project id, and leaves the monitored workspace untouched."
    - generic [ref=e25]:
      - generic [ref=e26]: Project path
      - textbox "Project path" [ref=e27]:
        - /placeholder: /absolute/path/to/project
    - generic [ref=e28]:
      - button "Register project" [ref=e29] [cursor=pointer]
      - button "Clear input" [disabled] [ref=e30]
    - paragraph [ref=e31]: Registered Project Snapshot Fixture.
  - generic [ref=e32]:
    - region "Registered inventory" [ref=e33]:
      - generic [ref=e34]:
        - generic [ref=e35]:
          - heading "Registered inventory" [level=2] [ref=e36]
          - paragraph [ref=e37]: Current projection from /api/projects.
        - button "Refresh inventory" [ref=e38] [cursor=pointer]
      - list [ref=e39]:
        - listitem [ref=e40]:
          - button "prj_958197c2-68e3-4598-a5f9-95794d6bfa98 Project Snapshot Fixture /tmp/gsd-web-e2e-vdvPlz/initialized-project Initialized Healthy 0 warnings The monitor last confirmed a initialized snapshot via Register. Apr 23, 2026, 2:58 AM" [pressed] [ref=e41] [cursor=pointer]:
            - generic [ref=e42]: prj_958197c2-68e3-4598-a5f9-95794d6bfa98
            - strong [ref=e43]: Project Snapshot Fixture
            - generic [ref=e44]: /tmp/gsd-web-e2e-vdvPlz/initialized-project
            - generic [ref=e45]:
              - generic [ref=e46]: Initialized
              - generic [ref=e47]: Healthy
              - generic [ref=e48]: 0 warnings
            - paragraph [ref=e49]: The monitor last confirmed a initialized snapshot via Register.
            - time [ref=e50]: Apr 23, 2026, 2:58 AM
    - region "Project detail" [ref=e51]:
      - generic [ref=e52]:
        - generic [ref=e53]:
          - heading "Project detail" [level=2] [ref=e54]
          - paragraph [ref=e55]: Truthful snapshot from /api/projects/:id plus manual refresh.
        - generic [ref=e56]:
          - button "Reload detail" [ref=e57] [cursor=pointer]
          - button "Refresh selected project" [ref=e58] [cursor=pointer]
      - alert [ref=e59]: project mutation response.event.payload.trigger must be a string.
      - generic [ref=e60]:
        - generic [ref=e61]:
          - generic [ref=e62]:
            - paragraph [ref=e63]: prj_958197c2-68e3-4598-a5f9-95794d6bfa98
            - heading "Project Snapshot Fixture" [level=3] [ref=e64]
            - paragraph [ref=e65]: /tmp/gsd-web-e2e-vdvPlz/initialized-project
          - generic [ref=e66]:
            - generic [ref=e67]: Initialized
            - generic [ref=e68]: Healthy
            - generic [ref=e69]: 0 warnings
        - generic [ref=e70]:
          - generic [ref=e71]:
            - term [ref=e72]: Registered path
            - definition [ref=e73]: /tmp/gsd-web-e2e-vdvPlz/initialized-project
          - generic [ref=e74]:
            - term [ref=e75]: Project id
            - definition [ref=e76]: prj_958197c2-68e3-4598-a5f9-95794d6bfa98
          - generic [ref=e77]:
            - term [ref=e78]: Last event
            - definition [ref=e79]: evt_2
          - generic [ref=e80]:
            - term [ref=e81]: Snapshot checked
            - definition [ref=e82]:
              - time [ref=e83]: Apr 23, 2026, 2:58 AM
          - generic [ref=e84]:
            - term [ref=e85]: Last attempted
            - definition [ref=e86]:
              - time [ref=e87]: Apr 23, 2026, 2:58 AM
          - generic [ref=e88]:
            - term [ref=e89]: Last successful
            - definition [ref=e90]:
              - time [ref=e91]: Apr 23, 2026, 2:58 AM
          - generic [ref=e92]:
            - term [ref=e93]: Last trigger
            - definition [ref=e94]: Register
          - generic [ref=e95]:
            - term [ref=e96]: GSD id
            - definition [ref=e97]: gsd-initialized-project
          - generic [ref=e98]:
            - term [ref=e99]: Repo fingerprint
            - definition [ref=e100]: initialized-project-fingerprint
        - generic [ref=e101]:
          - generic [ref=e102]:
            - generic [ref=e103]:
              - heading "Monitor freshness" [level=4] [ref=e104]
              - paragraph [ref=e105]: Service-owned reconcile health that stays distinct from the current snapshot state.
            - generic [ref=e106]:
              - generic [ref=e107]: Healthy
              - generic [ref=e108]: Register
          - paragraph [ref=e109]: The monitor last confirmed a initialized snapshot via Register.
        - generic [ref=e110]:
          - generic [ref=e112]:
            - heading "Initialization" [level=4] [ref=e113]
            - paragraph [ref=e114]: "Explicitly run the supported `/gsd init` flow without leaving this project detail."
          - paragraph [ref=e115]: This project will stay uninitialized until you explicitly start the supported bootstrap flow.
        - generic [ref=e116]:
          - heading "Directory summary" [level=4] [ref=e117]
          - paragraph [ref=e118]: "Sample entries from the live directory read:"
          - list [ref=e119]:
            - listitem [ref=e120]: .gsd-id
            - listitem [ref=e121]: .gsd
        - generic [ref=e122]:
          - heading "Warnings" [level=4] [ref=e123]
          - paragraph [ref=e124]: No degraded or missing-source warnings were emitted.
        - generic [ref=e125]:
          - generic [ref=e126]:
            - generic [ref=e127]:
              - heading "Recent timeline" [level=4] [ref=e128]
              - paragraph [ref=e129]: "Persisted recent monitor and refresh history from `/api/projects/:id/timeline`."
            - generic [ref=e130]:
              - generic [ref=e131]: 1 entry
              - button "Reload timeline" [ref=e132] [cursor=pointer]
          - list [ref=e133]:
            - listitem [ref=e134]:
              - generic [ref=e135]:
                - generic [ref=e136]:
                  - generic [ref=e137]: Registered
                  - generic [ref=e138]: Healthy
                  - generic [ref=e139]: Register
                - time [ref=e140]: Apr 23, 2026, 2:58 AM
              - paragraph [ref=e141]: Registered project with a truthful initialized snapshot.
              - generic [ref=e142]:
                - generic [ref=e143]:
                  - term [ref=e144]: Snapshot
                  - definition [ref=e145]: Initialized
                - generic [ref=e146]:
                  - term [ref=e147]: Warnings
                  - definition [ref=e148]: 0 warnings
                - generic [ref=e149]:
                  - term [ref=e150]: Changed
                  - definition [ref=e151]: "Yes"
                - generic [ref=e152]:
                  - term [ref=e153]: Event
                  - definition [ref=e154]: evt_2
        - generic [ref=e155]:
          - generic [ref=e156]:
            - heading "Snapshot source states" [level=4] [ref=e157]
            - paragraph [ref=e158]: Per-source truth from the backend snapshot adapter.
          - generic [ref=e159]:
            - article [ref=e160]:
              - generic [ref=e161]:
                - strong [ref=e162]: Directory
                - paragraph [ref=e163]: No extra source detail was emitted.
              - generic [ref=e164]: ok
            - article [ref=e165]:
              - generic [ref=e166]:
                - strong [ref=e167]: .gsd directory
                - paragraph [ref=e168]: No extra source detail was emitted.
              - generic [ref=e169]: ok
            - article [ref=e170]:
              - generic [ref=e171]:
                - strong [ref=e172]: .gsd-id
                - paragraph [ref=e173]: No extra source detail was emitted.
              - generic [ref=e174]: ok
            - article [ref=e175]:
              - generic [ref=e176]:
                - strong [ref=e177]: PROJECT.md
                - paragraph [ref=e178]: No extra source detail was emitted.
              - generic [ref=e179]: ok
            - article [ref=e180]:
              - generic [ref=e181]:
                - strong [ref=e182]: repo-meta.json
                - paragraph [ref=e183]: No extra source detail was emitted.
              - generic [ref=e184]: ok
            - article [ref=e185]:
              - generic [ref=e186]:
                - strong [ref=e187]: auto.lock
                - paragraph [ref=e188]: No extra source detail was emitted.
              - generic [ref=e189]: ok
            - article [ref=e190]:
              - generic [ref=e191]:
                - strong [ref=e192]: STATE.md
                - paragraph [ref=e193]: No extra source detail was emitted.
              - generic [ref=e194]: ok
            - article [ref=e195]:
              - generic [ref=e196]:
                - strong [ref=e197]: gsd.db
                - paragraph [ref=e198]: No extra source detail was emitted.
              - generic [ref=e199]: ok
        - generic [ref=e200]:
          - heading "Repo metadata" [level=4] [ref=e201]
          - generic [ref=e202]:
            - generic [ref=e203]:
              - term [ref=e204]: Project
              - definition [ref=e205]: initialized-project
            - generic [ref=e206]:
              - term [ref=e207]: Branch
              - definition [ref=e208]: main
            - generic [ref=e209]:
              - term [ref=e210]: Head SHA
              - definition [ref=e211]: abc1234def5678
            - generic [ref=e212]:
              - term [ref=e213]: Dirty
              - definition [ref=e214]: "false"
        - generic [ref=e215]:
          - heading "Workspace notes" [level=4] [ref=e216]
          - generic [ref=e217]:
            - paragraph [ref=e218]:
              - strong [ref=e219]: "PROJECT.md:"
              - text: This project mimics a GSD workspace.
            - paragraph [ref=e220]:
              - strong [ref=e221]: "STATE.md:"
              - text: "# State Healthy fixture state for integration coverage."
```

# Test source

```ts
  200 |             message: 'Simulated register failure.',
  201 |             statusCode: 500,
  202 |           }),
  203 |         });
  204 |       },
  205 |       { times: 1 },
  206 |     );
  207 | 
  208 |     await page.getByLabel('Project path').fill(failingProjectPath);
  209 |     await page.getByRole('button', { name: 'Register project' }).click();
  210 | 
  211 |     await expect(page.getByTestId('register-error')).toContainText('Simulated register failure');
  212 |     await expect(page.getByLabel('Project path')).toHaveValue(failingProjectPath);
  213 |     await expect(page.getByTestId('inventory-count')).toContainText('1 project');
  214 |   });
  215 | 
  216 |   test('surfaces disconnected SSE state, truncates oversized warnings, and fails fast on malformed refresh payloads', async ({
  217 |     page,
  218 |     harness,
  219 |   }) => {
  220 |     const initializedProjectPath = await createInitializedProject(harness.workspace.root, 'initialized-project');
  221 | 
  222 |     await page.route('**/api/events', async (route) => {
  223 |       await route.abort('failed');
  224 |     });
  225 | 
  226 |     await page.goto(harness.baseUrl);
  227 | 
  228 |     await expect(page.getByTestId('stream-status')).toContainText('Disconnected');
  229 | 
  230 |     await page.getByLabel('Project path').fill(initializedProjectPath);
  231 |     await page.getByRole('button', { name: 'Register project' }).click();
  232 | 
  233 |     await expect(page.getByTestId('register-success')).toContainText('Registered');
  234 |     await expect(page.getByTestId('inventory-count')).toContainText('1 project');
  235 | 
  236 |     const registeredProject = await getProjectByCanonicalPath(harness.baseUrl, initializedProjectPath);
  237 |     const oversizedWarningMessage = 'Oversized warning text '.repeat(40);
  238 |     const degradedProject = structuredClone(registeredProject);
  239 |     const degradedCheckedAt = new Date().toISOString();
  240 | 
  241 |     degradedProject.updatedAt = degradedCheckedAt;
  242 |     degradedProject.lastEventId = 'evt_999';
  243 |     degradedProject.snapshot.status = 'degraded';
  244 |     degradedProject.snapshot.checkedAt = degradedCheckedAt;
  245 |     degradedProject.monitor = {
  246 |       health: 'degraded',
  247 |       lastAttemptedAt: degradedCheckedAt,
  248 |       lastSuccessfulAt: degradedCheckedAt,
  249 |       lastTrigger: 'manual_refresh',
  250 |       lastError: null,
  251 |     };
  252 |     degradedProject.snapshot.warnings = [
  253 |       {
  254 |         source: 'stateMd',
  255 |         code: 'source_malformed',
  256 |         message: oversizedWarningMessage,
  257 |       },
  258 |     ];
  259 |     degradedProject.snapshot.sources.stateMd = {
  260 |       ...degradedProject.snapshot.sources.stateMd,
  261 |       state: 'malformed',
  262 |       detail: 'STATE.md became malformed during refresh.',
  263 |     };
  264 | 
  265 |     const oversizedWarningResponse: ProjectMutationResponse = {
  266 |       project: degradedProject,
  267 |       event: {
  268 |         id: 'evt_999',
  269 |         sequence: 999,
  270 |         type: 'project.refreshed',
  271 |         emittedAt: degradedCheckedAt,
  272 |         projectId: degradedProject.projectId,
  273 |         payload: {
  274 |           projectId: degradedProject.projectId,
  275 |           canonicalPath: degradedProject.canonicalPath,
  276 |           snapshotStatus: degradedProject.snapshot.status,
  277 |           warningCount: degradedProject.snapshot.warnings.length,
  278 |           warnings: degradedProject.snapshot.warnings,
  279 |           sourceStates: buildSourceStateMap(degradedProject.snapshot),
  280 |           changed: true,
  281 |           checkedAt: degradedProject.snapshot.checkedAt,
  282 |         },
  283 |       },
  284 |     };
  285 | 
  286 |     await page.route(
  287 |       `**/api/projects/${registeredProject.projectId}/refresh`,
  288 |       async (route) => {
  289 |         await route.fulfill({
  290 |           status: 200,
  291 |           contentType: 'application/json',
  292 |           body: JSON.stringify(oversizedWarningResponse),
  293 |         });
  294 |       },
  295 |       { times: 1 },
  296 |     );
  297 | 
  298 |     await page.getByRole('button', { name: 'Refresh selected project' }).click();
  299 | 
> 300 |     await expect(page.getByTestId('detail-status')).toContainText('Degraded');
      |                                                     ^ Error: expect(locator).toContainText(expected) failed
  301 |     await expect(page.getByTestId('warning-list')).toContainText('STATE.md');
  302 | 
  303 |     const warningText = await page.getByTestId('warning-list').textContent();
  304 |     expect(warningText).toContain('…');
  305 |     expect(warningText?.length ?? 0).toBeLessThan(400);
  306 | 
  307 |     await page.route(
  308 |       `**/api/projects/${registeredProject.projectId}/refresh`,
  309 |       async (route) => {
  310 |         await route.fulfill({
  311 |           status: 200,
  312 |           contentType: 'application/json',
  313 |           body: JSON.stringify({
  314 |             project: {
  315 |               projectId: registeredProject.projectId,
  316 |               registeredPath: registeredProject.registeredPath,
  317 |               canonicalPath: registeredProject.canonicalPath,
  318 |               createdAt: registeredProject.createdAt,
  319 |               updatedAt: registeredProject.updatedAt,
  320 |               lastEventId: registeredProject.lastEventId,
  321 |             },
  322 |             event: {
  323 |               id: 'evt_1000',
  324 |               sequence: 1000,
  325 |               type: 'project.refreshed',
  326 |               emittedAt: degradedCheckedAt,
  327 |               projectId: registeredProject.projectId,
  328 |               payload: {
  329 |                 projectId: registeredProject.projectId,
  330 |                 canonicalPath: registeredProject.canonicalPath,
  331 |                 snapshotStatus: 'degraded',
  332 |                 warningCount: 1,
  333 |                 warnings: degradedProject.snapshot.warnings,
  334 |                 sourceStates: buildSourceStateMap(degradedProject.snapshot),
  335 |                 changed: true,
  336 |                 checkedAt: degradedCheckedAt,
  337 |               },
  338 |             },
  339 |           }),
  340 |         });
  341 |       },
  342 |       { times: 1 },
  343 |     );
  344 | 
  345 |     await page.getByRole('button', { name: 'Refresh selected project' }).click();
  346 | 
  347 |     await expect(page.getByTestId('refresh-error')).toContainText('project mutation response.project.snapshot');
  348 |     await expect(page.getByTestId('detail-status')).toContainText('Degraded');
  349 |     await expect(page.getByTestId('warning-list')).toContainText('STATE.md');
  350 |   });
  351 | });
  352 | 
```