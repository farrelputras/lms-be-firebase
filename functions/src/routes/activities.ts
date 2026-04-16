import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {adminDb, normalizeFirestoreData} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {requireRole} from "../middleware/requireRole.js";
import {checkEnrollment} from "../middleware/checkEnrollment.js";
import {checkAndAwardBadges} from "../utils/badges.js";
import {success, error} from "../utils/response.js";

type ActivityType = "drag_drop" | "word_search" | "true_or_false";

interface DragDropItem {
  id: string;
  label: string;
  correctCategory: string;
}

interface TrueFalseStatement {
  id: string;
  text: string;
  correct: boolean;
}

interface GridSize {
  rows: number;
  cols: number;
}

const router = Router({mergeParams: true});

const validTypes: ActivityType[] = [
  "drag_drop",
  "word_search",
  "true_or_false",
];

const isStringArray = (value: unknown): value is string[] => {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
};

const isGridSize = (value: unknown): value is GridSize => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const rows = (value as Record<string, unknown>).rows;
  const cols = (value as Record<string, unknown>).cols;
  return typeof rows === "number" && typeof cols === "number";
};

const validateGridRange = (gridSize: GridSize): string | null => {
  if (
    gridSize.rows < 8 ||
    gridSize.rows > 15 ||
    gridSize.cols < 8 ||
    gridSize.cols > 15
  ) {
    return "gridSize rows and cols must be between 8 and 15";
  }
  return null;
};

const isDragDropItems = (value: unknown): value is DragDropItem[] => {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.every((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }

    const typedItem = item as Record<string, unknown>;
    return (
      typeof typedItem.id === "string" &&
      typeof typedItem.label === "string" &&
      typeof typedItem.correctCategory === "string"
    );
  });
};

const isTrueFalseStatements = (value: unknown): value is TrueFalseStatement[] => {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.every((statement) => {
    if (!statement || typeof statement !== "object") {
      return false;
    }

    const typedStatement = statement as Record<string, unknown>;
    return (
      typeof typedStatement.id === "string" &&
      typeof typedStatement.text === "string" &&
      typeof typedStatement.correct === "boolean"
    );
  });
};

const validateRequiredCommonFields = (body: Record<string, unknown>): string | null => {
  if (!validTypes.includes(body.type as ActivityType)) {
    return "type must be one of drag_drop, word_search, true_or_false";
  }

  if (typeof body.title !== "string") {
    return "title is required and must be a string";
  }

  if (typeof body.position !== "number") {
    return "position is required and must be a number";
  }

  if (typeof body.maxPoints !== "number") {
    return "maxPoints is required and must be a number";
  }

  return null;
};

const validateTypeSpecificCreateFields = (
  activityType: ActivityType,
  body: Record<string, unknown>
): string | null => {
  if (activityType === "drag_drop") {
    if (!isStringArray(body.categories)) {
      return "categories is required and must be a string[] for drag_drop";
    }
    if (!isDragDropItems(body.items)) {
      return "items is required and must be an array of { id, label, correctCategory } for drag_drop";
    }
    if (typeof body.feedbackMode !== "string") {
      return "feedbackMode is required and must be a string for drag_drop";
    }
  }

  if (activityType === "word_search") {
    if (!isStringArray(body.wordList)) {
      return "wordList is required and must be a string[] for word_search";
    }
    if (!isGridSize(body.gridSize)) {
      return "gridSize is required and must be an object with numeric rows and cols for word_search";
    }

    const gridError = validateGridRange(body.gridSize);
    if (gridError) {
      return gridError;
    }
  }

  if (activityType === "true_or_false") {
    if (!isTrueFalseStatements(body.statements)) {
      return "statements is required and must be an array of { id, text, correct } for true_or_false";
    }
    if (typeof body.feedbackMode !== "string") {
      return "feedbackMode is required and must be a string for true_or_false";
    }
  }

  return null;
};

const validateTypeSpecificUpdateFields = (
  activityType: ActivityType,
  updates: Record<string, unknown>
): string | null => {
  if (updates.title !== undefined && typeof updates.title !== "string") {
    return "title must be a string";
  }
  if (updates.position !== undefined && typeof updates.position !== "number") {
    return "position must be a number";
  }
  if (updates.maxPoints !== undefined && typeof updates.maxPoints !== "number") {
    return "maxPoints must be a number";
  }

  if (activityType === "drag_drop") {
    if (updates.categories !== undefined && !isStringArray(updates.categories)) {
      return "categories must be a string[] for drag_drop";
    }
    if (updates.items !== undefined && !isDragDropItems(updates.items)) {
      return "items must be an array of { id, label, correctCategory } for drag_drop";
    }
    if (
      updates.feedbackMode !== undefined &&
      typeof updates.feedbackMode !== "string"
    ) {
      return "feedbackMode must be a string for drag_drop";
    }
  }

  if (activityType === "word_search") {
    if (updates.wordList !== undefined && !isStringArray(updates.wordList)) {
      return "wordList must be a string[] for word_search";
    }
    if (updates.gridSize !== undefined) {
      if (!isGridSize(updates.gridSize)) {
        return "gridSize must be an object with numeric rows and cols for word_search";
      }

      const gridError = validateGridRange(updates.gridSize);
      if (gridError) {
        return gridError;
      }
    }
  }

  if (activityType === "true_or_false") {
    if (
      updates.statements !== undefined &&
      !isTrueFalseStatements(updates.statements)
    ) {
      return "statements must be an array of { id, text, correct } for true_or_false";
    }
    if (
      updates.feedbackMode !== undefined &&
      typeof updates.feedbackMode !== "string"
    ) {
      return "feedbackMode must be a string for true_or_false";
    }
  }

  return null;
};

// POST /courses/:courseId/activities — admin create activity
router.post("/", verifyToken, requireRole("admin"), async (req, res) => {
  try {
    const courseId = req.params.courseId as string;
    const body = req.body as Record<string, unknown>;

    const commonError = validateRequiredCommonFields(body);
    if (commonError) {
      res.status(400).json(error("INVALID_INPUT", commonError));
      return;
    }

    const activityType = body.type as ActivityType;
    const typeError = validateTypeSpecificCreateFields(activityType, body);
    if (typeError) {
      res.status(400).json(error("INVALID_INPUT", typeError));
      return;
    }

    const docRef = adminDb
      .collection("courses")
      .doc(courseId)
      .collection("gamification")
      .doc();

    await docRef.set({
      ...body,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    res.status(201).json(success({activityId: docRef.id}));
  } catch (err: unknown) {
    console.error({
      route: "POST /courses/:courseId/activities",
      uid: req.user?.uid,
      courseId: req.params.courseId,
      errorMessage: err instanceof Error ? err.message : String(err),
      error: err,
    });
    res.status(500).json(error("CREATE_FAILED", "Failed to create activity"));
  }
});

// GET /courses/:courseId/activities/:activityId — unified student/admin fetch
router.get(
  "/:activityId",
  verifyToken,
  checkEnrollment,
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const activityId = req.params.activityId as string;
      const uid = req.user!.uid;
      const isAdmin = req.user?.role === "admin";
      const docSnap = await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("gamification")
        .doc(activityId)
        .get();

      if (!docSnap.exists) {
        res.status(404).json(error("NOT_FOUND", "Activity not found"));
        return;
      }

      const activityData = normalizeFirestoreData(
        docSnap.data()
      ) as Record<string, unknown>;

      if (isAdmin) {
        res.json(success({
          id: docSnap.id,
          ...activityData,
        }));
        return;
      }

      const position =
        typeof activityData.position === "number" ? activityData.position : 0;
      const currentActivityProgressSnap = await adminDb
        .collection("activity_progress")
        .doc(`${uid}_${activityId}`)
        .get();
      const currentActivityCompleted =
        (currentActivityProgressSnap.data()?.completed as boolean) ?? false;

      if (position > 0) {
        const [chaptersSnap, activitiesSnap] = await Promise.all([
          adminDb
            .collection("courses")
            .doc(courseId)
            .collection("chapters")
            .get(),
          adminDb
            .collection("courses")
            .doc(courseId)
            .collection("gamification")
            .get(),
        ]);

        const allItems = [
          ...chaptersSnap.docs.map((d) => {
            const data = d.data() as Record<string, unknown>;
            return {
              id: d.id,
              itemType: "chapter" as const,
              position: (data.position as number | undefined) ??
                (data.order as number | undefined) ??
                0,
            };
          }),
          ...activitiesSnap.docs.map((d) => {
            const data = d.data() as Record<string, unknown>;
            return {
              id: d.id,
              itemType: "activity" as const,
              position: (data.position as number | undefined) ?? 0,
            };
          }),
        ].sort((a, b) => a.position - b.position);

        const thisIndex = allItems.findIndex((item) => item.id === activityId);
        if (thisIndex > 0) {
          const prev = allItems[thisIndex - 1];
          let prevCompleted = false;

          if (prev.itemType === "chapter") {
            const progressSnap = await adminDb
              .collection("progress")
              .doc(`${uid}_${courseId}`)
              .get();
            const completedChapters =
              (progressSnap.data()?.completedChapters as string[]) ?? [];
            prevCompleted = completedChapters.includes(prev.id);
          } else {
            const apSnap = await adminDb
              .collection("activity_progress")
              .doc(`${uid}_${prev.id}`)
              .get();
            prevCompleted = (apSnap.data()?.completed as boolean) ?? false;
          }

          if (!prevCompleted && !currentActivityCompleted) {
            res.status(403).json(
              error(
                "LOCKED",
                "This activity is locked. Complete the previous item first."
              )
            );
            return;
          }
        }
      }

      const stripped = {...activityData};
      const type = stripped.type as string;

      if (type === "drag_drop" && Array.isArray(stripped.items)) {
        stripped.items = (stripped.items as Record<string, unknown>[]).map(
          ({id, label}) => ({id, label})
        );
      }

      if (type === "true_or_false" && Array.isArray(stripped.statements)) {
        stripped.statements = (
          stripped.statements as Record<string, unknown>[]
        ).map(({id, text}) => ({id, text}));
      }

      res.json(success({id: docSnap.id, ...stripped}));
    } catch (err: unknown) {
      console.error({
        route: "GET /courses/:courseId/activities/:activityId",
        uid: req.user?.uid,
        courseId: req.params.courseId,
        activityId: req.params.activityId,
        errorMessage: err instanceof Error ? err.message : String(err),
        error: err,
      });
      res.status(500).json(error("FETCH_FAILED", "Failed to fetch activity"));
    }
  }
);

// POST /courses/:courseId/activities/:activityId/submit — student submit
router.post(
  "/:activityId/submit",
  verifyToken,
  checkEnrollment,
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const activityId = req.params.activityId as string;
      const uid = req.user!.uid;
      const answers = req.body.answers as Record<string, unknown>;

      const activitySnap = await adminDb
        .collection("courses")
        .doc(courseId)
        .collection("gamification")
        .doc(activityId)
        .get();

      if (!activitySnap.exists) {
        res.status(404).json(error("NOT_FOUND", "Activity not found"));
        return;
      }

      const activityData = activitySnap.data() as Record<string, unknown>;
      const activityType = activityData.type as string;
      const maxPoints =
        typeof activityData.maxPoints === "number" ? activityData.maxPoints : 0;

      let correctCount = 0;
      let totalCount = 0;
      const feedback: Record<string, unknown>[] = [];

      if (activityType === "drag_drop") {
        const items = activityData.items as {
          id: string;
          label: string;
          correctCategory: string;
        }[];
        totalCount = items.length;
        const submittedAnswers = answers as Record<string, string>;

        for (const item of items) {
          const isCorrect = submittedAnswers[item.id] === item.correctCategory;
          if (isCorrect) correctCount++;
          feedback.push({
            id: item.id,
            correct: isCorrect,
            correctCategory: item.correctCategory,
          });
        }
      } else if (activityType === "word_search") {
        const wordList = activityData.wordList as string[];
        totalCount = wordList.length;
        const foundWords = Array.isArray(answers.foundWords) ?
          (answers.foundWords as string[]) :
          [];
        const foundNormalized = foundWords.map((w: string) => w.toLowerCase());

        for (const word of wordList) {
          const isCorrect = foundNormalized.includes(word.toLowerCase());
          if (isCorrect) correctCount++;
          feedback.push({word, found: isCorrect});
        }
      } else if (activityType === "true_or_false") {
        const statements = activityData.statements as {
          id: string;
          text: string;
          correct: boolean;
        }[];
        totalCount = statements.length;
        const submittedAnswers = answers as Record<string, boolean>;

        for (const [index, statement] of statements.entries()) {
          const statementId =
            typeof statement.id === "string" ? statement.id.trim() : "";
          const fallbackKey = `__statement_${index}`;

          // Backward compatibility for older activities created with empty statement IDs.
          const submittedValue = statementId.length > 0 ?
            submittedAnswers[statementId] :
            submittedAnswers[fallbackKey];

          const isCorrect = submittedValue === statement.correct;
          if (isCorrect) correctCount++;
          feedback.push({
            id: statementId || fallbackKey,
            correct: isCorrect,
            correctAnswer: statement.correct,
          });
        }
      } else {
        res.status(400).json(error("INVALID_INPUT", "Unknown activity type"));
        return;
      }

      const earnedPoints =
        totalCount > 0 ? Math.round((correctCount / totalCount) * maxPoints) : 0;
      const scorePercent =
        totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;

      const progressDocId = `${uid}_${activityId}`;
      const progressRef = adminDb.collection("activity_progress").doc(progressDocId);
      const progressSnap = await progressRef.get();
      const previousBestPoints: number = progressSnap.exists ?
        ((progressSnap.data()?.bestScore as number) ?? 0) :
        0;
      const isNewCompletion =
        !progressSnap.exists || !(progressSnap.data()?.completed as boolean);
      const previousAttempts: number = progressSnap.exists ?
        ((progressSnap.data()?.attempts as number) ?? 0) :
        0;

      const pointsDelta = Math.max(0, earnedPoints - previousBestPoints);
      const newBestPoints = Math.max(earnedPoints, previousBestPoints);
      const newBestScorePercent = totalCount > 0 && maxPoints > 0 ?
        Math.round((newBestPoints / maxPoints) * 100) :
        0;

      await progressRef.set({
        userId: uid,
        activityId,
        courseId,
        bestScore: newBestPoints,
        bestScorePercent: newBestScorePercent,
        attempts: previousAttempts + 1,
        lastAttemptAt: FieldValue.serverTimestamp(),
        completed: true,
      }, {merge: true});

      if (pointsDelta > 0) {
        const userRef = adminDb.collection("users").doc(uid);
        await userRef.update({totalPoints: FieldValue.increment(pointsDelta)});
      }

      const badges: string[] = [];
      const submittedBadges = await checkAndAwardBadges(uid, adminDb, {
        type: "activity_submitted",
        activityType,
        earnedPoints,
        maxPoints,
      });
      badges.push(...submittedBadges);

      if (earnedPoints === maxPoints && maxPoints > 0) {
        const perfectBadges = await checkAndAwardBadges(uid, adminDb, {
          type: "activity_perfect",
          activityType,
          maxPoints,
        });
        badges.push(...perfectBadges);
      }

      res.json(success({
        score: correctCount,
        maxPoints,
        scorePercent,
        pointsEarned: pointsDelta,
        earnedPoints,
        isNewCompletion,
        badges,
        feedback,
      }));
    } catch (err: unknown) {
      console.error({
        route: "POST /courses/:courseId/activities/:activityId/submit",
        uid: req.user?.uid,
        courseId: req.params.courseId,
        activityId: req.params.activityId,
        errorMessage: err instanceof Error ? err.message : String(err),
        error: err,
      });
      res.status(500).json(
        error("SUBMIT_FAILED", "Failed to submit activity")
      );
    }
  }
);

// PUT /courses/:courseId/activities/:activityId — admin update activity
router.put(
  "/:activityId",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const activityId = req.params.activityId as string;
      const docRef = adminDb
        .collection("courses")
        .doc(courseId)
        .collection("gamification")
        .doc(activityId);

      const existingSnap = await docRef.get();
      if (!existingSnap.exists) {
        res.status(404).json(error("NOT_FOUND", "Activity not found"));
        return;
      }

      const existingData = existingSnap.data() as Record<string, unknown>;
      const activityType = existingData.type as ActivityType;
      if (!validTypes.includes(activityType)) {
        res.status(400).json(
          error("INVALID_INPUT", "Stored activity type is invalid")
        );
        return;
      }

      const body = req.body as Record<string, unknown>;
      const updates: Record<string, unknown> = {};

      if (body.title !== undefined) updates.title = body.title;
      if (body.position !== undefined) updates.position = body.position;
      if (body.maxPoints !== undefined) updates.maxPoints = body.maxPoints;

      if (activityType === "drag_drop") {
        if (body.categories !== undefined) updates.categories = body.categories;
        if (body.items !== undefined) updates.items = body.items;
        if (body.feedbackMode !== undefined) {
          updates.feedbackMode = body.feedbackMode;
        }
      }

      if (activityType === "word_search") {
        if (body.wordList !== undefined) updates.wordList = body.wordList;
        if (body.gridSize !== undefined) updates.gridSize = body.gridSize;
      }

      if (activityType === "true_or_false") {
        if (body.statements !== undefined) updates.statements = body.statements;
        if (body.feedbackMode !== undefined) {
          updates.feedbackMode = body.feedbackMode;
        }
      }

      const updateError = validateTypeSpecificUpdateFields(activityType, updates);
      if (updateError) {
        res.status(400).json(error("INVALID_INPUT", updateError));
        return;
      }

      await docRef.update({
        ...updates,
        updatedAt: FieldValue.serverTimestamp(),
      });

      res.json(success({message: "Activity updated"}));
    } catch (err: unknown) {
      console.error({
        route: "PUT /courses/:courseId/activities/:activityId",
        uid: req.user?.uid,
        courseId: req.params.courseId,
        activityId: req.params.activityId,
        errorMessage: err instanceof Error ? err.message : String(err),
        error: err,
      });
      res.status(500).json(error("UPDATE_FAILED", "Failed to update activity"));
    }
  }
);

// DELETE /courses/:courseId/activities/:activityId — admin delete + cascade
router.delete(
  "/:activityId",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const courseId = req.params.courseId as string;
      const activityId = req.params.activityId as string;

      const activityRef = adminDb
        .collection("courses")
        .doc(courseId)
        .collection("gamification")
        .doc(activityId);

      const activitySnap = await activityRef.get();
      if (!activitySnap.exists) {
        res.status(404).json(error("NOT_FOUND", "Activity not found"));
        return;
      }

      const batch = adminDb.batch();
      batch.delete(activityRef);

      const progressSnap = await adminDb
        .collection("activity_progress")
        .where("activityId", "==", activityId)
        .get();

      progressSnap.docs.forEach((docSnap) => {
        batch.delete(docSnap.ref);
      });

      await batch.commit();
      res.json(success({message: "Activity deleted"}));
    } catch (err: unknown) {
      console.error({
        route: "DELETE /courses/:courseId/activities/:activityId",
        uid: req.user?.uid,
        courseId: req.params.courseId,
        activityId: req.params.activityId,
        errorMessage: err instanceof Error ? err.message : String(err),
        error: err,
      });
      res.status(500).json(error("DELETE_FAILED", "Failed to delete activity"));
    }
  }
);

export default router;
