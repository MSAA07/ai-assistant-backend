# BACKEND AUDIT REPORT

**Summary:** 50 files audited, 6 major issue categories found across duplicate logic, debug logs, and organization opportunities

---

## Category: Duplicate Logic

| Description | File A | File B | Recommendation |
|---|---|---|---|
| `normalizePositiveInteger()` - Same validation function | routes/exams.js (line 7) | routes/flashcards.js (line 7) | Extract to utils/validation.js |
| `normalizePositiveInteger()` continuation | routes/documents.js (line 120) | routes/exports.js (line 9) | Extract to utils/validation.js |
| `getOwnedDocument()` - Same authorization check | routes/exams.js (line 119) | routes/flashcards.js (line 20) | Extract to utils/authorization.js |
| `getOwnedExamRecord()` - Same authorization check | routes/exams.js (line 136) | routes/exports.js (line 18) | Extract to utils/authorization.js |

**Impact:** 150+ lines of code duplicated across 4 route files. Same logic patterns repeated makes maintenance harder and increases risk of inconsistent behavior.

**Risk if not fixed:** Medium - Code drift if one is updated but others aren't

---

## Category: Debug Console Logs

| File | Line | Content | Sensitive? | Recommendation |
|---|---|---|---|---|
| server.js | 29-30 | `console.log('OPENAI_API_KEY exists:', !!process.env.OPENAI_API_KEY)` + length | No, but debug-like | Remove - this is clearly development debugging |
| routes/documents.js | 276-278 | `console.log("Upload request received:", {userId, fileName, fileType})` | **YES** | Remove or sanitize - logs `userId` and `fileName` to console |
| routes/documents.js | 401 | `console.error(error.stack)` | Maybe | Consider - may leak file paths in error stacks |
| routes/documents.js | 399 | `console.error("Upload error:", error)` | No | Acceptable - error logging is standard |

**Note:** Most `console.error` statements in routes (30+ occurrences) are legitimate error logging and should remain. These are accompanied by `captureSentryException()` calls, which is correct practice.

**Risk if not addressed:** Low-Medium - Potential information disclosure in logs (userId, filenames in production)

---

## Category: Potentially Unused Exports

| Export | File | Usage | Status |
|---|---|---|---|
| `normalizeGenerationStatus()` | utils/documentGeneration.js | Only used within same file (line 380) | **Borderline** - Exported but not imported elsewhere |
| `normalizeStudyMaterials()` | utils/documentStatus.js | Only used within same file (line 81) | **Borderline** - Exported but not imported elsewhere |
| `isUsableExcerpt()` | utils/documentStatus.js | Only used within same file (line 54) | **Borderline** - Exported but not imported elsewhere |
| `getDocumentExcerptCount()` | utils/documentStatus.js | Only used within same file (line 32) | **Borderline** - Exported but not imported elsewhere |

**Analysis:** These are exported but not imported by any other file. However, they may be part of a public API contract or used by code outside this repo (frontend). Risk is LOW if they're intentional exports.

**Risk if removed:** Low-Medium - Only breaks if external code imports them

---

## Category: One-Time Use Scripts

| File | Purpose | Already Run? | Safe to Archive? |
|---|---|---|---|
| backfill-storage.js | Migrates storageUsed field for all users | Likely - targets BigInt field | **Yes** - Can be archived with date comment |
| reset-db.js | Clears all data for testing | On-demand | **Yes** - Development helper, not critical |
| scripts/backfill-phase2-canonical.js | Migrates legacy flashcards/exams to new schema | Maybe - migration state unknown | **Conditional** - Archive only after confirming all production data migrated |

**Recommendation:** Keep scripts in codebase but document run status in each file (e.g., `// Ran: 2024-06, Status: complete`)

**Risk if deleted:** Medium - Cannot re-run if needed for recovery

---

## Category: Test Files Without Test Runner

| File | Lines | Status |
|---|---|---|
| utils/authCallbackUrls.test.js | 157 | **Not executed** - No test script in package.json |
| utils/authRateLimit.test.js | 186 | **Not executed** - No test script in package.json |
| utils/filenames.test.js | 157 | **Not executed** - No test script in package.json |
| utils/frontendOrigins.test.js | 93 | **Not executed** - No test script in package.json |

**Observation:** Tests are written but package.json has no `"test"` script. Tests are never run in CI/CD.

**Risk if not addressed:** Medium - Tests exist for critical auth/validation but aren't enforced

---

## Category: Large Files to Consider Splitting

| File | Line count | Suggested Split | Priority |
|---|---|---|---|
| routes/admin.js | 1473 | Split by feature: users (400L), usage-analytics (300L), feature-flags (400L), audit-logs (200L) | Low |
| routes/documents.js | 737 | Split by feature: upload (250L), generation (250L), display (150L) | Low |
| utils/phase2Backfill.js | 677 | Split by entity: flashcards (250L), exams (250L), progress (100L) | Low |
| routes/exams.js | 572 | Split by feature: records (200L), attempts (200L), submission (172L) | Low |

**Note:** These are large but not problematic yet. Pre-launch staging phase makes splitting lower priority. Revisit when codebase grows past 15k lines.

**Risk of not splitting:** Low (but increases with future growth)

---

## Category: Environment Variables Check

All 18 environment variables in `.env.example` are accounted for:
- Directly used in code: DATABASE_URL, OPENAI_API_KEY, R2_ENDPOINT, SENTRY_DSN, etc.
- Used by libraries: BETTER_AUTH_SECRET, AUTH_CHALLENGE_REQUIRE_*, AUTH_RATE_LIMIT_*
- No unused environment variables found

**Status:** ✓ Clean

---

## Category: Commented-Out Code

Scanned all 50 files for commented-out code blocks. **Result: NONE FOUND**

Only found:
- Inline explanatory comments (appropriate)
- JSDoc-style documentation comments (appropriate)
- One comment explaining in-memory cache strategy (appropriate)

**Status:** ✓ Clean

---

## Category: No Actual Dead Routes

All 7 route creators exported from routes/ are mounted in server.js:
- ✓ createUserRouter() → /api/user
- ✓ createDocumentsRouter() → /api
- ✓ createFlashcardsRouter() → /api/flashcard
- ✓ createExamsRouter() → /api/exam
- ✓ createFlashcardSetsRouter() → /api
- ✓ createCanonicalExamsRouter() → /api
- ✓ createExportsRouter() → /api/exports
- ✓ createJobsRouter() → /api/jobs
- ✓ createAdminRouter() → /api/admin

**Status:** ✓ All routes are mounted and live

---

## PRIORITY ORDER

### 🔴 Safe Quick Wins (Delete with Confidence)

1. **Remove debug logs in server.js (lines 29-30)** - 2 lines, no dependencies
   - These are clearly marked as "Debugging for Railway deployment"
   
2. **Remove file logging in routes/documents.js (lines 276-278)** - 3 lines, logs sensitive userId/fileName
   - Replace with generic "Upload request received" if needed, without sensitive details

### 🟡 Needs Decision Before Touching

1. **Extract duplicate `normalizePositiveInteger()` to utils/** 
   - Requires: Creating new utils/validation.js, updating 4 import statements
   - Risk: Low if tested properly
   
2. **Extract duplicate `getOwnedDocument()` to utils/**
   - Requires: Creating new utils/authorization.js, updating 2 imports
   - Risk: Low, utility is very straightforward
   
3. **Extract duplicate `getOwnedExamRecord()` to utils/**
   - Requires: Creating new utils/authorization.js, updating 2 imports
   - Risk: Low, utility is very straightforward

4. **Remove unused exports from utils/documentStatus.js**
   - Confirm these aren't part of public API first
   - Risk: Medium if external code depends on them

5. **Add test script to package.json and enable test running**
   - Requires: Choosing test runner (Jest/Vitest), adding npm script
   - Risk: Low, but requires CI/CD setup decision

### 🟢 Nice to Have (Lower Priority)

1. **Organize one-time scripts**
   - Move backfill-storage.js and reset-db.js to scripts/ folder with README explaining each
   - Add date comment: `// Completed: [date], Status: [status]`
   - Risk: Very low, cosmetic

2. **Split routes/admin.js into multiple files** (1473 lines)
   - Can wait until post-launch or when team grows
   - Risk: Low

3. **Add structured logging** (not just console.error)
   - Consider adding Winston or Pino logger
   - Risk: Medium (requires infrastructure change)

---

## ESTIMATED SAVINGS

### Lines of Code
- **Immediate**: 5-10 lines (remove debug logs)
- **With duplicate extraction**: 150+ lines eliminated
- **Total potential cleanup**: 155+ lines

### Files
- **Potential consolidations**: 2-3 new utility files created, but no files deleted
- **Archiving scripts**: 2 files moved to archive (not deleted)

### Maintenance Burden
- **Reduced**: 4 places to update auth logic → 1 place
- **Reduced**: 4 places to update validation → 1 place
- **Improved**: Centralized ownership of critical logic

---

## RECOMMENDATIONS BY TIMELINE

### Week 1 (Immediate)
- [ ] Remove lines 29-30 from server.js
- [ ] Sanitize/remove logging in routes/documents.js line 276-278
- [ ] Add 1-line decision on exported utility functions (keep or remove)

### Week 2-3 (Before Beta Launch)
- [ ] Create utils/validation.js with `normalizePositiveInteger()`
- [ ] Create utils/authorization.js with document/exam ownership checks
- [ ] Update imports in 4 route files
- [ ] Add test script to package.json if planning to enforce tests

### Month 2+ (Post-Launch Cleanup)
- [ ] Organize one-time scripts with status documentation
- [ ] Consider splitting admin.js if team grows
- [ ] Evaluate adding structured logging framework

---

## NOTES FOR IMPLEMENTATION

1. **No data risks**: None of these changes affect database, schema, or user data
2. **No breaking changes**: If done correctly, users won't notice
3. **Test coverage**: 4 test files exist and should catch regressions if enabled
4. **Backwards compatibility**: No API consumers to worry about (internal only)

---

**Report Generated:** 2026-06-07  
**Audit Status:** PLANNING PHASE - No changes made yet  
**Ready for Review:** Yes
