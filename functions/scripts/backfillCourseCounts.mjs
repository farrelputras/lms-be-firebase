import "dotenv/config";
import {adminDb} from "../lib/firebaseAdmin.js";

async function backfill() {
  const coursesSnap = await adminDb.collection("courses").get();
  console.log(`Found ${coursesSnap.size} course(s). Starting backfill...`);

  let processed = 0;

  for (const courseDoc of coursesSnap.docs) {
    const courseId = courseDoc.id;

    const [chaptersSnap, activitiesSnap] = await Promise.all([
      adminDb.collection("courses").doc(courseId).collection("chapters").get(),
      adminDb.collection("courses").doc(courseId).collection("gamification").get(),
    ]);

    const totalChapters = chaptersSnap.size;
    const totalActivities = activitiesSnap.size;

    await adminDb.collection("courses").doc(courseId).update({
      totalChapters,
      totalActivities,
    });

    console.log(`[${courseId}] totalChapters=${totalChapters}, totalActivities=${totalActivities}`);
    processed++;
  }

  console.log(`\n✅ Backfill complete. ${processed} course(s) updated.`);
}

backfill().catch(console.error);
