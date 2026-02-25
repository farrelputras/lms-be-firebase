import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {adminDb, normalizeFirestoreData} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {success, error} from "../utils/response.js";

const router = Router();

router.use(verifyToken);

// POST /enrollments — enroll in a course
router.post("/", async (req, res) => {
  try {
    const {courseId} = req.body as {courseId?: string};
    const uid = req.user!.uid;

    if (!courseId) {
      res.status(400).json(
        error("BAD_REQUEST", "courseId is required")
      );
      return;
    }

    // Verify course exists
    const courseSnap = await adminDb
      .collection("courses").doc(courseId).get();
    if (!courseSnap.exists) {
      res.status(404).json(error("NOT_FOUND", "Course not found"));
      return;
    }

    // Check duplicate enrollment
    const existing = await adminDb
      .collection("enrollments")
      .where("userId", "==", uid)
      .where("courseId", "==", courseId)
      .limit(1)
      .get();

    if (!existing.empty) {
      res.status(409).json(
        error("CONFLICT", "Already enrolled in this course")
      );
      return;
    }

    const enrollmentData = {
      userId: uid,
      courseId,
      enrolledAt: FieldValue.serverTimestamp(),
    };

    const docRef = await adminDb
      .collection("enrollments").add(enrollmentData);
    res.status(201).json(success({id: docRef.id, ...enrollmentData}));
  } catch {
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
  } catch {
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
  } catch {
    res.status(500).json(
      error("FETCH_FAILED", "Failed to check enrollment status")
    );
  }
});

export default router;
