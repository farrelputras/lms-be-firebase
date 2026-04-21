import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { adminStorage } from "../firebaseAdmin.js";
import { verifyToken } from "../middleware/verifyToken.js";
import { requireRole } from "../middleware/requireRole.js";
import { success, error } from "../utils/response.js";
import busboy from "busboy";

const router = Router();

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

      bb.on("file", (_fieldname, fileStream, info) => {
        fileName = info.filename;
        fileMime = info.mimeType;
        const chunks: Buffer[] = [];
        fileStream.on("data", (chunk) => chunks.push(chunk));
        fileStream.on("end", () => {
          fileBuffer = Buffer.concat(chunks);
        });
      });

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