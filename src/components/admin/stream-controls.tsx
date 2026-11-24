import { setLeagueStreamUrl } from "@/app/actions/admin-season";
import {
  parseStoredStream,
  WATCH_OPENS_BEFORE_KICKOFF_MS,
} from "@/lib/broadcast";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { CardBody } from "@/components/ui";
import { AdminSection } from "@/components/admin/admin-section";

export async function StreamControls() {
  const stream = parseStoredStream(
    await getSetting(SETTING_KEYS.LEAGUE_STREAM_URL),
  );
  return (
    <AdminSection
      title="Match stream"
      subtitle={
        stream
          ? `On: playoff and final matches link to ${stream.platform}.`
          : "Off: no match links to a stream."
      }
    >
      <CardBody className="space-y-3">
        <p className="text-sm text-muted">
          One Twitch, YouTube or Kick channel for the league. Every playoff and
          final match links to it on Home, its match page and the schedule:
          where it will be streamed before kickoff, then a live link from{" "}
          {WATCH_OPENS_BEFORE_KICKOFF_MS / 60_000} minutes before kickoff until
          the series should be over, or longer once a game is in. While it is
          live, the match page (and Home, when that match is the only one on)
          also plays it in place, in the streaming service&apos;s own player,
          which loads only when a visitor presses play. On YouTube that needs
          the live video&apos;s link or a youtube.com/channel/UC… link. The
          regular season shows nothing. Remove it on playoff nights nobody
          streams.
        </p>
        <ActionForm
          action={setLeagueStreamUrl}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-0 flex-1 basis-64">
            <label htmlFor="streamUrl" className="mb-1 block text-xs text-muted">
              Stream link
            </label>
            <input
              id="streamUrl"
              name="streamUrl"
              type="url"
              inputMode="url"
              defaultValue={stream?.url ?? ""}
              placeholder="https://www.twitch.tv/yourchannel"
              className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
            />
          </div>
          <SubmitButton variant="secondary" size="sm">
            Save stream link
          </SubmitButton>
        </ActionForm>
        {stream ? (
          <ActionForm action={setLeagueStreamUrl} hidden={{ streamUrl: "" }}>
            <SubmitButton variant="ghost" size="sm">
              Remove stream link
            </SubmitButton>
          </ActionForm>
        ) : null}
      </CardBody>
    </AdminSection>
  );
}
