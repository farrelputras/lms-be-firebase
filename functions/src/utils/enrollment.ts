import {FieldValue} from "firebase-admin/firestore";
import {adminDb} from "../firebaseAdmin.js";

/**
 * Creates an enrollment doc for (uid, courseId) if one does not already exist.
 * Uses the existing enrollments collection shape: { userId, courseId, enrolledAt }.
 * Enrollment docs use auto-id (not composite id) — dedup is enforced by query.
 *
 * @returns { created: true, id } on a new enrollment; { created: false, id } if already enrolled.
 */
export async function createEnrollmentIfAbsent(
  uid: string,
  courseId: string
): Promise<{created: boolean; id: string}> {
  const existing = await adminDb
    .collection("enrollments")
    .where("userId", "==", uid)
    .where("courseId", "==", courseId)
    .limit(1)
    .get();

  if (!existing.empty) {
    return {created: false, id: existing.docs[0].id};
  }

  const docRef = await adminDb.collection("enrollments").add({
    userId: uid,
    courseId,
    enrolledAt: FieldValue.serverTimestamp(),
  });

  return {created: true, id: docRef.id};
}
