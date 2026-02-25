import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {adminDb} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {success, error} from "../utils/response.js";

const router = Router();

router.use(verifyToken);

// POST /progress — mark a chapter as completed
router.post("/", async (req, res) => {
  try {
    const {courseId, chapterId} = req.body as {
      courseId?: string;
      chapterId?: string;
    };
    const uid = req.user!.uid;

    if (!courseId || !chapterId) {
      res.status(400).json(
        error("BAD_REQUEST", "courseId and chapterId are required")
      );
      return;
    }

    const progressId = `${uid}_${courseId}`;
    const progressRef = adminDb.collection("progress").doc(progressId);
    const existing = await progressRef.get();

    // Count total chapters for percentage calculation
    const chaptersSnap = await adminDb
      .collection("courses")
      .doc(courseId)
      .collection("chapters")
      .get();
    const totalChapters = chaptersSnap.size;

    if (existing.exists) {
      const data = existing.data();
      const completed: string[] =
        (data?.completedChapters as string[]) || [];
      if (!completed.includes(chapterId)) {
        completed.push(chapterId);
      }

      const percentage =
        totalChapters > 0 ?
          Math.round((completed.length / totalChapters) * 100) :
          0;

      await progressRef.update({
        completedChapters: completed,
        percentage,
        updatedAt: FieldValue.serverTimestamp(),
      });

      res.json(success({
        id: progressId,
        userId: uid,
        courseId,
        completedChapters: completed,
        percentage,
      }));
    } else {
      const percentage =
        totalChapters > 0 ?
          Math.round((1 / totalChapters) * 100) :
          0;

      await progressRef.set({
        userId: uid,
        courseId,
        completedChapters: [chapterId],
        percentage,
        updatedAt: FieldValue.serverTimestamp(),
      });

      res.status(201).json(success({
        id: progressId,
        userId: uid,
        courseId,
        completedChapters: [chapterId],
        percentage,
      }));
    }
  } catch {
    res.status(500).json(
      error("PROGRESS_FAILED", "Failed to update progress")
    );
  }
});

// GET /progress/:courseId — get progress for a course
router.get("/:courseId", async (req, res) => {
  try {
    const uid = req.user!.uid;
    const {courseId} = req.params;

    const progressId = `${uid}_${courseId}`;
    const docSnap = await adminDb
      .collection("progress").doc(progressId).get();

    if (!docSnap.exists) {
      res.json(success({
        userId: uid,
        courseId,
        completedChapters: [],
        percentage: 0,
      }));
      return;
    }

    res.json(success({
      id: docSnap.id,
      ...docSnap.data(),
    }));
  } catch {
    res.status(500).json(
      error("FETCH_FAILED", "Failed to fetch progress")
    );
  }
});

export default router;
