# AI Assistant Backend - Agent Guidelines

## 1. Project Overview

**Application**: Backend API for the AI Study Assistant. Handles file processing (PDF, DOCX), database operations, and AI generation via OpenAI.
**Architecture**: REST API built with Express.js and Prisma ORM.
**Deployment Status**: ✅ Deployed on Railway (`https://ai-assistant-backend-production-ddf0.up.railway.app`)

| Component | Tech Stack |
|-----------|------------|
| **Runtime** | Node.js (v18+) |
| **Framework** | Express.js (v4.21+) |
| **Database** | PostgreSQL (managed via Prisma ORM) |
| **AI Integration** | OpenAI API (GPT-4o-mini) |
| **File Handling** | Multer (Uploads), pdf-parse, mammoth |

---

## 2. Build & Development Commands

### Setup & Run
*   **Install Dependencies**: `npm install`
*   **Start Server**: `npm start` (Runs `node server.js` on port 3001)
*   **Development**: `npm run dev` (Currently same as start, intended for nodemon if added)

### Database Management (Prisma)
*   **Sync Schema**: `npm run db:push`
    *   *Note*: Updates the database schema to match `prisma/schema.prisma`.
    *   *Warning*: Can result in data loss if schema changes are destructive.
*   **Database GUI**: `npm run db:studio`
    *   Opens a web interface to view and edit database records.
*   **Generate Client**: `npx prisma generate` (Run after schema changes)
*   **Backfill Storage Usage**: `node backfill-storage.js`
    *   Recalculates `storageUsed` per user from existing documents.

### Testing
*   **Current Status**: ❌ No testing framework configured.
*   **Recommended**: Use `jest` or `supertest` for future API tests.
*   **Single Test Pattern**: When tests are added, use `npm test -- test-file.js` for individual files.

### Linting & Formatting
*   **Current Status**: ❌ No linter or formatter configured.
*   **Recommended**: Add ESLint + Prettier with `npm i -D eslint prettier eslint-config-prettier`
*   **Standard Pattern**: StandardJS or Airbnb config for consistent code style.

---

## 3. Code Style Guidelines

### General JavaScript
*   **Type**: Use **ES Modules** (`import`/`export`) exclusively. Set `"type": "module"` in `package.json`.
*   **Variables**: Prefer `const`, use `let` only when reassignment is needed.
*   **Async**: Use `async`/`await` for all database and API calls.
*   **Paths**: Use `path` and `fileURLToPath` for file system operations to ensure cross-platform compatibility.

```javascript
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
```

### Import Ordering
1. External packages (express, cors, etc.)
2. Built-in Node modules (fs, path, etc.)
3. Internal modules (auth, middleware, routes)
4. Utility functions

### Naming Conventions
*   **Variables**: `camelCase` (e.g., `userId`, `fileName`)
*   **Constants**: `UPPER_SNAKE_CASE` (e.g., `MAX_FILE_SIZE`)
*   **Functions**: `camelCase` (e.g., `extractTextFromFile`)
*   **Files**: `kebab-case.js` (e.g., `documents.js`)

### Response Formatting
*   **Success**: `res.json({ data: ... })` or `res.json(object)`
*   **Error**: `res.status(code).json({ error: 'Description', details: 'Optional' })`
*   **HTTP Codes**: 200 (OK), 201 (Created), 400 (Bad Request), 403 (Forbidden), 404 (Not Found), 500 (Server Error)

### API Route Handlers
*   **Error Handling**: **MANDATORY** `try/catch` blocks in every async route.
*   **Validation**: Validate inputs (req.body, req.file, req.params) before processing.
*   **Return Early**: Use guard clauses for error cases to reduce nesting.

```javascript
app.post('/api/resource', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing ID' });

    const result = await prisma.resource.create({ data: { id } });
    res.json(result);
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
```

### Database Interactions
*   **Prisma**: Use the global `prisma` client instance.
*   **Schema**: Define models in `prisma/schema.prisma`.
*   **Relations**: Use relation fields (e.g., `user User @relation(...)`) to maintain referential integrity.
*   **Transactions**: Use `$transaction` for multi-operation updates.

### File Organization
*   **routes/**: Route handlers grouped by resource (documents.js, users.js, etc.)
*   **middleware/**: Authentication, authorization, validation
*   **utils/**: Shared utility functions (limits.js, etc.)
*   **uploads/**: Temporary storage for uploaded files (clean up after processing)

### Logging
*   **Info**: Use for startup, successful operations
*   **Errors**: Use `console.error()` with full error details including stack traces
*   **Requests**: Log important request details (userId, fileName, fileSize)

---

## 4. Agent Operational Rules

1.  **Environment Variables**:
    *   NEVER commit `.env` files.
    *   Required variables: `DATABASE_URL`, `OPENAI_API_KEY`, `PORT`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_BASE_URL`.
2.  **File System**:
    *   Use absolute paths with `path.join()`.
    *   Clean up uploaded files in `uploads/` after processing.
3.  **No Hallucinations**:
    *   Do not invent scripts like `npm test` if they are not in `package.json`.
    *   Do not import non-existent libraries.
4.  **Refactoring**:
    *   If refactoring `server.js` into multiple files (e.g., `routes/`, `controllers/`), ensure `app.js` or `server.js` remains the entry point.
5.  **Admin & Security**:
    *   All `/api/admin/*` endpoints must enforce admin role.
    *   All non-auth routes must enforce `requireAuth` and ownership checks.
    *   Validate all inputs to prevent injection attacks.

---

## 5. Deployment Notes

*   **Port**: defaults to `3001` unless `process.env.PORT` is set (Railway sets this automatically).
*   **CORS**: Configured to allow requests from frontend.
*   **Database**: Ensure `DATABASE_URL` is a valid PostgreSQL connection string (Provided by Railway).
*   **OpenAI**:
    *   `OPENAI_API_KEY` must be set in the deployment environment variables.
    *   The server logs "OPENAI_API_KEY exists: true/false" and its length on startup for debugging purposes.
*   **Authentication (Better Auth)**:
    *   `BETTER_AUTH_SECRET`: A long random string (e.g., generate with `openssl rand -hex 32`). **REQUIRED** for production.
    *   `BETTER_AUTH_BASE_URL`: The full URL of your backend (e.g., `https://your-app.up.railway.app`). **REQUIRED** for callbacks to work.

---

## 6. Git Guidelines

### .gitignore Essentials
```
.env
.env.local
.env.*.local
node_modules/
uploads/*
!uploads/.gitkeep
*.log
.DS_Store
.vscode/
.idea/
```

### Commit Messages
*   Use present tense: "Add feature" not "Added feature"
*   Use imperative mood: "Move cursor to..." not "Moves cursor to..."
*   Limit first line to 72 characters
*   Reference issues when applicable: "Fix #123 - resolve upload timeout"
