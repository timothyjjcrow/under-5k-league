import Image from "next/image";
import { buttonClasses } from "@/components/ui";
import type { TeamJersey } from "@/lib/team-jerseys";
import { cn } from "@/lib/utils";

export function TeamJerseyPreview({
  jersey,
  featured: isFeatured = false,
}: {
  jersey: TeamJersey;
  featured?: boolean;
}) {
  const featured = jersey.products[0];
  if (!featured) return null;

  return (
    <article className="min-w-0 overflow-hidden rounded-[var(--radius)] border border-line bg-surface shadow-sm shadow-black/10">
      <div className="px-4 pb-4 pt-4 sm:px-5 sm:pt-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-accent">
          Fourthwall jersey
        </p>
        <h3 className="mt-1 font-display text-xl font-semibold leading-tight text-fg [overflow-wrap:anywhere]">
          {jersey.teamName}
        </h3>
      </div>

      <div
        className={cn(
          "min-w-0",
          isFeatured &&
            "lg:grid lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start",
        )}
      >
        <div
          className={cn(
            "grid grid-cols-2 gap-2 px-3 sm:gap-3 sm:px-4",
            isFeatured && "lg:pb-5",
          )}
        >
          {(
            [
              { side: "Front", image: jersey.frontImage },
              { side: "Back", image: jersey.backImage },
            ] as const
          ).map(({ side, image }) => (
            <figure
              key={side}
              className="min-w-0 overflow-hidden rounded-lg border border-white/10 bg-[#e3e4e2]"
            >
              <a
                href={image}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`View full-size ${jersey.teamName} jersey ${side.toLowerCase()} mockup (opens in a new tab)`}
                className="group/image relative block rounded-lg p-1.5 outline-offset-[-3px] focus-visible:outline-2 focus-visible:outline-accent"
              >
                <Image
                  src={image}
                  alt={`${jersey.teamName} jersey, Fourthwall flat ${side.toLowerCase()} mockup${side === "Back" ? ` for ${featured.player}` : ""}`}
                  width={800}
                  height={800}
                  sizes={
                    isFeatured
                      ? "(min-width: 1152px) 310px, (min-width: 1024px) 28vw, 44vw"
                      : "(min-width: 1152px) 240px, (min-width: 768px) 23vw, 44vw"
                  }
                  className="aspect-square h-auto w-full object-contain"
                />
                <span
                  className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-md bg-white/80 text-xs text-slate-700 opacity-70 transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100"
                  aria-hidden="true"
                >
                  ↗
                </span>
              </a>
              <figcaption className="pb-2 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-700">
                {side}
              </figcaption>
            </figure>
          ))}
        </div>

        <div
          className={cn(
            "min-w-0 px-4 pb-4 pt-4 sm:px-5 sm:pb-5",
            isFeatured && "lg:pt-1",
          )}
        >
          <p className="text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
            Back shown: <span className="font-medium text-fg">{featured.player}</span>
            <span className="whitespace-nowrap"> · Position {featured.position}</span>
          </p>
          <a
            href={featured.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Shop ${featured.player} jersey on Fourthwall (opens in a new tab)`}
            className={buttonClasses(
              "secondary",
              "md",
              "mt-3 h-auto min-h-11 w-full justify-between gap-3 py-2.5 text-left sm:h-auto",
            )}
          >
            <span className="min-w-0 [overflow-wrap:anywhere]">
              Shop {featured.player} jersey
            </span>
            <span className="shrink-0 text-base text-muted" aria-hidden="true">
              ↗
            </span>
          </a>
          <details
            className="group/players mt-3 overflow-hidden rounded-lg border border-line-soft text-sm"
            open={isFeatured}
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 font-medium text-muted transition-colors hover:bg-surface-2/60 hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
              <span className="min-w-0">Other player jerseys</span>
              <span className="flex shrink-0 items-center gap-2" aria-hidden="true">
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] tabular-nums">
                  {jersey.products.length - 1}
                </span>
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  className="size-4 transition-transform group-open/players:rotate-180 motion-reduce:transition-none"
                >
                  <path
                    d="m4 6 4 4 4-4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </summary>
            <ul className="border-t border-line-soft p-1.5">
              {jersey.products.slice(1).map((product) => (
                <li key={product.position} className="min-w-0">
                  <a
                    href={product.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Shop ${product.player} jersey, position ${product.position}, on Fourthwall (opens in a new tab)`}
                    className="flex min-h-11 items-center gap-2.5 rounded-md px-2.5 py-2 text-fg transition-colors hover:bg-surface-2 hover:text-info focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  >
                    <span
                      className="flex size-6 shrink-0 items-center justify-center rounded bg-surface-2 text-[11px] font-semibold tabular-nums text-muted"
                      aria-hidden="true"
                    >
                      {product.position}
                    </span>
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      {product.player}
                    </span>
                    <span className="shrink-0 text-muted" aria-hidden="true">
                      ↗
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>
    </article>
  );
}
