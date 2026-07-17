import { maybeAnnounceUpcomingWeek } from "@/lib/reminder-service";

// Invisible server component: awaits the lazy match-night Discord reminder
// inside its own <Suspense fallback={null}> boundary, so on the rare request
// that actually sends, the page shell has already painted. Renders nothing.
export async function WeekReminderPing({
  season,
}: {
  season: { id: string; status: string };
}) {
  await maybeAnnounceUpcomingWeek(season);
  return null;
}
