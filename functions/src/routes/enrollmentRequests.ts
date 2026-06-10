import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {adminDb, normalizeFirestoreData} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {requireRole} from "../middleware/requireRole.js";
import {success, error} from "../utils/response.js";
import {createEnrollmentIfAbsent} from "../utils/enrollment.js";

const router = Router();

// All routes require authentication
router.use(verifyToken);

// ---------------------------------------------------------------------------
// POST /enrollment-requests — student submits a premium access request
// ---------------------------------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const uid = req.user!.uid;
    const {courseId} = req.body as {courseId?: string};

    if (!courseId) {
      res.status(400).json(error("BAD_REQUEST", "courseId is required"));
      return;
    }

    // Validate course: must exist, published, and premium
    const courseSnap = await adminDb.collection("courses").doc(courseId).get();
    if (!courseSnap.exists) {
      res.status(404).json(error("NOT_FOUND", "Course not found"));
      return;
    }

    const courseData = courseSnap.data() as {
      isPublished?: boolean;
      accessTier?: string;
    };

    if (courseData.isPublished !== true) {
      res.status(404).json(error("NOT_FOUND", "Course not found"));
      return;
    }

    if (courseData.accessTier !== "premium") {
      res.status(400).json(
        error("BAD_REQUEST", "This course does not require an enrollment request")
      );
      return;
    }

    // Already enrolled? Return 409
    const enrollmentSnap = await adminDb
      .collection("enrollments")
      .where("userId", "==", uid)
      .where("courseId", "==", courseId)
      .limit(1)
      .get();

    if (!enrollmentSnap.empty) {
      res.status(409).json(
        error("ALREADY_ENROLLED", "You are already enrolled in this course")
      );
      return;
    }

    // Composite ID: one request doc per student per course (idempotency key)
    const docId = `${uid}_${courseId}`;
    const docRef = adminDb.collection("enrollment_requests").doc(docId);
    const existingSnap = await docRef.get();

    // Idempotent: pending request already exists — return it as-is
    if (existingSnap.exists) {
      const existing = existingSnap.data() as {status?: string};
      if (existing.status === "pending") {
        res.status(200).json(success({
          id: docId,
          ...(normalizeFirestoreData(existingSnap.data()) as Record<string, unknown>),
        }));
        return;
      }
    }

    // Create or overwrite (re-request after decline resets to pending)
    const requestData = {
      userId: uid,
      courseId,
      status: "pending",
      requestedAt: FieldValue.serverTimestamp(),
    };

    await docRef.set(requestData);

    // Return 201 for new request (or re-request after decline)
    res.status(201).json(success({
      id: docId,
      ...requestData,
    }));
  } catch (err: unknown) {
    console.error({
      route: "POST /enrollment-requests",
      uid: req.user?.uid,
      courseId: (req.body as {courseId?: string})?.courseId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json(
      error("REQUEST_FAILED", "Failed to submit enrollment request")
    );
  }
});

// ---------------------------------------------------------------------------
// GET /enrollment-requests/me — student views their own requests
// ---------------------------------------------------------------------------
router.get("/me", async (req, res) => {
  try {
    const uid = req.user!.uid;

    // Single-field filter — no composite index required
    const snapshot = await adminDb
      .collection("enrollment_requests")
      .where("userId", "==", uid)
      .get();

    // Sort in memory by requestedAt desc (avoids forcing an index on userId + requestedAt)
    const requests = snapshot.docs
      .map((docSnap) => ({
        id: docSnap.id,
        ...(normalizeFirestoreData(docSnap.data()) as Record<string, unknown>),
      } as Record<string, unknown> & {id: string}))
      .sort((a, b) => {
        const aTime = (a.requestedAt as number | null) ?? 0;
        const bTime = (b.requestedAt as number | null) ?? 0;
        return bTime - aTime;
      });

    res.json(success(requests));
  } catch (err: unknown) {
    console.error({
      route: "GET /enrollment-requests/me",
      uid: req.user?.uid,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json(
      error("FETCH_FAILED", "Failed to fetch enrollment requests")
    );
  }
});

// ---------------------------------------------------------------------------
// GET /enrollment-requests — admin: pending queue (or by status)
// ---------------------------------------------------------------------------
router.get("/", requireRole("admin"), async (req, res) => {
  try {
    const status = (req.query.status as string | undefined) || "pending";

    // Uses composite index: (status ASC, requestedAt DESC) in firestore.indexes.json
    const snapshot = await adminDb
      .collection("enrollment_requests")
      .where("status", "==", status)
      .orderBy("requestedAt", "desc")
      .get();

    const requests = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...(normalizeFirestoreData(docSnap.data()) as Record<string, unknown>),
    }));

    res.json(success(requests));
  } catch (err: unknown) {
    console.error({
      route: "GET /enrollment-requests",
      uid: req.user?.uid,
      status: req.query.status,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json(
      error("FETCH_FAILED", "Failed to fetch enrollment requests")
    );
  }
});

// ---------------------------------------------------------------------------
// POST /enrollment-requests/:id/approve — admin approves a request
// ---------------------------------------------------------------------------
router.post("/:id/approve", requireRole("admin"), async (req, res) => {
  try {
    const id = req.params.id as string;
    const adminUid = req.user!.uid;

    const docRef = adminDb.collection("enrollment_requests").doc(id);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      res.status(404).json(error("NOT_FOUND", "Enrollment request not found"));
      return;
    }

    const requestData = docSnap.data() as {
      userId?: string;
      courseId?: string;
      status?: string;
    };

    const {userId, courseId} = requestData;

    if (!userId || !courseId) {
      res.status(500).json(
        error("ENROLLMENT_GATE_FAILED", "Request document is missing userId or courseId")
      );
      return;
    }

    // Create enrollment if not already enrolled (idempotent)
    await createEnrollmentIfAbsent(userId, courseId);

    // Update request to approved
    const updates = {
      status: "approved",
      decidedAt: FieldValue.serverTimestamp(),
      decidedBy: adminUid,
    };

    await docRef.update(updates);

    const updated = await docRef.get();
    res.json(success({
      id,
      ...(normalizeFirestoreData(updated.data()) as Record<string, unknown>),
    }));
  } catch (err: unknown) {
    console.error({
      route: "POST /enrollment-requests/:id/approve",
      uid: req.user?.uid,
      requestId: req.params.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json(
      error("APPROVE_FAILED", "Failed to approve enrollment request")
    );
  }
});

// ---------------------------------------------------------------------------
// POST /enrollment-requests/:id/decline — admin declines a request
// ---------------------------------------------------------------------------
router.post("/:id/decline", requireRole("admin"), async (req, res) => {
  try {
    const id = req.params.id as string;
    const adminUid = req.user!.uid;
    const {reason} = req.body as {reason?: string};

    const docRef = adminDb.collection("enrollment_requests").doc(id);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      res.status(404).json(error("NOT_FOUND", "Enrollment request not found"));
      return;
    }

    const updates: Record<string, unknown> = {
      status: "declined",
      decidedAt: FieldValue.serverTimestamp(),
      decidedBy: adminUid,
    };
    if (reason !== undefined && reason !== "") {
      updates.declineReason = reason;
    }

    await docRef.update(updates);

    const updated = await docRef.get();
    res.json(success({
      id,
      ...(normalizeFirestoreData(updated.data()) as Record<string, unknown>),
    }));
  } catch (err: unknown) {
    console.error({
      route: "POST /enrollment-requests/:id/decline",
      uid: req.user?.uid,
      requestId: req.params.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json(
      error("DECLINE_FAILED", "Failed to decline enrollment request")
    );
  }
});

export default router;
