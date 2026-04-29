import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {adminDb, normalizeFirestoreData} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {success, error} from "../utils/response.js";

const router = Router({mergeParams: true});

router.use(verifyToken);

/**
 * Generate serial number for certificate.
 * Format: CERT-{courseId[0..5].toUpperCase()}-{uid[0..5].toUpperCase()}-{YYYYMMDD}
 */
function generateSerialNumber(courseId: string, uid: string): string {
  const now = new Date();
  const yyyymmdd = now
    .toISOString()
    .split("T")[0]
    .replace(/-/g, "");
  return `CERT-${courseId
    .slice(0, 5)
    .toUpperCase()}-${uid
    .slice(0, 5)
    .toUpperCase()}-${yyyymmdd}`;
}

// POST /certificates — issue or retrieve existing certificate (idempotent)
router.post("/", async (req, res) => {
  try {
    const {courseId} = req.params as {courseId: string};
    const uid = req.user!.uid;

    if (!courseId) {
      res.status(400).json(
        error("BAD_REQUEST", "courseId is required in path")
      );
      return;
    }

    // Check progress eligibility: percentage === 100
    const progressId = `${uid}_${courseId}`;
    const progressSnap = await adminDb
      .collection("progress")
      .doc(progressId)
      .get();

    if (!progressSnap.exists || progressSnap.data()?.percentage !== 100) {
      res.status(403).json(
        error(
          "CERTIFICATE_NOT_ELIGIBLE",
          "Kamu belum memenuhi syarat untuk mendapatkan sertifikat."
        )
      );
      return;
    }

    // Check gamification activity eligibility: all activities must have bestScorePercent === 100
    const gamificationSnap = await adminDb
      .collection("courses")
      .doc(courseId)
      .collection("gamification")
      .get();

    if (!gamificationSnap.empty) {
      // If there are gamification activities, check each one
      for (const gamDoc of gamificationSnap.docs) {
        const activityId = gamDoc.id;
        const activityProgressId = `${uid}_${activityId}`;
        const activityProgressSnap = await adminDb
          .collection("activity_progress")
          .doc(activityProgressId)
          .get();

        // If activity progress not found or bestScorePercent !== 100, not eligible
        if (
          !activityProgressSnap.exists ||
          activityProgressSnap.data()?.bestScorePercent !== 100
        ) {
          res.status(403).json(
            error(
              "CERTIFICATE_NOT_ELIGIBLE",
              "Kamu belum memenuhi syarat untuk mendapatkan sertifikat."
            )
          );
          return;
        }
      }
    }

    // Check if certificate already exists (idempotent)
    const certId = `${uid}_${courseId}`;
    const existingCertSnap = await adminDb
      .collection("certificates")
      .doc(certId)
      .get();

    if (existingCertSnap.exists) {
      // Return existing certificate
      const certData = existingCertSnap.data();
      res.status(200).json(success(normalizeFirestoreData(certData)));
      return;
    }

    // Fetch user name
    const userSnap = await adminDb.collection("users").doc(uid).get();
    const userName = userSnap.exists ? userSnap.data()?.name : "Unknown";

    // Fetch course name
    const courseSnap = await adminDb
      .collection("courses")
      .doc(courseId)
      .get();
    const courseName = courseSnap.exists ? courseSnap.data()?.title : "Unknown";

    // Generate certificate
    const serialNumber = generateSerialNumber(courseId, uid);
    const certData = {
      id: certId,
      userId: uid,
      courseId,
      userName,
      courseName,
      serialNumber,
      issuedAt: FieldValue.serverTimestamp(),
    };

    await adminDb.collection("certificates").doc(certId).set(certData);

    // Fetch, derive completionDate from server timestamp, and return
    const createdRef = adminDb.collection("certificates").doc(certId);
    const createdSnap = await createdRef.get();
    const createdData = createdSnap.data();

    const issuedAt = createdData?.issuedAt?.toDate?.() as Date | undefined;
    const completionDate = issuedAt
      ? issuedAt.toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0];

    await createdRef.update({completionDate});
    const updatedSnap = await createdRef.get();
    const updatedData = updatedSnap.data();

    res.status(200).json(success(normalizeFirestoreData(updatedData)));
  } catch (err) {
    const uid = req.user?.uid;
    const courseId = (req.params as {courseId?: string})?.courseId;
    console.error(`[certificates POST] uid=${uid} courseId=${courseId}`, err);
    res.status(500).json(
      error("INTERNAL_ERROR", "Failed to issue certificate")
    );
  }
});

// GET /me — retrieve existing certificate for current user
router.get("/me", async (req, res) => {
  try {
    const {courseId} = req.params as {courseId: string};
    const uid = req.user!.uid;

    if (!courseId) {
      res.status(400).json(
        error("BAD_REQUEST", "courseId is required in path")
      );
      return;
    }

    const certId = `${uid}_${courseId}`;
    const certSnap = await adminDb
      .collection("certificates")
      .doc(certId)
      .get();

    if (!certSnap.exists) {
      res.status(404).json(
        error("CERTIFICATE_NOT_FOUND", "Sertifikat tidak ditemukan")
      );
      return;
    }

    const certData = certSnap.data();
    res.status(200).json(success(normalizeFirestoreData(certData)));
  } catch (err) {
    const uid = req.user?.uid;
    const courseId = (req.params as {courseId?: string})?.courseId;
    console.error(`[certificates GET /me] uid=${uid} courseId=${courseId}`, err);
    res.status(500).json(
      error("INTERNAL_ERROR", "Failed to retrieve certificate")
    );
  }
});

export default router;
