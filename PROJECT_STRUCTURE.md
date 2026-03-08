# Project Structure

This document describes the organization of the AI Study Assistant repository.

---

## Root Structure

```
C:/Users/user/OneDrive/Desktop/New folder/
├── my-ai-assistant/           # Frontend application (Svelte + Vite)
├── ai-assistant-backend/      # Backend API (Node.js + Express + Prisma)
├── agent.md                   # Development guidelines
├── PROJECT_STRUCTURE.md       # This file - Repository organization
└── SYSTEM_OVERVIEW.md         # Architecture and system integration
```

---

## Frontend Structure

**Location**: `/my-ai-assistant`  
**Tech Stack**: Svelte 5.53.7 + Vite 7.3.1  
**Deployment**: Vercel

### Directory Tree

```
my-ai-assistant/
├── package.json               # Dependencies, scripts
├── package-lock.json
├── vite.config.js             # Vite build configuration
├── index.html                 # HTML entry point
├── README.md                  # Frontend documentation
├── AGENTS.md                  # Legacy developer guidelines
├── LICENSE
├── .gitignore
│
├── src/
│   ├── main.js                # Application entry point
│   ├── App.svelte             # Root component (routing, auth, layouts)
│   ├── routes.js              # Route definitions (static + dynamic)
│   ├── config.js              # API base URL configuration
│   │
│   ├── pages/                 # Route page components
│   │   ├── Landing.svelte     # Unauthenticated landing page
│   │   ├── Home.svelte        # Dashboard: upload, recent documents
│   │   ├── Documents.svelte   # Document library grid view
│   │   ├── DocumentView.svelte # Document detail: summary, flashcards, exams
│   │   ├── Exams.svelte       # Exams page (coming soon)
│   │   ├── Flashcards.svelte  # Flashcards page (coming soon)
│   │   └── Settings.svelte    # User settings
│   │
│   ├── components/            # Feature-specific components
│   │   ├── AdminDashboard.svelte
│   │   ├── AppHeader.svelte
│   │   ├── Footer.svelte
│   │   ├── admin/             # Admin panel components
│   │   │   ├── AdminStats.svelte       # Platform metrics
│   │   │   ├── UserTable.svelte        # User management
│   │   │   ├── UserDetail.svelte       # User detail view
│   │   │   ├── SessionManager.svelte   # Session management
│   │   │   ├── StorageOverview.svelte  # Storage analytics
│   │   │   └── AuditLogViewer.svelte   # Audit log viewer
│   │   └── auth/              # Authentication components
│   │       ├── SignIn.svelte
│   │       └── SignUp.svelte
│   │
│   ├── lib/                   # Shared library code
│   │   ├── components/
│   │   │   ├── layout/        # Layout components
│   │   │   │   ├── AppShell.svelte     # Main app container
│   │   │   │   ├── TopBar.svelte       # Header navigation
│   │   │   │   ├── Sidebar.svelte      # Desktop navigation
│   │   │   │   └── BottomNav.svelte    # Mobile navigation
│   │   │   └── ui/            # Reusable UI components
│   │   │       ├── EmptyState.svelte
│   │   │       ├── StatusBadge.svelte
│   │   │       ├── ConfirmModal.svelte
│   │   │       ├── DrawerShell.svelte
│   │   │       └── LanguageToggle.svelte
│   │   │
│   │   ├── stores/            # Feature-specific stores
│   │   │   └── language.js    # i18n language store
│   │   │
│   │   ├── i18n/              # Internationalization
│   │   │   ├── en.js          # English translations
│   │   │   ├── ar.js          # Arabic translations
│   │   │   └── t.js           # Translation function
│   │   │
│   │   ├── config/            # Feature configuration
│   │   │   └── features.js    # Feature flags
│   │   │
│   │   └── styles/            # Design system
│   │       └── tokens.css     # CSS design tokens
│   │
│   ├── stores/                # Global application stores
│   │   ├── auth.js            # Better Auth client, session
│   │   └── router.js          # Hash-based routing
│   │
│   └── styles/                # Global styles
│       └── global.css         # CSS resets, base styles
│
├── dist/                      # Build output (gitignored)
└── node_modules/              # Dependencies (gitignored)
```

### Key Folders Explained

#### `/src/pages/`
**Purpose**: Route page components - one component per route  
**Contents**: 7 page components  
**Responsibility**:
- Handle page-level logic
- Make API calls
- Manage page-specific state
- Render layout with data

**Key Files**:
- `Home.svelte` - Dashboard with document upload and recent documents
- `Documents.svelte` - Document library with grid view
- `DocumentView.svelte` - Individual document with flashcards and exams
- `Settings.svelte` - User settings and preferences

#### `/src/components/`
**Purpose**: Feature-specific components used across pages  
**Contents**: Admin panel and authentication components  
**Responsibility**:
- Implement specific features (admin tools, auth forms)
- Reusable across multiple pages when needed
- Handle feature-specific state

**Key Folders**:
- `admin/` - 6 components for admin panel functionality
- `auth/` - Sign in and sign up forms

#### `/src/lib/components/`
**Purpose**: Generic, reusable UI components  
**Contents**: Layout and UI primitives  
**Responsibility**:
- Provide consistent UI patterns
- No business logic
- Highly reusable across features

**Key Folders**:
- `layout/` - App shell, navigation, topbar (4 files)
- `ui/` - Modals, badges, empty states (5 files)

#### `/src/stores/`
**Purpose**: Global application state  
**Contents**: Auth and routing stores  
**Responsibility**:
- Manage app-wide state (authentication, routing)
- Single source of truth
- Accessible from any component

**Key Files**:
- `auth.js` - Better Auth integration, session management
- `router.js` - Hash-based routing with reactive stores

#### `/src/lib/stores/`
**Purpose**: Feature-specific stores  
**Contents**: Language/i18n store  
**Responsibility**:
- Manage feature-specific state
- Can be optional (tree-shakeable)

#### `/src/lib/i18n/`
**Purpose**: Internationalization system  
**Contents**: Translation dictionaries and function  
**Responsibility**:
- Store translations for multiple languages
- Provide translation function
- Currently: English (default), Arabic (optional via feature flag)

**Key Files**:
- `en.js` - English translations (8,913 bytes)
- `ar.js` - Arabic translations (11,548 bytes)
- `t.js` - Translation function with interpolation

#### `/src/lib/styles/`
**Purpose**: Design system tokens  
**Contents**: CSS custom properties  
**Responsibility**:
- Define colors, spacing, typography, motion
- Ensure consistent design across app
- Dark navy theme with purple accent

---

## Backend Structure

**Location**: `/ai-assistant-backend`  
**Tech Stack**: Node.js 18+ + Express 4 + Prisma 5  
**Database**: PostgreSQL  
**Deployment**: Railway (Docker)

### Directory Tree

```
ai-assistant-backend/
├── package.json               # Dependencies, scripts
├── package-lock.json
├── Dockerfile                 # Production container (Node 20 + Python 3)
├── railway.toml               # Railway deployment config
├── nixpacks.toml              # Alternative build config
├── requirements.txt           # Python dependencies (python-pptx)
├── .gitignore
├── AGENTS.md                  # Legacy developer guidelines
│
├── server.js                  # Main Express server (port 3001)
├── worker.js                  # Background job processor
├── auth.js                    # Better Auth configuration
│
├── routes/                    # API route handlers
│   ├── documents.js           # Document upload, get, delete (250 lines)
│   ├── admin.js               # Admin panel API (756 lines)
│   ├── user.js                # User profile, usage stats
│   ├── flashcards.js          # Flashcard progress tracking
│   ├── exams.js               # Exam attempt recording
│   └── jobs.js                # Job status polling
│
├── middleware/                # Express middleware
│   ├── auth.js                # Session validation, user attachment
│   ├── adminGuard.js          # Admin role verification
│   └── rateLimit.js           # In-memory rate limiting
│
├── utils/                     # Utility functions
│   ├── storage.js             # R2/S3 file upload and deletion
│   ├── jobQueue.js            # Job queue operations
│   ├── extractionPipeline.js  # Document text extraction (160 lines)
│   ├── limits.js              # User quota calculations
│   ├── auditLog.js            # Admin action logging
│   └── serializers.js         # JSON serialization (BigInt handling)
│
├── prisma/                    # Database layer
│   ├── schema.prisma          # Database schema (17 models, 257 lines)
│   ├── seed.js                # Admin user seeding script
│   └── migrations/            # Database migrations (generated)
│
├── scripts/                   # Maintenance and utility scripts
│   ├── extract_pptx.py        # Python PPTX extraction script
│   ├── backfill-storage.js    # Recalculate storage usage
│   └── reset-db.js            # Delete all data (dev only)
│
├── tmp/                       # Temporary upload directory (gitignored)
│   └── uploads/               # Multer saves here temporarily
│
└── node_modules/              # Dependencies (gitignored)
```

### Key Folders Explained

#### `/routes/`
**Purpose**: Express route handlers - one router per resource  
**Contents**: 6 route files  
**Responsibility**:
- Define API endpoints
- Handle HTTP requests/responses
- Validate input
- Call business logic
- Return JSON responses

**Key Files**:
- `documents.js` (250 lines) - Document upload, retrieval, deletion
- `admin.js` (756 lines) - Comprehensive admin panel API
- `user.js` - User profile and usage statistics
- `jobs.js` - Job status polling for async operations

#### `/middleware/`
**Purpose**: Express middleware functions  
**Contents**: 3 middleware files  
**Responsibility**:
- Authenticate requests
- Authorize admin access
- Rate limit requests
- Attach user data to request object

**Key Files**:
- `auth.js` - Validates Better Auth session, attaches `req.session.user`
- `adminGuard.js` - Checks user role is admin, returns 403 if not
- `rateLimit.js` - In-memory rate limiter (default 120 req/min)

#### `/utils/`
**Purpose**: Business logic and helper functions  
**Contents**: 6 utility files  
**Responsibility**:
- Implement core business logic
- Abstract complex operations
- Provide reusable functions
- Keep routes clean and focused

**Key Files**:
- `extractionPipeline.js` (160 lines) - Extract text from PDF, DOCX, PPTX
- `storage.js` - Upload/delete files from Cloudflare R2 (S3-compatible)
- `jobQueue.js` - Create and query async jobs
- `limits.js` - Calculate user quotas (monthly limits, remaining documents)

#### `/prisma/`
**Purpose**: Database schema and migrations  
**Contents**: Schema file, seed script, migrations folder  
**Responsibility**:
- Define database models (17 models)
- Track schema changes (migrations)
- Seed initial data (admin user)
- Generate Prisma Client

**Key Files**:
- `schema.prisma` (257 lines) - Complete database schema
- `seed.js` - Creates default admin user (admin@ai.com / admin123)

**Database Models**:
- User, Session, Account (auth)
- Document, DocumentExcerpt (documents)
- FlashcardProgress, ExamAttempt (learning)
- Job (async processing)
- AuditLog, UserLimit, UsageEvent (admin/monitoring)
- FeatureFlag, FeatureFlagAssignment (feature management)
- CostAnomalyAlert (cost monitoring)

#### `/scripts/`
**Purpose**: Maintenance and one-off scripts  
**Contents**: Python extraction script, maintenance scripts  
**Responsibility**:
- Extract PPTX files (Python subprocess)
- Recalculate storage usage
- Database maintenance

**Key Files**:
- `extract_pptx.py` - Uses python-pptx to extract slides, notes, images
- `backfill-storage.js` - Recalculates User.storageUsed from documents
- `reset-db.js` - Deletes all data (dev/staging only)

#### Key Files Explained

##### `server.js` (89 lines)
**Purpose**: Main Express application  
**Responsibilities**:
- Initialize Express app
- Configure CORS
- Mount Better Auth handlers
- Mount route handlers
- Start HTTP server on PORT (default 3001)

##### `worker.js` (87 lines)
**Purpose**: Background job processor  
**Responsibilities**:
- Poll database for queued jobs every 2 seconds
- Use `SELECT FOR UPDATE SKIP LOCKED` for concurrency
- Process jobs: extract_document, generate_exam, generate_flashcards
- Update job status: queued → running → succeeded/failed
- Retry failed jobs up to 3 times
- Must run as separate process from server

##### `auth.js` (69 lines)
**Purpose**: Better Auth configuration  
**Responsibilities**:
- Configure authentication adapter (Prisma)
- Define email/password authentication
- Enable admin plugin
- Configure trusted origins (localhost, Vercel)
- Set cookie options (secure, sameSite)
- Define custom user fields (plan, documentsUsed, monthlyLimit)

---

## Important Files Summary

### Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| `package.json` | Both repos | Dependencies, scripts |
| `vite.config.js` | Frontend | Vite build configuration |
| `Dockerfile` | Backend | Production container build |
| `railway.toml` | Backend | Railway deployment config |
| `prisma/schema.prisma` | Backend | Database schema (17 models) |

### Entry Points

| File | Location | Purpose |
|------|----------|---------|
| `index.html` | Frontend | HTML entry point |
| `src/main.js` | Frontend | JavaScript entry point |
| `src/App.svelte` | Frontend | Root Svelte component |
| `server.js` | Backend | Express server entry |
| `worker.js` | Backend | Job processor entry |

### Key Implementation Files

| File | Lines | Purpose |
|------|-------|---------|
| `routes/admin.js` | 756 | Admin panel API (comprehensive) |
| `routes/documents.js` | 250 | Document management |
| `utils/extractionPipeline.js` | 160 | File text extraction |
| `src/pages/Home.svelte` | ~300 | Dashboard with upload |
| `src/pages/DocumentView.svelte` | ~400 | Document detail view |

---

## Maintenance Guidelines

### When to Update This Document

✅ **Update when:**
- Adding new top-level directories
- Creating new major feature folders
- Adding new page routes
- Restructuring existing folders
- Adding new route files in backend
- Adding new major utilities

❌ **Don't update for:**
- Individual file changes within documented folders
- Minor component additions
- Style tweaks
- Bug fixes that don't change structure

### Quick Reference

**To find:**
- API endpoints → `/ai-assistant-backend/routes/`
- Page components → `/my-ai-assistant/src/pages/`
- Reusable UI → `/my-ai-assistant/src/lib/components/`
- Database models → `/ai-assistant-backend/prisma/schema.prisma`
- Business logic → `/ai-assistant-backend/utils/`
- Global state → `/my-ai-assistant/src/stores/`
- Styles → `/my-ai-assistant/src/lib/styles/tokens.css`

---

**Last Updated**: March 2026
