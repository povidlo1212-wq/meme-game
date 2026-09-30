# Firebase → SQLite on Amvera

The running bot remains on Firebase unless `DB_BACKEND=sqlite` is set. Do not
change that variable until the current Firebase data has been exported,
imported, uploaded to Amvera's persistent **Data** area, and verified. The
SQLite file must live at `/data/meme-game.sqlite` (not in Code or `/app`).

The Firebase console has **Realtime Database → Data → ⋮ → Export JSON**.
Keep the export private; it includes player and payment-related records.
The offline import command is:

```text
node import-firebase-export.js <absolute-export.json> <absolute-new.sqlite>
```

The import refuses to overwrite an existing file and verifies that the
imported tree matches the export. Upload only the resulting SQLite file to
Amvera **Data**. Never upload the JSON or SQLite file to GitHub.

Before switching, re-export immediately before cutover: the first export
becomes stale whenever another payment or game write occurs. Keep the Firebase
export as a recovery copy. Rollback is `DB_BACKEND=firebase`, but remember
that new SQLite writes made after cutover will not appear in Firebase without
a reverse migration.

This only migrates the bot/server's database operations. The frontend still
connects directly to Firebase for leaderboard and room discovery, and uses
Ably for live multiplayer. Do not disable Firebase until those are migrated
and tested separately, including mobile/VPN connectivity.
