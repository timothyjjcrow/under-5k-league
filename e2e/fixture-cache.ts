import { waitForDevRoutes } from "./dev-routes";

// Expire the reused dev server's caches after a suite reseeds its fixture
// database (POST /api/test/cache; the route explains why). This is the first
// thing every suite's global setup asks of its dev server, so it first waits
// until that server routes the app: a fresh `next dev` can answer a route
// that exists with a 404 while its route table fills in (dev-routes.ts).
// Once the route is known, a 404 is the route's own refusal (a production
// build, no dev login, a non-fixture database).
export async function expireFixtureCache(origin: string, label: string) {
  await waitForDevRoutes(origin, label);
  const cache = await fetch(`${origin}/api/test/cache`, {
    method: "POST",
  }).catch(() => null);
  if (cache?.ok) return;
  throw new Error(
    `Couldn't expire the reused ${label} fixture cache (${cache?.status ?? "no response"})`,
  );
}
