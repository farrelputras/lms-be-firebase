import {Router} from "express";
import {FieldValue} from "firebase-admin/firestore";

import {adminDb} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {success, error} from "../utils/response.js";

const router = Router();

router.use(verifyToken);

// POST /chatbot/message
router.post("/message", async (req, res) => {
  try {
    const {message, sessionId} = req.body as {
      message?: string;
      sessionId?: string;
    };
    const uid = req.user!.uid;

    if (!message || !sessionId) {
      res.status(400).json(
        error("BAD_REQUEST", "message and sessionId are required")
      );
      return;
    }

    const sessRef = adminDb
      .collection("chatHistory")
      .doc(uid)
      .collection("sessions")
      .doc(sessionId);

    // Save user message
    await sessRef.collection("messages").add({
      role: "user",
      content: message,
      timestamp: FieldValue.serverTimestamp(),
    });

    // TODO: Forward to AI provider (OpenAI, Google AI, etc.)
    // Placeholder response for now
    const aiResponse =
      "Terima kasih atas pertanyaan Anda tentang literasi syariah. " +
      "Fitur chatbot AI sedang dalam pengembangan.";

    // Save assistant response
    await sessRef.collection("messages").add({
      role: "assistant",
      content: aiResponse,
      timestamp: FieldValue.serverTimestamp(),
    });

    // Update session metadata
    await sessRef.set(
      {
        lastMessage: message,
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true}
    );

    res.json(success({sessionId, response: aiResponse}));
  } catch {
    res.status(500).json(
      error("CHATBOT_FAILED", "Failed to process chatbot message")
    );
  }
});

export default router;
