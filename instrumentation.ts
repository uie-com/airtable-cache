// Next.js loads this file automatically when it starts the app.
// The cache service rebuilds missing preload files from the `/cache-<site>.js` rewrite route on
// demand, so this startup hook stays intentionally empty to avoid framework-specific bundling
// issues before the first request arrives.
export async function register(): Promise<void> {}
