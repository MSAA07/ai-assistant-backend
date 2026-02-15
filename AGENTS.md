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

### Testing
*   **Current Status**: ❌ No testing framework configured.
*   **Recommended**: Use `jest` or `supertest` for future API tests.

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

### API Route Handlers
*   **Error Handling**: **MANDATORY** `try/catch` blocks in every async route.
*   **Responses**:
    *   Success: `res.json({ data: ... })` or `res.json(object)`
    *   Error: `res.status(500).json({ error: 'Description' })`
*   **Validation**: Validate inputs (req.body, req.file) before processing.

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

---

## 4. Agent Operational Rules

1.  **Environment Variables**:
    *   NEVER commit `.env` files.
    *   Required variables: `DATABASE_URL`, `OPENAI_API_KEY`, `PORT`.
2.  **File System**:
    *   Use absolute paths.
    *   Clean up uploaded files in `uploads/` after processing (if applicable).
3.  **No Hallucinations**:
    *   Do not invent scripts like `npm test` if they are not in `package.json`.
    *   Do not import non-existent libraries.
4.  **Refactoring**:
    *   If refactoring `server.js` into multiple files (e.g., `routes/`, `controllers/`), ensure `app.js` or `server.js` remains the entry point.

---

## 5. Deployment Notes

*   **Port**: defaults to `3001` unless `process.env.PORT` is set (Railway sets this automatically).
*   **CORS**: Configured to allow requests from frontend.
*   **Database**: Ensure `DATABASE_URL` is a valid PostgreSQL connection string (Provided by Railway).
