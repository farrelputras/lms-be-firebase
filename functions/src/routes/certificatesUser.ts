import {Router} from "express";

import {adminDb, normalizeFirestoreData} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {success, error} from "../utils/response.js";

const router = Router();

router.use(verifyToken);

// GET /me — retrieve all certificates for current user
router.get("/me", async (req, res) => {
  try {
    const uid = req.user!.uid;

    const snapshot = await adminDb
      .collection("certificates")
      .where("userId", "==", uid)
      .orderBy("issuedAt", "desc")
      .get();

    const certificates = snapshot.docs.map((docSnap) => {
      const data = normalizeFirestoreData(docSnap.data()) as Record<string, unknown>;
      return {id: docSnap.id, ...data};
    });

    res.status(200).json(success(certificates));
  } catch (err) {
    const uid = req.user?.uid;
    console.error(`[certificatesUser GET /me] uid=${uid}`, err);
    res.status(500).json(
      error("INTERNAL_ERROR", "Failed to retrieve certificates")
    );
  }
});

export default router;
