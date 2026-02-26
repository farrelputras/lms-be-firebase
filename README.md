# Literasi Syariah LMS — API Documentation

**Base URL:** `https://<project-region>-<project-id>.cloudfunctions.net/api`  
**API Version:** `v1`  
**Content-Type:** `application/json`

---

## Table of Contents

- [Response Format](#response-format)
- [Authentication](#authentication)
- [Health Check](#health-check)
- [Auth](#auth)
- [Users (Admin)](#users-admin)
- [Courses](#courses)
- [Chapters](#chapters)
- [Quizzes](#quizzes)
- [Enrollments](#enrollments)
- [Progress](#progress)
- [Storage](#storage)
- [Leaderboard](#leaderboard)
- [Error Codes](#error-codes)

---

## Response Format

All endpoints return a consistent JSON shape.

**Success:**

```json
{
  "success": true,
  "data": { ... }
}
```

**Error:**

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}
```

---

## Authentication

Most endpoints require a Firebase Auth ID token passed in the `Authorization` header:

```
Authorization: Bearer <firebase_id_token>
```

The token is verified server-side. The decoded user object (`uid`, `email`, `role`) is attached to the request context. Roles are managed via Firebase custom claims and Firestore.

| Role         | Description                          |
| ------------ | ------------------------------------ |
| `student`    | Default role. Can enroll, learn, take quizzes |
| `admin`      | Full access. Manage users, courses, content |
| `instructor` | Assignable role for future use       |

Legend used below:
- 🔓 **Public** — no auth required
- 🔑 **Auth** — any authenticated user
- 🛡️ **Admin** — requires `admin` role
- 📚 **Enrolled** — requires enrollment in the course (admins bypass)

---

## Health Check

### `GET /health`

🔓 Public

Returns service health status.

**Response:**

```json
{ "ok": true, "service": "lms-be-firebase" }
```

---

## Auth

### `POST /v1/auth/register`

🔓 Public

Creates a new Firebase Auth user and Firestore user profile.

**Request Body:**

| Field      | Type   | Required | Description                       |
| ---------- | ------ | -------- | --------------------------------- |
| `email`    | string | ✅       | User email                        |
| `password` | string | ✅       | User password                     |
| `name`     | string | ❌       | Display name (defaults to email prefix) |

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "uid": "abc123",
    "email": "user@example.com",
    "name": "user",
    "role": "student"
  }
}
```

---

### `POST /v1/auth/assign-role`

🛡️ Admin

Assigns a role to a user via Firebase custom claims and updates Firestore.

**Request Body:**

| Field  | Type   | Required | Description                                    |
| ------ | ------ | -------- | ---------------------------------------------- |
| `uid`  | string | ✅       | Target user's UID                              |
| `role` | string | ✅       | One of: `student`, `admin`, `instructor`       |

**Response `200`:**

```json
{
  "success": true,
  "data": { "uid": "abc123", "role": "admin" }
}
```

---

### `GET /v1/auth/me`

🔑 Auth

Returns the current authenticated user's Firestore profile.

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "uid": "abc123",
    "name": "Ahmad",
    "email": "ahmad@example.com",
    "role": "student",
    "totalPoints": 150,
    "isActive": true,
    "createdAt": "2026-01-15T10:30:00.000Z"
  }
}
```

---

## Users (Admin)

> All endpoints in this section require **Admin** authentication.

### `GET /v1/users`

🛡️ Admin

List all users with optional filtering.

**Query Parameters:**

| Param    | Type   | Description                             |
| -------- | ------ | --------------------------------------- |
| `role`   | string | Filter by role (`student`, `admin`, `instructor`) |
| `search` | string | Search by name or email (case-insensitive) |

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "uid": "abc123",
      "name": "Ahmad",
      "email": "ahmad@example.com",
      "role": "student",
      "totalPoints": 150,
      "isActive": true
    }
  ]
}
```

---

### `GET /v1/users/:uid`

🛡️ Admin

Get a single user profile.

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "uid": "abc123",
    "name": "Ahmad",
    "email": "ahmad@example.com",
    "role": "student",
    "totalPoints": 150,
    "isActive": true
  }
}
```

---

### `PATCH /v1/users/:uid`

🛡️ Admin

Update user profile fields. Also synchronizes changes with Firebase Auth.

**Request Body:**

| Field   | Type   | Required | Description       |
| ------- | ------ | -------- | ----------------- |
| `name`  | string | ❌       | Updated name      |
| `email` | string | ❌       | Updated email     |

**Response `200`:** Updated user object.

---

### `DELETE /v1/users/:uid`

🛡️ Admin

Disables the Firebase Auth account and marks the Firestore document as inactive.

**Response `200`:**

```json
{
  "success": true,
  "data": { "uid": "abc123", "isActive": false }
}
```

---

### `POST /v1/users/upsert`

🛡️ Admin

Create or update a user profile (backward-compatible endpoint).

**Request Body:**

| Field         | Type   | Required | Description                     |
| ------------- | ------ | -------- | ------------------------------- |
| `uid`         | string | ✅       | Firebase Auth UID               |
| `email`       | string | ✅       | User email                      |
| `displayName` | string | ❌       | Display name                    |

**Response `200`:** Full user profile object.

---

## Courses

### `GET /v1/courses`

🔓 Public (optional auth)

List all published courses. Admins with a valid token see all courses (including unpublished).

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "id": "courseId1",
      "title": "Dasar Ekonomi Syariah",
      "description": "Introduction to Islamic economics",
      "thumbnailUrl": "https://...",
      "isPublished": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-10T00:00:00.000Z"
    }
  ]
}
```

---

### `GET /v1/courses/:courseId`

🔓 Public

Get course detail by ID.

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "id": "courseId1",
    "title": "Dasar Ekonomi Syariah",
    "description": "...",
    "thumbnailUrl": "https://...",
    "isPublished": true,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-10T00:00:00.000Z"
  }
}
```

---

### `POST /v1/courses`

🛡️ Admin

Create a new course.

**Request Body:**

| Field          | Type    | Required | Description                        |
| -------------- | ------- | -------- | ---------------------------------- |
| `title`        | string  | ✅       | Course title                       |
| `description`  | string  | ❌       | Course description                 |
| `thumbnailUrl` | string  | ❌       | Thumbnail image URL                |
| `isPublished`  | boolean | ❌       | Publish status (default: `false`)  |

**Response `201`:** Created course object.

---

### `PATCH /v1/courses/:courseId`

🛡️ Admin

Update course metadata. Only provided fields are updated.

**Request Body:** Same fields as `POST` (all optional).

**Response `200`:** Updated course object.

---

### `DELETE /v1/courses/:courseId`

🛡️ Admin

Delete a course.

**Response `200`:**

```json
{
  "success": true,
  "data": { "id": "courseId1", "deleted": true }
}
```

---

## Chapters

### `GET /v1/courses/:courseId/chapters`

📚 Enrolled / 🛡️ Admin

List all chapters for a course, ordered by `order` field.

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "id": "chapterId1",
      "title": "Pengantar",
      "content": "...",
      "videoUrl": "https://...",
      "order": 1,
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### `GET /v1/courses/:courseId/chapters/:chapterId`

📚 Enrolled / 🛡️ Admin

Get a single chapter's full content.

**Response `200`:** Single chapter object.

---

### `POST /v1/courses/:courseId/chapters`

🛡️ Admin

Create a new chapter.

**Request Body:**

| Field      | Type   | Required | Description                     |
| ---------- | ------ | -------- | ------------------------------- |
| `title`    | string | ✅       | Chapter title                   |
| `content`  | string | ❌       | Chapter content (HTML/markdown) |
| `videoUrl` | string | ❌       | Video URL                       |
| `order`    | number | ❌       | Sort order (default: `0`)       |

**Response `201`:** Created chapter object.

---

### `PATCH /v1/courses/:courseId/chapters/:chapterId`

🛡️ Admin

Update chapter fields.

**Request Body:** Same fields as `POST` (all optional).

**Response `200`:** Updated chapter object.

---

### `DELETE /v1/courses/:courseId/chapters/:chapterId`

🛡️ Admin

Delete a chapter.

**Response `200`:**

```json
{
  "success": true,
  "data": { "id": "chapterId1", "deleted": true }
}
```

---

## Quizzes

### `GET /v1/courses/:courseId/quizzes`

📚 Enrolled / 🛡️ Admin

List all quizzes for a course. `correctAnswer` is stripped from questions for non-admin users.

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "id": "quizId1",
      "title": "Quiz Bab 1",
      "questions": [
        {
          "question": "Apa itu riba?",
          "options": ["Bunga bank", "Zakat", "Sedekah", "Wakaf"]
        }
      ]
    }
  ]
}
```

> **Note:** Admin users will also see `correctAnswer` (number index) in each question object.

---

### `GET /v1/courses/:courseId/quizzes/:quizId`

📚 Enrolled / 🛡️ Admin

Get a single quiz. `correctAnswer` stripped for non-admins.

**Response `200`:** Single quiz object.

---

### `POST /v1/courses/:courseId/quizzes`

🛡️ Admin

Create a quiz with a questions array.

**Request Body:**

| Field       | Type            | Required | Description      |
| ----------- | --------------- | -------- | ---------------- |
| `title`     | string          | ✅       | Quiz title       |
| `questions` | QuizQuestion[]  | ✅       | Array of questions |

**QuizQuestion schema:**

| Field           | Type     | Description                       |
| --------------- | -------- | --------------------------------- |
| `question`      | string   | The question text                 |
| `options`       | string[] | Array of answer options           |
| `correctAnswer` | number   | Index of the correct option (0-based) |

**Response `201`:** Created quiz object.

---

### `PATCH /v1/courses/:courseId/quizzes/:quizId`

🛡️ Admin

Update quiz title and/or questions.

**Response `200`:** Updated quiz object (includes `correctAnswer`).

---

### `DELETE /v1/courses/:courseId/quizzes/:quizId`

🛡️ Admin

Delete a quiz.

**Response `200`:**

```json
{
  "success": true,
  "data": { "id": "quizId1", "deleted": true }
}
```

---

### `POST /v1/courses/:courseId/quizzes/:quizId/submit`

📚 Enrolled

Submit answers to a quiz. The server calculates the score and saves the result.

**Request Body:**

| Field     | Type     | Required | Description                                    |
| --------- | -------- | -------- | ---------------------------------------------- |
| `answers` | number[] | ✅       | Array of selected option indices (0-based), one per question |

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "id": "resultId1",
    "userId": "abc123",
    "courseId": "courseId1",
    "quizId": "quizId1",
    "answers": [0, 2, 1],
    "score": 67,
    "correctCount": 2,
    "totalQuestions": 3,
    "submittedAt": null
  }
}
```

---

## Enrollments

> All endpoints require authentication.

### `POST /v1/enrollments`

🔑 Auth

Enroll the current user in a course. Prevents duplicate enrollments.

**Request Body:**

| Field      | Type   | Required | Description |
| ---------- | ------ | -------- | ----------- |
| `courseId`  | string | ✅       | Course ID   |

**Response `201`:**

```json
{
  "success": true,
  "data": {
    "id": "enrollmentId1",
    "userId": "abc123",
    "courseId": "courseId1",
    "enrolledAt": null
  }
}
```

**Error `409`:** Already enrolled.

---

### `GET /v1/enrollments/my`

🔑 Auth

Get all courses the current user is enrolled in.

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "id": "enrollmentId1",
      "userId": "abc123",
      "courseId": "courseId1",
      "enrolledAt": "2026-01-15T10:30:00.000Z"
    }
  ]
}
```

---

### `GET /v1/enrollments/:courseId/status`

🔑 Auth

Check if the current user is enrolled in a specific course.

**Response `200`:**

```json
{
  "success": true,
  "data": { "enrolled": true }
}
```

---

## Progress

> All endpoints require authentication.

### `POST /v1/progress`

🔑 Auth

Mark a chapter as completed. Automatically calculates completion percentage.

**Request Body:**

| Field       | Type   | Required | Description |
| ----------- | ------ | -------- | ----------- |
| `courseId`   | string | ✅       | Course ID   |
| `chapterId` | string | ✅       | Chapter ID  |

**Response `200` / `201`:**

```json
{
  "success": true,
  "data": {
    "id": "uid_courseId",
    "userId": "abc123",
    "courseId": "courseId1",
    "completedChapters": ["chapterId1", "chapterId2"],
    "percentage": 67
  }
}
```

> Returns `201` if this is the first progress record for the user-course pair, `200` if updating.

---

### `GET /v1/progress/:courseId`

🔑 Auth

Get the current user's progress for a specific course.

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "id": "uid_courseId",
    "userId": "abc123",
    "courseId": "courseId1",
    "completedChapters": ["chapterId1"],
    "percentage": 33
  }
}
```

> Returns `completedChapters: []` and `percentage: 0` if no progress exists.

---

## Storage

> All endpoints require authentication.

### `POST /v1/storage/upload-url`

🛡️ Admin

Generate a signed upload URL for Firebase Storage (valid for 15 minutes).

**Request Body:**

| Field         | Type   | Required | Description                              |
| ------------- | ------ | -------- | ---------------------------------------- |
| `fileName`    | string | ✅       | File name                                |
| `contentType` | string | ✅       | MIME type (e.g. `image/png`)             |
| `folder`      | string | ❌       | Storage folder (e.g. `courses`, `chapters`) |

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "uploadUrl": "https://storage.googleapis.com/...",
    "filePath": "courses/image.png"
  }
}
```

---

### `GET /v1/storage/download-url/:fileId`

🔑 Auth

Generate a signed download URL (valid for 1 hour).

**Query Parameters:**

| Param  | Type   | Description                                   |
| ------ | ------ | --------------------------------------------- |
| `path` | string | Full file path in storage (overrides `:fileId`) |

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "downloadUrl": "https://storage.googleapis.com/...",
    "filePath": "courses/image.png"
  }
}
```

---

## Leaderboard

### `GET /v1/leaderboard`

🔓 Public

Get all users sorted by total points in descending order.

**Response `200`:**

```json
{
  "success": true,
  "data": [
    { "uid": "abc123", "name": "Ahmad", "totalPoints": 500 },
    { "uid": "def456", "name": "Fatimah", "totalPoints": 350 }
  ]
}
```

---

## Error Codes

| HTTP Status | Code                   | Description                              |
| ----------- | ---------------------- | ---------------------------------------- |
| `400`       | `BAD_REQUEST`          | Missing or invalid request parameters    |
| `401`       | `UNAUTHORIZED`         | Missing, invalid, or expired auth token  |
| `403`       | `FORBIDDEN`            | Insufficient role/permissions or not enrolled |
| `404`       | `NOT_FOUND`            | Requested resource does not exist        |
| `409`       | `CONFLICT`             | Duplicate enrollment                     |
| `500`       | `REGISTER_FAILED`      | User registration error                  |
| `500`       | `ASSIGN_ROLE_FAILED`   | Role assignment error                    |
| `500`       | `FETCH_FAILED`         | Database read error                      |
| `500`       | `CREATE_FAILED`        | Database write error                     |
| `500`       | `UPDATE_FAILED`        | Database update error                    |
| `500`       | `DELETE_FAILED`        | Database delete error                    |
| `500`       | `ENROLL_FAILED`        | Enrollment error                         |
| `500`       | `UPSERT_FAILED`        | User upsert error                        |
| `500`       | `PROGRESS_FAILED`      | Progress update error                    |
| `500`       | `SUBMIT_FAILED`        | Quiz submission error                    |
| `500`       | `UPLOAD_URL_FAILED`    | Storage upload URL generation error      |
| `500`       | `DOWNLOAD_URL_FAILED`  | Storage download URL generation error    |
| `500`       | `ENROLLMENT_CHECK_FAILED` | Enrollment verification error         |
