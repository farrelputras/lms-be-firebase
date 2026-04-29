# LMS Literasi Syariah — Backend Developer Guide

This guide is written for backend developers maintaining or extending the `lms-be-firebase` repository. It focuses on the internal architecture — how the request pipeline is assembled, why middleware is ordered the way it is, how the gamification system is wired, and where the known traps are. If you are a frontend developer looking for how to call the API, see `FRONTEND_API_GUIDE.md` instead.

**Runtime:** Firebase Cloud Functions v2, Node.js 22, Express 5  
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
│   │   │   ├── activities.ts
│   │   │   ├── content.ts
│   │   │   ├── certificates.ts
│   │   │   ├── certificatesUser.ts   # GET /v1/certificates/me — all certs for current user
│   │   │   ├── enrollments.ts        # ⚠️ file exists but NOT mounted in index.ts
│   │   │   ├── progress.ts
│   │   │   ├── storage.ts
│   │   │   ├── media.ts
│   │   │   └── leaderboard.ts
│   │   └── utils/
│   │       ├── response.ts           # success() and error() envelope helpers
│   │       └── badges.ts             # checkAndAwardBadges utility + BADGE_REGISTRY
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

After the Admin SDK is ready, an Express app is created with the following global middleware applied in order: CORS (currently configured with `origin: "*"` — open to all origins; the `CORS_ORIGIN` environment variable approach is commented out), and a conditional `express.json()` body parser that skips multipart requests so that file upload routes handled by multer are not broken. The global middleware runs before any route-specific middleware — this matters because body parsing must happen before any route handler attempts to read `req.body`.

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
 Route-specific middleware      ← e.g. requirePublishedCourse, requireRole on individual routes
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

Takes one or more role strings as arguments and returns a middleware function — for example `requireRole('admin')` or `requireRole('admin', 'instructor')`. It requires `verifyToken` to have already run (it reads `req.user`). If `req.user` is undefined (unauthenticated), it sends `401`. If `req.user.role` is not in the allowed list, it sends `403`. There is no role hierarchy — admin is not implicitly a superset of instructor. Use the variadic form when a route should be accessible to multiple distinct roles.

**Used by:** Admin-only routes, either as `router.use(requireRole('admin'))` at the router level or as a per-route argument.

### `checkEnrollment`

**Location:** `src/middleware/checkEnrollment.ts`

Verifies that the authenticated user is enrolled in the course identified by `req.params.courseId`. It requires `verifyToken` to have already run. Admin users bypass this check entirely — the middleware checks `req.user.role === 'admin'` and calls `next()` immediately if true. For non-admin users, it queries the `enrollments` collection for a document matching `{ userId: req.user.uid, courseId: req.params.courseId }`. If no matching document is found, it sends `403`.

**Critical dependency:** This middleware reads `courseId` from `req.params.courseId`. It only works correctly on routes where the Express router has `mergeParams: true` set, because chapter and quiz routes are sub-routers mounted under `/courses/:courseId/...` — without `mergeParams: true`, `req.params.courseId` would be undefined in the child router. All course-scoped routers in this codebase already set `mergeParams: true`.

**Used by:** Not currently applied to any mounted route. The middleware is defined and functional, but all course-scoped content routes now use `requirePublishedCourse` instead. It will be reinstated once the enrollment router is mounted and enrollment-gated access is fully enforced.

---

### `requirePublishedCourse`

**Location:** `src/middleware/requirePublishedCourse.ts`

Verifies that the course identified by `req.params.courseId` exists and has `isPublished === true`. It requires `verifyToken` to have already run. Admin users bypass this check entirely — they can access unpublished courses for authoring and moderation. For all other roles, if the course does not exist or is not published, the middleware sends `404` (not `403`) — intentionally matching the behaviour of the courses GET endpoints to avoid leaking the existence of unpublished content.

This middleware replaced `checkEnrollment` as the primary access gate on course-scoped student routes. Any authenticated student can now read chapters, quizzes, activities, and content for any published course regardless of enrollment status. Enrollment is tracked in the `enrollments` collection but is not currently enforced as an access gate on content routes.

**Critical dependency:** Like `checkEnrollment`, this middleware reads `courseId` from `req.params.courseId` and therefore only works correctly on sub-routers with `mergeParams: true` set.

**Used by:** Chapter GET routes, quiz GET routes, quiz submit route, all activity routes, content GET route, and progress routes.

---

## Route Architecture

Each route file exports an Express `Router` instance. Routers are mounted in `index.ts`. Routes that are nested under a course path use `Router({ mergeParams: true })` to inherit the `:courseId` param from the parent router.

The mounting tree in `index.ts` looks like this:

```
/health                                   → inline handler in index.ts
/v1/auth                                  → routes/auth.ts
/v1/users                                 → routes/users.ts        (router.use(verifyToken, requireRole('admin')))
/v1/courses                               → routes/courses.ts
/v1/courses/:courseId/chapters            → routes/chapters.ts       (mergeParams: true, requirePublishedCourse)
/v1/courses/:courseId/quizzes             → routes/quizzes.ts        (mergeParams: true, requirePublishedCourse)
/v1/courses/:courseId/activities          → routes/activities.ts     (mergeParams: true, requirePublishedCourse)
/v1/courses/:courseId/content             → routes/content.ts        (mergeParams: true, requirePublishedCourse)
/v1/courses/:courseId/progress            → routes/progress.ts       (mergeParams: true, router.use(verifyToken))
/v1/courses/:courseId/certificates        → routes/certificates.ts   (mergeParams: true, router.use(verifyToken))
/v1/certificates                          → routes/certificatesUser.ts (router.use(verifyToken))
/v1/storage                               → routes/storage.ts        (router.use(verifyToken))
/v1/leaderboard                           → routes/leaderboard.ts
/v1/media                                 → routes/media.ts

⚠️  NOT MOUNTED: routes/enrollments.ts exists with full implementation but is absent from index.ts.
    All /v1/enrollments/* endpoints are currently unreachable (return 404).
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

**`courses/{courseId}/gamification/{activityId}`** — Subcollection under each course for gamification activities (drag & drop, word search, true/false). The `type` field determines the activity variant and which type-specific fields are present. The `position` field determines ordering relative to chapters.

**`activity_progress/{uid_activityId}`** — The document ID is a composite key in the format `{uid}_{activityId}`. Stores progress for gamification activities including `bestScore`, `bestScorePercent`, `attempts`, and `completed`.

**`certificates/{uid_courseId}`** — The document ID is a composite key in the format `{uid}_{courseId}`. Created by `POST /v1/courses/:courseId/certificates` and is idempotent — if the document already exists the existing data is returned. Fields: `id`, `userId`, `courseId`, `userName`, `courseName`, `serialNumber` (format: `CERT-{courseId[0..5]}-{uid[0..5]}-{YYYYMMDD}`), `issuedAt` (server timestamp), `completionDate` (ISO date string derived from `issuedAt`). Eligibility gate: `progress.percentage === 100` AND `activity_progress.bestScore === 100` for every activity in the course's `gamification` subcollection.

---

## Gamification Internals

The gamification system consists of two parts: atomic point writes inside route handlers, and a shared badge utility called after every point write.

### Point writes

Points are written using `FieldValue.increment(n)` which is an atomic server-side operation. It does not require reading the current value first, which means concurrent requests from the same user cannot cause a race condition that results in lost points. The two places where points are awarded are the chapter completion handler in `progress.ts` and the quiz submit handler in `quizzes.ts`. In both cases, the `set(..., { merge: true })` pattern is used rather than `update()` so that a missing `totalPoints` field (e.g. on a brand new user document) is handled gracefully — Firestore treats `increment` on a missing field as starting from zero.

The chapter completion handler has one additional concern: it must only award points on the first completion of each chapter. It handles this by reading the progress document before the Firestore write, capturing the pre-update `completedChapters` array, and checking whether `chapterId` is already present. The `isNewCompletion` boolean is determined from this pre-update snapshot — if you read it after the update, the chapter will always appear to be already present, and points will never be awarded. This is a subtle but critical ordering constraint.

### Badge utility — `src/utils/badges.ts`

The `checkAndAwardBadges(uid, db, event)` function is called after every significant user action. It takes three arguments: the user's UID, the Firestore admin instance, and a typed event descriptor. It returns an array of newly awarded `BadgeId` strings. The full event union is:

```typescript
type BadgeEvent =
  | { type: "account_created" }
  | { type: "chapter_finished" }
  | { type: "activity_submitted"; correctCount: number; totalQuestions: number }
  | { type: "leaderboard_update" }
```

Call sites and their event types:
- `auth.ts` — `account_created` → awards `newcomer`
- `progress.ts` — `chapter_finished` → awards `first_step`
- `activities.ts` submit — `activity_submitted` → awards `active_learner` always; awards `perfect_score` if `correctCount === totalQuestions`; then calls again with `leaderboard_update`
- `quizzes.ts` submit — calls with `leaderboard_update` after awarding quiz points

Internally, the function reads the user's current `badges` array from Firestore, evaluates rules for the given event, filters out badges already present (idempotency), writes the updated array back to Firestore only if there are new badges to add, and returns the newly awarded badges. The function never writes to Firestore when nothing is new — this avoids unnecessary writes on the hot path.

The `leaderboard_update` event makes a Firestore query: `users` collection ordered by `totalPoints` descending, limited to 3. If the current user's UID appears at index 0 they are eligible for `number_1`; if they appear at any of the 3 positions they are eligible for `top_3`. This is a 3-document read on every point-awarding action. One known gap: this query does not filter `isActive=true` — see Known Issues.

```
checkAndAwardBadges call flow:
1. Read users/{uid}.badges from Firestore
2. Evaluate badge rules for event type:
   - account_created   → newcomer
   - chapter_finished  → first_step
   - activity_submitted and correctCount === totalQuestions → active_learner + perfect_score
   - activity_submitted otherwise → active_learner
   - leaderboard_update → query top 3; top_3 if present; number_1 if rank 0
3. Filter eligible badges against existing badges (remove already-earned)
4. If any new badges remain:
   a. Write updated badges array to users/{uid}
   b. Return new badge IDs
5. If no new badges: return []
```

After each call, callers map the returned badge IDs through `BADGE_REGISTRY` (exported from `badges.ts`) to produce `{ id, name, icon, color }` objects for the response — so clients can render badge notifications immediately without a separate lookup.

---

## Environment Variables

| Variable | Required | Notes |
|---|---|---|
| `PROJECT_ID` | Yes (explicit init) | Firebase project ID. |
| `CLIENT_EMAIL` | Yes (explicit init) | Service account email. |
| `PRIVATE_KEY` | Yes (explicit init) | Service account private key. Newline-escaped — the code calls `.replace(/\\n/g, '\n')` during init. |
| `STORAGE_BUCKET` | Yes (for storage routes) | GCS bucket name without `gs://` prefix. |
| `CORS_ORIGIN` | No | Currently unused — the CORS configuration in `index.ts` is hardcoded to `origin: "*"`. This variable is read from env but the line is commented out. Restore the commented block before any production deployment that requires CORS restriction. |

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

**Firestore security rules use stale collection name.** The rules file references `quizResults` (camelCase). The route now writes to `quiz_results` (snake_case). Any client-side Firestore access to `quiz_results` will be denied until the rules are updated. Since the current frontend uses the backend API exclusively and does not query Firestore directly, this is not currently causing visible failures — but it is a trap waiting for the next developer who tries to add a client-side Firestore listener.

**Quiz question schema drift between admin write and student read.** Questions are stored in Firestore with `questionText` as the field name for question text. The admin create/update interface models the field as `question` in the TypeScript `QuizQuestion` interface. The student normalization function correctly reads `questionText` from the stored document. However, if an admin client submits a question object using `question` instead of `questionText`, the data is stored with the wrong field name and students will see blank questions. The TypeScript interface and the stored schema are out of sync, and there is no runtime validation that catches this mismatch.

**Non-transactional duplicate enrollment check.** The `POST /enrollments` handler checks for duplicate enrollments using a query followed by a write. Two concurrent enrollment requests for the same user-course pair can both pass the duplicate check before either write completes, resulting in two enrollment documents. At MVP scale this is unlikely, but it is worth fixing with a Firestore transaction before any high-traffic promotion.

**`top_3` badge query does not filter inactive users.** The `checkAndAwardBadges` utility queries users by `totalPoints` without filtering `isActive=true`. An inactive (soft-deleted) user with a high point total can occupy a top-3 slot and prevent an active user from earning the `top_3` badge, even though the inactive user does not appear on the visible leaderboard. The fix is to add `.where('isActive', '==', true)` to the query in `badges.ts` — but be aware this will also require the same composite index as the leaderboard query.

**No content route enforces enrollment.** All course-scoped student routes — chapters, quizzes, activities, content, and progress — gate access on `requirePublishedCourse` (course exists and is published) rather than enrollment. Any authenticated student can read the content of any published course regardless of whether they have an `enrollments` document. This is a deliberate MVP simplification; if enrollment-gated access is required before launch, `checkEnrollment` needs to be reinstated on the relevant routes and the enrollment router must also be mounted.

**Storage download path override is broad.** `GET /storage/download-url/:fileId` accepts a `?path=` query parameter that, if provided, overrides the `:fileId` param and signs any existing GCS path for any authenticated user. There is no ownership check or path boundary policy. Any authenticated user can obtain a signed read URL for any object in the bucket if they know the path.

**Enrollment router is not mounted.** `routes/enrollments.ts` is fully implemented but has no corresponding `app.use(...)` line in `index.ts`. All `/v1/enrollments/*` endpoints return `404`. Add `app.use("/v1/enrollments", enrollmentsRouter)` to `index.ts` (and import the router) to restore enrollment functionality.

**CORS is open to all origins.** The `origin: process.env.CORS_ORIGIN` line in `index.ts` is commented out and replaced with `origin: "*"`. This is acceptable for local emulator development but must be restricted before any production deployment that handles authenticated user data. Restore the commented `CORS_ORIGIN` block and set the env variable appropriately.

**Certificate eligibility check uses `bestScore` field semantics that are pending confirmation.** The `POST /certificates` handler checks `activityProgress.bestScore !== 100` to determine eligibility. `bestScore` stores the raw proportional points value (not a percentage), but the eligibility check treats it as if it were a percentage. This works correctly today because `bestScore` and `bestScorePercent` happen to both equal 100 on a perfect attempt — but the field name is misleading and the check may break if activity scoring changes. The comment `// bestScore === 100 assumption — pending confirmation` in `certificates.ts` flags this explicitly.

---

## Adding a New Endpoint — Checklist

When adding a new endpoint to the backend, work through this checklist to avoid common oversights.

Decide which route file it belongs in, or create a new route file and mount it in `index.ts`. **Mounting is a manual step** — a new route file that is not added to `index.ts` will silently return `404` with no build-time warning (the enrollment router is the current example of this trap).

Apply the correct middleware — use `verifyToken` for all authenticated routes, add `requireRole('admin')` for admin-only operations, and add `requirePublishedCourse` for any route that accesses course-scoped content on behalf of a student (this gates on publication status, not enrollment). If the route is in a sub-router mounted under `/courses/:courseId/...`, ensure the router is created with `Router({ mergeParams: true })` so that `req.params.courseId` is accessible to both the route handler and `requirePublishedCourse`.

Use the `success()` and `error()` utilities from `utils/response.ts` for all responses. Wrap the entire handler body in a `try/catch` and log structured context in the catch block — at minimum include `uid: req.user?.uid` and any relevant resource IDs.

If the endpoint writes points, use `FieldValue.increment(n)` and call `checkAndAwardBadges` with the appropriate event type from the `BadgeEvent` union in `utils/badges.ts`. Map the returned badge IDs through `BADGE_REGISTRY` before including them in the response so clients receive full badge metadata.

After implementing, rebuild with `npm run build` and verify the endpoint in the emulator before committing.