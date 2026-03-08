# Agent Documentation

This document provides guidelines for AI agents and developers working on the AI Study Assistant project.

---

## Project Stack

### Frontend
- **Framework**: Svelte 5.53.7
- **Build Tool**: Vite 7.3.1
- **Deployment**: Vercel
- **Styling**: CSS with design tokens
- **Authentication**: Better Auth 1.4.18 (client)
- **i18n**: Custom translation system (English/Arabic support)

### Backend
- **Runtime**: Node.js 18+ (Docker: Node 20)
- **Framework**: Express.js 4.21.1
- **ORM**: Prisma 5.22.0
- **Database**: PostgreSQL (Railway managed)
- **Authentication**: Better Auth 1.4.18 (server)
- **File Upload**: Multer 1.4.5-lts.1
- **AI**: OpenAI API 4.73.0 (GPT-4o-mini) - Ready for implementation
- **Storage**: Cloudflare R2 (S3-compatible)
- **Deployment**: Railway (Docker container)

### Additional Technologies
- **File Processing**: pdf-parse, mammoth, python-pptx
- **Job Queue**: Database-backed queue with worker leases and stale-job recovery
- **Python**: For PPTX extraction (requirements.txt)

## Lifecycle Architecture

- **Document is the lifecycle owner**: the frontend reads `Document.processingStatus`, `processingJobId`, `processingError`, and `processedAt` as the source of truth.
- **User-visible states**: `queued -> processing -> complete | failed`
- **Job rows are worker coordination records**: jobs still move through `queued -> running -> succeeded | failed`, but that status is internal to the worker and polling APIs.
- **Upload is atomic**: the backend uploads to storage, creates the `Document`, increments usage, creates the `Job`, and links `processingJobId` inside one Prisma transaction before returning `202 Accepted`.
- **Workers use leases**: claiming a queued job sets `workerId`, `leaseExpiresAt`, and `lastHeartbeatAt`; heartbeats extend the lease while extraction and AI generation run.
- **Startup is schema-safe**: the worker waits for the lifecycle columns to exist, backfills document lifecycle state, then starts polling for queued jobs.
- **Expired leases recover automatically**: startup recovery and the periodic stale-job sweep requeue or fail abandoned running jobs and keep the owning document status in sync.

---

## Git Workflow

### Simplified Push-to-Stage Workflow

**Default workflow for all changes:**

```
1. Make changes in your working directory
2. Commit to local repository  
3. Push directly to 'stage' branch
4. Automatic deployment to staging (Vercel + Railway)
5. Test on staging environment
6. ONLY push to 'production' when user explicitly requests it
```

### Rules

- ❌ **Do NOT** create feature branches
- ❌ **Do NOT** create pull requests
- ✅ **Always** push directly to `stage` for all work
- ✅ `stage` branch = automatic testing environment
- ✅ `production` branch = manual promotion only (when explicitly requested)

### Branch Strategy

```
stage       → Auto-deploys to staging → Test here
              ↓ (manual, when requested)
production  → Auto-deploys to production → Live site
```

### Deployment Triggers

- **Push to `stage`**: 
  - Frontend: Deploys to `my-ai-assistant-git-stage-*.vercel.app`
  - Backend: Deploys to Railway staging instance
  
- **Push to `production`** (only when explicitly requested):
  - Frontend: Deploys to `my-ai-assistant.vercel.app`
  - Backend: Deploys to Railway production instance

---

## Development Behavior Rules

### 1. Always Analyze Before Coding

- Read relevant existing code first
- Understand the current architecture
- Check for similar implementations
- Review related files in the area you're working on
- Use the Task tool for exploratory codebase searches

### 2. Modify Only Required Files

- Make surgical changes to specific files
- Avoid touching unrelated code
- Don't refactor code that works unless necessary
- Keep changes focused on the task at hand

### 3. Avoid Modifying Shared/Core Modules

- Be extremely cautious with:
  - `auth.js` (frontend and backend)
  - Prisma schema (requires migration)
  - Global stores (`/stores`)
  - Middleware (`/middleware`)
  - Design tokens (`tokens.css`)
  
- Only modify these when absolutely necessary
- Document any changes to shared modules

### 4. Prefer Small Incremental Changes

- Make small, testable commits
- One feature/fix per commit when possible
- Test each change before moving to the next
- Push to staging frequently to verify

### 5. Test on Staging

- Always verify changes on staging before considering production
- Check both frontend and backend behavior
- Test authentication flows if modified
- Verify API responses and error handling

### 6. Use Environment-Specific Configs

- Different API URLs for dev/staging/production
- Never hardcode environment-specific values
- Use environment variables for all configs
- Keep `.env.example` files updated

---

## Code Style Standards

### General (All Code)

**ES Modules:**
- Always use `"type": "module"` style
- Include `.js` extensions in imports: `import foo from './bar.js'`
- Use named exports for utilities: `export function foo() {}`
- Use default exports for components: `export default MyComponent`

**Async Operations:**
- Always use `async/await` (never raw Promises or callbacks)
- Wrap async routes in try/catch blocks
- Handle errors explicitly

**Variables:**
- Prefer `const` for immutable values
- Use `let` sparingly for reassignment
- Never use `var`

**Error Handling:**
- All async routes must have try/catch
- Return appropriate HTTP status codes
- Log errors with `console.error()`
- Provide user-friendly error messages

### Frontend (Svelte)

**Component Structure:**
```svelte
<script>
  // 1. Imports
  import { onMount } from 'svelte';
  
  // 2. Props
  export let title = 'Default';
  
  // 3. State
  let items = [];
  
  // 4. Derived state
  $: total = items.length;
  
  // 5. Functions
  async function fetchData() {
    // ...
  }
  
  // 6. Lifecycle
  onMount(async () => {
    await fetchData();
  });
</script>

<!-- 7. Template -->
<div>
  <h1>{title}</h1>
  <p>Total: {total}</p>
</div>

<!-- 8. Styles -->
<style>
  div {
    padding: var(--space-4);
  }
</style>
```

**Best Practices:**
- Use Svelte 5 runes syntax where appropriate
- Prefer reactive declarations (`$:`) for derived state
- Keep components under 300 lines when possible
- Extract complex logic into utility functions
- Use design tokens from `tokens.css`

### Backend (Express)

**Route Structure:**
```javascript
import express from 'express';
const router = express.Router();

// Always wrap in try/catch
router.get('/endpoint', async (req, res) => {
  try {
    // Validate input
    if (!req.body.field) {
      return res.status(400).json({ error: 'Field required' });
    }
    
    // Business logic
    const result = await someOperation();
    
    // Return response
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error in endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
```

**Best Practices:**
- Use Express Router for modular routes
- Always validate input before processing
- Use Prisma for all database operations
- Return consistent JSON response formats
- Log errors with context

### Commit Messages

**Format:**
- Present tense, imperative mood
- Start with capital letter
- No period at the end
- Max 72 characters for first line

**Examples:**
```
✅ Add flashcard progress tracking
✅ Fix document deletion bug
✅ Update admin panel with session management
✅ Refactor extraction pipeline for better error handling

❌ added flashcard feature
❌ bug fix
❌ Updated stuff
```

---

## Environment Variables

### Frontend (.env)

```bash
# Development
VITE_API_BASE_URL=http://localhost:3001

# Staging
VITE_API_BASE_URL=https://ai-assistant-backend-staging.up.railway.app

# Production
VITE_API_BASE_URL=https://ai-assistant-backend-production.up.railway.app

# Feature flags
VITE_ENABLE_ARABIC_UI=false
```

### Backend (.env)

```bash
# Database (Railway provides this automatically)
DATABASE_URL=postgresql://user:password@host:port/database

# Authentication (Required)
BETTER_AUTH_SECRET=<generate with: openssl rand -hex 32>
BETTER_AUTH_BASE_URL=https://your-backend.up.railway.app
ADMIN_EMAILS=admin@example.com,another@example.com

# OpenAI (Required for AI features)
OPENAI_API_KEY=sk-...

# Cloudflare R2 Storage (Optional - falls back to local /tmp)
R2_ENDPOINT=https://your-account.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=ai-study-assistant-uploads

# Server (Railway sets PORT automatically)
PORT=3001
NODE_ENV=production
```

---

## Testing & Deployment

### Local Development

**Frontend:**
```bash
cd my-ai-assistant
npm install
npm run dev          # http://localhost:5173
```

**Backend:**
```bash
cd ai-assistant-backend
npm install
npm start            # Port 3001
npm run worker       # Separate terminal for job processing
```

### Staging Deployment

1. **Commit and push to `stage` branch**
   ```bash
   git add .
   git commit -m "Your commit message"
   git push origin stage
   ```

2. **Automatic deployments:**
   - Vercel deploys frontend to `*-git-stage-*.vercel.app`
   - Railway deploys backend to staging instance
   
3. **Verify on staging:**
   - Test all changed functionality
   - Check browser console for errors
   - Verify API responses
   - Test authentication if modified

### Production Deployment

**Only when explicitly requested by user:**

```bash
git push origin production
```

This triggers production deployments on both Vercel and Railway.

---

## Database Operations

### Prisma Commands

```bash
# Sync schema to database (used in Railway startup)
npx prisma db push

# Generate Prisma Client (after schema changes)
npx prisma generate

# Open Prisma Studio (database GUI)
npx prisma studio

# Create admin user
npm run seed

# Recalculate storage usage (maintenance)
node backfill-storage.js
```

### Schema Changes

When modifying `prisma/schema.prisma`:

1. Make changes to schema file
2. Run `npx prisma db push` locally to test
3. Commit schema changes
4. Push to `stage` - Railway will auto-run `prisma db push` on deploy
5. Verify on staging database
6. When ready, push to production (only when requested)

---

## Common Tasks

### Adding a New API Endpoint

1. Create/modify route file in `/routes`
2. Add route logic with try/catch
3. Mount router in `server.js` if new file
4. Test locally
5. Push to `stage` and test on staging
6. Update `SYSTEM_OVERVIEW.md` with new endpoint

### Adding a New Page

1. Create component in `/src/pages`
2. Add route to `/src/routes.js`
3. Add navigation item to `Sidebar.svelte` and/or `BottomNav.svelte`
4. Test locally
5. Push to `stage` and verify

### Adding a New Database Model

1. Edit `prisma/schema.prisma`
2. Run `npx prisma db push` locally
3. Update related routes/logic
4. Test locally
5. Push to `stage` - schema syncs automatically
6. Update `SYSTEM_OVERVIEW.md` with new model

### Modifying Authentication

1. **Be very careful** - affects all users
2. Test extensively locally
3. Review `auth.js` in both frontend and backend
4. Ensure session compatibility
5. Test sign in, sign out, session persistence
6. Push to `stage` and test thoroughly
7. **Only push to production when explicitly requested**

---

## Troubleshooting

### Frontend Issues

**API calls failing:**
- Check `VITE_API_BASE_URL` is set correctly
- Verify `credentials: 'include'` in fetch calls
- Check browser console for CORS errors
- Verify backend is running and accessible

**Authentication not working:**
- Check session cookie is being set
- Verify Better Auth configuration matches between frontend/backend
- Check `BETTER_AUTH_BASE_URL` matches actual backend URL

### Backend Issues

**Database connection errors:**
- Verify `DATABASE_URL` is correct
- Run `npx prisma db push` to sync schema
- Check Railway database is running

**File upload failures:**
- Check R2 credentials if using cloud storage
- Verify `/tmp/uploads` directory exists (created automatically)
- Check file size under 25MB limit

**Worker not processing jobs:**
- Ensure `worker.js` is running (separate process)
- Check database connection in worker
- Look for error logs in worker console

---

## Maintenance Guidelines

### Documentation Updates

**Update `agent.md` (this file) when:**
- Workflow changes
- New environment variables added
- Stack/dependencies change
- Deployment process changes

**Update `PROJECT_STRUCTURE.md` when:**
- New folders created
- Major file reorganization
- New route pages added

**Update `SYSTEM_OVERVIEW.md` when:**
- New API endpoints added
- Authentication flow changes
- New external services integrated
- Architecture changes

### Keep Docs Synchronized

- Update docs in the same commit as code changes when possible
- Review docs monthly for accuracy
- Ask for clarification if documentation is unclear

---

## Security Reminders

- ❌ **Never commit** `.env` files, API keys, or secrets
- ❌ **Never log** sensitive data (passwords, tokens, API keys)
- ✅ **Always validate** user input on backend
- ✅ **Always check** ownership before allowing access to resources
- ✅ **Use admin middleware** for admin-only routes
- ✅ **Rate limit** sensitive endpoints

---

## Resources

- **Frontend Repo**: `/my-ai-assistant`
- **Backend Repo**: `/ai-assistant-backend`
- **Svelte Docs**: https://svelte.dev/docs
- **Prisma Docs**: https://www.prisma.io/docs
- **Better Auth Docs**: https://better-auth.com/docs
- **Railway Docs**: https://docs.railway.app
- **Vercel Docs**: https://vercel.com/docs

---

**Last Updated**: March 2026
