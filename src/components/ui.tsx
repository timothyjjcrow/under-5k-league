import * as React from "react";
import Link from "next/link";
import { DISCORD_INVITE_URL, MATCH_SCHEDULE } from "@/lib/constants";
import { cn, initials } from "@/lib/utils";
import { rankMedalName, rankMedalTier, rankStars } from "@/lib/rank";
import { type Hero, heroById, heroIcon, parseHeroList } from "@/lib/heroes";
import { DOTA_ROLES, parseRoles } from "@/lib/roles";
import type { FormResult } from "@/lib/team-matches";
import { splitLinks } from "@/lib/linkify";
import { CountUp } from "./count-up";
import { NewsMedia } from "./news-media";

// ---------- Button ----------

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "accent";
export type ButtonSize = "sm" | "md" | "lg";

const baseBtn =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-50";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-brand text-brand-fg hover:bg-brand/90",
  secondary:
    "bg-surface-2 text-fg border border-line hover:border-muted/60 hover:bg-surface-2/70",
  ghost: "text-muted hover:text-fg hover:bg-surface-2/60",
  danger: "bg-danger text-white hover:bg-danger/90",
  accent: "bg-accent text-black hover:bg-accent/90",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
) {
  return cn(baseBtn, variantClasses[variant], sizeClasses[size], className);
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return <button className={buttonClasses(variant, size, className)} {...props} />;
}

// ---------- Card ----------

export function Card({
  className,
  interactive,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius)] border border-line bg-surface/80 shadow-sm backdrop-blur",
        interactive &&
          "transition duration-200 hover:-translate-y-0.5 hover:border-muted/60 hover:shadow-lg hover:shadow-black/30 motion-reduce:transform-none motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-line px-5 py-4",
        className,
      )}
    >
      <div className="min-w-0">
        <h3 className="font-display text-lg font-semibold text-fg [overflow-wrap:anywhere]">
          {title}
        </h3>
        {subtitle ? (
          <p className="mt-0.5 text-sm text-muted [overflow-wrap:anywhere]">
            {subtitle}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function CardBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}

// ---------- Badge ----------

const badgeTones = {
  neutral: "bg-surface-2 text-muted border-line",
  brand: "bg-brand/15 text-brand border-brand/30",
  accent: "bg-accent/15 text-accent border-accent/30",
  success: "bg-success/15 text-success border-success/30",
  info: "bg-info/15 text-info border-info/30",
  danger: "bg-danger/15 text-danger border-danger/30",
} as const;

export function Badge({
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  tone?: keyof typeof badgeTones;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        badgeTones[tone],
        className,
      )}
      {...props}
    />
  );
}

// ---------- Rank medal ----------

/**
 * The actual Dota 2 ranked-medal graphic: the base medallion (`rank_icon_*`)
 * with the star-ring overlay (`rank_star_*`) composited on top, both bundled
 * under `/public/ranks`. Immortal (tier 8) has no stars. Renders nothing when
 * the medal is unknown/unranked. Hover shows the medal name.
 */
export function RankMedal({
  rankTier,
  size = 24,
  showLabel = false,
  className,
}: {
  rankTier: number | null | undefined;
  size?: number;
  showLabel?: boolean;
  className?: string;
}) {
  const tier = rankMedalTier(rankTier);
  if (tier === 0) return null;
  const stars = rankStars(rankTier);
  const name = rankMedalName(rankTier);
  const medal = (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/ranks/rank_icon_${tier}.png`}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        className="absolute inset-0 h-full w-full object-contain"
      />
      {tier < 8 && stars > 0 ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/ranks/rank_star_${stars}.png`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          className="absolute inset-0 h-full w-full object-contain"
        />
      ) : null}
    </span>
  );
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      title={name}
      aria-label={name}
    >
      {medal}
      {showLabel ? (
        <span className="text-xs font-medium text-muted">{name}</span>
      ) : null}
    </span>
  );
}

/**
 * Back-compat wrapper — every existing call site now renders the real medal
 * graphic instead of a text pill.
 */
export function RankBadge({
  rankTier,
  className,
}: {
  rankTier: number | null | undefined;
  className?: string;
}) {
  return <RankMedal rankTier={rankTier} className={className} />;
}

// ---------- Role badges ----------

const ROLE_TONE: Record<string, string> = {
  "1": "bg-rose-500/15 text-rose-300 border-rose-500/30",
  "2": "bg-amber-500/15 text-amber-300 border-amber-500/30",
  "3": "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  "4": "bg-sky-500/15 text-sky-300 border-sky-500/30",
  "5": "bg-violet-500/15 text-violet-300 border-violet-500/30",
};

/** Colored position pills (1–5) parsed from a stored roles string. */
export function RoleBadges({
  roles,
  className,
}: {
  roles: string | null | undefined;
  className?: string;
}) {
  const keys = parseRoles(roles);
  if (keys.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {keys.map((k) => {
        const role = DOTA_ROLES.find((r) => r.key === k);
        return (
          <span
            key={k}
            title={role ? `${role.short} · ${role.label}` : undefined}
            className={cn(
              "inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 text-[11px] font-semibold tabular-nums",
              ROLE_TONE[k],
            )}
          >
            {k}
          </span>
        );
      })}
    </span>
  );
}

// ---------- Player link ----------

/**
 * Wraps a player's name/avatar in a link to their season profile. Server-safe,
 * so it works in both server pages and the client player-pool.
 */
export function PlayerLink({
  userId,
  className,
  children,
}: {
  userId: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={`/players/${userId}`}
      className={cn("hover:text-info hover:underline", className)}
    >
      {children}
    </Link>
  );
}

// ---------- Form strip ----------

const FORM_TONE: Record<FormResult, string> = {
  W: "bg-success/15 text-success border-success/30",
  L: "bg-danger/15 text-danger border-danger/30",
  D: "bg-surface-2 text-muted border-line",
};

/** Row of recent W/L/D chips (most-recent first). Renders nothing when empty. */
export function FormStrip({
  form,
  size = 6,
  className,
}: {
  form: FormResult[];
  size?: number;
  className?: string;
}) {
  if (form.length === 0) return null;
  const spoken = form
    .map((r) => ({ W: "win", L: "loss", D: "draw" })[r])
    .join(", ");
  return (
    <span
      role="img"
      aria-label={`Recent form, newest first: ${spoken}`}
      className={cn("inline-flex items-center gap-1", className)}
    >
      {form.map((r, i) => (
        <span
          key={i}
          aria-hidden
          style={{ width: `${size * 4}px`, height: `${size * 4}px` }}
          className={cn(
            "grid place-items-center rounded border text-[11px] font-semibold",
            FORM_TONE[r],
          )}
        >
          {r}
        </span>
      ))}
    </span>
  );
}

// A kills/deaths/assists line with consistent semantic coloring — green
// kills, red deaths, blue assists — used anywhere a KDA appears (box scores,
// match history, standout games) so the stat reads the same everywhere.
export function KDA({
  kills,
  deaths,
  assists,
  className,
}: {
  kills: number;
  deaths: number;
  assists: number;
  className?: string;
}) {
  return (
    <span className={cn("font-mono tabular-nums", className)}>
      <span className="text-success">{kills}</span>
      <span className="text-muted">/</span>
      <span className="text-danger">{deaths}</span>
      <span className="text-muted">/</span>
      <span className="text-info">{assists}</span>
    </span>
  );
}

// ---------- Avatar ----------

export function Avatar({
  name,
  src,
  size = 36,
  className,
}: {
  name: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const dim = { width: size, height: size };
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={name}
        style={dim}
        className={cn("rounded-full object-cover", className)}
      />
    );
  }
  return (
    <span
      style={dim}
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-muted",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

// ---------- Team crest ----------

/**
 * Deterministic hue (0–359) from a stable seed, so each team gets a consistent
 * color identity. Seed on the team id (not the name) so editing the name keeps
 * the color.
 */
export function teamHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/**
 * A generated monogram "crest" for a team (teams have no uploaded logos): the
 * team's initials on a gradient tinted with its own color identity.
 */
export function TeamCrest({
  name,
  seed,
  size = 40,
  className,
}: {
  name: string;
  seed: string;
  size?: number;
  className?: string;
}) {
  const hue = teamHue(seed);
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-xl font-display font-bold uppercase text-white shadow ring-1 ring-white/15",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        backgroundImage: `linear-gradient(135deg, hsl(${hue} 62% 46%), hsl(${hue} 62% 28%))`,
      }}
    >
      {initials(name)}
    </span>
  );
}

// ---------- Progress ----------

export function Progress({
  value,
  max,
  className,
}: {
  value: number;
  max: number;
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={cn("h-2.5 w-full rounded-full bg-surface-2", className)}>
      <div
        className="bar-fill h-full rounded-full bg-brand transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ---------- Skeleton ----------

/** A shimmering placeholder block for loading states. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-md", className)} />;
}

// A card-shaped placeholder for streaming Suspense fallbacks. `rows` sets the
// body line count; `header` draws a title/subtitle bar. Sized to roughly match
// a populated card so streamed content swaps in with minimal layout shift.
export function CardSkeleton({
  rows = 3,
  header = true,
  className,
}: {
  rows?: number;
  header?: boolean;
  className?: string;
}) {
  return (
    <Card className={className} aria-hidden>
      {header ? (
        <div className="border-b border-line px-5 py-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-1.5 h-3 w-24" />
        </div>
      ) : null}
      <CardBody className="space-y-2.5">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton
            key={i}
            className={cn("h-3.5", i === rows - 1 ? "w-2/3" : "w-full")}
          />
        ))}
      </CardBody>
    </Card>
  );
}

// ---------- Sparkline ----------

/** A tiny trend line (SVG) with a soft area fill and an end dot. */
export function Sparkline({
  values,
  width = 140,
  height = 36,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 3;
  const n = values.length;
  const pts = values.map((v, i) => {
    const x = pad + (i / (n - 1)) * (width - pad * 2);
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });
  const line = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${pts[n - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
  const [ex, ey] = pts[n - 1];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden
    >
      <path d={area} fill="var(--color-accent)" opacity={0.12} />
      <path
        d={line}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={ex} cy={ey} r={2.5} fill="var(--color-accent)" />
    </svg>
  );
}

// ---------- Empty state ----------

function EmptyGlyph() {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z" />
      <path d="M3 7.5 12 12l9-4.5M12 12v9" opacity={0.5} />
    </svg>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius)] border border-dashed border-line bg-surface-2/20 px-6 py-12 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl border border-line bg-surface-2/60 text-muted">
        {icon ?? <EmptyGlyph />}
      </div>
      <div>
        <p className="font-display text-base font-semibold text-fg">{title}</p>
        {description ? (
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

// ---------- LinkifiedText ----------

/**
 * Free text with bare http(s) URLs rendered as real links, and image/GIF/video
 * URLs (incl. pasted Giphy/Tenor/Klipy links, normalized in `splitLinks`)
 * rendered inline (news bodies). `images="hide"` collapses media to a tiny chip
 * instead — for compact previews (the dashboard's clamped news card) where a
 * full embed would blow out the layout.
 */
export function LinkifiedText({
  text,
  className,
  images = "inline",
}: {
  text: string;
  className?: string;
  images?: "inline" | "hide";
}) {
  return (
    <span className={className}>
      {splitLinks(text).map((t, i) => {
        if (t.type === "link") {
          return (
            <a
              key={i}
              href={t.value}
              target="_blank"
              rel="noreferrer"
              className="break-all text-info hover:underline"
            >
              {t.value}
            </a>
          );
        }
        if (t.type === "image" || t.type === "video") {
          return images === "hide" ? (
            <span key={i} className="text-muted">
              🎞️ GIF
            </span>
          ) : (
            <NewsMedia key={i} src={t.value} kind={t.type} />
          );
        }
        return <React.Fragment key={i}>{t.value}</React.Fragment>;
      })}
    </span>
  );
}

// ---------- Stat ----------

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface-2/40 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 font-display text-3xl font-bold tabular-nums text-fg">
        {typeof value === "number" ? <CountUp value={value} /> : value}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

export function PageTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-3xl font-bold text-fg sm:text-4xl">
          {title}
        </h1>
        {subtitle ? <p className="mt-1 text-muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

// ---------- Section title ----------

/** A page-section heading in the display font with an accent tick marker. */
export function SectionTitle({
  children,
  aside,
  className,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        "flex items-center gap-2.5 font-display text-lg font-semibold",
        className,
      )}
    >
      <span aria-hidden className="h-4 w-1 shrink-0 rounded-full bg-accent" />
      <span>{children}</span>
      {aside ? (
        <span className="font-sans text-sm font-normal text-muted">{aside}</span>
      ) : null}
    </h2>
  );
}

// ---------- Hero icons ----------

export function HeroIcon({
  hero,
  size = 26,
  className,
}: {
  hero: Hero;
  size?: number;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={heroIcon(hero)}
      alt={hero.name}
      title={hero.name}
      width={size}
      height={size}
      loading="lazy"
      style={{ width: size, height: size }}
      className={cn(
        "shrink-0 rounded-md border border-line/70 bg-surface-2 object-cover",
        className,
      )}
    />
  );
}

/**
 * A grid of a player's or team's most-played heroes, each with a win-rate
 * bar colored by performance (green winning / neutral even / red losing).
 * Shared by the player profile and team pages.
 */
export function HeroPool({
  heroes,
  heroNames,
  limit = 8,
}: {
  heroes: { heroId: number; games: number; wins: number }[];
  heroNames?: Record<number, string>;
  limit?: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
      {heroes.slice(0, limit).map((h) => {
        const hero = heroById(h.heroId);
        const winPct = Math.round((h.wins / h.games) * 100);
        // Green when clearly winning, red when clearly losing, neutral around even.
        const tone = winPct >= 60 ? "win" : winPct >= 40 ? "even" : "loss";
        return (
          <div
            key={h.heroId}
            className="rounded-lg border border-line bg-surface-2/40 p-2"
          >
            <div className="flex items-center gap-2">
              {hero ? (
                <HeroIcon hero={hero} size={30} />
              ) : (
                <span className="h-[30px] w-[30px] shrink-0 rounded-md border border-line/70 bg-surface-2" />
              )}
              <div className="min-w-0 text-xs">
                <div className="truncate font-medium">
                  {hero?.name ?? heroNames?.[h.heroId] ?? `Hero ${h.heroId}`}
                </div>
                <div className="text-muted">
                  {h.games}g ·{" "}
                  <span
                    className={cn(
                      "font-semibold",
                      tone === "win"
                        ? "text-success"
                        : tone === "loss"
                          ? "text-danger"
                          : "text-fg",
                    )}
                  >
                    {winPct}%
                  </span>{" "}
                  W
                </div>
              </div>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
              <div
                className={cn(
                  "bar-fill h-full rounded-full",
                  tone === "win"
                    ? "bg-success/70"
                    : tone === "loss"
                      ? "bg-danger/70"
                      : "bg-muted/60",
                )}
                style={{ width: `${winPct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Renders a free-text favorite-heroes string as a row of hero icons, falling
 * back to plain text for any tokens we couldn't match to a hero.
 */
export function HeroList({
  value,
  size = 26,
  max = 10,
  className,
}: {
  value: string | null | undefined;
  size?: number;
  max?: number;
  className?: string;
}) {
  const { matched, unmatched } = parseHeroList(value);
  if (matched.length === 0 && unmatched.length === 0) return null;
  const shown = matched.slice(0, max);
  const extra = matched.length - shown.length;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {shown.map((hero) => (
        <HeroIcon key={hero.id} hero={hero} size={size} />
      ))}
      {extra > 0 ? (
        <span className="text-xs text-muted">+{extra}</span>
      ) : null}
      {unmatched.length > 0 ? (
        <span className="text-xs text-muted">{unmatched.join(", ")}</span>
      ) : null}
    </span>
  );
}

// ---------- Discord ----------

export function DiscordIcon({
  size = 18,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={cn("shrink-0", className)}
    >
      <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.291a.077.077 0 0 1-.006.128 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

export function CalendarIcon({
  size = 18,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("shrink-0", className)}
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

/**
 * Prominent "match night" callout — surfaces the weekly game slot before
 * players commit to signing up. Pass the season's `matchSchedule`; falls back
 * to the app-wide MATCH_SCHEDULE default when unset.
 */
export function ScheduleCallout({
  label,
  className,
}: {
  label?: string | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-info/30 bg-info/10 px-4 py-3",
        className,
      )}
    >
      <span
        aria-hidden
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-info/15 text-info"
      >
        <CalendarIcon size={20} />
      </span>
      <div className="min-w-0 text-sm">
        <div className="font-medium">
          Match night —{" "}
          <span className="text-info">{label || MATCH_SCHEDULE.label}</span>
        </div>
        <div className="text-xs text-muted">
          Games run weekly. Make sure you can play before you sign up.
        </div>
      </div>
    </div>
  );
}

/** Blurple "Join our Discord" button linking to the league invite. */
export function DiscordButton({
  label = "Join our Discord",
  size = "md",
  className,
}: {
  label?: string;
  size?: ButtonSize;
  className?: string;
}) {
  return (
    <a
      href={DISCORD_INVITE_URL}
      target="_blank"
      rel="noreferrer"
      className={cn(
        baseBtn,
        sizeClasses[size],
        "bg-[#5865F2] text-white hover:bg-[#4752c4]",
        className,
      )}
    >
      <DiscordIcon />
      {label}
    </a>
  );
}

export function ShieldCheckIcon({
  size = 18,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("shrink-0", className)}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/**
 * Reassurance for players wary of "Sign in with Steam" — explains, plainly,
 * that it's used only to grab their name + profile and the Steam API is safe.
 */
export function SteamSafetyNote({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-line bg-surface-2/40 p-4 text-left",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheckIcon size={18} className="text-success" />
        Why Steam sign-in?
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        Only to get your{" "}
        <b className="font-medium text-fg">name and profile</b> — nothing else.
        You log in on Steam&apos;s own site, so we never see your password, and
        Steam&apos;s API only shares public info — it can&apos;t touch your
        account.
      </p>
    </div>
  );
}
