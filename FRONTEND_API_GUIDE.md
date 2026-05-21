# LMS Literasi Syariah — Frontend API Guide

This guide is written for frontend developers (web or mobile) consuming the LMS Literasi Syariah backend API. It focuses entirely on **how to call the API correctly** — what to send, what you get back, and what to watch out for. You do not need to know how the backend is structured internally to use this guide.

**Base URL (local emulator):** `http://127.0.0.1:5001/literasi-ekonomi-syariah/us-central1/api`  
**Base URL (production):** `https://api-gohgnhhszq-uc.a.run.app`  
**All routes are prefixed with:** `/v1`  
**All requests and responses use:** `application/json`

---

## Table of Contents

- [How Authentication Works](#how-authentication-works)
- [The Response Envelope](#the-response-envelope)
- [Error Handling](#error-handling)
- [Auth Endpoints](#auth-endpoints)
- [User Management Endpoints](#user-management-endpoints) *(admin only)*
- [Course Endpoints](#course-endpoints)
- [Chapter Endpoints](#chapter-endpoints)
- [Quiz Endpoints](#quiz-endpoints)
- [Activity Endpoints](#activity-endpoints)
- [Course Content Endpoint](#course-content-endpoint)
- [Progress Endpoints](#progress-endpoints) — mark complete, get progress, reset (dev only)
- [Certificate Endpoints](#certificate-endpoints)
- [User Certificate Endpoint](#user-certificate-endpoint) — all certs across courses
- [Enrollment Endpoints](#enrollment-endpoints) ⚠️ currently unmounted — see section
- [Leaderboard Endpoint](#leaderboard-endpoint)
- [Storage Endpoints](#storage-endpoints)
- [Media Endpoints](#media-endpoints)
- [Gamification — Points and Badges](#gamification--points-and-badges)
- [Things That Will Catch You Off Guard](#things-that-will-catch-you-off-guard)

---

## How Authentication Works

The backend uses **Firebase ID tokens** for authentication. Think of an ID token as a short-lived proof that a user is who they say they are — it expires after one hour, but the Firebase client SDK handles silent refresh automatically so you rarely need to think about expiry in practice.

Every protected API call needs this header:

```
Authorization: Bearer <idToken>
```

The flow to get that token is as follows. First, the user registers or logs in using the Firebase client SDK (not a backend endpoint — Firebase handles this directly). After login, you call `firebaseAuth.currentUser.getIdToken()` to retrieve the current token string. Attach that string as the Bearer token on every subsequent API request.

```javascript
// Example: getting the token and calling the API
const token = await firebaseAuth.currentUser.getIdToken();

const response = await fetch(`${BASE_URL}/v1/courses`, {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
});
```

If the token has expired and you get a `401` back, call `getIdToken(true)` (the `true` forces a refresh) and retry the request. Most Firebase client SDKs have a helper for this pattern.

**For testing with Postman:** Since you cannot use the Firebase client SDK directly in Postman, you can exchange email and password for an ID token using the Firebase REST Auth API. Make a `POST` request to `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<YOUR_WEB_API_KEY>` with body `{ "email": "...", "password": "...", "returnSecureToken": true }`. The `idToken` field in the response is your Bearer token.

---

## The Response Envelope

Every response from the API — whether success or error — is wrapped in the same envelope shape. This makes it easy to write a single response handler in your API client layer.

A successful response always looks like this, where `data` contains whatever the endpoint returns:

```json
{
  "success": true,
  "data": { }
}
```

An error response always looks like this:

```json
{
  "success": false,
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "A human-readable description of what went wrong."
  }
}
```

Because the envelope is consistent, you can write a single wrapper function in your API client layer that checks `success` first and either returns `data` or throws an error using `error.code`. This is much cleaner than checking HTTP status codes in every individual API call.

```javascript
// Suggested API client wrapper pattern
async function apiCall(endpoint, options = {}) {
  const token = await firebaseAuth.currentUser.getIdToken();
  const response = await fetch(`${BASE_URL}/v1${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const json = await response.json();

  if (!json.success) {
    // json.error.code is machine-readable — useful for conditional UI logic
    // json.error.message is human-readable — can be shown directly to the user
    throw new ApiError(json.error.code, json.error.message);
  }

  return json.data;
}
```

---

## Error Handling

The following error codes appear across multiple endpoints. Each endpoint section below also documents errors that are specific to that endpoint.

| HTTP Status | Code | What it means for your UI |
|---|---|---|
| `400` | `BAD_REQUEST` | You sent a missing or invalid field. Check the request body. |
| `401` | `UNAUTHORIZED` | Token is missing, expired, or invalid. Refresh the token and retry. |
| `403` | `FORBIDDEN` | The user is authenticated but does not have permission. Show an access denied message. |
| `403` | `LOCKED` | The activity is locked because the previous item has not been completed. Show a "complete previous item" prompt — this is distinct from a permission error. |
| `404` | `NOT_FOUND` | The resource does not exist, or is hidden for access control reasons (e.g. unpublished course). |
| `409` | `CONFLICT` | A duplicate resource already exists (e.g. enrolling in a course you are already enrolled in). |
| `500` | `*_FAILED` | Something went wrong on the server. Log the error and show a generic retry message. |

One important nuance on `404`: when a non-admin requests an unpublished course, the API returns `404` rather than `403`. This is intentional — it prevents the frontend from leaking information about the existence of unpublished content. Treat all `404` responses the same way regardless of why they were returned.

---

## Auth Endpoints

### Register a new user — `POST /v1/auth/register`

Creates a Firebase Auth account, assigns the `student` role, and creates the user profile document. After a successful register, use the Firebase client SDK to sign the user in and obtain their ID token.

```json
// Request body
{
  "email": "student@example.com",
  "password": "securePassword123",
  "name": "Budi Santoso"
}
```

```json
// Response (HTTP 201)
{
  "success": true,
  "data": {
    "uid": "abc123xyz",
    "email": "student@example.com",
    "name": "Budi Santoso",
    "role": "student",
    "earnedBadges": [
      {
        "id": "newcomer",
        "name": "Newcomer",
        "icon": "celebration",
        "color": "blue"
      }
    ]
  }
}
```

### Sync current user + claims — `POST /v1/auth/sync`

Requires authentication. This endpoint ensures a Firestore user profile exists for the authenticated Firebase user, syncs custom claims from Firestore role, and may return newly awarded onboarding badges. Call this immediately after any OAuth or social login flow where the user may not have a Firestore profile yet.

```json
// Optional request body
{
  "email": "student@example.com",
  "displayName": "Budi Santoso"
}
```

```json
// Response (HTTP 201)
{
  "success": true,
  "data": {
    "message": "User synced successfully",
    "uid": "abc123xyz",
    "role": "student",
    "earnedBadges": []
  }
}
```

Note: this endpoint always returns HTTP 201, even when the user profile already existed and no changes were made.

### Assign a role — `POST /v1/auth/assign-role` *(admin only)*

Changes a user's role. Valid values for `role` are `student`, `instructor`, and `admin`. After the backend updates the role, the affected user must call `getIdToken(true)` to force a token refresh — their current token still carries the old role until refreshed.

### Get current user profile — `GET /v1/auth/me`

Returns the full profile of the currently authenticated user. Call this after login to hydrate your user state, and again after any action that might change `totalPoints` or `badges`. The `totalPoints` field always returns a number (never null — defaults to `0`), and `badges` always returns an array (never null — defaults to `[]`).

```json
// Response
{
  "success": true,
  "data": {
    "uid": "abc123xyz",
    "email": "student@example.com",
    "name": "Budi Santoso",
    "role": "student",
    "totalPoints": 42,
    "badges": ["perfect_score"],
    "isActive": true
  }
}
```

---

## User Management Endpoints

All user management routes require an admin token. They are protected at the router level — every route under `/v1/users` is admin-only with no exceptions.

### List users — `GET /v1/users`

Returns all user profiles. Supports two optional query parameters:
- `?role=student` — filter by role (`student`, `instructor`, `admin`)
- `?search=budi` — case-insensitive substring match against name or email

```json
// Response
{
  "success": true,
  "data": [
    { "uid": "abc123", "name": "Budi Santoso", "email": "budi@example.com", "role": "student", "totalPoints": 42, "badges": [], "isActive": true }
  ]
}
```

### Get a user — `GET /v1/users/:uid`

Returns a single user document. Returns `404` with code `NOT_FOUND` if the user does not exist.

### Update a user — `PATCH /v1/users/:uid` *(admin only)*

Partial update. Accepted fields: `name`, `email`, `totalPoints`. If `email` or `name` is provided, the Firebase Auth record is also updated.

```json
// Example: override a student's point total
{ "totalPoints": 100 }
```

`totalPoints` is set to the provided value directly — this is not an increment operation. Use this only for admin corrections; normal point accumulation goes through the gamification route handlers.

### Delete a user — `DELETE /v1/users/:uid` *(admin only)*

**This is a permanent, irreversible hard delete.** It:
1. Deletes the Firebase Auth account for the user
2. Deletes the `users/{uid}` Firestore document
3. Deletes all Firestore documents where `userId == uid` across: `enrollments`, `progress`, `quiz_results`, `activity_progress`, `certificates`

There is no soft-delete or undo path. Confirm with the user before triggering this from an admin UI.

```json
// Response
{ "success": true, "data": { "uid": "abc123" } }
```

### Upsert a user profile — `POST /v1/users/upsert` *(admin only)*

Creates a user document if one does not exist, or updates the `email` and `name` fields if it does. This is a backward-compatibility endpoint for sync flows that do not go through `/auth/register` or `/auth/sync`. Requires `uid` and `email` in the request body.

```json
// Request body
{ "uid": "abc123", "email": "user@example.com", "displayName": "Budi Santoso" }
```

---

## Course Endpoints

### List courses — `GET /v1/courses`

No token required. If the user is not authenticated, only published courses are returned. If the user is an admin, all courses (including unpublished) are returned. This means you can call this endpoint before the user logs in to show a course catalog.

**For authenticated users only:** each course object in the array also includes a `progressPercentage` field (integer 0–100). This value reflects combined progress across both chapters and activities — it is not chapters-only. This is batch-loaded server-side in a single query — you do not need to call the progress endpoint separately to populate a course list. Unauthenticated responses do not include this field.

### Get a single course — `GET /v1/courses/:courseId`

No token required. Non-admin users receive a `404` if the course is unpublished — not a `403`. See the note in the Error Handling section above about why this is intentional.

### Create a course — `POST /v1/courses` *(admin only)*

New courses are created with `isPublished: false` by default. Use `PATCH` to publish when ready.

### Update a course — `PATCH /v1/courses/:courseId` *(admin only)*

Partial update — only include the fields you want to change. To publish a course, send `{ "isPublished": true }`. To unpublish, send `{ "isPublished": false }`. Other fields are left untouched.

### Delete a course — `DELETE /v1/courses/:courseId` *(admin only)*

**Important:** Deleting a course does not cascade. Chapters, quizzes, progress records, and enrollments associated with the course are not deleted. Your UI should handle the case where a student's enrolled course no longer exists.

---

## Chapter Endpoints

All chapter routes are nested under `/v1/courses/:courseId/chapters`. Every student request to these routes requires the user to be **authenticated and the course to be published**. Unauthenticated requests receive `401`; requests to an unpublished or non-existent course receive `404`.

### List chapters — `GET /v1/courses/:courseId/chapters`

Returns chapters ordered by the `order` field ascending. Each chapter includes `isPublished`, though the backend does not currently filter out unpublished chapters from this list — that filtering logic lives on the frontend.

### Mark a chapter complete — see [Progress Endpoints](#progress-endpoints)

Chapter completion is handled by the progress endpoint, not the chapters endpoint.

### Create a chapter — `POST /v1/courses/:courseId/chapters` *(admin only)*

The `isPublished` field controls visibility. It defaults to `false` if you omit it. The `isFree` field is **intentionally excluded** from this MVP — do not send it. Creating a chapter increments the `totalChapters` counter on the course document.

Chapter media is stored as two separate fields — do **not** use the old `videoUrl` field:

| Field | Type | Notes |
|---|---|---|
| `mediaType` | string | Media provider type, e.g. `"youtube"`. Defaults to `"youtube"` if omitted. |
| `mediaUrl` | string | The URL of the media. |

### Update a chapter — `PATCH /v1/courses/:courseId/chapters/:chapterId` *(admin only)*

Partial update. If you omit `isPublished` from the body, the existing value is preserved. This means you can safely update `title` without accidentally unpublishing a live chapter.

### Delete a chapter — `DELETE /v1/courses/:courseId/chapters/:chapterId` *(admin only)*

Deletes the chapter and decrements the `totalChapters` counter on the course document.

---

## Quiz Endpoints

All quiz routes are nested under `/v1/courses/:courseId/quizzes`. Student requests require authentication and the course to be published.

### What students see vs what admins see

This is the most important thing to understand about quiz endpoints. The question shape returned to students is different from the shape stored in Firestore and returned to admins. When a student calls any GET quiz endpoint, each question is normalized to only `{ question, options[] }` — the correct answer index and other metadata are stripped. The `question` field is sourced from the stored `questionText` field. Admins receive the full stored shape including `correctAnswerIndex`.

```json
// What a student sees (normalized)
{
  "question": "Apa kepanjangan dari ZISWAF?",
  "options": ["Zakat, Infak, Sedekah, Wakaf", "Zakat, Iman, Syariah, Wakaf", "..."]
}

// What an admin sees (full shape)
{
  "questionText": "Apa kepanjangan dari ZISWAF?",
  "correctAnswerIndex": 0,
  "options": ["Zakat, Infak, Sedekah, Wakaf", "Zakat, Iman, Syariah, Wakaf", "..."],
  "type": "multipleChoice",
  "points": 1
}
```

### Create a quiz — `POST /v1/courses/:courseId/quizzes` *(admin only)*

When writing question objects, use `questionText` as the field name for the question text — not `question`. The student normalization reads from `questionText`. If you accidentally use `question`, students will see blank question text. This is the single most important naming rule in the entire API.

### Update a quiz — `PATCH /v1/courses/:courseId/quizzes/:quizId` *(admin only)*

Partial update. Send only the fields you want to change (`title`, `questions`, or both).

### Delete a quiz — `DELETE /v1/courses/:courseId/quizzes/:quizId` *(admin only)*

Deletes the quiz document. Does not cascade to `quiz_results`.

### Submit quiz answers — `POST /v1/courses/:courseId/quizzes/:quizId/submit`

This is the most complex endpoint in the API. It scores answers server-side, awards points, checks badge eligibility, and returns the full result in one response.

**How to format your answers:** The `answers` field is a plain array of integers. Each integer is the zero-based index of the option the student selected. The position in the array corresponds to the question at the same position — `answers[0]` is the answer to `questions[0]`, `answers[1]` to `questions[1]`, and so on. The array length must exactly match the number of questions in the quiz.

```json
// Request body — submitting answers for a 3-question quiz
// Student selected option 0 for Q1, option 1 for Q2, option 2 for Q3
{
  "answers": [0, 1, 2]
}
```

```json
// Response
{
  "success": true,
  "data": {
    "score": 3,
    "total": 3,
    "passed": true,
    "pointsAwarded": 3,
    "earnedBadges": [
      {
        "id": "active_learner",
        "name": "Active Learner",
        "icon": "auto_stories",
        "color": "orange"
      },
      {
        "id": "perfect_score",
        "name": "Perfect Score",
        "icon": "verified",
        "color": "amber"
      }
    ],
    "answers": [
      { "questionId": "0", "correct": true },
      { "questionId": "1", "correct": true },
      { "questionId": "2", "correct": true }
    ]
  }
}
```

The `passed` field is `true` **only when the student answered every question correctly** (100%). It is `false` for any partial score, including 19 out of 20. Use this field to drive the perfect score UI state. The `pointsAwarded` field always equals `score` — one point per correct answer. Points are awarded on every submission including retakes, so a student who retakes a quiz earns points each time.

Quiz submissions now trigger the same badge checks as activity submissions. `earnedBadges` will always include `active_learner` on the first time that badge is earned, and will include `perfect_score` if the student answered every question correctly. It may also include `top_3` or `number_1` if the student's new point total places them in the leaderboard top 3.

After receiving a submit response, call `GET /auth/me` to refresh the user's full profile state so that `totalPoints` and `badges` are up to date in your UI.

---

## Activity Endpoints

All activity routes are nested under `/v1/courses/:courseId/activities`. Student requests require authentication and the course to be published. Activities are stored in the `gamification` subcollection under a course document.

There are three activity types: `drag_drop`, `word_search`, and `true_or_false`. The type is fixed at creation and cannot be changed via update.

### Create an activity — `POST /v1/courses/:courseId/activities` *(admin only)*

All activity types share four common required fields:

| Field | Type | Notes |
|---|---|---|
| `type` | string | `drag_drop`, `word_search`, or `true_or_false` |
| `title` | string | Display name shown to students |
| `position` | number | Sort order in the course content sequence |
| `maxPoints` | number | Maximum points a student can earn |

Each type then requires its own additional fields:

**`drag_drop`**
```json
{
  "type": "drag_drop",
  "title": "Kategorikan Instrumen Keuangan Syariah",
  "position": 2,
  "maxPoints": 10,
  "categories": ["Sosial", "Komersial"],
  "items": [
    { "id": "item1", "label": "Zakat", "correctCategory": "Sosial" },
    { "id": "item2", "label": "Mudharabah", "correctCategory": "Komersial" }
  ],
  "feedbackMode": "immediate"
}
```

**`word_search`**
```json
{
  "type": "word_search",
  "title": "Temukan Istilah Ekonomi Syariah",
  "position": 3,
  "maxPoints": 5,
  "wordList": ["ZAKAT", "WAKAF", "RIBA"],
  "gridSize": { "rows": 10, "cols": 10 }
}
```
`gridSize` rows and cols must each be between 8 and 15 (inclusive).

**`true_or_false`**
```json
{
  "type": "true_or_false",
  "title": "Benar atau Salah: Konsep Dasar",
  "position": 4,
  "maxPoints": 6,
  "statements": [
    { "id": "s1", "text": "Riba diperbolehkan dalam Islam.", "correct": false },
    { "id": "s2", "text": "Zakat termasuk rukun Islam.", "correct": true }
  ],
  "feedbackMode": "immediate"
}
```

**Important:** Each statement in a `true_or_false` activity must have a non-empty `id`. Activities created with empty `id` strings on statements are handled with a fallback key on the submit side (`__statement_0`, `__statement_1`, etc.), but this is a backward-compatibility measure — always provide meaningful IDs when creating activities.

Creating an activity increments the `totalActivities` counter on the course document.

Response on success: `{ "activityId": "<newId>" }` with HTTP 201.

### Get an activity — `GET /v1/courses/:courseId/activities/:activityId`

Returns the activity. Requires authentication and the course to be published. **Correct answer data is stripped for students** — the same pattern as quizzes:
- `drag_drop`: each item returns only `{ id, label }` — `correctCategory` is removed
- `true_or_false`: each statement returns only `{ id, text }` — `correct` is removed
- `word_search`: full data is returned (no answers to strip)

Admins receive the full stored shape including `correctCategory` / `correct` values.

**Locking:** If the activity's `position` is greater than 0 and the student has not yet completed the previous item in the sequence (either a chapter or another activity), the endpoint returns `403` with code `LOCKED`:

```json
{
  "success": false,
  "error": {
    "code": "LOCKED",
    "message": "This activity is locked. Complete the previous item first."
  }
}
```

Exception: if the student has already completed the activity in a prior session, it is always accessible regardless of whether the previous item is completed.

### Submit activity answers — `POST /v1/courses/:courseId/activities/:activityId/submit`

The answer format differs by activity type.

**`drag_drop`** — a plain object mapping each item ID to the selected category string:
```json
{ "answers": { "item1": "Sosial", "item2": "Komersial" } }
```

**`word_search`** — an object with a `foundWords` string array (case-insensitive):
```json
{ "answers": { "foundWords": ["ZAKAT", "WAKAF"] } }
```

**`true_or_false`** — a plain object mapping each statement ID to a boolean:
```json
{ "answers": { "s1": false, "s2": true } }
```

```json
// Response
{
  "success": true,
  "data": {
    "score": 2,
    "totalItems": 2,
    "maxPoints": 10,
    "scorePercent": 100,
    "earnedPoints": 10,
    "pointsEarned": 10,
    "isNewCompletion": true,
    "earnedBadges": [],
    "feedback": [
      { "id": "item1", "correct": true, "correctCategory": "Sosial" },
      { "id": "item2", "correct": true, "correctCategory": "Komersial" }
    ]
  }
}
```

**`score`** is the raw correct count. **`totalItems`** is the total number of scoreable items in the activity. **`earnedPoints`** is the proportional points scored this attempt (`Math.round(score / totalItems * maxPoints)`). **`pointsEarned`** is the delta actually added to `totalPoints` — only the improvement over the student's previous best score is credited. On a first attempt these two fields are equal; on a retake where the student scored lower than before, `pointsEarned` will be `0`.

`isNewCompletion` is `true` on the first submission only. Use it to decide whether to trigger a course-progress animation. The activity is marked `completed: true` on the first submission and stays that way regardless of future scores.

After submission, the backend automatically recomputes the course progress percentage (combining chapters + activities) and writes it to the progress document. You do not need to call any separate progress endpoint to refresh the percentage — it will be up to date on the next call to `GET /v1/courses/:courseId/progress` or `GET /v1/courses`.

`feedback` shape differs by type:
- `drag_drop`: `[{ id, correct, correctCategory }]`
- `word_search`: `[{ word, found }]`
- `true_or_false`: `[{ id, correct, correctAnswer }]`

After receiving a submit response, call `GET /auth/me` to refresh the user's cumulative `totalPoints`.

### Update an activity — `PUT /v1/courses/:courseId/activities/:activityId` *(admin only)*

Partial update. Only include fields you want to change. The activity `type` cannot be changed. Type-specific fields are only accepted if they match the stored type — sending `wordList` to a `drag_drop` activity has no effect.

### Delete an activity — `DELETE /v1/courses/:courseId/activities/:activityId` *(admin only)*

Deletes the activity and **cascades**: all `activity_progress` documents for that activity are deleted in the same batch. Also decrements the `totalActivities` counter on the course document.

---

## Course Content Endpoint

### Get course content — `GET /v1/courses/:courseId/content`

Returns a unified, ordered list of all chapters and activities for a course. Requires authentication and the course to be published. This is the primary endpoint for rendering the course sidebar or table of contents — it replaces calling `GET /chapters` and `GET /activities` separately.

Each item in the array includes `itemType` (`"chapter"` or `"activity"`), `completed`, and `locked` fields in addition to the item's own data. Items are sorted by `position` ascending. Activities with sensitive fields (`correctCategory`, `correct`) are already stripped in this response.

```json
// Response (abbreviated)
{
  "success": true,
  "data": [
    {
      "itemType": "chapter",
      "id": "chapterAbc",
      "title": "Pengantar Ekonomi Syariah",
      "position": 1,
      "completed": true,
      "locked": false
    },
    {
      "itemType": "activity",
      "id": "activityXyz",
      "type": "drag_drop",
      "title": "Kategorikan Instrumen",
      "position": 2,
      "completed": false,
      "locked": false,
      "bestScorePercent": 80,
      "attempts": 2
    },
    {
      "itemType": "activity",
      "id": "activityWww",
      "type": "word_search",
      "title": "Temukan Istilah",
      "position": 3,
      "completed": false,
      "locked": true
    }
  ]
}
```

**`locked`** is `true` when the immediately preceding item has not been completed. The first item is never locked. **`bestScorePercent`** and **`attempts`** are only present on activity items and only when the student has at least one prior submission.

Admins always receive `locked: false` for every item, regardless of their own progress.

---

## Progress Endpoints

### Mark a chapter complete — `POST /v1/courses/:courseId/progress`

Marks a chapter as completed for the calling user. The `courseId` goes in the URL — the request body only needs `chapterId`.

```json
// Request body
{
  "chapterId": "chapterIdAbc"
}
```

```json
// Response — HTTP 201 on first completion, HTTP 200 on subsequent calls
{
  "success": true,
  "data": {
    "completedChapters": ["chapterIdAbc"],
    "percentage": 50,
    "pointsAwarded": 10,
    "earnedBadges": []
  }
}
```

**`percentage`** is the combined completion percentage across both chapters and activities — it is not chapters-only. A course with 2 chapters and 2 activities at 50% means 2 of the 4 total items have been completed. Use this value to drive the course progress bar.

The `pointsAwarded` field is `10` on the first completion of a chapter and `0` on any subsequent call with the same chapter. Use this field to decide whether to show a "+10 points" animation — if `pointsAwarded` is `0`, the user already completed this chapter before and you should not show the animation again.

The response HTTP status is `201` on the first time a chapter is marked complete for this student, and `200` on subsequent calls. Use this to distinguish first-completion celebrations from idempotent re-submissions if needed.

### Get progress for a course — `GET /v1/courses/:courseId/progress`

Returns the user's progress for a course. The `percentage` field reflects combined chapter + activity completion. If the user has not completed any items yet, returns an empty default rather than a `404` — so this endpoint is always safe to call without checking enrollment first.

### Reset all progress — `DELETE /v1/courses/:courseId/progress` *(dev/testing only)*

Clears all of the calling user's progress for a course in one call. This endpoint exists only for development and testing — it is not available in production builds of the frontend.

Deletes:
- The `progress` document for this user+course (chapter completions and percentage)
- All `quiz_results` documents for this user+course
- All `activity_progress` documents for this user+course

Points earned are **not** deducted.

```json
// Response
{
  "success": true,
  "data": {
    "deleted": true,
    "quizResultsCleared": 2,
    "activityProgressCleared": 1
  }
}
```

After a successful reset the page should be reloaded so that the sidebar and progress bar reflect the cleared state.

---

## Certificate Endpoints

All certificate routes are nested under `/v1/courses/:courseId/certificates`. Every request requires authentication (`verifyToken` is applied globally to the router).

### Eligibility requirements

A certificate can only be issued when **both** of the following are true:

1. The student's `progress` document for the course has `percentage === 100` (all chapters and activities completed — combined progress, not chapters-only).
2. Every activity in the course's `gamification` subcollection has a corresponding `activity_progress` record for the student with `bestScorePercent === 100` (perfect score on at least one attempt).

If either condition is not met, the endpoint returns `403` with code `CERTIFICATE_NOT_ELIGIBLE`. If the course has no gamification activities, only the chapter-completion check applies.

Note: since `percentage` is now a combined chapter+activity value, a student who completes all chapters but has not submitted all activities will have `percentage < 100` and will not be eligible even if their chapter completion is 100%. Both conditions must be fully satisfied.

### Issue or retrieve a certificate — `POST /v1/courses/:courseId/certificates`

Idempotent. If a certificate has already been issued for this student and course, the existing certificate is returned without creating a duplicate. If eligible and no certificate exists, a new one is created. Always returns HTTP 200.

```json
// Response (new or existing certificate)
{
  "success": true,
  "data": {
    "id": "abc123xyz_3bViFooKRQSBQxVLjGIJ",
    "userId": "abc123xyz",
    "courseId": "3bViFooKRQSBQxVLjGIJ",
    "userName": "Budi Santoso",
    "courseName": "Pengantar Ekonomi Syariah",
    "serialNumber": "CERT-3BVIF-ABC12-20260428",
    "issuedAt": "2026-04-28T10:00:00.000Z",
    "completionDate": "2026-04-28"
  }
}
```

`serialNumber` format: `CERT-{first 5 chars of courseId uppercased}-{first 5 chars of uid uppercased}-{YYYYMMDD}`.

| HTTP Status | Code | What it means |
|---|---|---|
| `403` | `CERTIFICATE_NOT_ELIGIBLE` | Combined progress is not 100%, or at least one activity does not have a 100% best score percentage. |
| `500` | `INTERNAL_ERROR` | Server error during issuance. |

### Get my certificate — `GET /v1/courses/:courseId/certificates/me`

Returns the student's existing certificate for the course. Does not issue a new one.

```json
// Response
{
  "success": true,
  "data": {
    "id": "abc123xyz_3bViFooKRQSBQxVLjGIJ",
    "userId": "abc123xyz",
    "courseId": "3bViFooKRQSBQxVLjGIJ",
    "userName": "Budi Santoso",
    "courseName": "Pengantar Ekonomi Syariah",
    "serialNumber": "CERT-3BVIF-ABC12-20260428",
    "issuedAt": "2026-04-28T10:00:00.000Z",
    "completionDate": "2026-04-28"
  }
}
```

| HTTP Status | Code | What it means |
|---|---|---|
| `404` | `CERTIFICATE_NOT_FOUND` | No certificate has been issued yet for this student and course. |
| `500` | `INTERNAL_ERROR` | Server error during retrieval. |

---

## User Certificate Endpoint

### Get all my certificates — `GET /v1/certificates/me`

Requires authentication. Returns all certificates the current user has received across every course, ordered by issue date descending. This is distinct from `GET /v1/courses/:courseId/certificates/me` — that retrieves the certificate for a single specific course; this retrieves the full list across all courses in one call.

```json
// Response
{
  "success": true,
  "data": [
    {
      "id": "abc123xyz_3bViFooKRQSBQxVLjGIJ",
      "userId": "abc123xyz",
      "courseId": "3bViFooKRQSBQxVLjGIJ",
      "userName": "Budi Santoso",
      "courseName": "Pengantar Ekonomi Syariah",
      "serialNumber": "CERT-3BVIF-ABC12-20260428",
      "issuedAt": "2026-04-28T10:00:00.000Z",
      "completionDate": "2026-04-28"
    }
  ]
}
```

Returns an empty array if the user has no certificates yet. Use this to populate the student's achievements page or profile without issuing per-course queries.

---

## Enrollment Endpoints

> ⚠️ **Known issue:** The enrollment router is currently not mounted in the backend entry point. All `/v1/enrollments/*` endpoints will return `404` until this is fixed. Do not build enrollment flows against the current production build — check with the backend team before using these routes.

### Check enrollment status — `GET /v1/enrollments/:courseId/status`

Returns `{ "enrolled": true/false }`. Use this to decide whether to show a "Start Course" or "Enroll" button without fetching the full enrollment list.

### Get my enrollments — `GET /v1/enrollments/my`

Returns all courses the current user is enrolled in. Use this to populate the student's "My Courses" dashboard.

### Enroll a user — `POST /v1/enrollments`

When called by a student, enrolls the student in a course. When called by an admin, the `userId` field can be used to enroll any other user. Non-admin users who provide `userId` receive a `403`.

```json
// Student enrolling themselves
{ "courseId": "3bViFooKRQSBQxVLjGIJ" }

// Admin enrolling a student
{ "courseId": "3bViFooKRQSBQxVLjGIJ", "userId": "abc123xyz" }
```

If the student is already enrolled, the endpoint returns `409` with code `CONFLICT` — not a silent success. Check for this code and show an appropriate message rather than treating it as a generic error.

---

## Leaderboard Endpoint

### Get leaderboard — `GET /v1/leaderboard`

No token required. Returns all active users ranked by `totalPoints` descending. The `badges` field is always an array — it returns `[]` for users with no badges rather than being absent.

```json
// Response
{
  "success": true,
  "data": [
    { "uid": "abc123xyz", "name": "Budi Santoso", "totalPoints": 85, "badges": ["perfect_score", "top_3"] },
    { "uid": "def456uvw", "name": "Siti Rahayu", "totalPoints": 60, "badges": [] }
  ]
}
```

---

## Storage Endpoints

### Get a signed upload URL — `POST /v1/storage/upload-url` *(admin only)*

Returns a signed GCS URL valid for 15 minutes. Upload the file directly to that URL from the client — do not route the file through the backend. After upload, store the `filePath` value and use it with the download URL endpoint.

### Get a signed download URL — `GET /v1/storage/download-url/:fileId`

Returns a signed read URL valid for 1 hour. The `:fileId` is the file path in Cloud Storage (URL-encoded). Use this to generate temporary access URLs for course thumbnails, video files, or any other stored assets.

---

## Media Endpoints

### Upload a thumbnail image — `POST /v1/media/upload` *(admin only)*

Uploads an image file directly to Cloud Storage via a multipart form upload. The backend streams the file using busboy and stores it at `thumbnails/{uuid}.{ext}`. The response contains a **permanent public URL** — it does not expire.

Send the request as `multipart/form-data` with the image in any field name. Do not set `Content-Type: application/json`.

```json
// Response (HTTP 201)
{
  "success": true,
  "data": {
    "imageUrl": "https://firebasestorage.googleapis.com/v0/b/your-bucket/o/thumbnails%2Fuuid.jpg?alt=media"
  }
}
```

Use the returned `imageUrl` as the `thumbnailUrl` when creating or updating a course. **Choose between the two upload patterns based on where the file lives:**
- Use `POST /v1/media/upload` when the image file is already in the client and you want the server to handle the stream.
- Use `POST /v1/storage/upload-url` when you want the client to upload directly to GCS (a signed write URL is returned; the binary never passes through the backend).

### Resolve a media path to a view URL — `GET /v1/media/view?path=<filePath>`

Returns a redirect to a signed read URL by default. This lets clients render media using a backend URL while keeping storage provider details hidden behind backend contracts.

Query params:
- `path` (required): storage file path (currently restricted to `thumbnails/...`)
- `redirect` (optional): set to `0` to receive JSON instead of HTTP redirect

Default behavior (`redirect` omitted or not `0`):
- HTTP `302` redirect to signed URL

JSON behavior (`redirect=0`):
```json
{
  "success": true,
  "data": {
    "viewUrl": "https://...signed...",
    "filePath": "thumbnails/example.jpg"
  }
}
```

This endpoint validates path format and existence, then signs a read URL for 1 hour.

---

## Gamification — Points and Badges

Understanding the gamification system helps you build the right UI reactions at the right moments.

**Points** come from three sources:
- **Chapter completion** — `+10 points` on the first completion only. `pointsAwarded` is `0` on re-completions.
- **Quiz submission** — `+1 point per correct answer` on every submission including retakes.
- **Activity submission** — proportional points based on score vs `maxPoints`. Only the *improvement* over the student's previous best is credited to `totalPoints`. The response field `pointsEarned` is this delta; `earnedPoints` is the raw points scored this attempt.

**Badges** are strings stored in `users.badges` and awarded idempotently. Current badge IDs are:
- `newcomer`
- `first_step`
- `active_learner`
- `perfect_score`
- `top_3`
- `number_1`

`active_learner` and `perfect_score` can now be earned from both quiz submissions and gamification activity submissions — they are not exclusive to activities. `perfect_score` requires a 100% score on the submission that triggers it.

Action endpoints now return newly awarded badges as `earnedBadges` objects with metadata (`id`, `name`, `icon`, `color`) so clients can render UI immediately without extra lookup tables.

The recommended UI pattern for gamification feedback is to read points plus `earnedBadges` from the immediate response to drive animation/modal, then call `GET /auth/me` in the background to refresh global user totals and persistent badge array.

---

## Things That Will Catch You Off Guard

These are subtle behaviours that are easy to miss and hard to debug once you hit them.

**`questionText` not `question` when creating quizzes.** When your admin UI creates a quiz, the question text field must be sent as `questionText`. The student-facing GET response renames it to `question` during normalization, which can make it look like `question` is the right field name when you read the response — but it is not the right field name when you write. Writing `question` silently stores it, and students will then see blank questions.

**Quiz answers are positional integers, not objects.** The submit endpoint expects `{ "answers": [0, 2, 1] }` — not `[{ "questionId": 0, "answer": 0 }]`. The position in the array is the question identifier, and the value is the selected option index.

**`passed` means 100%, not "above passing grade".** The `passed` field in the quiz submit response is `true` only when every single question is correct. A quiz with a `passingGrade` of 8 out of 20 questions does not set `passed: true` at 8 correct — that field is exclusively for the perfect score state. You will need to implement your own passing grade logic on the frontend using `score` and `passingGrade` from the quiz document.

**`GET /auth/me` after gamification actions.** Submit/progress responses include immediate points fields (`pointsAwarded` or `pointsEarned`) and `earnedBadges`, but they do not return updated cumulative `totalPoints`. Call `GET /auth/me` after these actions to refresh totals shown in header/profile.

**Unpublished courses return `404`, not `403`.** If you are building an admin preview feature where an admin views an unpublished course as a student would, be aware that the non-admin path returns `404` for unpublished content — there is no way to distinguish "course does not exist" from "course exists but is unpublished" from the non-admin perspective. Use an admin token if the admin needs to preview unpublished content.

**Activity answer format is not uniform.** Unlike quiz answers (a flat integer array), each activity type has a different answer shape. `drag_drop` expects `{ "answers": { "<itemId>": "<category>" } }`. `word_search` expects `{ "answers": { "foundWords": ["WORD1", "WORD2"] } }`. `true_or_false` expects `{ "answers": { "<statementId>": true/false } }`. Sending the wrong shape will silently score every answer as incorrect.

**`pointsEarned` vs `earnedPoints` in activity submit.** The response contains both fields. `earnedPoints` is the points the student scored this attempt. `pointsEarned` is the delta actually added to `totalPoints` — only the improvement over their previous best. On a retake where the score dropped, `pointsEarned` is `0` even though `earnedPoints` is positive. Use `pointsEarned` to decide whether to show a "+N points" animation.

**Locked activities return `403 LOCKED`, not `403 FORBIDDEN`.** The error code is `LOCKED` rather than `FORBIDDEN`. Handle this separately in your UI — a locked activity should show a "complete the previous item first" prompt, not a generic access-denied message.

**`drag_drop` and `true_or_false` strip correct answers on GET, same as quizzes.** When a student fetches an activity, `correctCategory` is removed from drag-drop items and `correct` is removed from true-or-false statements. The full shape is only visible to admins. Don't rely on the GET response to pre-populate correct answers on the frontend.

**`progressPercentage` on `GET /v1/courses` is combined chapter+activity progress.** The field reflects how many total items (chapters + activities) have been completed, not just chapters. A course with 2 chapters done out of 2 chapters total but no activities done will not show `progressPercentage: 100` if the course has activities. Unauthenticated responses omit this field entirely — do not default it to `0` if it is absent, as that may indicate the user is simply not logged in.

**`percentage` in the progress response is combined, not chapters-only.** This changed in a recent backend update. If your UI previously displayed the progress percentage as chapter completion and treated activities separately, it may now show a lower percentage than expected for users who have not completed all activities. The progress bar should represent the full course completion, not just chapter reading.

**Certificate eligibility requires a perfect `bestScorePercent` on every activity, not just completion.** A student who has `completed: true` on all activities but whose `bestScorePercent` is less than 100 on any one of them will receive `403 CERTIFICATE_NOT_ELIGIBLE` when calling `POST /certificates`. The eligibility check uses `bestScorePercent === 100` — the normalised 0–100 percentage field, not the raw `bestScore` points field. Additionally, since the `percentage` gate is now combined, the student must also have completed all activities (not just chapters) before the progress check passes.

**Chapters, quizzes, and activities are not enrollment-gated.** Any authenticated student can read content from any published course — they do not need to be enrolled. The access gate on all content routes is `requirePublishedCourse` (course exists and `isPublished === true`), not enrollment. Enrollment is tracked in the database but is not currently enforced as an access gate.

**Enrollment endpoints are currently unreachable.** The enrollment router exists in the backend but is not mounted. All `/v1/enrollments/*` calls will return `404`. Wait for the backend fix before implementing enrollment UI flows. When the router is mounted, be aware that attempting to enroll in a course you are already enrolled in returns `409 CONFLICT`, not a silent success.

**Chapter `videoUrl` has been replaced by `mediaType` + `mediaUrl`.** If your code reads `chapter.videoUrl` to render a video, it will get `undefined` on any chapter created after this change. Switch to reading `chapter.mediaType` and `chapter.mediaUrl`. Existing chapters in older databases that still have `videoUrl` can be migrated using the `migrate-videourl-to-mediaurl.mjs` script — ask the backend team if you encounter chapters with missing media.

**`DELETE /v1/users/:uid` is a permanent hard delete.** Unlike many "delete" endpoints that soft-delete by setting `isActive: false`, this one removes the Firebase Auth record and all associated Firestore data immediately. There is no undo, no recycle bin, and no recovery path. Build a confirmation dialog in any admin UI that calls this endpoint.

**Quiz submissions now award `active_learner` and `perfect_score` badges.** Previously only gamification activities triggered these badges. Now quiz submissions trigger the same `activity_submitted` badge check. If your UI shows a badge notification only after activity submits, update it to also handle the `earnedBadges` array on quiz submit responses.
