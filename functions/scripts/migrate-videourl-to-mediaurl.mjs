import 'dotenv/config';
import { FieldValue } from 'firebase-admin/firestore';

import { adminDb } from '../lib/firebaseAdmin.js';

async function run() {
  let scannedDocs = 0;
  let patchedDocs = 0;

  const coursesSnap = await adminDb.collection('courses').get();

  for (const courseDoc of coursesSnap.docs) {
    const chaptersSnap = await courseDoc.ref.collection('chapters').get();

    for (const chapterDoc of chaptersSnap.docs) {
      scannedDocs += 1;

      const data = chapterDoc.data();
      if (!('videoUrl' in data)) {
        console.log(`[skipped] ${chapterDoc.ref.path}`);
        continue;
      }

      await chapterDoc.ref.update({
        mediaUrl: data.videoUrl,
        mediaType: 'youtube',
        videoUrl: FieldValue.delete(),
      });

      patchedDocs += 1;
      console.log(`[patched] ${chapterDoc.ref.path} | videoUrl="${data.videoUrl}"`);
    }
  }

  console.log('--- migration summary ---');
  console.log(`documentsScanned=${scannedDocs}`);
  console.log(`documentsPatched=${patchedDocs}`);
}

run().catch((err) => {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
