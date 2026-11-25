// The inhouse post-game grade pieces: the letter chip, the award chips and the
// breakdown. No hooks, so the server box score and the room's client result
// card both render them.

import type { GradeAwardView, GradeView } from "@/lib/inhouse-grade-view";
import type { GradeLetter } from "@/lib/player-grades";
import { letterTone } from "@/lib/player-grades";
import { cn } from "@/lib/utils";

type Tone = ReturnType<typeof letterTone>;

const TONE_CHIP: Record<Tone, string> = {
  success: "border-success/40 bg-success/10 text-success",
  accent: "border-accent/40 bg-accent/10 text-accent",
  default: "border-line bg-surface-2 text-fg/80",
  muted: "border-line text-muted",
};

const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  accent: "text-accent",
  default: "text-fg/80",
  muted: "text-muted",
};

/** "A-" → "A−" for display (a real minus sign). */
export function letterLabel(letter: GradeLetter): string {
  return letter.replace("-", "−");
}

const spokenLetter = (letter: GradeLetter) =>
  letter.replace("+", " plus").replace("-", " minus");

/** The grade as a chip: the letter, and the score out of 100 beside it. */
export function GradeChip({
  letter,
  score,
  size = "sm",
  className,
}: {
  letter: GradeLetter;
  score: number;
  size?: "sm" | "lg";
  className?: string;
}) {
  const s = letter === "S";
  return (
    <span
      role="img"
      aria-label={`Grade ${spokenLetter(letter)}, ${score} out of 100`}
      title={`Grade ${letterLabel(letter)}: ${score} out of 100`}
      className={cn(
        "inline-flex shrink-0 items-baseline gap-1 rounded border font-display font-bold tabular-nums",
        size === "lg" ? "px-2 py-0.5 text-2xl leading-8" : "px-1.5 text-xs leading-5",
        s
          ? "border-accent bg-accent/20 text-accent"
          : TONE_CHIP[letterTone(letter)],
        className,
      )}
    >
      <span aria-hidden>{letterLabel(letter)}</span>
      <span
        aria-hidden
        className={cn(
          "font-sans font-medium opacity-75",
          size === "lg" ? "text-sm" : "text-[10px]",
        )}
      >
        {score}
      </span>
    </span>
  );
}

/** The awards a player earned this game, as small chips. */
export function AwardChips({
  awards,
  className,
}: {
  awards: readonly GradeAwardView[];
  className?: string;
}) {
  if (awards.length === 0) return null;
  return (
    <ul
      aria-label="Awards"
      className={cn("flex min-w-0 flex-wrap gap-1", className)}
    >
      {awards.map((a) => (
        <li
          key={a.key}
          title={a.desc}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 text-[11px] leading-5",
            a.key === "mvp"
              ? "border-accent/50 bg-accent/15 font-semibold text-accent"
              : a.key === "topCore" || a.key === "topSupport"
                ? "border-success/40 bg-success/10 font-medium text-success"
                : "border-line bg-surface-2 text-fg/80",
          )}
        >
          <span aria-hidden>{a.emoji}</span>
          {a.label}
        </li>
      ))}
    </ul>
  );
}

/** How one player's grade was made: its three parts and every area. */
export function GradeBreakdown({ view }: { view: GradeView }) {
  return (
    <details className="group/grade mt-1.5">
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 text-[11px] text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [&::-webkit-details-marker]:hidden">
        How this grade was made
        <span
          aria-hidden
          className="text-[10px] transition-transform group-open/grade:rotate-180 motion-reduce:transition-none"
        >
          ▾
        </span>
      </summary>
      <div className="mt-1.5 space-y-2.5 rounded-md border border-line-soft bg-surface-2/40 p-2.5 text-xs">
        <ul className="space-y-1">
          {view.parts.map((p) => (
            <li key={p.key} className="flex min-w-0 items-baseline justify-between gap-3">
              <span className="min-w-0">
                <span className="font-medium text-fg">{p.label}</span>{" "}
                <span className="text-muted">({p.weight})</span>
                <span className="block text-[11px] text-muted">{p.note}</span>
              </span>
              <span className="shrink-0 tabular-nums">
                {p.letter ? (
                  <>
                    {p.score}{" "}
                    <b className={cn("font-semibold", TONE_TEXT[p.tone])}>
                      {letterLabel(p.letter)}
                    </b>
                  </>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </span>
            </li>
          ))}
        </ul>

        <div>
          <p className="mb-1 font-medium text-fg">
            This game, as a {view.role.toLowerCase()}
          </p>
          <ul className="space-y-0.5">
            {view.areas.map((a) => (
              <li
                key={a.key}
                title={a.desc}
                className="flex min-w-0 items-baseline justify-between gap-3"
              >
                <span className="min-w-0 text-muted">
                  {a.label}
                  {a.counted ? (
                    <span className="ml-1 text-[10px] font-medium text-accent">
                      counted
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums">
                  {a.value}{" "}
                  <b className={cn("font-semibold", TONE_TEXT[a.tone])}>
                    {letterLabel(a.letter)}
                  </b>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-muted">
            Kill participation and survival always count; of the rest, the
            two best count.
          </p>
        </div>

        {view.hero.length > 0 ? (
          <div>
            <p className="mb-1 font-medium text-fg">On this hero, worldwide</p>
            <ul className="space-y-0.5">
              {view.hero.map((h) => (
                <li key={h.label} className="flex items-baseline justify-between gap-3">
                  <span className="text-muted">{h.label}</span>
                  <span className="shrink-0 tabular-nums">{h.beats}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {view.mmr.length > 0 ? (
          <div>
            <p className="mb-1 font-medium text-fg">Against players near their MMR</p>
            <ul className="space-y-0.5">
              {view.mmr.map((m) => (
                <li key={m.label} className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="min-w-0 text-muted">{m.label}</span>
                  <span className="shrink-0 tabular-nums">
                    {m.value}{" "}
                    <span className="text-muted">(typical {m.typical})</span>{" "}
                    {m.beats}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {view.partial ? (
          <p className="text-[11px] text-muted">
            OpenDota hadn’t parsed the replay when this game was graded, so
            damage taken, stuns, wards, stacks and laning aren’t in it. The
            site grades the game again once the replay is parsed (it checks
            for a day).
          </p>
        ) : null}
      </div>
    </details>
  );
}
