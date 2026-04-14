import 'dotenv/config';
import crypto from 'node:crypto';

import { adminDb } from '../lib/firebaseAdmin.js';

const isBlankId = (value) => typeof value !== 'string' || value.trim() === '';

async function run() {
  let scannedDocs = 0;
  let patchedDocs = 0;
  let patchedItemsTotal = 0;
  let dragDropDocs = 0;

  const coursesSnap = await adminDb.collection('courses').get();

  for (const courseDoc of coursesSnap.docs) {
    const gamificationSnap = await courseDoc.ref.collection('gamification').get();

    for (const docSnap of gamificationSnap.docs) {
      scannedDocs += 1;

      const data = docSnap.data();
      if (data.type !== 'drag_drop') {
        continue;
      }

      dragDropDocs += 1;
      const items = Array.isArray(data.items) ? data.items : [];

      let patchedItemsForDoc = 0;
      const updatedItems = items.map((item) => {
        const current = item && typeof item === 'object' ? item : {};
        if (isBlankId(current.id)) {
          patchedItemsForDoc += 1;
          return {
            ...current,
            id: crypto.randomUUID(),
          };
        }

        return current;
      });

      if (patchedItemsForDoc > 0) {
        await docSnap.ref.update({ items: updatedItems });
        patchedDocs += 1;
        patchedItemsTotal += patchedItemsForDoc;
        console.log(`[patched] ${docSnap.ref.path} | patchedItems=${patchedItemsForDoc}`);
        console.log(`  sampleItemIds=${updatedItems.map((i) => i.id).slice(0, 3).join(', ')}`);
      } else {
        console.log(`[skipped] ${docSnap.ref.path}`);
      }
    }
  }

  console.log('--- migration summary ---');
  console.log(`documentsScanned=${scannedDocs}`);
  console.log(`dragDropDocumentsScanned=${dragDropDocs}`);
  console.log(`documentsPatched=${patchedDocs}`);
  console.log(`itemsPatched=${patchedItemsTotal}`);
}

run().catch((err) => {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
