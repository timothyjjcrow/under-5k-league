import { formatLeagueMatchTime } from "@/lib/match-time";
import { InhouseNightControls } from "@/components/admin/inhouse-night-controls";
import { inhouseNightPhase } from "@/lib/inhouse-night";
import { readInhouseNight } from "@/lib/inhouse-night-service";
import { readInhouseNightRsvps } from "@/lib/inhouse-night-rsvp-service";
import { AdminSection } from "@/components/admin/admin-section";

export async function AdminInhouseNight() {
  const { night } = await readInhouseNight();
  const rsvps = night ? await readInhouseNightRsvps(night.id) : null;
  // eslint-disable-next-line react-hooks/purity -- async server component
  const nowMs = Date.now();
  const phase = night ? inhouseNightPhase(night, nowMs) : null;
  return (
    <AdminSection
      id="adm-inhouse-night"
      title="Inhouse night"
      subtitle={
        night && phase === "upcoming"
          ? `Planned: ${formatLeagueMatchTime(new Date(night.startsAtMs), "full")}`
          : phase === "on"
            ? "On now."
            : "None planned: pick an evening and it's announced on the site and in Discord."
      }
    >
      <InhouseNightControls night={night} rsvps={rsvps} nowMs={nowMs} />
    </AdminSection>
  );
}
