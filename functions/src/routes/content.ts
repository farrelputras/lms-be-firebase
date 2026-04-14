import {Router} from "express";

import {adminDb, normalizeFirestoreData} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {checkEnrollment} from "../middleware/checkEnrollment.js";
import {success, error} from "../utils/response.js";

type ActivityType = "drag_drop" | "word_search" | "true_or_false";

interface ProgressSummary {
  completed: boolean;
  bestScorePercent?: number;
  attempts?: number;
}

interface ChapterContentItem {
  itemType: "chapter";
  id: string;
  title: string;
  position: number;
  completed: boolean;
  locked: boolean;
  [key: string]: unknown;
}

interface ActivityContentItem {
  itemType: "activity";
  id: string;
  type: ActivityType;
  title: string;
  position: number;
  completed: boolean;
  locked: boolean;
  bestScorePercent?: number;
  attempts?: number;
  [key: string]: unknown;
}

type ContentItem = ChapterContentItem | ActivityContentItem;

const router = Router({mergeParams: true});

const toPosition = (data: Record<string, unknown>): number => {
  if (typeof data.position === "number") return data.position;
  if (typeof data.order === "number") return data.order;
  return 0;
};

const toTitle = (data: Record<string, unknown>, fallback: string): string => {
  return typeof data.title === "string" ? data.title : fallback;
};

const sanitizeActivityData = (
  data: Record<string, unknown>
): Record<string, unknown> => {
  const activityType = data.type as ActivityType | undefined;

  if (activityType === "drag_drop" && Array.isArray(data.items)) {
    return {
      ...data,
      items: data.items.map((item) => {
        const typedItem = item as Record<string, unknown>;
        return {
          id: typedItem.id,
          label: typedItem.label,
        };
      }),
    };
  }

  if (activityType === "true_or_false" && Array.isArray(data.statements)) {
    return {
      ...data,
      statements: data.statements.map((statement) => {
        const typedStatement = statement as Record<string, unknown>;
        return {
          id: typedStatement.id,
          text: typedStatement.text,
        };
      }),
    };
  }

  return data;
};

router.get("/", verifyToken, checkEnrollment, async (req, res) => {
  try {
    const courseId = req.params.courseId as string;
    const uid = req.user!.uid;

    const [chaptersSnap, activitiesSnap] = await Promise.all([
      adminDb.collection("courses").doc(courseId).collection("chapters").get(),
      adminDb
        .collection("courses")
        .doc(courseId)
        .collection("gamification")
        .get(),
    ]);

    const chapterItems = chaptersSnap.docs.map((docSnap) => {
      const data = normalizeFirestoreData(
        docSnap.data()
      ) as Record<string, unknown>;

      return {
        itemType: "chapter" as const,
        id: docSnap.id,
        ...data,
        title: toTitle(data, "Untitled Chapter"),
        position: toPosition(data),
      };
    });

    const activityItems = activitiesSnap.docs.map((docSnap) => {
      const rawData = normalizeFirestoreData(
        docSnap.data()
      ) as Record<string, unknown>;
      const data = sanitizeActivityData(rawData);
      const type = data.type as ActivityType;

      return {
        itemType: "activity" as const,
        id: docSnap.id,
        ...data,
        type,
        title: toTitle(data, "Untitled Activity"),
        position: toPosition(data),
      };
    });

    const items = [...chapterItems, ...activityItems].sort(
      (a, b) => a.position - b.position
    );

    const [progressSnap, activityProgressSnaps] = await Promise.all([
      adminDb.collection("progress").doc(`${uid}_${courseId}`).get(),
      adminDb.collection("activity_progress").where("userId", "==", uid).get(),
    ]);

    const completedChapters: string[] = progressSnap.exists ?
      ((progressSnap.data()?.completedChapters as string[]) || []) :
      [];

    const activityProgressMap = new Map<string, ProgressSummary>();
    activityProgressSnaps.docs.forEach((docSnap) => {
      const data = normalizeFirestoreData(
        docSnap.data()
      ) as Record<string, unknown>;

      const rawActivityId = data.activityId;
      const activityId = typeof rawActivityId === "string" ?
        rawActivityId :
        (docSnap.id.includes("_") ? docSnap.id.split("_").slice(1).join("_") : "");

      if (!activityId) {
        return;
      }

      const existing = activityProgressMap.get(activityId);
      const completed = typeof data.completed === "boolean" ? data.completed : false;
      const bestScorePercent =
        typeof data.bestScorePercent === "number" ? data.bestScorePercent : undefined;
      const attempts = typeof data.attempts === "number" ? data.attempts : undefined;

      if (!existing) {
        activityProgressMap.set(activityId, {
          completed,
          bestScorePercent,
          attempts,
        });
        return;
      }

      activityProgressMap.set(activityId, {
        completed: existing.completed || completed,
        bestScorePercent: typeof bestScorePercent === "number" ?
          Math.max(existing.bestScorePercent ?? 0, bestScorePercent) :
          existing.bestScorePercent,
        attempts: typeof attempts === "number" ?
          Math.max(existing.attempts ?? 0, attempts) :
          existing.attempts,
      });
    });

    const result = items.map((item, index) => {
      let completed = false;
      if (item.itemType === "chapter") {
        completed = completedChapters.includes(item.id);
      } else {
        completed = activityProgressMap.get(item.id)?.completed ?? false;
      }

      const previous = index > 0 ? (items[index - 1] as ContentItem) : null;
      const previousCompleted = previous ?
        (previous.itemType === "chapter" ?
          completedChapters.includes(previous.id) :
          (activityProgressMap.get(previous.id)?.completed ?? false)) :
        true;

      const locked = index === 0 ? false : !previousCompleted;
      const baseItem = {
        ...item,
        completed,
        locked,
      } as ContentItem;

      if (baseItem.itemType === "activity") {
        const progress = activityProgressMap.get(baseItem.id);
        return {
          ...baseItem,
          ...(progress?.bestScorePercent !== undefined ?
            {bestScorePercent: progress.bestScorePercent} :
            {}),
          ...(progress?.attempts !== undefined ?
            {attempts: progress.attempts} :
            {}),
        };
      }

      return baseItem;
    });

    if (req.user?.role === "admin") {
      const unlockedForAdmin = result.map((item) => ({
        ...item,
        locked: false,
      }));
      res.json(success(unlockedForAdmin));
      return;
    }

    res.json(success(result));
  } catch (err: unknown) {
    console.error({
      route: "GET /courses/:courseId/content",
      uid: req.user?.uid,
      courseId: req.params.courseId,
      errorMessage: err instanceof Error ? err.message : String(err),
      error: err,
    });
    res.status(500).json(
      error("FETCH_FAILED", "Failed to fetch course content")
    );
  }
});

export default router;
