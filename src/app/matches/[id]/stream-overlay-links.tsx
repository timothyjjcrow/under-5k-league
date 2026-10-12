"use client";

import { pushToast } from "@/components/toaster";
import { buttonClasses, textLink } from "@/components/ui";
import { OVERLAY_WIDGETS, overlayPath } from "@/lib/stream-overlay-page";

/**
 * For casters: this match's OBS overlay links, folded shut at the foot of the
 * page. Each layout has its size beside it, since a Browser source of that
 * size fits it exactly. The link is copied with the host the caster is on
 * (`window.location.origin`), so a preview deployment copies itself; the
 * address shown is the path, the same on the server and in the browser.
 */
export function StreamOverlayLinks({ matchId }: { matchId: string }) {
  const copy = async (path: string, label: string) => {
    const url = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      pushToast("success", `Copied the ${label.toLowerCase()} link`);
    } catch {
      // The clipboard can refuse (a permission, plain HTTP): show the link
      // rather than claim a copy that didn't happen.
      pushToast("error", `Couldn't copy. The link is ${url}`);
    }
  };
  return (
    <details
      id="match-overlay"
      className="group scroll-mt-24 rounded-[var(--radius)] border border-line bg-surface-2/30"
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-[var(--radius)] px-4 py-3 text-sm font-semibold transition-colors hover:bg-surface-2/50 focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <span>
          Stream overlay for OBS
          <span className="mt-1 block text-xs font-normal leading-relaxed text-muted">
            For casters: both teams, the series score and rotating player cards
          </span>
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-5 w-5 shrink-0 text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="space-y-3 border-t border-line-soft px-4 py-3 text-sm text-muted">
        <p>
          Casting this match? In OBS, add a Browser source, paste one of these
          links and give the source the size beside it. The background is
          see-through, and the score and records update by themselves when a
          game is recorded.
        </p>
        <ul className="space-y-2">
          {OVERLAY_WIDGETS.map(({ widget, label, width, height }) => (
            <li
              key={widget}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line-soft bg-surface/60 px-3 py-2"
            >
              <span className="min-w-0 flex-1 basis-48">
                <span className="block font-medium text-fg">{label}</span>
                <span className="block text-xs tabular-nums">
                  {width} × {height}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Copy link: ${label}`}
                className={buttonClasses("secondary", "sm")}
                onClick={() => void copy(overlayPath(matchId, widget), label)}
              >
                Copy link
              </button>
              <a
                href={overlayPath(matchId, widget, { preview: true })}
                target="_blank"
                rel="noreferrer"
                className={textLink("text-sm")}
              >
                Preview<span className="sr-only">: {label}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
