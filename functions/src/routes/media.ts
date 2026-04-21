import { Router } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { adminStorage } from "../firebaseAdmin.js";
import { verifyToken } from "../middleware/verifyToken.js";
import { requireRole } from "../middleware/requireRole.js";
import { success, error } from "../utils/response.js";

const router = Router();

// Configure multer to store files in memory temporarily
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});

// POST /media/upload — Admin only
router.post(
  "/upload",
  verifyToken,
  requireRole("admin"),
  upload.single("file"), // Flutter must use 'file' as the form-data key
  async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json(error("BAD_REQUEST", "No image file provided"));
        return;
      }

      // 1. Target the default bucket
      const bucket = adminStorage.bucket();

      // 2. Create a unique filename
      const extension = req.file.originalname.split('.').pop();
      const filename = `thumbnails/${uuidv4()}.${extension}`;
      const fileRef = bucket.file(filename);

      // 3. Upload the buffer to Firebase Storage
      await fileRef.save(req.file.buffer, {
        metadata: {
          contentType: req.file.mimetype,
        },
      });

      // 4. Make the file publicly readable (so Flutter can use Image.network)
      await fileRef.makePublic();

      // 5. Construct the public URL
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;

      res.status(201).json(success({ imageUrl: publicUrl }));
    } catch (err: unknown) {
      console.error("Upload Error:", err);
      res.status(500).json(error("UPLOAD_FAILED", "Failed to upload image"));
    }
  }
);

export default router;