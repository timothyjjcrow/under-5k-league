// Expire the reused dev server's caches after a suite reseeds its fixture
// database (POST /api/test/cache; the route explains why). A freshly started
// dev server can answer that first request with a 404 while it settles: CI
// saw one in 0.2s (2026-10-06) where a good run compiles the route in about a
// second, and the same commit's other league passed. The route's own refusal
// (a production build, no dev login, a non-fixture database) is a 404 too,
// so retry a few times, then fail loudly with the last status.
export async function expireFixtureCache(origin: string, label: string) {
  let status = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
    const cache = await fetch(`${origin}/api/test/cache`, {
      method: "POST",
    }).catch(() => null);
    if (cache?.ok) return;
    status = cache?.status ?? 0;
  }
  throw new Error(
    `Couldn't expire the reused ${label} fixture cache (${status})`,
  );
}
