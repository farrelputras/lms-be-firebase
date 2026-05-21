import {FieldValue} from "firebase-admin/firestore";

import {adminDb} from "../firebaseAdmin.js";

/**
 * Recompute a course's combined progress percentage (chapters + activities)
 * and persist it on progress/{uid}_{courseId}. An activity counts as done when
 * its activity_progress.completed === true. Runs in a transaction so the
 * percentage stays consistent when chapter-complete and activity-submit race
 * the same field. Creates the progress doc if it does not exist yet (e.g. a
 * student finishes an activity before any chapter). Returns the computed value.
 */
export async function recalculateCourseProgress(
  uid: string,
  courseId: string,
): Promise<number> {
  const progressRef = adminDb.collection("progress").doc(`${uid}_${courseId}`);
  const chaptersRef = adminDb
    .collection("courses")
    .doc(courseId)
    .collection("chapters");
  const gamificationRef = adminDb
    .collection("courses")
    .doc(courseId)
    .collection("gamification");
  const activityProgressQuery = adminDb
    .collection("activity_progress")
    .where("userId", "==", uid);

  return adminDb.runTransaction(async (tx) => {
    // All reads must precede the write inside a transaction.
    const progressSnap = await tx.get(progressRef);
    const chaptersSnap = await tx.get(chaptersRef);
    const gamificationSnap = await tx.get(gamificationRef);
    const activityProgressSnap = await tx.get(activityProgressQuery);

    const existingChapterIds = new Set(chaptersSnap.docs.map((d) => d.id));
    const courseActivityIds = new Set(gamificationSnap.docs.map((d) => d.id));

    const totalChapters = existingChapterIds.size;
    const totalActivities = courseActivityIds.size;
    const total = totalChapters + totalActivities;

    const completedChapters: string[] = progressSnap.exists ?
      ((progressSnap.data()?.completedChapters as string[]) ?? []) :
      [];
    // Filter to chapters that still exist so a deleted chapter cannot push
    // the count above the total.
    const doneChapters = completedChapters.filter(
      (id) => existingChapterIds.has(id)
    ).length;

    // Scope by the course's actual activity set (mirrors content.ts), so the
    // count cannot exceed totalActivities and does not depend on a courseId
    // field being present on each activity_progress doc.
    const doneActivities = activityProgressSnap.docs.filter((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const rawActivityId = data.activityId;
      const activityId = typeof rawActivityId === "string" ?
        rawActivityId :
        (doc.id.includes("_") ? doc.id.split("_").slice(1).join("_") : "");
      return courseActivityIds.has(activityId) && data.completed === true;
    }).length;

    const done = doneChapters + doneActivities;
    const percentage = total > 0 ? Math.round((done / total) * 100) : 0;

    if (progressSnap.exists) {
      tx.update(progressRef, {
        percentage,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      tx.set(progressRef, {
        userId: uid,
        courseId,
        completedChapters: [],
        percentage,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return percentage;
  });
}
