# LMS Literasi Syariah — Backend Developer Guide

This guide is written for backend developers maintaining or extending the `lms-be-firebase` repository. It focuses on the internal architecture — how the request pipeline is assembled, why middleware is ordered the way it is, how the gamification system is wired, and where the known traps are. If you are a frontend developer looking for how to call the API, see `FRONTEND_API_GUIDE.md` instead.

**Runtime:** Firebase Cloud Functions v2, Node.js 20, Express 5  
**Database:** Firestore via Admin SDK  
**Storage:** Google Cloud Storage via Admin SDK  
**Auth:** Firebase Authentication with custom claims  
**Backend version:** v3.0 (Phases 1–3 complete)

---

## Table of Contents

- [Project Layout](#project-layout)
- [How the App Boots](#how-the-app-boots)
- [The Request Pipeline](#the-request-pipeline)
- [Middleware Reference](#middleware-reference)
- [Route Architecture](#route-architecture)
- [Data Model](#data-model)
- [Gamification Internals](#gamification-internals)
- [Environment Variables](#environment-variables)
- [Response Utilities](#response-utilities)
- [Running Locally](#running-locally)
- [Known Issues and Technical Debt](#known-issues-and-technical-debt)
- [Adding a New Endpoint — Checklist](#adding-a-new-endpoint--checklist)

---

## Project Layout

```
lms-be-firebase/
├── functions/
│   ├── src/
│   │   ├── index.ts                  # Entrypoint — app setup and router mounting
│   │   ├── firebaseAdmin.ts          # Admin SDK init and Firestore utilities
│   │   ├── middleware/
│   │   │   ├── verifyToken.ts        # Firebase ID token verification
│   │   │   ├── requireRole.ts        # Role-based route guard
│   │   │   └── checkEnrollment.ts    # Enrollment gate for course-scoped routes
│   │   ├── routes/
│   │   │   ├── auth.ts
│   │   │   ├── users.ts
│   │   │   ├── courses.ts
│   │   │   ├── chapters.ts
│   │   │   ├── quizzes.ts
│   │   │   ├── enrollments.ts
│   │   │   ├── progress.ts
│   │   │   ├── storage.ts
│   │   │   └── leaderboard.ts
│   │   └── utils/
│   │       ├── response.ts           # success() and error() envelope helpers
│   │       └── badges.ts             # checkAndAwardBadges utility
│   ├── scripts/
│   │   ├── seedQuiz.mjs              # Seed a test quiz into a course
│   │   └── test-badges.mjs           # Standalone badge logic tests
│   ├── lib/                          # Compiled TypeScript output — do not edit
│   └── package.json
└── .env                              # Local environment variables (not committed)
```

The only directory you should ever edit is `functions/src/`. The `functions/lib/` directory is the compiled output produced by `npm run build` — the Firebase emulator and production deployment both run from `lib/`, not `src/`. This is the most common source of confusion when a code change appears to have no effect: you edited `src/` but forgot to rebuild `lib/`.

---

## How the App Boots

The entrypoint is `functions/src/index.ts`. The boot sequence works as follows. First, `firebaseAdmin.ts` is imported, which initializes the Firebase Admin SDK using environment variables if they are present, or falls back to Application Default Credentials (ADC). The Admin SDK must be initialized before any route handler runs — this happens at module load time, not at request time, so initialization errors will appear in the cold-start log rather than in individual request logs.

After the Admin SDK is ready, an Express app is created with the following global middleware applied in order: CORS (using the `CORS_ORIGIN` environment variable as an allowlist), and `express.json()` for body parsing. The global middleware runs before any route-specific middleware — this matters because body parsing must happen before any route handler attempts to read `req.body`.

Routes are then mounted under the `/v1` prefix. The order of mounting does not affect routing correctness since each mount path is distinct, but it does affect the order in which Express searches for a matching route, which has a negligible performance implication at MVP scale. Finally, the Express app is exported as a Firebase Cloud Function using `onRequest` with `maxInstances: 10`.

```
App boot order:
1. Firebase Admin SDK initialized (module load)
2. Express app created
3. Global middleware: CORS, JSON body parser
4. Routes mounted under /v1
5. Exported as Firebase Cloud Function (onRequest)
```

---

## The Request Pipeline

Understanding how a request flows through the system before reaching a route handler is essential for debugging middleware-related issues. Every request passes through the following stages in order.

```
Incoming request
      │
      ▼
 Global middleware
 (CORS + JSON parser)          ← Applied to all routes
      │
      ▼
 Router middleware              ← e.g. router.use(verifyToken) on the users router
      │
      ▼
 Route-specific middleware      ← e.g. checkEnrollment, requireRole on individual routes
      │
      ▼
 Route handler                  ← The async function that reads req, calls Firestore, sends res
      │
      ▼
 Response sent
```

The key insight is that middleware is applied in registration order and each piece of middleware either calls `next()` to continue the chain or calls `res.json()` to short-circuit and end the request. If a middleware short-circuits (for example, `verifyToken` returns `401` because the token is invalid), none of the subsequent middleware or the route handler runs. This is why middleware order matters — placing `checkEnrollment` before `requireRole` on a route would mean enrolled users without the right role get through the enrollment check before being rejected, which is the wrong order.

---

## Middleware Reference

### `verifyToken`

**Location:** `src/middleware/verifyToken.ts`

This middleware is the foundation of the entire auth system. It reads the `Authorization: Bearer <token>` header, verifies the token using `adminAuth.verifyIdToken()`, and populates `req.user` with `{ uid, email, role }`. Role resolution happens in the following order: first it checks the token's custom claims for a `role` field, then falls back to reading `users/{uid}.role` from Firestore, then defaults to `student` if neither is found. The Firestore fallback exists to handle the window between when a user's role is updated in Firestore and when they receive a new token with the updated custom claim.

If the token is missing or verification fails, the middleware sends a `401` response and the request goes no further.

**Used by:** Most routes. Applied at the router level for admin-only route groups, or at the individual route level for mixed-auth route groups.

### `optionalAuth`

**Location:** `src/middleware/verifyToken.ts` (exported separately)

Behaves identically to `verifyToken` except it never blocks the request on failure. If a token is present and valid, `req.user` is populated. If the token is absent or invalid, `req.user` remains undefined and the request continues. Used on routes that have role-sensitive behavior but also need to serve unauthenticated requests — specifically `GET /courses` and `GET /courses/:courseId`, which return published-only content to anonymous users and all content to admins.

### `requireRole`

**Location:** `src/middleware/requireRole.ts`

Takes a role string as an argument and returns a middleware function. It requires `verifyToken` to have already run (it reads `req.user`). If `req.user` is undefined (unauthenticated), it sends `401`. If `req.user.role` does not match the required role, it sends `403`. Note that the current implementation checks for an exact role match — there is no role hierarchy (admin is not treated as a superset of instructor). If you need a route accessible to both admin and instructor, you would need to extend this middleware or add a second role check.

**Used by:** Admin-only routes, either as `router.use(requireRole('admin'))` at the router level or as a per-route argument.

### `checkEnrollment`

**Location:** `src/middleware/checkEnrollment.ts`

Verifies that the authenticated user is enrolled in the course identified by `req.params.courseId`. It requires `verifyToken` to have already run. Admin users bypass this check entirely — the middleware checks `req.user.role === 'admin'` and calls `next()` immediately if true. For non-admin users, it queries the `enrollments` collection for a document matching `{ userId: req.user.uid, courseId: req.params.courseId }`. If no matching document is found, it sends `403`.

**Critical dependency:** This middleware reads `courseId` from `req.params.courseId`. It only works correctly on routes where the Express router has `mergeParams: true` set, because chapter and quiz routes are sub-routers mounted under `/courses/:courseId/...` — without `mergeParams: true`, `req.params.courseId` would be undefined in the child router. All course-scoped routers in this codebase already set `mergeParams: true`.

**Used by:** Chapter GET routes, quiz GET routes, quiz submit route, and progress POST route.

---

## Route Architecture

Each route file exports an Express `Router` instance. Routers are mounted in `index.ts`. Routes that are nested under a course path use `Router({ mergeParams: true })` to inherit the `:courseId` param from the parent router.

The mounting tree in `index.ts` looks like this:

```
/health                           → inline handler in index.ts
/v1/auth                          → routes/auth.ts
/v1/users                         → routes/users.ts       (router.use(verifyToken, requireRole('admin')))
/v1/courses                       → routes/courses.ts
/v1/courses/:courseId/chapters    → routes/chapters.ts    (mergeParams: true)
/v1/courses/:courseId/quizzes     → routes/quizzes.ts     (mergeParams: true)
/v1/enrollments                   → routes/enrollments.ts (router.use(verifyToken))
/v1/courses/:courseId/progress    → routes/progress.ts    (mergeParams: true, router.use(verifyToken))
/v1/storage                       → routes/storage.ts     (router.use(verifyToken))
/v1/leaderboard                   → routes/leaderboard.ts
```

An important detail about the users router: it applies `verifyToken` and `requireRole('admin')` at the router level using `router.use(...)`. This means every route registered on that router — including routes added in the future — is automatically admin-protected without needing to specify it per route. This is the right pattern for route groups where every endpoint shares the same access requirements. For route groups with mixed access (like quizzes, where GET is enrolled-student and POST is admin), the middleware is applied per route instead.

### Route file conventions

Each route file follows the same internal structure. The router is created at the top, router-level middleware is applied with `router.use()` immediately after, then individual route handlers are defined, and the router is exported as default at the bottom. Route handlers are all `async` functions. Error handling is done with a `try/catch` block in every handler — the catch block logs structured context and sends a `500` response. Errors are never re-thrown from route handlers.

---

## Data Model

All collections are at the Firestore root level except chapters and quizzes, which are subcollections under their parent course document.

**`users/{uid}`** — One document per Firebase Auth user. The `totalPoints` field is the single source of truth for a user's accumulated points. It is only ever written using `FieldValue.increment()` from within route handlers — never using a read-modify-write pattern. The `badges` field is an array of strings. `isActive` is set to `false` on soft-delete and is never truly deleted.

**`courses/{courseId}`** — Top-level course documents. `isPublished` controls visibility for non-admin users at the API layer.

**`courses/{courseId}/chapters/{chapterId}`** — Subcollection under each course. The `order` field is an integer used for sorted retrieval. The `isPublished` field on chapters is persisted by the backend but is not currently used for server-side filtering — the frontend is responsible for filtering unpublished chapters from the display.

**`courses/{courseId}/quizzes/{quizId}`** — Subcollection under each course. Questions are stored as an array of objects with this shape in Firestore: `{ questionText, correctAnswerIndex, options[], type, points, correctAnswerText }`. The `correctAnswerIndex` is a zero-based integer pointing to the correct option. The student-facing GET response strips `correctAnswerIndex` and renames `questionText` to `question`.

**`enrollments/{enrollmentId}`** — Each document represents one user-course enrollment pair. The document ID is auto-generated. Documents have `userId`, `courseId`, and `enrolledAt`.

**`progress/{uid_courseId}`** — The document ID is a composite key in the format `{uid}_{courseId}`. This makes progress lookups a single document read rather than a query, which is more efficient and predictable. The `completedChapters` field is an array of chapter ID strings.

**`quiz_results/{resultId}`** — Auto-generated document ID. Stores the full result of a single quiz submission including `pointsAwarded`. Note: the collection name is `quiz_results` (snake_case). Historical documentation and Firestore security rules may reference `quizResults` (camelCase) — those references are stale and need to be updated.

---

## Gamification Internals

The gamification system consists of two parts: atomic point writes inside route handlers, and a shared badge utility called after every point write.

### Point writes

Points are written using `FieldValue.increment(n)` which is an atomic server-side operation. It does not require reading the current value first, which means concurrent requests from the same user cannot cause a race condition that results in lost points. The two places where points are awarded are the chapter completion handler in `progress.ts` and the quiz submit handler in `quizzes.ts`. In both cases, the `set(..., { merge: true })` pattern is used rather than `update()` so that a missing `totalPoints` field (e.g. on a brand new user document) is handled gracefully — Firestore treats `increment` on a missing field as starting from zero.

The chapter completion handler has one additional concern: it must only award points on the first completion of each chapter. It handles this by reading the progress document before the Firestore write, capturing the pre-update `completedChapters` array, and checking whether `chapterId` is already present. The `isNewCompletion` boolean is determined from this pre-update snapshot — if you read it after the update, the chapter will always appear to be already present, and points will never be awarded. This is a subtle but critical ordering constraint.

### Badge utility — `src/utils/badges.ts`

The `checkAndAwardBadges(uid, db, event)` function is called after every point write. It takes three arguments: the user's UID, the Firestore admin instance, and an event descriptor that is either `{ type: 'quiz_submit', correctCount, totalQuestions }` or `{ type: 'points_update' }`. It returns an array of newly awarded badge strings.

Internally, the function reads the user's current `badges` array from Firestore, determines which badges should be awarded based on the event and the current leaderboard state, filters out any badges already present (idempotency), writes the updated array back to Firestore only if there are new badges to add, and returns the newly awarded badges. The function never writes to Firestore when there is nothing new to add — this avoids unnecessary writes on the hot path.

The `top_3` check makes a Firestore query: `users` collection ordered by `totalPoints` descending, limited to 3. If the current user's UID appears in those 3 results, the badge is eligible. This is a 3-document read on every point-awarding action. It is acceptable at MVP scale. One known gap: this query does not filter `isActive=true`, meaning a soft-deleted user who still has high `totalPoints` in Firestore can occupy a top-3 slot and push an active user out of badge eligibility. The leaderboard endpoint does filter by `isActive` — this inconsistency is a known issue to fix in a future iteration.

```
checkAndAwardBadges call flow:
1. Read users/{uid}.badges from Firestore
2. If event is quiz_submit and correctCount === totalQuestions → eligible for perfect_score
3. Query top 3 users by totalPoints → check if uid appears → eligible for top_3
4. Filter eligible badges against existing badges (remove already-earned ones)
5. If any new badges remain:
   a. Write updated badges array to users/{uid}
   b. Return new badges
6. If no new badges: return []
```

---

## Environment Variables

| Variable | Required | Notes |
|---|---|---|
| `PROJECT_ID` | Yes (explicit init) | Firebase project ID. |
| `CLIENT_EMAIL` | Yes (explicit init) | Service account email. |
| `PRIVATE_KEY` | Yes (explicit init) | Service account private key. Newline-escaped — the code calls `.replace(/\\n/g, '\n')` during init. |
| `STORAGE_BUCKET` | Yes (for storage routes) | GCS bucket name without `gs://` prefix. |
| `CORS_ORIGIN` | No | Comma-separated list of allowed origins. Defaults to `http://localhost:3000`. |

If all four Admin SDK variables are present, the SDK initializes with explicit service account credentials. If any are missing, it falls back to ADC. For local development with the Firebase emulator, ADC works automatically — you do not need to provide the service account variables. For production deployment, always use explicit credentials via environment config.

**Do not use the old variable names** `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, or `FIREBASE_STORAGE_BUCKET` — they are no longer read by the code. Using them will silently fall through to ADC without an error, which can be confusing in production.

---

## Response Utilities

`src/utils/response.ts` exports two helper functions that every route handler uses.

`success(data)` returns `{ success: true, data }`. `error(code, message)` returns `{ success: false, error: { code, message } }`. Always use these helpers rather than constructing the envelope manually — it ensures consistency across all endpoints and makes it easier to change the envelope shape in the future by editing one file.

---

## Running Locally

```bash
# Install dependencies
cd functions && npm install

# Build TypeScript
npm run build

# Start Firebase emulator (from project root)
firebase emulators:start
```

The emulator runs the Functions service on `http://127.0.0.1:5001`. After any code change, you must rebuild with `npm run build` before the emulator picks up the change. The emulator does not watch `src/` for changes — it serves from `lib/` which is the compiled output. If you change a file and the behavior does not change, the first thing to check is whether you forgot to rebuild.

**Running the badge tests manually:**

```bash
npm run build && node scripts/test-badges.mjs
```

This script is not wired into `npm test` yet — it must be run manually.

**Seeding a test quiz:**

```bash
# Set COURSE_ID in .env or pass inline
COURSE_ID=your_course_id node scripts/seedQuiz.mjs
```

If `COURSE_ID` is not set, the script falls back to a hardcoded default value. Always set `COURSE_ID` explicitly to avoid accidentally seeding into the wrong course.

---

## Known Issues and Technical Debt

These are issues in the current implementation that the next developer to touch the codebase should be aware of. They are ordered by production risk, not by effort to fix.

**Missing Firestore composite index for leaderboard.** The `GET /leaderboard` handler queries `users` with `where('isActive', '==', true)` combined with `orderBy('totalPoints', 'desc')`. This requires a composite index that is not currently present in `firestore.indexes.json`. The query works in the local emulator (which does not enforce index requirements) but will fail in production with a Firestore error. This must be created and deployed before any production launch.

**Firestore security rules use stale collection name.** The rules file references `quizResults` (camelCase). The route now writes to `quiz_results` (snake_case). Any client-side Firestore access to `quiz_results` will be denied until the rules are updated. Since the current frontend uses the backend API exclusively and does not query Firestore directly, this is not currently causing visible failures — but it is a trap waiting for the next developer who tries to add a client-side Firestore listener.

**Quiz question schema drift between admin write and student read.** Questions are stored in Firestore with `questionText` as the field name for question text. The admin create/update interface models the field as `question` in the TypeScript `QuizQuestion` interface. The student normalization function correctly reads `questionText` from the stored document. However, if an admin client submits a question object using `question` instead of `questionText`, the data is stored with the wrong field name and students will see blank questions. The TypeScript interface and the stored schema are out of sync, and there is no runtime validation that catches this mismatch.

**Non-transactional duplicate enrollment check.** The `POST /enrollments` handler checks for duplicate enrollments using a query followed by a write. Two concurrent enrollment requests for the same user-course pair can both pass the duplicate check before either write completes, resulting in two enrollment documents. At MVP scale this is unlikely, but it is worth fixing with a Firestore transaction before any high-traffic promotion.

**`top_3` badge query does not filter inactive users.** The `checkAndAwardBadges` utility queries users by `totalPoints` without filtering `isActive=true`. An inactive (soft-deleted) user with a high point total can occupy a top-3 slot and prevent an active user from earning the `top_3` badge, even though the inactive user does not appear on the visible leaderboard. The fix is to add `.where('isActive', '==', true)` to the query in `badges.ts` — but be aware this will also require the same composite index as the leaderboard query.

**Progress GET is not enrollment-gated.** `GET /courses/:courseId/progress` applies `verifyToken` but not `checkEnrollment`. Any authenticated user can read the progress of any course, whether or not they are enrolled. This may be intentional — reading progress for an unenrolled course is harmless since there will be nothing there — but it is inconsistent with the chapter and quiz GET routes which do enforce enrollment. A product decision should be made and documented either way.

**Storage download path override is broad.** `GET /storage/download-url/:fileId` accepts a `?path=` query parameter that, if provided, overrides the `:fileId` param and signs any existing GCS path for any authenticated user. There is no ownership check or path boundary policy. Any authenticated user can obtain a signed read URL for any object in the bucket if they know the path.

---

## Adding a New Endpoint — Checklist

When adding a new endpoint to the backend, work through this checklist to avoid common oversights.

Decide which route file it belongs in, or create a new route file and mount it in `index.ts`. Apply the correct middleware — use `verifyToken` for all authenticated routes, add `requireRole('admin')` for admin-only operations, and add `checkEnrollment` for any route that accesses course-scoped content on behalf of a student. If the route is in a sub-router mounted under `/courses/:courseId/...`, ensure the router is created with `Router({ mergeParams: true })` so that `req.params.courseId` is accessible. Use the `success()` and `error()` utilities from `utils/response.ts` for all responses. Wrap the entire handler body in a `try/catch` and log structured context in the catch block — at minimum include `uid: req.user?.uid` and any relevant resource IDs. If the endpoint writes points, use `FieldValue.increment(n)` and call `checkAndAwardBadges` afterward. After implementing, rebuild with `npm run build` and verify the endpoint in the emulator before committing.