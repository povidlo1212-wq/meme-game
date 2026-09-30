# Firebase → SQLite on Amvera

The running bot remains on Firebase unless `DB_BACKEND=sqlite` is set. Do not
change that variable until the new code is deployed and the existing data has
been exported. The SQLite file must live at `/data/meme-game.sqlite` (not in
Code or `/app`).

For the first cutover, set `DB_BACKEND=sqlite` and
`SQLITE_BOOTSTRAP_FROM_FIREBASE=1` on the one running Amvera replica. If the
SQLite file is absent, startup copies the latest Firebase database into
`/data`, verifies it and only then begins serving requests. The existing
Firebase service-account and database URL variables must remain available for
that first start. On later restarts, the existing SQLite file is used directly.
Never run a second replica against the same SQLite file.

The Firebase console has **Realtime Database → Data → ⋮ → Export JSON**.
Keep the export private; it includes player and payment-related records.
The offline import command, if server-side bootstrap cannot be used, is:

```text
node import-firebase-export.js <absolute-export.json> <absolute-new.sqlite>
```

The offline import refuses to overwrite an existing file and verifies that the
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
