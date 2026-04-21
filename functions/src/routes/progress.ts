import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {adminDb} from "../firebaseAdmin.js";
import {requirePublishedCourse} from "../middleware/requirePublishedCourse.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {checkAndAwardBadges} from "../utils/badges.js";
import {success, error} from "../utils/response.js";

const router = Router({mergeParams: true});

router.use(verifyToken);

// POST /courses/:courseId/progress — mark a chapter as completed
router.post("/", requirePublishedCourse, async (req, res) => {
  try {
    const {chapterId} = req.body as {
      chapterId?: string;
    };
    const {courseId} = req.params as {courseId: string};
    const uid = req.user!.uid;

    if (!chapterId) {
      res.status(400).json(
        error("BAD_REQUEST", "chapterId is required")
      );
      return;
    }

    const chapterSnap = await adminDb
      .collection("courses")
      .doc(courseId)
      .collection("chapters")
      .doc(chapterId)
      .get();

    if (!chapterSnap.exists) {
      res.status(400).json(
        error("INVALID_CHAPTER", "Chapter does not belong to this course")
      );
      return;
    }

    const progressId = `${uid}_${courseId}`;
    const progressRef = adminDb.collection("progress").doc(progressId);
    const existing = await progressRef.get();
    let isNewCompletion = false;
    let completed: string[] = [];

    // Count total chapters for percentage calculation
    const chaptersSnap = await adminDb
      .collection("courses")
      .doc(courseId)
      .collection("chapters")
      .get();
    const totalChapters = chaptersSnap.size;
    let percentage = 0;

    if (existing.exists) {
      const data = existing.data();
      completed =
        (data?.completedChapters as string[]) || [];
      if (!completed.includes(chapterId)) {
        completed.push(chapterId);
        isNewCompletion = true;
      }

      percentage =
        totalChapters > 0 ?
          Math.round((completed.length / totalChapters) * 100) :
          0;

      await progressRef.update({
        completedChapters: completed,
        percentage,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      completed = [chapterId];
      isNewCompletion = true;

      percentage =
        totalChapters > 0 ?
          Math.round((1 / totalChapters) * 100) :
          0;

      await progressRef.set({
        userId: uid,
        courseId,
        completedChapters: completed,
        percentage,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    let pointsAwarded = 0;
    let badges: string[] = [];
    if (isNewCompletion) {
      await adminDb.collection("users").doc(uid).set({
        totalPoints: FieldValue.increment(10),
      }, {merge: true});

      pointsAwarded = 10;
      badges = await checkAndAwardBadges(uid, adminDb, {type: "points_update"});
    }

    if (existing.exists) {
      res.json(success({
        completedChapters: completed,
        percentage,
        pointsAwarded,
        badges,
      }));
    } else {
      res.status(201).json(success({
        completedChapters: completed,
        percentage,
        pointsAwarded,
        badges,
      }));
    }
  } catch (err: unknown) {
    console.error({
      route: "POST /courses/:courseId/progress",
      uid: req.user?.uid,
      courseId: req.params.courseId,
      chapterId: (req.body as {chapterId?: string})?.chapterId,
      errorMessage: err instanceof Error ? err.message : String(err),
      error: err,
    });
    res.status(500).json(
      error("PROGRESS_FAILED", "Failed to update progress")
    );
  }
});

// GET /courses/:courseId/progress — get progress for a course
router.get("/", requirePublishedCourse, async (req, res) => {
  try {
    const uid = req.user!.uid;
    const {courseId} = req.params as {courseId: string};

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
  } catch (err: unknown) {
    console.error({
      route: "GET /courses/:courseId/progress",
      uid: req.user?.uid,
      courseId: (req.params as {courseId?: string}).courseId,
      errorMessage: err instanceof Error ? err.message : String(err),
      error: err,
    });
    res.status(500).json(
      error("FETCH_FAILED", "Failed to fetch progress")
    );
  }
});

// DELETE /courses/:courseId/progress — reset progress for testing
router.delete("/", requirePublishedCourse, async (req, res) => {
  try {
    const uid = req.user!.uid;
    const {courseId} = req.params as {courseId: string};

    const progressId = `${uid}_${courseId}`;

    // Delete progress document
    await adminDb.collection("progress").doc(progressId).delete();

    // Query quiz results and activity progress for this user+course
    const [quizResultsSnap, activityProgressSnap] = await Promise.all([
      adminDb
        .collection("quiz_results")
        .where("userId", "==", uid)
        .where("courseId", "==", courseId)
        .get(),
      adminDb
        .collection("activity_progress")
        .where("userId", "==", uid)
        .where("courseId", "==", courseId)
        .get(),
    ]);

    const quizResultsCleared = quizResultsSnap.size;
    const activityProgressCleared = activityProgressSnap.size;

    // Batch delete all related documents
    const totalToDelete = quizResultsCleared + activityProgressCleared;
    if (totalToDelete > 0) {
      const batch = adminDb.batch();
      quizResultsSnap.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });
      activityProgressSnap.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });
      await batch.commit();
    }

    res.json(success({
      deleted: true,
      quizResultsCleared,
      activityProgressCleared,
    }));
  } catch (err: unknown) {
    console.error({
      route: "DELETE /courses/:courseId/progress",
      uid: req.user?.uid,
      courseId: req.params.courseId,
      errorMessage: err instanceof Error ? err.message : String(err),
      error: err,
    });
    res.status(500).json(
      error("RESET_FAILED", "Failed to reset progress")
    );
  }
});

export default router;
