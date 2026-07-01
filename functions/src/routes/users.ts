import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {
  adminAuth, adminDb, normalizeFirestoreData,
} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {requireRole} from "../middleware/requireRole.js";
import {checkAndAwardBadges} from "../utils/badges.js";
import {resolveChatbotEnabled} from "../utils/chatbotAccess.js";
import {createEnrollmentIfAbsent} from "../utils/enrollment.js";
import {success, error} from "../utils/response.js";

const router = Router();

// All user-management routes require admin
router.use(verifyToken, requireRole("admin"));

// GET /users — list all users with optional filters
router.get("/", async (req, res) => {
  try {
    const {role, search} = req.query as {
      role?: string;
      search?: string;
    };

    let query: FirebaseFirestore.Query = adminDb.collection("users");
    if (role) {
      query = query.where("role", "==", role);
    }

    const snapshot = await query.get();
    let users: Array<Record<string, unknown>> = snapshot.docs.map(
      (docSnap) => {
        const data = normalizeFirestoreData(
          docSnap.data()
        ) as Record<string, unknown>;
        return {
          uid: docSnap.id,
          ...data,
          chatbotEnabled: resolveChatbotEnabled(data.role as string | undefined, data.chatbotEnabled),
        };
      }
    );

    if (search) {
      const s = search.toLowerCase();
      users = users.filter((u) => {
        const n = String(u["name"] || "").toLowerCase();
        const e = String(u["email"] || "").toLowerCase();
        return n.includes(s) || e.includes(s);
      });
    }

    res.json(success(users));
  } catch {
    res.status(500).json(error("FETCH_FAILED", "Failed to fetch users"));
  }
});

// GET /users/:uid
router.get("/:uid", async (req, res) => {
  try {
    const {uid} = req.params;
    const docSnap = await adminDb.collection("users").doc(uid).get();

    if (!docSnap.exists) {
      res.status(404).json(error("NOT_FOUND", "User not found"));
      return;
    }

    const data = normalizeFirestoreData(docSnap.data()) as Record<string, unknown>;
    res.json(success({
      uid: docSnap.id,
      ...data,
      chatbotEnabled: resolveChatbotEnabled(data.role as string | undefined, data.chatbotEnabled),
    }));
  } catch {
    res.status(500).json(error("FETCH_FAILED", "Failed to fetch user"));
  }
});

// PATCH /users/:uid
router.patch("/:uid", async (req, res) => {
  try {
    const {uid} = req.params;
    const {name, email, totalPoints, chatbotEnabled} = req.body as {
      name?: string;
      email?: string;
      totalPoints?: number;
      chatbotEnabled?: boolean;
    };

    const updates: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    if (totalPoints !== undefined) updates.totalPoints = totalPoints;
    if (chatbotEnabled !== undefined) {
      if (typeof chatbotEnabled !== "boolean") {
        res.status(400).json(error("BAD_REQUEST", "chatbotEnabled must be a boolean"));
        return;
      }
      updates.chatbotEnabled = chatbotEnabled;
    }

    await adminDb.collection("users").doc(uid).update(updates);

    if (email) await adminAuth.updateUser(uid, {email});
    if (name) await adminAuth.updateUser(uid, {displayName: name});

    const updated = await adminDb.collection("users").doc(uid).get();
    const updatedData = normalizeFirestoreData(updated.data()) as Record<string, unknown>;
    res.json(success({
      uid: updated.id,
      ...updatedData,
      chatbotEnabled: resolveChatbotEnabled(updatedData.role as string | undefined, updatedData.chatbotEnabled),
    }));
  } catch {
    res.status(500).json(
      error("UPDATE_FAILED", "Failed to update user")
    );
  }
});

// DELETE /users/:uid — hard-delete from Auth + cascade Firestore cleanup
router.delete("/:uid", async (req, res) => {
  const {uid} = req.params;
  try {
    await adminAuth.deleteUser(uid);

    const COLLECTIONS = [
      "enrollments",
      "progress",
      "quiz_results",
      "activity_progress",
      "certificates",
    ];

    const refs: FirebaseFirestore.DocumentReference[] = [
      adminDb.collection("users").doc(uid),
    ];

    for (const col of COLLECTIONS) {
      const snap = await adminDb
        .collection(col)
        .where("userId", "==", uid)
        .get();
      snap.docs.forEach((d) => refs.push(d.ref));
    }

    const CHUNK = 499;
    for (let i = 0; i < refs.length; i += CHUNK) {
      const batch = adminDb.batch();
      refs.slice(i, i + CHUNK).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }

    res.json(success({uid}));
  } catch (err) {
    console.error("[DELETE user]", uid, err);
    res.status(500).json(error("DELETE_FAILED", "Failed to delete user"));
  }
});

// POST /users/upsert — backward-compatible upsert
router.post("/upsert", async (req, res) => {
  const {uid, email, displayName} = req.body as {
    uid?: string;
    email?: string;
    displayName?: string;
  };

  if (!uid || !email) {
    res.status(400).json(
      error("BAD_REQUEST", "uid and email are required")
    );
    return;
  }

  try {
    const userRef = adminDb.collection("users").doc(uid);
    const existing = await userRef.get();

    if (!existing.exists) {
      await userRef.set({
        uid,
        email,
        name: displayName || email.split("@")[0],
        role: "student",
        totalPoints: 0,
        isActive: true,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      await userRef.set(
        {
          email,
          name: displayName || existing.data()?.name || "",
          updatedAt: FieldValue.serverTimestamp(),
        },
        {merge: true}
      );
    }

    const latest = await userRef.get();
    res.json(success({
      uid: latest.id,
      ...(normalizeFirestoreData(latest.data()) as Record<string, unknown>),
    }));
  } catch {
    res.status(500).json(
      error("UPSERT_FAILED", "Failed to upsert user profile")
    );
  }
});

// PRD14 — Batch Register: max rows per upload, kept well under the
// 60s function timeout when combined with the concurrency cap below.
const MAX_BATCH_ROWS = 100;
const BATCH_CONCURRENCY = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type BatchStudentRow = {
  name?: string;
  email?: string;
  password?: string;
  courseId?: string;
};

// PRD20 — Batch Enrollment: per-row enrollment outcome, independent of the
// registration outcome above. Present only when the row carried a courseId.
type BatchEnrollmentResult = {
  courseId: string;
  status: "enrolled" | "already_enrolled" | "course_not_found" | "failed";
  reason?: string;
};

type BatchResultRow = {
  email: string;
  status: "created" | "skipped" | "failed";
  uid?: string;
  reason?: string;
  enrollment?: BatchEnrollmentResult;
};

// Runs `fn` over `items` with at most `limit` in flight at once —
// bounded concurrency avoids both Auth rate limits (full parallel)
// and the function timeout (full serial) for large batches.
const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };

  const workers = Array.from(
    {length: Math.min(limit, items.length)},
    () => worker()
  );
  await Promise.all(workers);
  return results;
};

// POST /users/batch — PRD14 batch register (admin-only, via router.use above)
// + PRD20 batch enrollment: an optional per-row `courseId` enrolls the
// resulting (created or pre-existing) uid into that course, admin-bypass
// (ignores isPublished/accessTier), raw `enrollments` doc only.
router.post("/batch", async (req, res) => {
  const {students, defaultPassword} = req.body as {
    students?: BatchStudentRow[];
    defaultPassword?: string;
  };

  if (!Array.isArray(students) || students.length === 0) {
    res.status(400).json(
      error("BAD_REQUEST", "students must be a non-empty array")
    );
    return;
  }

  if (students.length > MAX_BATCH_ROWS) {
    res.status(400).json(
      error("BATCH_TOO_LARGE", `Max ${MAX_BATCH_ROWS} students per upload`)
    );
    return;
  }

  const createdBy = req.user!.uid;

  try {
    // PRD20 — prefetch distinct course validity once, before the per-row
    // loop, instead of re-reading the same course once per row.
    const distinctCourseIds = Array.from(
      new Set(
        students
          .map((r) => r.courseId?.trim())
          .filter((id): id is string => Boolean(id))
      )
    );

    const courseValid = new Map<string, boolean>();
    if (distinctCourseIds.length > 0) {
      const refs = distinctCourseIds.map((id) => adminDb.collection("courses").doc(id));
      const snaps = await adminDb.getAll(...refs);
      snaps.forEach((snap, i) => courseValid.set(distinctCourseIds[i], snap.exists));
    }

    const results = await mapWithConcurrency(
      students,
      BATCH_CONCURRENCY,
      async (row): Promise<BatchResultRow> => {
        const email = (row.email || "").trim();
        const courseId = row.courseId?.trim() || undefined;

        // PRD20 — enrolls whichever uid the registration step resolves to
        // (created or pre-existing/skipped); never runs for failed rows.
        const enrollIfNeeded = async (
          uid: string | undefined
        ): Promise<BatchEnrollmentResult | undefined> => {
          if (!courseId) return undefined;
          if (!uid) return {courseId, status: "failed", reason: "No account to enroll"};
          if (!courseValid.get(courseId)) {
            return {courseId, status: "course_not_found"};
          }
          try {
            const enrollResult = await createEnrollmentIfAbsent(uid, courseId);
            return {
              courseId,
              status: enrollResult.created ? "enrolled" : "already_enrolled",
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to enroll";
            return {courseId, status: "failed", reason: msg};
          }
        };

        if (!email || !EMAIL_RE.test(email)) {
          return {email: email || "(missing)", status: "failed", reason: "Invalid or missing email"};
        }

        const password = (row.password || defaultPassword || "").trim();
        if (!password) {
          return {email, status: "failed", reason: "Missing password"};
        }

        const displayName = row.name?.trim() || email.split("@")[0];

        try {
          const userRecord = await adminAuth.createUser({
            email,
            password,
            displayName,
          });

          await adminAuth.setCustomUserClaims(userRecord.uid, {role: "student"});

          await adminDb.collection("users").doc(userRecord.uid).set({
            name: displayName,
            email,
            role: "student",
            totalPoints: 0,
            isActive: true,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            createdVia: "batch",
            createdBy,
          });

          await checkAndAwardBadges(userRecord.uid, adminDb, {type: "account_created"});

          const enrollment = await enrollIfNeeded(userRecord.uid);
          return {email, status: "created", uid: userRecord.uid, enrollment};
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Failed to create user";
          if (/already exists/i.test(msg)) {
            let uid: string | undefined;
            try {
              uid = (await adminAuth.getUserByEmail(email)).uid;
            } catch {
              uid = undefined;
            }
            const enrollment = await enrollIfNeeded(uid);
            return {email, status: "skipped", reason: "Email already registered", uid, enrollment};
          }
          return {email, status: "failed", reason: msg};
        }
      }
    );

    const summary = results.reduce(
      (acc, r) => {
        acc.total++;
        acc[r.status]++;
        if (r.enrollment) {
          if (r.enrollment.status === "enrolled") acc.enrolled++;
          else if (r.enrollment.status === "already_enrolled") acc.alreadyEnrolled++;
          else acc.enrollFailed++;
        }
        return acc;
      },
      {
        total: 0, created: 0, skipped: 0, failed: 0,
        enrolled: 0, alreadyEnrolled: 0, enrollFailed: 0,
      }
    );

    res.status(201).json(success({summary, results}));
  } catch (err) {
    console.error("[POST /users/batch]", {uid: createdBy, rows: students.length}, err);
    res.status(500).json(error("BATCH_FAILED", "Failed to process batch registration"));
  }
});

export default router;
