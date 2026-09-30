// One-time offline import. Never commit the Firebase JSON export or the resulting DB.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { openSqliteStore } = require('./sqlite-store');

async function main() {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination || !path.isAbsolute(source) || !path.isAbsolute(destination)) {
    throw new Error('Usage: node import-firebase-export.js <absolute-export.json> <absolute-new.sqlite>');
  }
  if (fs.existsSync(destination)) throw new Error('Destination already exists; refusing to overwrite');
  const data = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.paidUsers) {
    throw new Error('Expected Firebase export with paidUsers; refusing incomplete import');
  }
  const store = await openSqliteStore(destination);
  try {
    await store.ref('').set(data);
    const imported = (await store.ref('').get()).val();
    assert.deepStrictEqual(imported, data, 'Imported data differs from source');
    for (const [collection, records] of Object.entries(data)) {
      console.log(collection + ': ' + (records && typeof records === 'object' ? Object.keys(records).length : 1) + ' records verified');
    }
    console.log('SQLite import complete; keep both files private and outside GitHub');
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error('Import failed:', error.message);
  process.exitCode = 1;
});
