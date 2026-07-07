import * as React from "react";
import Link from "next/link";
import { cn, initials } from "@/lib/utils";
import { rankMedalName, rankMedalTier } from "@/lib/rank";
import { type Hero, heroIcon, parseHeroList } from "@/lib/heroes";
import { DOTA_ROLES, parseRoles } from "@/lib/roles";

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
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius)] border border-line bg-surface/80 shadow-sm backdrop-blur",
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
      <div>
        <h3 className="text-base font-semibold text-fg">{title}</h3>
        {subtitle ? (
          <p className="mt-0.5 text-sm text-muted">{subtitle}</p>
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

const RANK_TONE: Record<number, string> = {
  0: "bg-surface-2 text-muted border-line",
  1: "bg-stone-500/15 text-stone-300 border-stone-500/30",
  2: "bg-green-500/15 text-green-300 border-green-500/30",
  3: "bg-teal-500/15 text-teal-300 border-teal-500/30",
  4: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  5: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  6: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  7: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  8: "bg-amber-500/15 text-amber-300 border-amber-500/30",
};

/** Colored ranked-medal pill. Renders nothing when the medal is unknown. */
export function RankBadge({
  rankTier,
  className,
}: {
  rankTier: number | null | undefined;
  className?: string;
}) {
  const tier = rankMedalTier(rankTier);
  if (tier === 0) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        RANK_TONE[tier],
        className,
      )}
    >
      {rankMedalName(rankTier)}
    </span>
  );
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
        className="h-full rounded-full bg-brand transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ---------- Empty state ----------

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
    <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius)] border border-dashed border-line px-6 py-12 text-center">
      {icon ? <div className="text-muted">{icon}</div> : null}
      <div>
        <p className="font-medium text-fg">{title}</p>
        {description ? (
          <p className="mt-1 text-sm text-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
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
      <div className="mt-1 text-2xl font-semibold text-fg">{value}</div>
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
        <h1 className="text-2xl font-bold tracking-tight text-fg sm:text-3xl">
          {title}
        </h1>
        {subtitle ? <p className="mt-1 text-muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
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
