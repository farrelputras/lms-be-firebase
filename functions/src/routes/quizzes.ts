import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {adminDb, normalizeFirestoreData} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {requireRole} from "../middleware/requireRole.js";
import {requirePublishedCourse} from "../middleware/requirePublishedCourse.js";
import {checkAndAwardBadges, BADGE_REGISTRY} from "../utils/badges.js";
import {success, error} from "../utils/response.js";

interface QuizQuestion {
  questionText: string;
  type?: string;
  options?: string[];
  correctAnswerIndex?: number;
  correctAnswerText?: string;
  points?: number;
}

interface StudentQuizQuestion {
  questionText: string;
  type?: string;
  options?: string[];
  points?: number;
}

const toStudentQuestions = (questions: unknown): StudentQuizQuestion[] => {
  if (!Array.isArray(questions)) {
    return [];
  }

  return questions.map((q) => {
    const qRecord = q as Record<string, unknown>;
    return {
      questionText: (qRecord.questionText as string) || "",
      type: (qRecord.type as string) || "multipleChoice",
      options: Array.isArray(qRecord.options) ? (qRecord.options as string[]) : [],
      points: (qRecord.points as number) || 1,
    };
  });
};

const router = Router({mergeParams: true});

// GET /courses/:courseId/quizzes — list quizzes (auth + enrolled)
router.get("/", verifyToken, requirePublishedCourse, async (req, res) => {
  try {
    const courseId = req.params.courseId as string;
    const snapshot = await adminDb
      .collection("courses")
      .doc(courseId)
      .collection("quizzes")
      .get();

    const quizzes = snapshot.docs.map((docSnap) => {
      const data = normalizeFirestoreData(
        docSnap.data()
      ) as Record<string, unknown>;

      // Strip correct answers for non-admin users
      if (req.user?.role !== "admin") {
        data.questions = toStudentQuestions(data.questions);
      }
      return {id: docSnap.id, ...data};
    });

    res.json(success(quizzes));
  } catch (err: unknown) {
    console.error({
      route: "GET /courses/:courseId/quizzes",
      uid: req.user?.uid,
      courseId: req.params.courseId,
      errorMessage: err instanceof Error ? err.message : String(err),
      error: err,
    });
    res.status(500).json(
      error("FETCH_FAILED", "Failed to fetch quizzes")
    );
  }
});

// GET /courses/:courseId/quizzes/:quizId
router.get(
  "/:quizId",
  verifyToken,
  requirePublishedCourse,
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const quizId = req.params.quizId as string;
      const docSnap = await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("quizzes")
        .doc(quizId)
        .get();

      if (!docSnap.exists) {
        res.status(404).json(error("NOT_FOUND", "Quiz not found"));
        return;
      }

      const data = normalizeFirestoreData(
        docSnap.data()
      ) as Record<string, unknown>;

      // Strip correct answers for non-admin users
      if (req.user?.role !== "admin") {
        data.questions = toStudentQuestions(data.questions);
      }

      res.json(success({id: docSnap.id, ...data}));
    } catch (err: unknown) {
      console.error({
        route: "GET /courses/:courseId/quizzes/:quizId",
        uid: req.user?.uid,
        courseId: req.params.courseId,
        quizId: req.params.quizId,
        errorMessage: err instanceof Error ? err.message : String(err),
        error: err,
      });
      res.status(500).json(
        error("FETCH_FAILED", "Failed to fetch quiz")
      );
    }
  }
);

// GET /courses/:courseId/quizzes/:quizId/result — student: aggregated prior result
router.get(
  "/:quizId/result",
  verifyToken,
  requirePublishedCourse,
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const quizId = req.params.quizId as string;
      const uid = req.user!.uid;

      // 1. Load quiz doc — 404 if missing (mirrors GET /:quizId)
      const quizSnap = await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("quizzes")
        .doc(quizId)
        .get();

      if (!quizSnap.exists) {
        res.status(404).json(error("NOT_FOUND", "Quiz not found"));
        return;
      }

      const quizData = quizSnap.data();
      const passingGrade =
        typeof quizData?.passingGrade === "number" ? quizData.passingGrade : 0;
      const questions = Array.isArray(quizData?.questions) ? quizData.questions : [];
      const totalQuestions = (questions as unknown[]).length;

      // 2. Equality-only query — no composite index needed (merge-join on single-field indexes)
      const resultsSnap = await adminDb
        .collection("quiz_results")
        .where("userId", "==", uid)
        .where("quizId", "==", quizId)
        .get();

      // 3. Aggregate in memory; guard legacy/malformed rows (pre-refactor mobile writes may
      //    lack quizId; treat missing score/pointsAwarded as 0)
      let attemptCount = 0;
      let bestScore = 0;          // stored as percentage (0–100)
      let bestPointsAwarded = 0;  // raw points
      let lastSubmittedAt: string | null = null;

      for (const docSnap of resultsSnap.docs) {
        const d = docSnap.data();
        // Skip rows without a quizId field
        if (!d.quizId) continue;

        attemptCount++;
        const rowScore = typeof d.score === "number" ? d.score : 0;
        const rowPoints = typeof d.pointsAwarded === "number" ? d.pointsAwarded : 0;
        if (rowScore > bestScore) bestScore = rowScore;
        if (rowPoints > bestPointsAwarded) bestPointsAwarded = rowPoints;

        const submittedAt = d.submittedAt?.toDate?.();
        if (submittedAt instanceof Date) {
          const iso = submittedAt.toISOString();
          if (lastSubmittedAt === null || iso > lastSubmittedAt) {
            lastSubmittedAt = iso;
          }
        }
      }

      const attempted = attemptCount > 0;
      // passed: server-authoritative; units are points vs points (matches §14.3 rule)
      const passed =
        attempted && (passingGrade > 0 ? bestPointsAwarded >= passingGrade : true);

      res.json(
        success({
          attempted,
          attemptCount,
          bestScore,
          bestPointsAwarded,
          totalQuestions,
          passingGrade,
          passed,
          lastSubmittedAt,
        })
      );
    } catch (err: unknown) {
      console.error({
        route: "GET /courses/:courseId/quizzes/:quizId/result",
        uid: req.user?.uid,
        courseId: req.params.courseId,
        quizId: req.params.quizId,
        errorMessage: err instanceof Error ? err.message : String(err),
        error: err,
      });
      res.status(500).json(error("FETCH_FAILED", "Failed to fetch quiz result"));
    }
  }
);

// POST /courses/:courseId/quizzes — admin only
router.post(
  "/",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const {
        title,
        questions,
        type,
        gamificationType,
        passingGrade,
        allowRetake,
        showAnswers,
      } = req.body as {
        title?: string;
        questions?: QuizQuestion[];
        type?: string;
        gamificationType?: string;
        passingGrade?: number;
        allowRetake?: boolean;
        showAnswers?: boolean;
      };

      if (!title || !questions || !Array.isArray(questions)) {
        res.status(400).json(
          error("BAD_REQUEST", "title and questions array are required")
        );
        return;
      }

      const quizData: Record<string, unknown> = {
        title,
        questions,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      // Persist optional quiz metadata when provided
      if (type !== undefined) quizData.type = type;
      if (gamificationType !== undefined) {
        quizData.gamificationType = gamificationType;
      }
      if (passingGrade !== undefined) quizData.passingGrade = passingGrade;
      if (allowRetake !== undefined) quizData.allowRetake = allowRetake;
      if (showAnswers !== undefined) quizData.showAnswers = showAnswers;

      const docRef = await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("quizzes")
        .add(quizData);

      res.status(201).json(success({id: docRef.id, ...quizData}));
    } catch (err: unknown) {
      console.error({
        route: "POST /courses/:courseId/quizzes",
        uid: req.user?.uid,
        courseId: req.params.courseId,
        errorMessage: err instanceof Error ? err.message : String(err),
        error: err,
      });
      res.status(500).json(
        error("CREATE_FAILED", "Failed to create quiz")
      );
    }
  }
);

// PATCH /courses/:courseId/quizzes/:quizId — admin only
router.patch(
  "/:quizId",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const quizId = req.params.quizId as string;
      const {
        title,
        questions,
        type,
        gamificationType,
        passingGrade,
        allowRetake,
        showAnswers,
      } = req.body as {
        title?: string;
        questions?: QuizQuestion[];
        type?: string;
        gamificationType?: string;
        passingGrade?: number;
        allowRetake?: boolean;
        showAnswers?: boolean;
      };

      const updates: Record<string, unknown> = {
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (title !== undefined) updates.title = title;
      if (questions !== undefined) updates.questions = questions;
      if (type !== undefined) updates.type = type;
      if (gamificationType !== undefined) {
        updates.gamificationType = gamificationType;
      }
      if (passingGrade !== undefined) updates.passingGrade = passingGrade;
      if (allowRetake !== undefined) updates.allowRetake = allowRetake;
      if (showAnswers !== undefined) updates.showAnswers = showAnswers;

      await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("quizzes")
        .doc(quizId)
        .update(updates);

      const updated = await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("quizzes")
        .doc(quizId)
        .get();

      res.json(success({
        id: updated.id,
        ...(normalizeFirestoreData(updated.data()) as Record<
          string, unknown
        >),
      }));
    } catch (err: unknown) {
      console.error({
        route: "PATCH /courses/:courseId/quizzes/:quizId",
        uid: req.user?.uid,
        courseId: req.params.courseId,
        quizId: req.params.quizId,
        errorMessage: err instanceof Error ? err.message : String(err),
        error: err,
      });
      res.status(500).json(
        error("UPDATE_FAILED", "Failed to update quiz")
      );
    }
  }
);

// DELETE /courses/:courseId/quizzes/:quizId — admin only
router.delete(
  "/:quizId",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const quizId = req.params.quizId as string;
      await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("quizzes")
        .doc(quizId)
        .delete();

      res.json(success({id: quizId, deleted: true}));
    } catch (err: unknown) {
      console.error({
        route: "DELETE /courses/:courseId/quizzes/:quizId",
        uid: req.user?.uid,
        courseId: req.params.courseId,
        quizId: req.params.quizId,
        errorMessage: err instanceof Error ? err.message : String(err),
        error: err,
      });
      res.status(500).json(
        error("DELETE_FAILED", "Failed to delete quiz")
      );
    }
  }
);

// POST /courses/:courseId/quizzes/:quizId/submit — student
router.post(
  "/:quizId/submit",
  verifyToken,
  requirePublishedCourse,
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const quizId = req.params.quizId as string;
      const {answers} = req.body as {answers?: (number | string)[]};

      if (!answers || !Array.isArray(answers)) {
        res.status(400).json(
          error("BAD_REQUEST", "answers array is required")
        );
        return;
      }

      const quizSnap = await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("quizzes")
        .doc(quizId)
        .get();

      if (!quizSnap.exists) {
        res.status(404).json(error("NOT_FOUND", "Quiz not found"));
        return;
      }

      const quizData = quizSnap.data();
      const questions = (quizData?.questions as QuizQuestion[]) || [];

      if (answers.length !== questions.length) {
        res.status(400).json(
          error(
            "BAD_REQUEST",
            `Expected ${questions.length} answers, got ${answers.length}`
          )
        );
        return;
      }

      let correctCount = 0;
      let pointsAwarded = 0;
      questions.forEach((q, i) => {
        const answer = answers[i];
        let isCorrect = false;

        if (q.type === "shortAnswer") {
          if (
            answer != null &&
            String(answer).trim().toLowerCase() === (q.correctAnswerText || "").trim().toLowerCase()
          ) {
            isCorrect = true;
          }
        } else {
          if (q.correctAnswerIndex === answer) {
            isCorrect = true;
          }
        }

        if (isCorrect) {
          correctCount++;
          pointsAwarded += (q.points || 1);
        }
      });

      const totalQuestions = questions.length;
      const uid = req.user!.uid;

      await adminDb.collection("users").doc(uid).set({
        totalPoints: FieldValue.increment(pointsAwarded),
      }, {merge: true});

      // 1. Submit basic quiz activity check
      const submittedBadgeIds = await checkAndAwardBadges(uid, adminDb, {
        type: "activity_submitted",
        correctCount,
        totalQuestions,
      });

      // 2. Leaderboard check (since points were just awarded)
      const rankBadgeIds = await checkAndAwardBadges(uid, adminDb, {
        type: "leaderboard_update"
      });

      // 3. Combine and map to metadata objects
      const combinedIds = [...submittedBadgeIds, ...rankBadgeIds];
      const earnedBadges = combinedIds.map(id => ({
        id,
        ...BADGE_REGISTRY[id as keyof typeof BADGE_REGISTRY]
      }));

      const answerSummary = questions.map((q, i) => {
        const answer = answers[i];
        let isCorrect = false;
        if (q.type === "shortAnswer") {
          isCorrect = answer != null && String(answer).trim().toLowerCase() === (q.correctAnswerText || "").trim().toLowerCase();
        } else {
          isCorrect = q.correctAnswerIndex === answer;
        }

        return {
          questionId: ((q as unknown as Record<string, unknown>).id as string) || String(i),
          correct: isCorrect,
        };
      });

      const resultData = {
        userId: uid,
        courseId,
        quizId,
        answers,
        score: Math.round((correctCount / totalQuestions) * 100),
        correctCount,
        totalQuestions,
        pointsAwarded,
        submittedAt: FieldValue.serverTimestamp(),
      };

      await adminDb
        .collection("quiz_results")
        .add(resultData);

      res.json(success({
        score: correctCount,
        total: totalQuestions,
        passed: correctCount === totalQuestions,
        pointsAwarded,
        earnedBadges, // Updated to pass the full badge objects
        answers: answerSummary,
      }));
    } catch (err: unknown) {
      console.error({
        route: "POST /courses/:courseId/quizzes/:quizId/submit",
        uid: req.user?.uid,
        courseId: req.params.courseId,
        quizId: req.params.quizId,
        errorMessage: err instanceof Error ? err.message : String(err),
        error: err,
      });
      res.status(500).json(
        error("SUBMIT_FAILED", "Failed to submit quiz")
      );
    }
  }
);

export default router;