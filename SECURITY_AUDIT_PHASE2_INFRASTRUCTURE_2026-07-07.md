# Security Audit Phase 2 Infrastructure - 2026-07-07

Scope: read-only infrastructure/config security audit. No code, environment variables, platform settings, DNS records, R2 bucket settings, or deployment settings were changed.

## Findings

| Item | File/Line or Manual-Check | Status | Notes |
| --- | --- | --- | --- |
| R2/S3 client construction | `utils/storage.js:1-7`, `utils/storage.js:31-65` | Pass | Storage uses the AWS S3 SDK against Cloudflare R2-compatible config: `S3Client`, `region: "auto"`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME`. Production-like deployments require all four R2 env vars. |
| R2 bucket ACL / public access config in code | `utils/storage.js:80-85` | Needs Review | `PutObjectCommand` sets `Bucket`, `Key`, `Body`, and `ContentType` only. No object ACL, public-read ACL, bucket policy, or public-access-block setting is managed in code. Actual Cloudflare dashboard bucket public/private setting requires manual confirmation. |
| R2 object URL returned by upload helper | `utils/storage.js:86`, callers at `routes/documents.js:378`, `worker.js:338` | Needs Review | `uploadFile()` returns `{ key, url: "${R2_ENDPOINT}/${BUCKET}/${key}" }`, but current callers use/store the `key`, not the URL. If the bucket is public, that constructed URL pattern could be directly fetchable; if private, it is not useful externally. Manual R2 dashboard confirmation needed. |
| R2 signed URL usage | Repo grep for `getSignedUrl`, `@aws-sdk/s3-request-presigner`, `presign`; `utils/storage.js:116-124` | Needs Review | No R2/S3 presigned URL generation was found, so there is no R2 signed URL expiry duration to report. File reads are server-mediated with `GetObjectCommand` into `/tmp`, then returned through authenticated routes. |
| R2 authenticated download paths | `utils/storage.js:116-124`, `routes/exports.js:176-199`, `utils/extractionPipeline.js:397-404` | Pass | Export downloads and extraction use server-side `downloadFileToTmp()` with R2 `GetObjectCommand`; user-facing export download route still checks artifact ownership before calling it. |
| Mistral signed URL is unrelated to R2 | `utils/mistralOcr.js:34-57` | Informational | Repo has a Mistral file signed URL flow for OCR, but this is provider-side Mistral access, not Cloudflare R2/S3 signed URL access. |
| App-level HSTS | `server.js:1-145`; grep for `Strict-Transport-Security` | Fail | Backend Express app does not set `Strict-Transport-Security`. Live Railway API response for `/api/health` also did not include HSTS. No `max-age` or `includeSubDomains` exists at app level. |
| Frontend/Vercel HSTS observation | Manual live header check: `https://stage.studymaxing.com` | Pass | Vercel-served frontend returned `Strict-Transport-Security: max-age=63072000`. It did not include `includeSubDomains` in the observed header. |
| Platform HTTPS | Manual docs check: Vercel encryption docs; Railway public networking/domains docs | Pass | Vercel docs state deployments are served over HTTPS and HTTP is redirected to HTTPS with 308. Railway docs state public networking provides automatic SSL certificates and custom domains become accessible via HTTPS after configuration. This is platform TLS, separate from app-level HSTS/security headers. Sources: https://vercel.com/docs/cdn-security/encryption and https://docs.railway.com/networking/public-networking |
| Helmet dependency | `package.json:22-40`, `npm.cmd ls helmet --depth=0`, grep in `package-lock.json` | Fail | Helmet is not installed and no Helmet import/configuration was found. `npm ls helmet` returned an empty tree. |
| Security headers middleware | `server.js:65-74`, `server.js:99-145` | Fail | Server config contains CORS and JSON body parsing only. No equivalent middleware sets CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP, COEP, or CORP. |
| Headers currently set by backend app/platform on live API | Manual live header check: `https://ai-assistant-backend-staging.up.railway.app/api/health` with `Origin: https://stage.studymaxing.com` | Needs Review | Observed response headers included `access-control-allow-credentials: true`, `access-control-allow-origin: https://stage.studymaxing.com`, `vary: Origin`, `content-type: application/json; charset=utf-8`, `server: railway-hikari`, `x-powered-by: Express`, `x-railway-edge`, `x-railway-request-id`, and `x-hikari-trace`. No CSP, HSTS, nosniff, frame, referrer, permissions, COOP, COEP, or CORP headers were present. `X-Powered-By: Express` is exposed. |
| CORS headers | `server.js:65-71`, live API header check | Pass | Express CORS is configured with dynamic allowed origins, credentials enabled, methods `GET, POST, PUT, DELETE, PATCH, OPTIONS`, and allowed request headers `Content-Type`, `Authorization`, `User-Agent`. Live API reflected `https://stage.studymaxing.com` and set credentials. |
| Route-specific non-security headers | `middleware/authHardening.js:92`, `routes/qa.js:1837`, `routes/documents.js:621-623`, `routes/exports.js:188-199`, `utils/httpHeaders.js:1-27` | Informational | App sets `Retry-After` for auth/QA rate limiting and `Content-Type`, `Content-Disposition`, `Content-Length` for PDF/export responses. These do not replace baseline security headers. |
| CSP | `server.js:1-145`, live API header check | Fail | No `Content-Security-Policy` configured or observed on backend API responses. |
| X-Content-Type-Options | `server.js:1-145`, live API header check | Fail | No `X-Content-Type-Options: nosniff` configured or observed on backend API responses. |
| X-Frame-Options / frame-ancestors | `server.js:1-145`, live API header check | Fail | No `X-Frame-Options` and no CSP `frame-ancestors` configured or observed on backend API responses. |
| Referrer-Policy | `server.js:1-145`, live API header check | Fail | No `Referrer-Policy` configured or observed on backend API responses. |
| Permissions-Policy | `server.js:1-145`, live API header check | Fail | No `Permissions-Policy` configured or observed on backend API responses. |
| Cross-origin isolation/resource headers | `server.js:1-145`, live API header check | Needs Review | No `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, or `Cross-Origin-Resource-Policy` configured or observed. These may be optional for this API but should be deliberately decided. |
| Email provider config in repo | `.env.example:7-12`, `utils/email.js:27-77`, `QA_TIER1_FAILURES_AUDIT_2026-07-04.md:122-261` | Needs Review | Repo documents `AUTH_EMAIL_FROM_EMAIL`, `AUTH_EMAIL_PROVIDER="resend"`, and `RESEND_API_KEY`, and code sends through `https://api.resend.com/emails`. In-repo docs do not document required SPF/DKIM/DMARC records. |
| SPF DNS record | Manual DNS TXT lookup via `nslookup -type=txt studymaxing.com 8.8.8.8` | Needs Review | DNS returned `v=spf1 include:amazonses.com ~all`. This is a softfail policy and references Amazon SES. Because the app uses Resend, confirm in the Resend dashboard whether this is the expected SPF include/alignment for the configured sender domain. |
| DKIM DNS record | Manual DNS TXT lookup via `nslookup -type=txt resend._domainkey.studymaxing.com 8.8.8.8` | Pass | DNS returned a DKIM public key at `resend._domainkey.studymaxing.com`, which is consistent with a Resend domain verification selector. Manual Resend dashboard confirmation is still recommended. |
| DMARC DNS record | Manual DNS TXT lookup via `nslookup -type=txt _dmarc.studymaxing.com 8.8.8.8` | Pass | DNS returned `v=DMARC1; p=quarantine; rua=mailto:dmarc@studymaxing.com; adkim=s; aspf=s; pct=100`. Policy is strict alignment for DKIM/SPF and quarantine at 100%. |
| MX DNS record | Manual DNS MX lookup via local resolver | Informational | `studymaxing.com` MX records point to Google mail exchangers. This affects inbound mail, not directly outbound auth email spoofing, but is useful context for domain ownership/mail posture. |

## Live Header Evidence

Backend staging API `GET https://ai-assistant-backend-staging.up.railway.app/api/health` with `Origin: https://stage.studymaxing.com` returned:

```text
access-control-allow-credentials: true
access-control-allow-origin: https://stage.studymaxing.com
content-type: application/json; charset=utf-8
server: railway-hikari
vary: Origin
x-powered-by: Express
x-railway-edge: cdg1
x-railway-request-id: present
```

Frontend staging `GET https://stage.studymaxing.com` returned:

```text
access-control-allow-origin: *
content-type: text/html; charset=utf-8
server: Vercel
strict-transport-security: max-age=63072000
x-vercel-cache: HIT
x-vercel-id: present
```

## Manual Confirmations Still Required

1. Confirm Cloudflare R2 bucket public-access setting and any bucket policy in the Cloudflare dashboard. Code does not manage or assert private bucket policy.
2. Confirm Resend domain verification state in the Resend dashboard for `studymaxing.com`, especially SPF alignment with the current `include:amazonses.com` record and the `resend._domainkey` DKIM selector.
3. Decide whether backend API responses should add baseline security headers through Helmet or equivalent middleware, and whether Railway should receive an app-level HSTS header to match frontend posture.
