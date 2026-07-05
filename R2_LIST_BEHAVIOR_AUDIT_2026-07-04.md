# R2 empty-prefix ListObjectsV2 behavior audit - 2026-07-04

Scope: audit-only investigation into why the staging Tier 1 R2 health check sees `NoSuchKey` / `The specified key does not exist` from an empty-prefix `ListObjectsV2` call. No code, environment variables, R2 bucket contents, or external service settings were changed.

## Executive summary

The current code does **not** explain the staging behavior. `utils/storage.js` sends a standard AWS SDK v3 `ListObjectsV2Command` with `Bucket: process.env.R2_BUCKET_NAME`, `Prefix: ""`, and `MaxKeys: 1`. Cloudflare's current R2 documentation shows `ListObjectsV2` as a supported S3 operation and gives an AWS SDK v3 example that calls `ListObjectsV2Command({ Bucket: "my-bucket" })` and receives HTTP 200. I found no Cloudflare documentation saying an empty-prefix list should return `NoSuchKey`.

The raw R2 probes requested in this audit could not be completed from this workstation because the staging R2 environment variables are not present locally and the Railway CLI is not linked/authenticated for this checkout. That means the exact root cause is **not proven yet**. The current catch-and-pass behavior should be treated as a temporary workaround, not as a confirmed-safe final fix.

Most likely next thing to verify is staging's actual `R2_ENDPOINT` and `R2_BUCKET_NAME` formatting in Railway. The endpoint should be the account-level S3 API endpoint, shaped like `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, and the bucket variable should be only the bucket name, with no URL, leading slash, trailing slash, or embedded bucket path.

## Step 1 - Actual app code path

`utils/storage.js` constructs R2 state at module load:

```js
31: export function getStorageConfigurationStatus(env = process.env) {
32:   const missing = [
33:     'R2_ENDPOINT',
34:     'R2_ACCESS_KEY_ID',
35:     'R2_SECRET_ACCESS_KEY',
36:     'R2_BUCKET_NAME',
37:   ].filter((name) => !hasValue(env[name]))
...
55: const storageStatus = getStorageConfigurationStatus()
56: const r2 = storageStatus.configured ? new S3Client({
57:   region: 'auto',
58:   endpoint: process.env.R2_ENDPOINT,
59:   credentials: {
60:     accessKeyId: process.env.R2_ACCESS_KEY_ID,
61:     secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
62:   }
63: }) : null
65: const BUCKET = process.env.R2_BUCKET_NAME
```

The list helper is:

```js
127: export async function listFiles(prefix = '', maxKeys = 1) {
128:   if (!r2) {
129:     assertStorageConfiguredForRuntime()
130:     throw new Error('R2 storage is not configured')
131:   }
132:
133:   const response = await r2.send(new ListObjectsV2Command({
134:     Bucket: BUCKET,
135:     Prefix: prefix,
136:     MaxKeys: maxKeys,
137:   }))
138:
139:   return response.Contents || []
140: }
```

Important configuration facts:

| Setting | Current code behavior |
| --- | --- |
| `R2_ENDPOINT` | Read from `process.env.R2_ENDPOINT` at module load. |
| `R2_BUCKET_NAME` | Read from `process.env.R2_BUCKET_NAME` at module load and passed as `Bucket`. |
| Region | Hardcoded as `auto`. |
| Credentials | Read from `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. |
| `forcePathStyle` | Not set. The AWS SDK default behavior applies. |
| Prefix in current health check | `""` via `listFiles("", 1)`. |

Local runtime env status from this workstation:

```txt
R2_ENDPOINT=<missing>
R2_BUCKET_NAME=<missing>
R2_ACCESS_KEY_ID=<missing>
R2_SECRET_ACCESS_KEY=<missing>
```

Railway CLI status:

```txt
railway.cmd status
No linked project found. Run railway link to connect to a project

railway.cmd whoami
Unauthorized. Please run `railway login` again.
```

So the actual staging values could not be read from this session. No secrets were requested from the user and no Railway link/login/environment changes were made.

## Step 2 - Direct isolated SDK probe

I ran an isolated Node/AWS SDK v3 probe harness outside `routes/qa.js`. It was designed to call the same endpoint/credentials directly with these three inputs:

```js
new ListObjectsV2Command({
  Bucket: process.env.R2_BUCKET_NAME,
  Prefix: "",
  MaxKeys: 1,
})

new ListObjectsV2Command({
  Bucket: process.env.R2_BUCKET_NAME,
  Prefix: "qa-health-dummy/",
  MaxKeys: 1,
})

new ListObjectsV2Command({
  Bucket: process.env.R2_BUCKET_NAME,
  MaxKeys: 1,
})
```

The harness could not make network calls because all required R2 env vars were absent locally. Raw harness output:

```json
{
  "env": {
    "R2_ENDPOINT": "<missing>",
    "R2_BUCKET_NAME": "<missing>",
    "R2_ACCESS_KEY_ID": "<missing>",
    "R2_SECRET_ACCESS_KEY": "<missing>"
  },
  "missing": [
    "R2_ENDPOINT",
    "R2_BUCKET_NAME",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY"
  ]
}
```

Because of that, the exact raw R2 response/error for `Prefix: ""`, `Prefix: "qa-health-dummy/"`, and omitted `Prefix` is still unknown. The only live staging evidence available from the Admin QA history is:

```txt
R2 storage reachable
R2 configuration present; bucket list returned NoSuchKey on this endpoint
PASS
```

That message proves the deployed app hit the `NoSuchKey` catch path in `routes/qa.js`; it does not expose the raw R2 HTTP response body or request URL.

## Step 3 - Cloudflare R2 documentation check

Cloudflare says R2 provides an S3-compatible API and existing S3 code can work by changing the endpoint URL. Source: https://developers.cloudflare.com/r2/get-started/s3/

Cloudflare documents the R2 S3 API endpoint shape as:

```txt
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

Source: https://developers.cloudflare.com/r2/get-started/s3/

Cloudflare documents the R2 S3 region as `auto`. Source: https://developers.cloudflare.com/r2/api/s3/api/

Cloudflare lists `ListObjectsV2` as an implemented object-level operation. Source: https://developers.cloudflare.com/r2/api/s3/api/

Cloudflare's AWS SDK v3 example constructs an `S3Client` with:

```js
new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
})
```

The same example then calls:

```js
new ListObjectsV2Command({ Bucket: "my-bucket" })
```

and shows a successful HTTP 200 response shape. Source: https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/

I found no Cloudflare documentation stating that an empty-prefix `ListObjectsV2` should return `NoSuchKey`, and no official JavaScript SDK v3 example requiring `forcePathStyle` for the account-level R2 endpoint.

## Step 4 - Root-cause classification

### (a) Normal/documented Cloudflare R2 quirk

Not supported by the documentation found. Cloudflare documents `ListObjectsV2` as implemented and shows a successful bucket list with no `Prefix` in the AWS SDK v3 example. I found no documented R2 behavior saying empty-prefix list operations should return `NoSuchKey`.

### (b) S3 client or env misconfiguration

Plausible, but not proven in this session.

The current code does not set `forcePathStyle`, but Cloudflare's official JavaScript SDK v3 example also does not set it. Missing `forcePathStyle` alone is therefore not enough to call this a confirmed bug.

The more suspicious area is the actual Railway value formatting for `R2_ENDPOINT` and `R2_BUCKET_NAME`, which could not be inspected here. Specific misconfigurations to rule out:

- `R2_ENDPOINT` includes the bucket name or a path segment instead of only `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
- `R2_ENDPOINT` is a public/custom object URL rather than the S3 API endpoint.
- `R2_BUCKET_NAME` contains a URL, path, slash, casing mismatch, or whitespace instead of only the bucket name.
- The SDK is generating a request URL shape that R2 accepts for `PutObject`/`GetObject`/`DeleteObject` but not for `ListObjectsV2`.

Tier 2 passing proves upload, extraction, generation, export, delete, and sign-out work, but it does not prove the list operation is correctly configured.

### (c) Something else

This is the only fully defensible classification from the current evidence: the exact cause remains undetermined because direct staging R2 probes could not be run. What is known is narrower:

- The app's `listFiles("", 1)` call reaches a `NoSuchKey`-style error on staging.
- Cloudflare docs do not describe that as normal for empty-prefix listing.
- The current code catches that specific error and reports pass, so the health check no longer proves that `ListObjectsV2` works.

## Recommendation

Do not treat the current catch-and-pass workaround as proven safe as-is. It is acceptable only as a temporary production-noise suppressor while storage is otherwise proven by Tier 2 uploads/downloads/deletes.

Recommended next audit/fix step:

1. Read the actual Railway staging values for `R2_ENDPOINT` and `R2_BUCKET_NAME` without exposing secrets.
2. Confirm `R2_ENDPOINT` exactly matches the Cloudflare S3 API endpoint shape: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
3. Confirm `R2_BUCKET_NAME` is only the bucket name.
4. From an authenticated environment with the staging R2 env loaded, rerun the three isolated SDK probes:
   - `Prefix: ""`
   - `Prefix: "qa-health-dummy/"`
   - no `Prefix`
5. Capture the AWS SDK `$metadata.httpStatusCode`, error `name`, error `message`, and request URL shape.

If the direct probes succeed after correcting endpoint/bucket formatting, remove the catch-and-pass workaround and let the health check require a real successful list. If the direct probes still produce `NoSuchKey` with correctly formatted R2 settings, keep the app functionality backed by Tier 2 and replace the health check with a more representative non-destructive probe, such as a small write/read/delete fixture or a documented bucket-level operation.
