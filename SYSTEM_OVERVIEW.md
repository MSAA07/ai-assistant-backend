# System Overview

This document explains the architecture, integration patterns, and data flows of the AI Study Assistant system.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    User's Browser                               │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Svelte SPA (my-ai-assistant.vercel.app)                   │ │
│  │  • Hash-based routing (#/dashboard, #/documents)           │ │
│  │  • Better Auth client (session management)                 │ │
│  │  • Fetch API with credentials: 'include'                   │ │
│  │  • Dark navy theme with responsive layout                  │ │
│  └─────────────────────┬──────────────────────────────────────┘ │
└────────────────────────┼────────────────────────────────────────┘
                         │
                         │ HTTPS + Session Cookies
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              Backend API (Railway)                              │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Express Server (server.js) - Port 3001                    │ │
│  │  • Better Auth middleware (session validation)             │ │
│  │  • REST API endpoints (/api/*)                             │ │
│  │  • Multer file upload (max 25MB)                           │ │
│  │  • Prisma Client (type-safe database queries)              │ │
│  │  • CORS configured for Vercel frontend                     │ │
│  └─────────┬──────────────────────────────┬───────────────────┘ │
│            │                              │                     │
│            ▼                              ▼                     │
│  ┌──────────────────┐          ┌──────────────────┐           │
│  │  Worker Process  │          │  PostgreSQL DB   │           │
│  │  (worker.js)     │◄─────────┤  (Railway)       │           │
│  │                  │  Poll    │                  │           │
│  │  • Job polling   │  jobs    │  • 17 models     │           │
│  │  • File extract  │          │  • Prisma ORM    │           │
│  │  • AI generation │          │  • Migrations    │           │
│  └──────────────────┘          └──────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
         │                              │
         │ Python subprocess            │ S3 API
         ▼                              ▼
┌──────────────────┐          ┌──────────────────┐
│  Python Script   │          │  Cloudflare R2   │
│  extract_pptx.py │          │  (File Storage)  │
│  • python-pptx   │          │  • S3-compatible │
│  • JSON output   │          │  • User uploads  │
└──────────────────┘          └──────────────────┘
```

### Key Components

1. **Frontend (Svelte SPA)**: User interface, client-side routing, session management
2. **Backend API (Express)**: REST endpoints, authentication, business logic
3. **Worker Process**: Async job processing (file extraction, AI generation)
4. **PostgreSQL Database**: Data persistence via Prisma ORM
5. **Cloudflare R2**: Object storage for uploaded documents
6. **Python Scripts**: PPTX text extraction (subprocess)

---

## Frontend ↔ Backend Communication

### Connection Setup

**API Base URL Configuration:**
```javascript
// src/config.js
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';
```

**Environment-Specific URLs:**
- **Development**: `http://localhost:3001`
- **Staging**: `https://ai-assistant-backend-staging.up.railway.app`
- **Production**: `https://ai-assistant-backend-production.up.railway.app`

### Request Pattern

All API calls follow this pattern:

```javascript
const response = await fetch(`${API_BASE}/api/endpoint`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  credentials: 'include',  // CRITICAL: sends session cookie
  body: JSON.stringify(data)
});

if (!response.ok) {
  const error = await response.json();
  throw new Error(error.error || 'Request failed');
}

const result = await response.json();
```

**Critical Elements:**
- `credentials: 'include'` - Required for session cookies to be sent
- Error handling - Check `response.ok` before parsing JSON
- Consistent JSON response format from backend

### CORS Configuration

**Backend (server.js):**
```javascript
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://my-ai-assistant-ypzx.vercel.app',
  'https://my-ai-assistant.vercel.app',
  // Dynamic: *.vercel.app domains containing 'my-ai-assistant'
];

app.use(cors({
  origin: (origin, callback) => {
    if (allowedOrigins.includes(origin) || 
        isVercelDeployment(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true  // Allow cookies
}));
```

---

## API Structure

### Public Endpoints

```
GET  /api/health              # Health check (no auth required)
```

### Authentication Endpoints (Better Auth)

```
POST /api/auth/sign-up        # User registration
     Body: { email, password, name }
     Returns: { user, session }

POST /api/auth/sign-in        # Email/password login
     Body: { email, password }
     Returns: { user, session }
     Sets: HTTP-only session cookie

GET  /api/auth/session        # Get current session
     Returns: { user, session } or null

POST /api/auth/sign-out       # Logout
     Clears: Session cookie
     Returns: { success: true }
```

### User Endpoints

```
GET  /api/user/me             # Current user profile + documents
     Auth: Required
     Returns: {
       user: { id, email, name, plan, role, documentsUsed, monthlyLimit, storageUsed },
       documents: [{ id, filename, createdAt, flashcards, examQuestions }],
       remainingDocuments: number
     }
```

### Document Endpoints

```
POST /api/upload              # Upload document
     Auth: Required
     Content-Type: multipart/form-data
     Body: { file, language }
     Max Size: 25MB
     Allowed: PDF, DOCX, PPTX
     Returns: { 
       jobId: string,
       message: 'Document uploaded, processing started'
     }
     Status: 202 Accepted

GET  /api/document/:id        # Get document by ID
     Auth: Required
     Ownership: Must own document or be admin
     Returns: {
       id, filename, originalName, fileType, language,
       summary, flashcards, examQuestions, createdAt
     }

DELETE /api/document/:id      # Delete document
     Auth: Required
     Ownership: Must own document or be admin
     Actions:
       • Deletes document record
       • Deletes from R2 storage
       • Updates user storageUsed
     Returns: { success: true }
```

### Learning Endpoints

```
POST /api/flashcard/progress  # Save flashcard progress
     Auth: Required
     Body: { documentId, cardIndex, mastered }
     Upserts: FlashcardProgress record
     Returns: { success: true, progress }

POST /api/exam/attempt        # Record exam attempt
     Auth: Required
     Body: { documentId, answers, score, totalQuestions }
     Creates: ExamAttempt record
     Returns: { success: true, attempt }
```

### Job Endpoints

```
GET  /api/jobs/:id            # Get job status (polling)
     Auth: Required
     Ownership: Must own job or be admin
     Returns: {
       id, status, progressPct, result, errorMessage
     }
     Statuses: 'queued', 'running', 'succeeded', 'failed'
```

### Admin Endpoints

All admin endpoints require:
- Authentication (valid session)
- Admin role (`user.role === 'admin'`)
- Rate limiting (120 requests/minute)

**User Management:**
```
GET    /api/admin/users                    # List users (filter, search, paginate)
POST   /api/admin/users                    # Create user
GET    /api/admin/users/:id                # Get user details
PATCH  /api/admin/users/:id                # Update user (name, plan, role, limit)
DELETE /api/admin/users/:id                # Delete user
POST   /api/admin/users/:id/suspend        # Ban user
POST   /api/admin/users/:id/unsuspend      # Unban user
```

**File Management:**
```
GET    /api/admin/users/:id/files          # List user's documents
DELETE /api/admin/users/:id/files/:docId   # Delete user's document (admin override)
```

**Session Management:**
```
GET    /api/admin/users/:id/sessions       # List user's sessions
DELETE /api/admin/users/:id/sessions       # Revoke all user sessions
DELETE /api/admin/users/:id/sessions/:sid  # Revoke specific session
GET    /api/admin/sessions                 # List all active sessions
DELETE /api/admin/sessions/:id             # Revoke any session
```

**Analytics:**
```
GET    /api/admin/analytics                # Platform-wide stats
       Returns: {
         totalUsers, totalDocuments, totalStorage,
         activeUsers24h, activeUsers7d, activeUsers30d,
         newUsersToday, documentsToday
       }

GET    /api/admin/storage                  # Storage usage by user
       Returns: [{ userId, name, storageUsed, documentCount }]
```

**Audit Logs:**
```
GET    /api/admin/audit-logs               # Query audit logs
       Query: action, adminId, startDate, endDate, page, limit
       Returns: { logs: [], total, page, totalPages }
```

---

## Prisma Database Usage

### Database: PostgreSQL on Railway

**Prisma Client Initialization:**
```javascript
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
```

### Database Models (17 Total)

#### Authentication & User Management

**User**
```prisma
model User {
  id              String   @id @default(cuid())
  email           String   @unique
  name            String?
  emailVerified   Boolean  @default(false)
  role            String   @default("user")  // "user" or "admin"
  plan            String   @default("free")  // "free", "pro", "premium"
  documentsUsed   Int      @default(0)
  monthlyLimit    Int      @default(5)
  storageUsed     BigInt   @default(0)
  banned          Boolean  @default(false)
  createdAt       DateTime @default(now())
  lastActive      DateTime @default(now())
  
  // Relations
  sessions        Session[]
  accounts        Account[]
  documents       Document[]
  jobs            Job[]
  flashcardProgress FlashcardProgress[]
  examAttempts    ExamAttempt[]
  usageEvents     UsageEvent[]
}
```

**Session** (Better Auth)
```prisma
model Session {
  id         String   @id @default(cuid())
  userId     String
  token      String   @unique
  expiresAt  DateTime
  ipAddress  String?
  userAgent  String?
  createdAt  DateTime @default(now())
  
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

**Account** (Better Auth - passwords/OAuth)
```prisma
model Account {
  id                String   @id @default(cuid())
  accountId         String   @unique
  providerId        String
  userId            String
  accessToken       String?
  refreshToken      String?
  password          String?  // Hashed by Better Auth
  
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

#### Document Management

**Document**
```prisma
model Document {
  id              String   @id @default(cuid())
  userId          String
  filename        String
  originalName    String
  fileType        String   // "pdf", "docx", "pptx"
  fileSize        BigInt
  language        String   @default("en")  // Response language
  storageKey      String   // R2 storage key or local path
  summary         String?  @db.Text  // AI-generated
  flashcards      Json?    // AI-generated array
  examQuestions   Json?    // AI-generated array
  createdAt       DateTime @default(now())
  
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  excerpts        DocumentExcerpt[]
  flashcardProgress FlashcardProgress[]
  examAttempts    ExamAttempt[]
  
  @@index([userId])
}
```

**DocumentExcerpt** (Cached extraction)
```prisma
model DocumentExcerpt {
  id           String   @id @default(cuid())
  documentId   String
  slideOrPage  Int      // Page/slide number
  excerptType  String   // "slide_text", "speaker_note", "image_flag"
  content      String   @db.Text
  charOffset   Int      @default(0)
  createdAt    DateTime @default(now())
  
  document     Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  
  @@index([documentId])
}
```

#### Learning Features

**FlashcardProgress**
```prisma
model FlashcardProgress {
  id           String   @id @default(cuid())
  userId       String
  documentId   String
  cardIndex    Int      // Index in flashcards array
  mastered     Boolean  @default(false)
  lastReviewed DateTime @default(now())
  
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  document     Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  
  @@unique([userId, documentId, cardIndex])
}
```

**ExamAttempt**
```prisma
model ExamAttempt {
  id             String   @id @default(cuid())
  userId         String
  documentId     String
  score          Int
  totalQuestions Int
  answers        Json     // User's answers
  completedAt    DateTime @default(now())
  
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  document       Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  
  @@index([userId])
  @@index([documentId])
}
```

#### Job Queue

**Job**
```prisma
model Job {
  id           String   @id @default(cuid())
  userId       String
  jobType      String   // "extract_document", "generate_exam", "generate_flashcards"
  status       String   @default("queued")  // "queued", "running", "succeeded", "failed"
  progressPct  Int      @default(0)
  retryCount   Int      @default(0)
  payload      Json     // Input data
  result       Json?    // Output data
  errorMessage String?  @db.Text
  createdAt    DateTime @default(now())
  startedAt    DateTime?
  completedAt  DateTime?
  
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  @@index([status])
}
```

#### Admin & Monitoring

**AuditLog**
```prisma
model AuditLog {
  id         String   @id @default(cuid())
  adminId    String
  action     String   // "CREATE_USER", "DELETE_USER", "BAN_USER", etc.
  targetId   String?  // ID of affected resource
  details    Json?    // Additional context
  ipAddress  String?
  createdAt  DateTime @default(now())
  
  @@index([adminId])
  @@index([action])
  @@index([createdAt])
}
```

**UsageEvent** (AI cost tracking - ready for implementation)
```prisma
model UsageEvent {
  id               String   @id @default(cuid())
  userId           String
  eventType        String   // "ai_generation", "document_upload", etc.
  featureKey       String   // "document_summary", "flashcards", "exam"
  aiModelUsed      String?  // "gpt-4o-mini"
  inputTokens      Int?
  outputTokens     Int?
  estimatedCostUsd Float?
  metadata         Json?
  createdAt        DateTime @default(now())
  
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  @@index([userId, createdAt])
  @@index([eventType, createdAt])
}
```

**UserLimit** (Quota management)
```prisma
model UserLimit {
  userId          String   @id
  dailyTokenCap   Int      @default(10000)
  dailyDocCap     Int      @default(10)
  tokensUsedToday Int      @default(0)
  docsUsedToday   Int      @default(0)
  lastResetDate   DateTime @default(now())
  overrideBy      String?  // Admin who set custom limit
}
```

### Prisma Usage Patterns

**Type-Safe Queries:**
```javascript
// Find user with documents
const user = await prisma.user.findUnique({
  where: { id: userId },
  include: {
    documents: {
      orderBy: { createdAt: 'desc' },
      take: 10
    }
  }
});

// Create document
const document = await prisma.document.create({
  data: {
    userId,
    filename,
    originalName,
    fileType,
    fileSize,
    language,
    storageKey
  }
});

// Upsert flashcard progress
await prisma.flashcardProgress.upsert({
  where: {
    userId_documentId_cardIndex: {
      userId,
      documentId,
      cardIndex
    }
  },
  update: { mastered, lastReviewed: new Date() },
  create: { userId, documentId, cardIndex, mastered }
});
```

**Transactions:**
```javascript
// Delete document and update storage atomically
await prisma.$transaction([
  prisma.document.delete({ where: { id: documentId } }),
  prisma.user.update({
    where: { id: userId },
    data: { storageUsed: { decrement: fileSize } }
  })
]);
```

---

## Authentication Flow

### Sign Up Flow

```
1. User fills form (email, password, name) → Frontend
   ↓
2. POST /api/auth/sign-up → Backend
   ↓
3. Better Auth validates input
   ↓
4. Hashes password (bcrypt)
   ↓
5. Creates User record (plan: "free", role: "user")
   ↓
6. Creates Account record (password)
   ↓
7. Creates Session record
   ↓
8. Sets HTTP-only cookie: better-auth.session_token
   ↓
9. Returns { user, session } → Frontend
   ↓
10. Frontend stores in $session store
```

### Sign In Flow

```
1. User submits credentials → Frontend
   ↓
2. POST /api/auth/sign-in → Backend
   ↓
3. Better Auth finds Account by email
   ↓
4. Compares password hash
   ↓
5. Creates new Session record
   ↓
6. Sets HTTP-only cookie: better-auth.session_token
   ↓
7. Updates User.lastActive
   ↓
8. Returns { user, session } → Frontend
   ↓
9. Frontend stores in $session store
```

### Authenticated Request Flow

```
1. Frontend makes request with credentials: 'include'
   ↓
2. Browser automatically includes session cookie
   ↓
3. Backend receives request → requireAuth middleware
   ↓
4. Extracts token from cookie
   ↓
5. Queries Session table by token
   ↓
6. Checks expiration (valid if not expired)
   ↓
7. Queries User by session.userId
   ↓
8. Checks ADMIN_EMAILS for auto-elevation
   ↓
9. Attaches req.session = { user, session }
   ↓
10. Updates User.lastActive
   ↓
11. Proceeds to route handler
```

### Admin Elevation

**Automatic:**
- Emails in `ADMIN_EMAILS` env var are auto-promoted
- Checked on every authenticated request
- Updates `user.role = 'admin'` in database

**Manual:**
- Admin can promote users via `PATCH /api/admin/users/:id`
- Sets `role: 'admin'` in User record

### Sign Out Flow

```
1. User clicks logout → Frontend
   ↓
2. POST /api/auth/sign-out → Backend
   ↓
3. Better Auth deletes Session record
   ↓
4. Clears session cookie
   ↓
5. Returns { success: true } → Frontend
   ↓
6. Frontend clears $session store
   ↓
7. Redirects to landing page
```

---

## Document Processing Flow

### Complete Upload & Processing Flow

```
1. User selects file (PDF/DOCX/PPTX) → Frontend
   ↓
2. User selects response language (en/ar)
   ↓
3. Frontend validates file type and size (<25MB)
   ↓
4. Check user quota (remainingDocuments > 0)
   ↓
5. XMLHttpRequest uploads with progress tracking
   ↓
6. POST /api/upload (multipart/form-data) → Backend
   ↓
7. Multer saves to /tmp/uploads temporarily
   ↓
8. Backend validates file type and user quota
   ↓
9. Upload to Cloudflare R2 (or local fallback)
   • Key: uploads/{userId}/{timestamp}-{filename}
   • Returns: storageKey
   ↓
10. Create Document record:
    • Status: Empty summary/flashcards/exams
    • storageKey saved
   ↓
11. Update User record:
    • documentsUsed++
    • storageUsed += fileSize
   ↓
12. Create Job record:
    • jobType: "extract_document"
    • status: "queued"
    • payload: { documentId, language }
   ↓
13. Return 202 Accepted with jobId → Frontend
   ↓
14. Frontend starts polling GET /api/jobs/:jobId every 2s
   ↓
15. Worker picks up job (separate process)
   ↓
16. Worker updates: status = "running", progressPct = 10
   ↓
17. Extract text based on file type:
   
   PDF:
   • Download from R2 to /tmp
   • Use pdf-parse library
   • Split by form feed (\f) for pages
   • Store each page as DocumentExcerpt
   
   DOCX:
   • Download from R2 to /tmp
   • Use mammoth library
   • Extract raw text
   • Chunk into ~500 char "pages"
   • Store each chunk as DocumentExcerpt
   
   PPTX:
   • Download from R2 to /tmp
   • Spawn Python subprocess: extract_pptx.py
   • Python uses python-pptx library
   • Extracts: slide text, speaker notes, image flags
   • Returns JSON
   • Parse and store as DocumentExcerpt records
   ↓
18. Worker updates: progressPct = 50
   ↓
19. [READY FOR IMPLEMENTATION] Generate with OpenAI:
   
   • Combine all DocumentExcerpt.content
   • Call OpenAI API (gpt-4o-mini):
     
     Summary:
     • Prompt: "Summarize this document in {language}"
     • Save to Document.summary
     
     Flashcards:
     • Prompt: "Create 10 study flashcards from this content"
     • Format: [{ front, back }]
     • Save to Document.flashcards
     
     Exam Questions:
     • Prompt: "Create 5 multiple-choice questions"
     • Format: [{ question, options, correctIndex }]
     • Save to Document.examQuestions
   
   • Track usage in UsageEvent table
   • Check UserLimit.dailyTokenCap
   ↓
20. Worker updates Document with AI-generated content
   ↓
21. Worker updates Job:
    • status = "succeeded"
    • progressPct = 100
    • result = { success: true }
   ↓
22. Frontend polling receives success
   ↓
23. Frontend navigates to /document/:id
   ↓
24. User views summary, flashcards, exam questions
```

### Error Handling

**If extraction fails:**
```
Worker catches error
   ↓
Increments job.retryCount
   ↓
If retryCount < 3:
  • Reset status to "queued"
  • Worker will retry later
Else:
  • Set status = "failed"
  • Set errorMessage
  • Frontend shows error to user
```

---

## AI Integration (Ready for Implementation)

### Current Status

✅ **Infrastructure Ready:**
- OpenAI API key configured (`OPENAI_API_KEY` env var)
- UsageEvent model for token/cost tracking
- UserLimit model for quota enforcement
- CostAnomalyAlert model for overspending detection
- Job queue supports generation job types

⏳ **Awaiting Implementation:**
- OpenAI API calls in worker.js
- Prompt engineering for summary, flashcards, exams
- Token usage tracking
- Cost calculation

### Planned Implementation

**Generate Summary:**
```javascript
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Combine excerpts
const fullText = excerpts.map(e => e.content).join('\n\n');

// Call OpenAI
const completion = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [
    {
      role: 'system',
      content: `You are a helpful study assistant. Summarize the following document in ${language}.`
    },
    {
      role: 'user',
      content: fullText
    }
  ],
  max_tokens: 500
});

const summary = completion.choices[0].message.content;

// Track usage
await prisma.usageEvent.create({
  data: {
    userId,
    eventType: 'ai_generation',
    featureKey: 'document_summary',
    aiModelUsed: 'gpt-4o-mini',
    inputTokens: completion.usage.prompt_tokens,
    outputTokens: completion.usage.completion_tokens,
    estimatedCostUsd: calculateCost(completion.usage)
  }
});

// Update document
await prisma.document.update({
  where: { id: documentId },
  data: { summary }
});
```

**Generate Flashcards:**
```javascript
const completion = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [
    {
      role: 'system',
      content: `Create 10 study flashcards from this document. 
                Return JSON array: [{ front: "question", back: "answer" }]`
    },
    {
      role: 'user',
      content: fullText
    }
  ],
  response_format: { type: "json_object" }
});

const flashcards = JSON.parse(completion.choices[0].message.content);

await prisma.document.update({
  where: { id: documentId },
  data: { flashcards }
});
```

**Cost Calculation:**
```javascript
// GPT-4o-mini pricing (as of 2024)
const COST_PER_1K_INPUT = 0.00015;   // $0.15 per 1M tokens
const COST_PER_1K_OUTPUT = 0.0006;   // $0.60 per 1M tokens

function calculateCost(usage) {
  const inputCost = (usage.prompt_tokens / 1000) * COST_PER_1K_INPUT;
  const outputCost = (usage.completion_tokens / 1000) * COST_PER_1K_OUTPUT;
  return inputCost + outputCost;
}
```

**Quota Enforcement:**
```javascript
// Before OpenAI call
const limit = await prisma.userLimit.findUnique({
  where: { userId }
});

if (limit && limit.tokensUsedToday >= limit.dailyTokenCap) {
  throw new Error('Daily token limit exceeded');
}

// After OpenAI call
await prisma.userLimit.update({
  where: { userId },
  data: {
    tokensUsedToday: {
      increment: completion.usage.total_tokens
    }
  }
});
```

---

## Storage Management

### Cloudflare R2 (S3-Compatible Storage)

**Configuration:**
```javascript
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  endpoint: process.env.R2_ENDPOINT,
  region: 'auto',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});
```

**Upload File:**
```javascript
async function uploadFile(localPath, userId, originalFilename, mimeType) {
  const key = `uploads/${userId}/${Date.now()}-${originalFilename}`;
  const fileBuffer = await fs.readFile(localPath);
  
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: mimeType
  }));
  
  return {
    key,
    url: `${process.env.R2_ENDPOINT}/${process.env.R2_BUCKET_NAME}/${key}`
  };
}
```

**Delete File:**
```javascript
async function deleteFile(key) {
  await s3Client.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key
  }));
}
```

**Fallback (Local Storage):**
- If R2 not configured, files stay in `/tmp/uploads`
- Not persistent across Railway restarts
- Only for development

**Storage Tracking:**
```javascript
// On upload
await prisma.user.update({
  where: { id: userId },
  data: {
    storageUsed: { increment: fileSize },
    documentsUsed: { increment: 1 }
  }
});

// On delete
await prisma.user.update({
  where: { id: userId },
  data: {
    storageUsed: { decrement: fileSize }
  }
});
```

**Backfill Script:**
```bash
# Recalculate storage usage from documents
node backfill-storage.js
```

---

## Deployment Flow

### Frontend Deployment (Vercel)

```
Developer commits and pushes to 'stage' branch
         ↓
Vercel detects push via GitHub webhook
         ↓
Vercel starts build process:
  • npm install
  • npm run build (vite build)
  • Outputs to dist/
         ↓
Vercel deploys static files to global CDN
         ↓
URL: my-ai-assistant-git-stage-[hash].vercel.app
         ↓
Environment Variables Applied:
  • VITE_API_BASE_URL → Staging backend URL
  • VITE_ENABLE_ARABIC_UI → false
         ↓
Deployment complete (typically 30-60 seconds)
         ↓
[Manual] When explicitly requested:
  Push to 'production' branch
         ↓
URL: my-ai-assistant.vercel.app
Environment: Production backend URL
```

**Vercel Configuration:**
- Auto-detects Vite project
- Serves `index.html` for all routes (SPA routing)
- HTTPS enabled by default
- Custom domains supported

### Backend Deployment (Railway)

```
Developer commits and pushes to 'stage' branch
         ↓
Railway detects push via GitHub webhook
         ↓
Railway starts build process using Dockerfile:
  
  FROM node:20-bullseye
  
  # Install system dependencies
  RUN apt-get update && apt-get install -y python3 python3-pip
  
  # Copy package files
  COPY package*.json ./
  COPY requirements.txt ./
  
  # Install Node.js dependencies
  RUN npm install
  
  # Install Python dependencies
  RUN pip3 install -r requirements.txt
  
  # Generate Prisma Client
  RUN npx prisma generate
  
  # Copy source code
  COPY . .
  
  # Expose port
  EXPOSE 3001
  
  # Start command
  CMD ["npm", "start"]
         ↓
Railway provisions container with PostgreSQL connection
         ↓
Container starts, runs: npm start
  • Executes: prisma db push --accept-data-loss
  • Syncs schema to database
  • Starts: node server.js
         ↓
URL: ai-assistant-backend-staging-[id].up.railway.app
         ↓
Environment Variables Applied:
  • DATABASE_URL → Staging PostgreSQL
  • BETTER_AUTH_SECRET
  • BETTER_AUTH_BASE_URL → Staging backend URL
  • ADMIN_EMAILS
  • OPENAI_API_KEY
  • R2_* (if configured)
  • PORT (auto-set by Railway)
         ↓
Separate Railway service runs worker:
  • Same Docker image
  • Command: node worker.js
  • Polls same database for jobs
         ↓
Deployment complete (typically 2-4 minutes)
         ↓
[Manual] When explicitly requested:
  Push to 'production' branch
         ↓
URL: ai-assistant-backend-production-[id].up.railway.app
Database: Production PostgreSQL (protected)
```

**Railway Configuration:**
- Auto-restarts on crash
- Health checks on `/api/health`
- Logs viewable in Railway dashboard
- Can scale horizontally (requires Redis for job queue)

### Database Migrations

**Development:**
```bash
# Make schema changes
npx prisma db push  # Syncs immediately (no migration file)
```

**Production:**
```bash
# Railway runs this on every deploy
prisma db push --accept-data-loss
```

**Note:** Using `db push` for simplicity. For production-grade migrations, use:
```bash
npx prisma migrate dev --name description
npx prisma migrate deploy  # In production
```

---

## Maintenance Rules

### When to Update This Document

✅ **Update when:**
- New API endpoints added or changed
- Authentication/authorization flow changes
- Database schema major changes (new models, relationships)
- New external services integrated (OpenAI, storage, etc.)
- Deployment process changes
- Architecture patterns change (e.g., adding Redis, message queue)
- Data flow changes significantly

❌ **Don't update for:**
- Minor bug fixes
- UI changes without backend impact
- Internal refactoring without API changes
- Adding individual routes that follow existing patterns

### Related Documentation

**Update `agent.md` when:**
- Git workflow changes
- Environment variables added/removed
- Code style standards evolve
- Development tools change

**Update `PROJECT_STRUCTURE.md` when:**
- New directories created
- Major folder reorganization
- New route files or major components added

### Keeping Docs Fresh

- Review quarterly for accuracy
- Update in same commit as architectural changes
- Ask for clarification if documentation is unclear
- Keep diagrams synchronized with implementation

---

## Quick Reference

### Key URLs

**Staging:**
- Frontend: `my-ai-assistant-git-stage-*.vercel.app`
- Backend: `ai-assistant-backend-staging.up.railway.app`

**Production:**
- Frontend: `my-ai-assistant.vercel.app`
- Backend: `ai-assistant-backend-production.up.railway.app`

### Key Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | Yes | PostgreSQL connection |
| `BETTER_AUTH_SECRET` | Yes | Session encryption |
| `BETTER_AUTH_BASE_URL` | Yes | Backend URL |
| `OPENAI_API_KEY` | Yes* | AI generation (*ready for impl) |
| `ADMIN_EMAILS` | No | Auto-admin emails |
| `R2_*` | No | Cloud storage (fallback: local) |
| `VITE_API_BASE_URL` | Yes | Backend API URL (frontend) |

### Key Commands

```bash
# Frontend
npm run dev          # Dev server (port 5173)
npm run build        # Production build

# Backend
npm start            # Server + DB push (port 3001)
npm run worker       # Job processor
npm run seed         # Create admin user
npx prisma studio    # Database GUI

# Database
npx prisma db push               # Sync schema
npx prisma generate              # Generate client
node backfill-storage.js         # Recalculate storage
```

---

**Last Updated**: March 2026
