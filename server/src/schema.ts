// This artifact stores no rows of its own: playback state is read live from
// the user's connected Spotify account on every poll, and lyrics are fetched
// on demand. The scaffold `entries` table is dropped by migration.
export {};
