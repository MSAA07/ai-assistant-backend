# QA Tier 1 failures audit - 2026-07-04

Scope: audit-only investigation of the two failing Tier 1 Health Check rows after restoring the Admin QA router. No code, environment variables, R2 objects, Resend settings, or external service settings were changed.

## Summary

Both failures appear to be QA health-check implementation/fixture issues, not proof that the production app paths are broken.

| Failure | Current root cause | Classification | Recommended fix |
| --- | --- | --- | --- |
| `R2 storage reachable` -> `The specified key does not exist.` | The QA check calls `ListObjectsV2` for a dummy prefix, `qa-health-dummy/`, in `process.env.R2_BUCKET_NAME`. It does not read a real fixture object. The current R2-compatible API returns `NoSuchKey` for that dummy-prefix list call, while the Tier 2 Pipeline Check can still upload, extract, generate, export, and delete successfully. | QA test bug / fixture-assumption bug, not a confirmed R2 credential or bucket outage. | Prefer a code fix: make the storage health check use a bucket-level operation or `listFiles("", 1)`, or treat `NoSuchKey` for the dummy prefix as nonfatal. Alternative fixture fix: create a durable marker object under `qa-health-dummy/`, but that makes health depend on bucket contents. |
| `Resend API key valid` -> `Resend API key is invalid.` | The QA check does `GET https://api.resend.com/domains` with `RESEND_API_KEY` and treats any `401` as invalid. Resend documents `restricted_api_key` as `401` for keys restricted to sending emails only, while actual app email paths use `POST https://api.resend.com/emails`. | QA test bug / permission-scope mismatch, not enough evidence that the app's sending key is revoked. | Code fix: do not label all Resend `401`s as invalid; parse the response body and distinguish restricted send-only keys. If the product intentionally requires domain-listing in QA, update Railway to a full-access Resend key, but that is broader access than email sending needs. |

## R2 storage check

### Exact code path

The Tier 1 test name is defined in `routes/qa.js`:

```js
35:   storageReachable: "R2 storage reachable",
```

The health check implementation is:

```js
1261:   await runStep(ctx, HEALTH_TEST_NAMES.storageReachable, async () => {
1262:     await listFiles("qa-health-dummy/", 1);
1263:     return "R2 list operation completed";
1264:   }, 1_000);
```

`listFiles` is imported from `utils/storage.js`:

```js
6: import { listFiles } from "../utils/storage.js";
```

The storage helper uses these R2 environment variables:

```js
33:     'R2_ENDPOINT',
34:     'R2_ACCESS_KEY_ID',
35:     'R2_SECRET_ACCESS_KEY',
36:     'R2_BUCKET_NAME',
```

The S3/R2 client is built from `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`, with `region: 'auto'`:

```js
56: const r2 = storageStatus.configured ? new S3Client({
57:   region: 'auto',
58:   endpoint: process.env.R2_ENDPOINT,
59:   credentials: {
60:     accessKeyId: process.env.R2_ACCESS_KEY_ID,
61:     secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
62:   }
63: }) : null
```

The bucket passed to the R2 ListObjectsV2 request is `process.env.R2_BUCKET_NAME`:

```js
65: const BUCKET = process.env.R2_BUCKET_NAME
...
133:   const response = await r2.send(new ListObjectsV2Command({
134:     Bucket: BUCKET,
135:     Prefix: prefix,
136:     MaxKeys: maxKeys,
137:   }))
```

So the failing health check is exactly:

```js
new ListObjectsV2Command({
  Bucket: process.env.R2_BUCKET_NAME,
  Prefix: "qa-health-dummy/",
  MaxKeys: 1,
})
```

### What it is not doing

The check does not write a temporary object, does not read a known object, and does not verify a specific PDF/test fixture in the bucket. It only lists a prefix.

That rules out "a specific test file no longer exists" as the direct cause.

### External docs cross-check

Cloudflare documents R2 as S3-compatible and says the S3 API endpoint should be `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; it also documents `ListObjectsV2` among supported S3 operations. Source: [Cloudflare R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/).

### Current diagnosis

The failure message, `The specified key does not exist.`, is consistent with an R2/S3 `NoSuchKey` response. For this code path, that response can only come from the dummy-prefix list operation, because no object key is otherwise specified.

This looks like option **(c) something else** from the task prompt: a QA storage health-check assumption problem. The test assumes listing a nonexistent placeholder prefix is a reliable no-op. In current staging, that assumption is false.

The strongest evidence that this is not a general bucket or credential outage is that the Tier 2 Pipeline Check completed successfully immediately after QA was restored:

```txt
Jul 4, 2026, 18:38  Staging  Pipeline  8 passed  0 failed
Upload pipeline test PDF: PASS
Wait for extraction: PASS
Wait for generation: PASS
PDF export: PASS
Delete document: PASS
```

Those paths exercise real document upload, worker extraction, generation, export, and cleanup behavior. If the R2 bucket name or credentials were generally wrong, this flow would be expected to fail at upload, extraction download, or cleanup.

### Recommended R2 fix

Recommended: code fix.

Safer options:

1. Replace `listFiles("qa-health-dummy/", 1)` with a bucket-level or root list check such as `listFiles("", 1)` so it does not depend on a made-up prefix.
2. Treat `NoSuchKey` from the dummy prefix as success, because the goal is to verify that R2 is reachable, not that a marker object exists.
3. If the team wants an explicit fixture, create and document a durable marker object under `qa-health-dummy/`, but that is a fixture maintenance requirement and should not be done silently.

## Resend API key check

### Exact code path

The Tier 1 test name is defined in `routes/qa.js`:

```js
38:   resendKeyValid: "Resend API key valid",
```

The implementation calls the shared API-key checker:

```js
1282:   await runStep(ctx, HEALTH_TEST_NAMES.resendKeyValid, async () => {
1283:     return assertApiKeyValid({
1284:       name: "Resend",
1285:       envKey: "RESEND_API_KEY",
1286:       url: "https://api.resend.com/domains",
1287:     });
1288:   }, 2_000);
```

The shared checker is:

```js
1223: async function assertApiKeyValid({ name, envKey, url }) {
1224:   const apiKey = process.env[envKey];
1225:   if (!apiKey) {
1226:     throw new Error(`${name} API key is not configured`);
1227:   }
1228:
1229:   const response = await fetchWithTimeout(url, {
1230:     method: "GET",
1231:     headers: { Authorization: `Bearer ${apiKey}` },
1232:   }, 5_000);
1233:
1234:   if (response.status === 401) {
1235:     throw new Error(`${name} API key is invalid`);
1236:   }
1237:
1238:   if (!response.ok) {
1239:     throw new Error(`${name} models endpoint returned ${response.status}`);
1240:   }
1241:
1242:   await response.text();
1243:   return `${name} API key was accepted`;
1244: }
```

So the failing check is exactly:

```http
GET https://api.resend.com/domains
Authorization: Bearer ${process.env.RESEND_API_KEY}
```

The checker does not parse the response body. It reports every Resend `401` as `Resend API key is invalid`.

### Actual email-sending paths

Auth email sending uses the same `RESEND_API_KEY`, but a different endpoint:

```js
74:     const apiKey = getRequiredEnv("RESEND_API_KEY");
...
77:     const response = await fetch("https://api.resend.com/emails", {
78:       method: "POST",
79:       headers: {
80:         Authorization: `Bearer ${apiKey}`,
81:         "Content-Type": "application/json",
82:       },
```

Admin alert email sending also uses `RESEND_API_KEY` against the email-send endpoint:

```js
199:   const email = buildEmailPayload(alert, env);
200:   const response = await fetchImpl("https://api.resend.com/emails", {
201:     method: "POST",
202:     headers: {
203:       Authorization: `Bearer ${config.apiKey}`,
204:       "Content-Type": "application/json",
205:     },
```

Therefore, the QA check is not testing the same operation the application uses for transactional email. It is testing whether the key can list domains.

### External docs cross-check

Resend documents API authentication as `Authorization: Bearer re_xxxxxxxxx`. Source: [Resend API introduction](https://resend.com/docs/api-reference/introduction).

Resend's current error docs distinguish:

- `restricted_api_key`: status `401`, message says the key is restricted to only send emails.
- `invalid_api_key`: status `403`, message says the key is invalid.

Source: [Resend API errors](https://resend.com/docs/api-reference/errors).

This matters because current QA code maps `401` to `Resend API key is invalid`, but Resend documents a common `401` case that means "send-only key used for a non-send operation", not "revoked or invalid key".

### Recent local/log evidence

Available code-level evidence:

- `/api/health` reports `authEmail.hasResendApiKey: true`.
- `/api/health` currently reports auth email diagnostics as idle after restart:

```json
"diagnostics":{"lastAttemptAt":"","lastResult":"idle","lastContext":"","lastMessageId":"","lastError":""}
```

That means the health endpoint does not provide recent proof of either success or failure for real auth email delivery since the latest backend restart.

Railway runtime logs and Sentry events were not accessible in this local session. The Railway CLI exists, but this checkout is not linked/authenticated for log access, and prior link attempts required `railway login`.

### Current diagnosis

This looks more like a health-check-specific bug than a proven broken Resend credential.

The most likely explanation is that staging uses a Resend API key with sending-only access. That would be sufficient for the app's real `POST /emails` code paths, but insufficient for QA's `GET /domains` check. The QA code then mislabels the resulting `401` as "invalid" even though Resend documents `invalid_api_key` as `403`, while `401` can mean a send-only restricted key.

The alternative is that the key is genuinely missing/malformed and Resend is returning a missing-key style `401`; however `/api/health` shows a non-empty `RESEND_API_KEY` is present, and the current QA code does not parse the response body to distinguish missing/restricted cases.

### Recommended Resend fix

Recommended: code fix, unless the product explicitly wants the staging backend to hold a full-access Resend key.

Safer options:

1. Parse the Resend error body and distinguish `restricted_api_key`, `missing_api_key`, and `invalid_api_key`.
2. Rename/reframe the health check if it intentionally requires domain-listing permission, for example `Resend full-access key valid`.
3. If the app only needs to send auth/admin emails, avoid validating with `/domains`; instead validate key presence/format and rely on real send diagnostics, or add a deliberately opt-in test email path.
4. Only update Railway to a full-access Resend key if the team decides QA should verify domain management permissions, not just email delivery.

## Final classification

| Check | Real external service problem? | QA test bug? | Recommended action |
| --- | --- | --- | --- |
| R2 storage reachable | Not confirmed. Tier 2 pipeline proves core storage paths work. | Yes, likely. Dummy-prefix list is not a reliable health probe. | Code fix preferred; fixture marker only if intentionally maintained. |
| Resend API key valid | Not confirmed. The app's email-send endpoint differs from QA's domain-list endpoint. | Yes, likely. The test requires/list-checks permissions the app may not need and mislabels `401`. | Code fix preferred; env var update only if full-access Resend is intentional. |
