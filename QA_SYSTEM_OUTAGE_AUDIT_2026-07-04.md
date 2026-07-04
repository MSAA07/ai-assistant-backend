# QA system outage audit - 2026-07-04

Scope: audit-only investigation of why the Admin QA tab is non-functional on staging. No source code was changed.

## Current mount status

`server.js` currently does **not** import or mount `routes/qa.js`.

Current route imports in `server.js` are:

```js
11: import { createUserRouter } from "./routes/user.js";
12: import { createDocumentsRouter } from "./routes/documents.js";
13: import { createFlashcardsRouter, createFlashcardSetsRouter } from "./routes/flashcards.js";
14: import { createExamsRouter, createCanonicalExamsRouter } from "./routes/exams.js";
15: import { createExportsRouter } from "./routes/exports.js";
16: import { createAdminRouter } from "./routes/admin.js";
17: import { createJobsRouter } from "./routes/jobs.js";
18: import { createTelegramRouter } from "./routes/telegram.js";
```

Current route mounts in `server.js` are:

```js
110: app.use("/api/user", createUserRouter({ prisma, requireAuth }));
111: app.use("/api", createDocumentsRouter({ prisma, requireAuth }));
112: app.use("/api/flashcard", createFlashcardsRouter({ prisma, requireAuth }));
113: app.use("/api/exam", createExamsRouter({ prisma, requireAuth }));
114: app.use("/api", createFlashcardSetsRouter({ prisma, requireAuth }));
115: app.use("/api", createCanonicalExamsRouter({ prisma, requireAuth }));
116: app.use("/api/exports", createExportsRouter({ prisma, requireAuth }));
117: app.use("/api/jobs", createJobsRouter({ prisma, requireAuth }));
118: app.use("/api", createTelegramRouter({ prisma, requireAuth }));
119: app.use(
120:   "/api/admin",
121:   createAdminRouter({ prisma, requireAuth, requireAdmin, auth }),
122: );
```

There is no current equivalent of:

```js
import { createQaRouter, initializeQaScheduler } from "./routes/qa.js";
app.use("/api/admin/qa", requireAuth, requireAdmin, createQaRouter({ prisma, auth }));
void initializeQaScheduler({ prisma, auth }).catch(...);
```

## QA route file status

`routes/qa.js` still exists and appears intact:

- `node --check routes/qa.js` passes.
- It still exports `initializeQaScheduler` at line 1799.
- It still exports `createQaRouter` at line 1830.
- It still defines these QA API handlers:
  - `GET /history`
  - `GET /progress`
  - `GET /schedule`
  - `POST /schedule`
  - `POST /health`
  - `POST /pipeline`
  - `POST /full`

Relevant current lines:

```js
1799: export async function initializeQaScheduler({ prisma, auth }) {
1800:   qaScheduleContext = { prisma, auth };
...
1830: export const createQaRouter = ({ prisma, auth }) => {
1831:   const router = express.Router();
...
1855:   router.get("/schedule", async (_req, res) => {
...
1905:   router.post("/health", async (req, res) => {
1909:   router.post("/pipeline", async (req, res) => {
1913:   router.post("/full", async (req, res) => {
```

## Direct deployed backend test

Frontend local config confirms the staging backend URL used for local proxying:

```txt
LOCAL_API_BASE_URL=https://ai-assistant-backend-staging.up.railway.app
```

The deployed staging backend health endpoint is live:

```http
curl -i -s https://ai-assistant-backend-staging.up.railway.app/api/health

HTTP/1.1 200 OK
...
{"status":"ok","message":"AI Study Assistant API is running",...}
```

Direct QA endpoint checks against the same Railway backend:

```http
curl -i -s https://ai-assistant-backend-staging.up.railway.app/api/admin/qa/schedule

HTTP/1.1 401 Unauthorized
access-control-allow-credentials: true
Content-Type: application/json; charset=utf-8
Server: railway-hikari
...

{"error":"Unauthorized"}
```

```http
curl -i -s https://ai-assistant-backend-staging.up.railway.app/api/admin/qa/health

HTTP/1.1 401 Unauthorized
access-control-allow-credentials: true
Content-Type: application/json; charset=utf-8
Server: railway-hikari
...

{"error":"Unauthorized"}
```

Unauthenticated `curl` requests are intercepted by the mounted `/api/admin` auth middleware before final route matching. That means the raw direct response confirms the request reaches the backend and admin middleware, while source inspection confirms there is no mounted QA router for authenticated admin requests to reach after auth succeeds.

## When this changed

Normal `git log -- server.js` initially hid the QA commits because of history simplification. Full-history server.js commits in the last 30 days are:

```txt
8bbf0a0  2026-06-14 20:08:50 +0300  Fix Telegram routes and study text formatting
f93a57d  2026-06-07 19:36:18 +0000  merge: integrate code audit improvements into stage branch
62962ad  2026-06-07 19:33:01 +0000  refactor: extract duplicate route helpers and remove debug logs
91dcd64  2026-06-07 21:08:04 +0300  Rebuild admin QA tiers
25a736b  2026-06-06 02:43:20 +0300  Add admin QA runner endpoint
```

The mount was first added in `25a736b` (`Add admin QA runner endpoint`, 2026-06-06 02:43:20 +0300):

```js
import { createQaRouter } from "./routes/qa.js";
app.use("/api/admin/qa", requireAuth, requireAdmin, createQaRouter({ prisma, auth }));
```

The mount and scheduler were still present in `91dcd64` (`Rebuild admin QA tiers`, 2026-06-07 21:08:04 +0300):

```js
import { createQaRouter, initializeQaScheduler } from "./routes/qa.js";
app.use("/api/admin/qa", requireAuth, requireAdmin, createQaRouter({ prisma, auth }));
void initializeQaScheduler({ prisma, auth }).catch((error) => {
  console.error("Failed to start QA scheduler:", error);
});
```

The QA import, mount, and scheduler startup were missing in `62962ad` (`refactor: extract duplicate route helpers and remove debug logs`, 2026-06-07 19:33:01 +0000). The diff from the QA-present server to that server removes:

```diff
-import { createQaRouter, initializeQaScheduler } from "./routes/qa.js";
-app.use("/api/admin/qa", requireAuth, requireAdmin, createQaRouter({ prisma, auth }));
-    void initializeQaScheduler({ prisma, auth }).catch((error) => {
-      console.error("Failed to start QA scheduler:", error);
-    });
```

The missing state was then integrated into `stage` by merge commit `f93a57d` (`merge: integrate code audit improvements into stage branch`, 2026-06-07 19:36:18 +0000). `8bbf0a0` later restored the Telegram route mount but did not restore the QA route mount.

Conclusion: this is a regression from the June 7 merge path. The QA system was not merely local-only; it was mounted in `server.js` before the audit-improvement merge path dropped it.

## Related fallout

The QA auto-schedule is also non-functional in the current server process:

- `routes/qa.js` defines `initializeQaScheduler({ prisma, auth })`.
- `routes/qa.js` reads and writes `QaScheduleConfig`.
- Current `server.js` never imports or calls `initializeQaScheduler`.
- The only JavaScript references to `initializeQaScheduler`, `createQaRouter`, and `QaScheduleConfig` are inside `routes/qa.js`.

Therefore the scheduler is not loaded at startup, and current startup code cannot emit the QA scheduler failure log from `routes/qa.js:1805` because that function is never called.

## Other unmounted route files

Runtime route modules in `routes/`:

| File | Mounted in current `server.js`? | Notes |
| --- | --- | --- |
| `admin.js` | Yes | Mounted at `/api/admin`. |
| `documents.js` | Yes | Mounted at `/api`. |
| `exams.js` | Yes | Mounted at `/api/exam` and canonical router mounted at `/api`. |
| `exports.js` | Yes | Mounted at `/api/exports`. |
| `flashcards.js` | Yes | Legacy router mounted at `/api/flashcard`; canonical router mounted at `/api`. |
| `jobs.js` | Yes | Mounted at `/api/jobs`. |
| `qa.js` | **No** | Exists and is syntactically valid, but is not imported, mounted, or initialized. |
| `telegram.js` | Yes | Mounted at `/api`. |
| `user.js` | Yes | Mounted at `/api/user`. |

`admin.test.js` and `telegram.test.js` are test files, not runtime route modules.

## Plain-English root cause

The Admin QA feature is present in the codebase, but the backend server no longer connects it to the running Express app. In early June, `server.js` did import and mount the QA router and start the QA scheduler. A later merge path dropped those lines, so the staging frontend still shows QA controls, but the backend never exposes the QA API routes or starts the QA schedule loader. As a result, the QA tab cannot load schedule/history data and cannot start the Pipeline Check.
