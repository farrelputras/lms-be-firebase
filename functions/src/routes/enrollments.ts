import {Router} from "express";

import {adminDb, normalizeFirestoreData} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {success, error} from "../utils/response.js";
import {createEnrollmentIfAbsent} from "../utils/enrollment.js";

const router = Router();

router.use(verifyToken);

// POST /enrollments — enroll in a course
router.post("/", async (req, res) => {
  try {
    const {courseId, userId} = req.body as {
      courseId?: string;
      userId?: string;
    };
    const callerUid = req.user!.uid;
    const callerRole = req.user!.role;

    if (userId && callerRole !== "admin") {
      res.status(403).json(
        error("FORBIDDEN", "Only admin can enroll another user")
      );
      return;
    }

    if (!courseId) {
      res.status(400).json(
        error("BAD_REQUEST", "courseId is required")
      );
      return;
    }

    const isAdminEnrollingOther = Boolean(userId) && callerRole === "admin";
    const targetUserId = isAdminEnrollingOther ? userId! : callerUid;

    // Admin enrolling another user — full bypass (any course/tier/publish state)
    if (isAdminEnrollingOther) {
      const courseSnap = await adminDb.collection("courses").doc(courseId).get();
      if (!courseSnap.exists) {
        res.status(404).json(error("NOT_FOUND", "Course not found"));
        return;
      }

      const result = await createEnrollmentIfAbsent(targetUserId, courseId);
      if (!result.created) {
        res.status(409).json(
          error("CONFLICT", "Already enrolled in this course")
        );
        return;
      }
      res.status(201).json(success({id: result.id, userId: targetUserId, courseId}));
      return;
    }

    // Self-enroll: must be published, free course
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

    if (courseData.accessTier === "premium") {
      res.status(403).json(
        error(
          "PREMIUM_REQUIRES_REQUEST",
          "This is a premium course. Submit an enrollment request to gain access."
        )
      );
      return;
    }

    const result = await createEnrollmentIfAbsent(targetUserId, courseId);
    if (!result.created) {
      res.status(409).json(
        error("CONFLICT", "Already enrolled in this course")
      );
      return;
    }
    res.status(201).json(success({id: result.id, userId: targetUserId, courseId}));
  } catch (err: unknown) {
    console.error({
      route: "POST /enrollments",
      uid: req.user?.uid,
      courseId: (req.body as {courseId?: string})?.courseId,
      userId: (req.body as {userId?: string})?.userId,
      errorMessage: err instanceof Error ? err.message : String(err),
      error: err,
    });
    res.status(500).json(
      error("ENROLL_FAILED", "Failed to enroll")
    );
  }
});

// GET /enrollments/my — current user's enrollments
router.get("/my", async (req, res) => {
  try {
    const uid = req.user!.uid;
    const snapshot = await adminDb
      .collection("enrollments")
      .where("userId", "==", uid)
      .get();

    const enrollments = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...(normalizeFirestoreData(docSnap.data()) as Record<
        string, unknown
      >),
    }));

    res.json(success(enrollments));
  } catch (err: unknown) {
    console.error({
      route: "GET /enrollments/my",
      uid: req.user?.uid,
      errorMessage: err instanceof Error ? err.message : String(err),
      error: err,
    });
    res.status(500).json(
      error("FETCH_FAILED", "Failed to fetch enrollments")
    );
  }
});

// GET /enrollments/:courseId/status
router.get("/:courseId/status", async (req, res) => {
  try {
    const uid = req.user!.uid;
    const {courseId} = req.params;

    const snapshot = await adminDb
      .collection("enrollments")
      .where("userId", "==", uid)
      .where("courseId", "==", courseId)
      .limit(1)
      .get();

    res.json(success({enrolled: !snapshot.empty}));
  } catch (err: unknown) {
    console.error({
      route: "GET /enrollments/:courseId/status",
      uid: req.user?.uid,
      courseId: req.params.courseId,
      errorMessage: err instanceof Error ? err.message : String(err),
      error: err,
    });
    res.status(500).json(
      error("FETCH_FAILED", "Failed to check enrollment status")
    );
  }
});

export default router;
