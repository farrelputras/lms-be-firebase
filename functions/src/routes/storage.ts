import {Router} from "express";

import {adminStorage} from "../firebaseAdmin.js";
import {verifyToken} from "../middleware/verifyToken.js";
import {requireRole} from "../middleware/requireRole.js";
import {success, error} from "../utils/response.js";

const router = Router();

router.use(verifyToken);

// POST /storage/upload-url — admin only
router.post(
  "/upload-url",
  requireRole("admin"),
  async (req, res) => {
    try {
      const {fileName, contentType, folder} = req.body as {
        fileName?: string;
        contentType?: string;
        folder?: string;
      };

      if (!fileName || !contentType) {
        res.status(400).json(
          error("BAD_REQUEST", "fileName and contentType are required")
        );
        return;
      }

      const filePath = folder ? `${folder}/${fileName}` : fileName;
      const bucket = adminStorage.bucket();
      const file = bucket.file(filePath);

      const [url] = await file.getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + 15 * 60 * 1000, // 15 minutes
        contentType,
      });

      res.json(success({uploadUrl: url, filePath}));
    } catch {
      res.status(500).json(
        error("UPLOAD_URL_FAILED", "Failed to generate upload URL")
      );
    }
  }
);

// GET /storage/download-url/:fileId — authenticated
router.get("/download-url/:fileId", async (req, res) => {
  try {
    const filePath = (req.query.path as string) || req.params.fileId;

    const bucket = adminStorage.bucket();
    const file = bucket.file(filePath);

    const [exists] = await file.exists();
    if (!exists) {
      res.status(404).json(error("NOT_FOUND", "File not found"));
      return;
    }

    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 60 * 60 * 1000, // 1 hour
    });

    res.json(success({downloadUrl: url, filePath}));
  } catch {
    res.status(500).json(
      error("DOWNLOAD_URL_FAILED", "Failed to generate download URL")
    );
  }
});

export default router;
