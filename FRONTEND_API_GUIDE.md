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
- [Course Endpoints](#course-endpoints)
- [Chapter Endpoints](#chapter-endpoints)
- [Quiz Endpoints](#quiz-endpoints)
- [Activity Endpoints](#activity-endpoints)
- [Course Content Endpoint](#course-content-endpoint)
- [Progress Endpoints](#progress-endpoints) — mark complete, get progress, reset (dev only)
- [Enrollment Endpoints](#enrollment-endpoints)
- [Leaderboard Endpoint](#leaderboard-endpoint)
- [Storage Endpoints](#storage-endpoints)
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

Because the envelope is consistent, you can write a single wrapper function in your API client that checks `success` first and either returns `data` or throws an error using `error.code`. This is much cleaner than checking HTTP status codes in every individual API call.

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
// Response
{
  "success": true,
  "data": {
    "uid": "abc123xyz",
    "email": "student@example.com",
    "name": "Budi Santoso",
    "role": "student"
  }
}
```

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

## Course Endpoints

### List courses — `GET /v1/courses`

No token required. If the user is not authenticated, only published courses are returned. If the user is an admin, all courses (including unpublished) are returned. This means you can call this endpoint before the user logs in to show a course catalog.

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

All chapter routes are nested under `/v1/courses/:courseId/chapters`. Every student request to these routes requires the user to be **enrolled in the course** — unenrolled students receive a `403`.

### List chapters — `GET /v1/courses/:courseId/chapters`

Returns chapters ordered by the `order` field ascending. Each chapter includes `isPublished`, though the backend does not currently filter out unpublished chapters from this list — that filtering logic lives on the frontend.

### Mark a chapter complete — see [Progress Endpoints](#progress-endpoints)

Chapter completion is handled by the progress endpoint, not the chapters endpoint.

### Create a chapter — `POST /v1/courses/:courseId/chapters` *(admin only)*

The `isPublished` field controls visibility. It defaults to `false` if you omit it. The `isFree` field is **intentionally excluded** from this MVP — do not send it.

### Update a chapter — `PATCH /v1/courses/:courseId/chapters/:chapterId` *(admin only)*

Partial update. If you omit `isPublished` from the body, the existing value is preserved. This means you can safely update `title` without accidentally unpublishing a live chapter.

---

## Quiz Endpoints

All quiz routes are nested under `/v1/courses/:courseId/quizzes`. Student requests require enrollment in the course.

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
    "badges": ["perfect_score"],
    "answers": [
      { "questionId": "0", "correct": true },
      { "questionId": "1", "correct": true },
      { "questionId": "2", "correct": true }
    ]
  }
}
```

The `passed` field is `true` **only when the student answered every question correctly** (100%). It is `false` for any partial score, including 19 out of 20. Use this field to drive the perfect score UI state. The `pointsAwarded` field always equals `score` — one point per correct answer. Points are awarded on every submission including retakes, so a student who retakes a quiz earns points each time. The `badges` array contains only badges newly awarded on this specific submission — it will be empty on retakes where the badge was already earned previously.

After receiving a submit response, call `GET /auth/me` to refresh the user's full profile state so that `totalPoints` and `badges` are up to date in your UI.

---

## Activity Endpoints

All activity routes are nested under `/v1/courses/:courseId/activities`. Student requests require enrollment. Activities are stored in the `gamification` subcollection under a course document.

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

Response on success: `{ "activityId": "<newId>" }` with HTTP 201.

### Get an activity — `GET /v1/courses/:courseId/activities/:activityId`

Returns the activity. Requires enrollment. **Correct answer data is stripped for students** — the same pattern as quizzes:
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
    "maxPoints": 10,
    "scorePercent": 100,
    "earnedPoints": 10,
    "pointsEarned": 10,
    "isNewCompletion": true,
    "badges": [],
    "feedback": [
      { "id": "item1", "correct": true, "correctCategory": "Sosial" },
      { "id": "item2", "correct": true, "correctCategory": "Komersial" }
    ]
  }
}
```

**`score`** is the raw correct count. **`earnedPoints`** is the proportional points scored this attempt (`Math.round(score / total * maxPoints)`). **`pointsEarned`** is the delta actually added to `totalPoints` — only the improvement over the student's previous best score is credited. On a first attempt these two fields are equal; on a retake where the student scored lower than before, `pointsEarned` will be `0`.

`isNewCompletion` is `true` on the first submission only. Use it to decide whether to trigger a course-progress animation. The activity is marked `completed: true` on the first submission and stays that way regardless of future scores.

`feedback` shape differs by type:
- `drag_drop`: `[{ id, correct, correctCategory }]`
- `word_search`: `[{ word, found }]`
- `true_or_false`: `[{ id, correct, correctAnswer }]`

After receiving a submit response, call `GET /auth/me` to refresh the user's cumulative `totalPoints`.

### Update an activity — `PUT /v1/courses/:courseId/activities/:activityId` *(admin only)*

Partial update. Only include fields you want to change. The activity `type` cannot be changed. Type-specific fields are only accepted if they match the stored type — sending `wordList` to a `drag_drop` activity has no effect.

### Delete an activity — `DELETE /v1/courses/:courseId/activities/:activityId` *(admin only)*

Deletes the activity and **cascades**: all `activity_progress` documents for that activity are deleted in the same batch.

---

## Course Content Endpoint

### Get course content — `GET /v1/courses/:courseId/content`

Returns a unified, ordered list of all chapters and activities for a course. Requires enrollment. This is the primary endpoint for rendering the course sidebar or table of contents — it replaces calling `GET /chapters` and `GET /activities` separately.

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
// Response
{
  "success": true,
  "data": {
    "completedChapters": ["chapterIdAbc"],
    "percentage": 50,
    "pointsAwarded": 10,
    "badges": []
  }
}
```

The `pointsAwarded` field is `10` on the first completion of a chapter and `0` on any subsequent call with the same chapter. Use this field to decide whether to show a "+10 points" animation — if `pointsAwarded` is `0`, the user already completed this chapter before and you should not show the animation again. The `percentage` is an integer from 0 to 100 representing how many of the course's chapters have been completed.

### Get progress for a course — `GET /v1/courses/:courseId/progress`

Returns the user's progress for a course. If the user has not completed any chapters yet, returns an empty default rather than a `404` — so this endpoint is always safe to call without checking enrollment first.

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

## Enrollment Endpoints

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

## Gamification — Points and Badges

Understanding the gamification system helps you build the right UI reactions at the right moments.

**Points** come from three sources:
- **Chapter completion** — `+10 points` on the first completion only. `pointsAwarded` is `0` on re-completions.
- **Quiz submission** — `+1 point per correct answer` on every submission including retakes.
- **Activity submission** — proportional points based on score vs `maxPoints`. Only the *improvement* over the student's previous best is credited to `totalPoints`. The response field `pointsEarned` is this delta; `earnedPoints` is the raw points scored this attempt.

**Badges** are strings stored in an array on the user profile. There are currently two badges. The `perfect_score` badge is awarded when a quiz submission has `passed: true` (100% score). The `top_3` badge is awarded when the user's `totalPoints` rank is within the top 3 on the leaderboard after any point increment. Both badges are idempotent — they are awarded exactly once and never duplicated, so you can safely check for their presence in `users.badges` without worrying about counting duplicates.

Activity submissions also invoke badge checks via `activity_submitted` and `activity_perfect` events — these badge rules are not yet implemented but will be added without changing the response shape.

The recommended UI pattern for gamification feedback is to read the points and `badges` fields from the immediate response to drive the animation or modal, then call `GET /auth/me` in the background to refresh the global user state so the header or profile page shows the updated totals.

---

## Things That Will Catch You Off Guard

These are subtle behaviours that are easy to miss and hard to debug once you hit them.

**`questionText` not `question` when creating quizzes.** When your admin UI creates a quiz, the question text field must be sent as `questionText`. The student-facing GET response renames it to `question` during normalization, which can make it look like `question` is the right field name when you read the response — but it is not the right field name when you write. Writing `question` silently stores it, and students will then see blank questions.

**Quiz answers are positional integers, not objects.** The submit endpoint expects `{ "answers": [0, 2, 1] }` — not `[{ "questionId": 0, "answer": 0 }]`. The position in the array is the question identifier, and the value is the selected option index.

**`passed` means 100%, not "above passing grade".** The `passed` field in the quiz submit response is `true` only when every single question is correct. A quiz with a `passingGrade` of 8 out of 20 questions does not set `passed: true` at 8 correct — that field is exclusively for the perfect score state. You will need to implement your own passing grade logic on the frontend using `score` and `passingGrade` from the quiz document.

**`GET /auth/me` after gamification actions.** The submit and progress responses return `pointsAwarded` and `badges` for the immediate action, but they do not return the updated `totalPoints` cumulative value. Call `GET /auth/me` after these actions to get the updated total for display in the header or profile.

**Unpublished courses return `404`, not `403`.** If you are building an admin preview feature where an admin views an unpublished course as a student would, be aware that the non-admin path returns `404` for unpublished content — there is no way to distinguish "course does not exist" from "course exists but is unpublished" from the non-admin perspective. Use an admin token if the admin needs to preview unpublished content.

**Activity answer format is not uniform.** Unlike quiz answers (a flat integer array), each activity type has a different answer shape. `drag_drop` expects `{ "answers": { "<itemId>": "<category>" } }`. `word_search` expects `{ "answers": { "foundWords": ["WORD1", "WORD2"] } }`. `true_or_false` expects `{ "answers": { "<statementId>": true/false } }`. Sending the wrong shape will silently score every answer as incorrect.

**`pointsEarned` vs `earnedPoints` in activity submit.** The response contains both fields. `earnedPoints` is the points the student scored this attempt. `pointsEarned` is the delta actually added to `totalPoints` — only the improvement over their previous best. On a retake where the score dropped, `pointsEarned` is `0` even though `earnedPoints` is positive. Use `pointsEarned` to decide whether to show a "+N points" animation.

**Locked activities return `403 LOCKED`, not `403 FORBIDDEN`.** The error code is `LOCKED` rather than `FORBIDDEN`. Handle this separately in your UI — a locked activity should show a "complete the previous item first" prompt, not a generic access-denied message.

**`drag_drop` and `true_or_false` strip correct answers on GET, same as quizzes.** When a student fetches an activity, `correctCategory` is removed from drag-drop items and `correct` is removed from true-or-false statements. The full shape is only visible to admins. Don't rely on the GET response to pre-populate correct answers on the frontend.
