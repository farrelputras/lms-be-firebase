import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {adminDb, normalizeFirestoreData} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {requireRole} from "../middleware/requireRole.js";
import {requirePublishedCourse} from "../middleware/requirePublishedCourse.js";
import {checkAndAwardBadges} from "../utils/badges.js";
import {success, error} from "../utils/response.js";

interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswerIndex: number;
}

interface StudentQuizQuestion {
  question: string;
  options: string[];
}

const toStudentQuestions = (questions: unknown): StudentQuizQuestion[] => {
  if (!Array.isArray(questions)) {
    return [];
  }

  return questions.map((q) => ({
    question: ((q as Record<string, unknown>).questionText as string) || "",
    options: Array.isArray((q as Record<string, unknown>).options) ?
      ((q as Record<string, unknown>).options as string[]) :
      [],
  }));
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

// POST /courses/:courseId/quizzes — admin only
router.post(
  "/",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const {title, questions} = req.body as {
        title?: string;
        questions?: QuizQuestion[];
      };

      if (!title || !questions || !Array.isArray(questions)) {
        res.status(400).json(
          error("BAD_REQUEST", "title and questions array are required")
        );
        return;
      }

      const quizData = {
        title,
        questions,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

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
      const {title, questions} = req.body as {
        title?: string;
        questions?: QuizQuestion[];
      };

      const updates: Record<string, unknown> = {
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (title !== undefined) updates.title = title;
      if (questions !== undefined) updates.questions = questions;

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
      const {answers} = req.body as {answers?: number[]};

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
      questions.forEach((q, i) => {
        if (q.correctAnswerIndex === answers[i]) correctCount++;
      });

      const totalQuestions = questions.length;
      const uid = req.user!.uid;

      await adminDb.collection("users").doc(uid).set({
        totalPoints: FieldValue.increment(correctCount),
      }, {merge: true});

      const badges = await checkAndAwardBadges(uid, adminDb, {
        type: "quiz_submit",
        correctCount,
        totalQuestions,
      });

      const answerSummary = questions.map((q, i) => ({
        questionId: ((q as unknown as Record<string, unknown>).id as string) ||
          String(i),
        correct: q.correctAnswerIndex === answers[i],
      }));

      const resultData = {
        userId: uid,
        courseId,
        quizId,
        answers,
        score: Math.round((correctCount / totalQuestions) * 100),
        correctCount,
        totalQuestions,
        pointsAwarded: correctCount,
        submittedAt: FieldValue.serverTimestamp(),
      };

      await adminDb
        .collection("quiz_results")
        .add(resultData);

      res.json(success({
        score: correctCount,
        total: totalQuestions,
        passed: correctCount === totalQuestions,
        pointsAwarded: correctCount,
        badges,
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
