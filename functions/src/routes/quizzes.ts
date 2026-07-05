import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {adminDb, normalizeFirestoreData} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {requireRole} from "../middleware/requireRole.js";
import {requirePublishedCourse} from "../middleware/requirePublishedCourse.js";
import {requirePremiumEnrollment} from "../middleware/requirePremiumEnrollment.js";
import {success, error} from "../utils/response.js";

// PRD21 — fixed penalty proportion for `scoringMode: 'penalty'` quizzes.
// A weight-4 question scores -1 on a wrong answer (0.25 * 4); short-answer
// and blank answers are never penalized (see submit handler).
const WRONG_PENALTY_RATIO = 0.25;

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
  imageUrl?: string;
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
      imageUrl: typeof qRecord.imageUrl === "string" ? qRecord.imageUrl : undefined,
    };
  });
};

const router = Router({mergeParams: true});

// GET /courses/:courseId/quizzes — list quizzes (auth + enrolled)
router.get("/", verifyToken, requirePublishedCourse, requirePremiumEnrollment, async (req, res) => {
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
  requirePremiumEnrollment,
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
  requirePremiumEnrollment,
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
      // passed: server-authoritative; units are points vs points (matches §14.3 rule).
      // A perfect score (bestScore is a percentage) always passes — guards against
      // quizzes authored with passingGrade above max obtainable points, and keeps
      // this flag consistent with the web result screen. Additive: only ever makes
      // `passed` more lenient.
      const passed =
        attempted &&
        (bestScore === 100 ||
          (passingGrade > 0 ? bestPointsAwarded >= passingGrade : true));

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
        timeLimitMinutes,
        scoringMode,
      } = req.body as {
        title?: string;
        questions?: QuizQuestion[];
        type?: string;
        gamificationType?: string;
        passingGrade?: number;
        allowRetake?: boolean;
        showAnswers?: boolean;
        timeLimitMinutes?: number;
        scoringMode?: string;
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
      if (timeLimitMinutes !== undefined) quizData.timeLimitMinutes = timeLimitMinutes;
      if (scoringMode === "standard" || scoringMode === "penalty") {
        quizData.scoringMode = scoringMode;
      }

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
        timeLimitMinutes,
        scoringMode,
      } = req.body as {
        title?: string;
        questions?: QuizQuestion[];
        type?: string;
        gamificationType?: string;
        passingGrade?: number;
        allowRetake?: boolean;
        showAnswers?: boolean;
        timeLimitMinutes?: number;
        scoringMode?: string;
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
      if (timeLimitMinutes !== undefined) updates.timeLimitMinutes = timeLimitMinutes;
      if (scoringMode === "standard" || scoringMode === "penalty") {
        updates.scoringMode = scoringMode;
      }

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
  requirePremiumEnrollment,
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const quizId = req.params.quizId as string;
      const {answers} = req.body as {answers?: (number | string | null)[]};

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
      // PRD21 — quizzes default to 'standard' (today's behavior); admins opt
      // individual quizzes into 'penalty' via POST/PATCH allowlists above.
      const scoringMode = quizData?.scoringMode === "penalty" ? "penalty" : "standard";

      if (answers.length !== questions.length) {
        res.status(400).json(
          error(
            "BAD_REQUEST",
            `Expected ${questions.length} answers, got ${answers.length}`
          )
        );
        return;
      }

      // PRD21 §5 — a null/undefined entry (or an empty short-answer string) is
      // a blank, not a wrong answer: it never scores negative, even in penalty mode.
      const isBlankAnswer = (q: QuizQuestion, answer: number | string | null | undefined) => {
        if (answer === null || answer === undefined) return true;
        if (q.type === "shortAnswer") return String(answer).trim() === "";
        return false;
      };

      let correctCount = 0;
      let rawScore = 0;
      let maxScore = 0;
      questions.forEach((q, i) => {
        const answer = answers[i];
        const weight = q.points || 1;
        maxScore += weight;

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
          rawScore += weight;
        } else if (
          scoringMode === "penalty" &&
          q.type !== "shortAnswer" &&
          !isBlankAnswer(q, answer)
        ) {
          // Wrong, non-blank, non-short-answer in penalty mode: subtract the fixed ratio.
          rawScore -= WRONG_PENALTY_RATIO * weight;
        }
        // Blank, short-answer wrong/blank, or standard-mode wrong: contributes 0.
      });

      // PRD21 D7 — final score never negative, regardless of how many wrong answers.
      const flooredScore = Math.max(0, rawScore);

      const totalQuestions = questions.length;
      const uid = req.user!.uid;

      // PRD21 Change 1 — quizzes are pure assessment: no gamification points or
      // badges are written here anymore (previously: totalPoints increment +
      // checkAndAwardBadges for "activity_submitted" and "leaderboard_update").
      const earnedBadges: {id: string}[] = [];

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

      // PRD21 §6.1 D5 — `score`/`pointsAwarded` field names are kept for
      // backward-compat with GET /:quizId/result + mobile parsing; their
      // meaning is repurposed to "assessment score" (percentage / raw points
      // of the penalized, floored result). Standard mode keeps the exact
      // pre-PRD21 formula (unweighted correctCount/totalQuestions) so a
      // full-answer submission is byte-for-byte identical to today (G5);
      // only penalty mode uses the weighted §5 formula (needed since wrong
      // answers can subtract a non-integer amount from a weighted score).
      const percentage = scoringMode === "penalty" ?
        (maxScore > 0 ? Math.min(100, Math.max(0, Math.round((flooredScore / maxScore) * 100))) : 0) :
        Math.round((correctCount / totalQuestions) * 100);

      const resultData = {
        userId: uid,
        courseId,
        quizId,
        answers,
        score: percentage,
        correctCount,
        totalQuestions,
        pointsAwarded: flooredScore,
        submittedAt: FieldValue.serverTimestamp(),
      };

      await adminDb
        .collection("quiz_results")
        .add(resultData);

      res.json(success({
        score: correctCount,
        total: totalQuestions,
        passed: correctCount === totalQuestions,
        pointsAwarded: flooredScore,
        earnedBadges,
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