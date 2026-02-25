import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {adminDb, normalizeFirestoreData} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {requireRole} from "../middleware/requireRole.js";
import {checkEnrollment} from "../middleware/checkEnrollment.js";
import {success, error} from "../utils/response.js";

interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
}

const router = Router({mergeParams: true});

// GET /courses/:courseId/quizzes — list quizzes (auth + enrolled)
router.get("/", verifyToken, checkEnrollment, async (req, res) => {
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
        const qs = (data.questions as QuizQuestion[]) || [];
        data.questions = qs.map(({question, options}) => ({
          question,
          options,
        }));
      }
      return {id: docSnap.id, ...data};
    });

    res.json(success(quizzes));
  } catch {
    res.status(500).json(
      error("FETCH_FAILED", "Failed to fetch quizzes")
    );
  }
});

// GET /courses/:courseId/quizzes/:quizId
router.get(
  "/:quizId",
  verifyToken,
  checkEnrollment,
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
        const qs = (data.questions as QuizQuestion[]) || [];
        data.questions = qs.map(({question, options}) => ({
          question,
          options,
        }));
      }

      res.json(success({id: docSnap.id, ...data}));
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
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
  checkEnrollment,
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
        if (q.correctAnswer === answers[i]) correctCount++;
      });

      const score = Math.round(
        (correctCount / questions.length) * 100
      );
      const uid = req.user!.uid;

      const resultData = {
        userId: uid,
        courseId,
        quizId,
        answers,
        score,
        correctCount,
        totalQuestions: questions.length,
        submittedAt: FieldValue.serverTimestamp(),
      };

      const resultRef = await adminDb
        .collection("quizResults")
        .add(resultData);

      res.json(success({
        id: resultRef.id,
        ...resultData,
        submittedAt: null,
      }));
    } catch {
      res.status(500).json(
        error("SUBMIT_FAILED", "Failed to submit quiz")
      );
    }
  }
);

export default router;
