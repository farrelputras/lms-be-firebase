import {Router} from "express";

import {adminDb} from "../firebaseAdmin.js";
import {success, error} from "../utils/response.js";

const router = Router();

// GET /leaderboard — public
router.get("/", async (_req, res) => {
  try {
    const snapshot = await adminDb
      .collection("users")
      .orderBy("totalPoints", "desc")
      .get();

    const users = snapshot.docs.map((docSnap) => {
      const data = docSnap.data();
      return {
        uid: docSnap.id,
        name: (data.name as string) ||
          (data.displayName as string) || "",
        totalPoints:
          typeof data.totalPoints === "number" ? data.totalPoints : 0,
      };
    });

    res.json(success(users));
  } catch {
    res.status(500).json(
      error("FETCH_FAILED", "Failed to fetch leaderboard")
    );
  }
});

export default router;
