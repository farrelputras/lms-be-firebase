import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { adminStorage } from "../firebaseAdmin.js";
import { verifyToken } from "../middleware/verifyToken.js";
import { requireRole } from "../middleware/requireRole.js";
import { success, error } from "../utils/response.js";

const busboy = require("busboy") as (options: {
  headers: Record<string, string | string[] | undefined>;
}) => any;

const router = Router();

router.get("/view", async (req, res) => {
  try {
    const path = req.query.path;
    const shouldRedirect = req.query.redirect !== "0";

    if (typeof path !== "string" || path.trim().length === 0) {
      res.status(400).json(error("BAD_REQUEST", "path query is required"));
      return;
    }

    const filePath = decodeURIComponent(path).trim();

    // Only allow expected storage prefix for web thumbnails.
    if (
      filePath.startsWith("/") ||
      filePath.includes("..") ||
      !filePath.startsWith("thumbnails/")
    ) {
      res.status(403).json(error("FORBIDDEN", "Invalid media path"));
      return;
    }

    const bucket = adminStorage.bucket();
    const file = bucket.file(filePath);
    const [exists] = await file.exists();

    if (!exists) {
      res.status(404).json(error("NOT_FOUND", "Media file not found"));
      return;
    }

    const [signedUrl] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 60 * 60 * 1000,
    });

    if (shouldRedirect) {
      res.redirect(302, signedUrl);
      return;
    }

    res.json(success({viewUrl: signedUrl, filePath}));
  } catch (err: unknown) {
    console.error("Media View Error:", err);
    res.status(500).json(error("MEDIA_VIEW_FAILED", String(err)));
  }
});

router.post(
  "/upload",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      // Use busboy directly instead of multer
      // Multer conflicts with Firebase Functions v2 body buffering
      const bb = busboy({ headers: req.headers });
      
      let fileBuffer: Buffer | null = null;
      let fileName = "";
      let fileMime = "";

      bb.on(
        "file",
        (
          _fieldname: string,
          fileStream: NodeJS.ReadableStream,
          info: {filename: string; mimeType: string}
        ) => {
        fileName = info.filename;
        fileMime = info.mimeType;
        const chunks: Buffer[] = [];
        fileStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        fileStream.on("end", () => {
          fileBuffer = Buffer.concat(chunks);
        });
        }
      );

      bb.on("finish", async () => {
        try {
          if (!fileBuffer || fileBuffer.length === 0) {
            res.status(400).json(error("BAD_REQUEST", "No image file provided"));
            return;
          }

          const bucket = adminStorage.bucket();
          const ext = fileName.split(".").pop() ?? "jpg";
          const filename = `thumbnails/${uuidv4()}.${ext}`;
          const fileRef = bucket.file(filename);

          await fileRef.save(fileBuffer, {
            metadata: { contentType: fileMime },
          });

          const encodedFilename = encodeURIComponent(filename);
          const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedFilename}?alt=media`;

          res.status(201).json(success({ imageUrl: publicUrl }));
        } catch (err: unknown) {
          console.error("Upload Error:", err);
          res.status(500).json(error("UPLOAD_FAILED", String(err)));
        }
      });

      if ((req as any).rawBody) {
  // Firebase Functions v2 already buffered the body into rawBody
  const { Readable } = require('stream');
  const readable = new Readable();
  readable.push((req as any).rawBody);
  readable.push(null);
  readable.pipe(bb);
} else {
  req.pipe(bb);
}

      req.pipe(bb);
    } catch (err: unknown) {
      console.error("Upload Error:", err);
      res.status(500).json(error("UPLOAD_FAILED", String(err)));
    }
  }
);

export default router;