// The link preview pictures, drawn by next/og (Satori). Satori reads a subset
// of CSS: every element with more than one child is a flex box, sizes are in
// pixels, and colours are plain hex or rgba. Nothing here runs in a browser.

import type { ReactNode } from "react";
import {
  hueHex,
  type MatchCardData,
  type MatchCardStatus,
  type OgTeam,
  type PlayerCardData,
  type SeasonCardData,
  type TeamCardData,
} from "@/lib/og-image";
import { crestInk } from "@/lib/team-hues";
import { teamInitials } from "@/lib/utils";

const COLOR = {
  bg: "#0b0f17",
  surface: "#121a29",
  line: "#303d54",
  fg: "#e8edf5",
  muted: "#a2aec2",
  accent: "#f2b134",
  success: "#3fb950",
  danger: "#f47067",
} as const;

/**
 * The emblem as og-assets loaded it, with the size it is drawn at. Europe's
 * sits on its own dark square, so it is drawn as a rounded tile.
 */
export type OgEmblem = {
  src: string;
  width: number;
  height: number;
  radius: number;
} | null;

/** What every picture carries besides its own facts. */
type OgBrand = { emblem: OgEmblem; leagueName: string };

/** The emblem's drawn size for this league's header logo. */
export function ogEmblem(src: string | null, europe: boolean): OgEmblem {
  if (!src) return null;
  // The header logos: 278x228 (US, transparent) and 228x228 (Europe).
  return europe
    ? { src, width: 72, height: 72, radius: 14 }
    : { src, width: 88, height: 72, radius: 0 };
}

/**
 * The shared frame: the dark page with the brand's red glow, the emblem and
 * league name top left over a kicker line, an optional pill top right, and
 * soft glows in the teams' own colours.
 */
function OgFrame({
  emblem,
  leagueName,
  kicker,
  pill,
  pillGold,
  glows = [],
  children,
}: {
  emblem: OgEmblem;
  leagueName: string;
  kicker: string;
  pill?: string | null;
  pillGold?: boolean;
  /** Hues glowing from the left and right edges. */
  glows?: number[];
  children: ReactNode;
}) {
  return (
    <div
      style={{
        width: 1200,
        height: 630,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        backgroundColor: COLOR.bg,
        color: COLOR.fg,
        fontFamily: "Oswald",
        padding: "40px 56px 44px",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 1200,
          height: 630,
          display: "flex",
          backgroundImage:
            "radial-gradient(circle at 50% -10%, rgba(220,52,52,0.28), rgba(11,15,23,0) 60%)",
        }}
      />
      {glows.map((hue, index) => (
        <div
          key={index}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 1200,
            height: 630,
            display: "flex",
            backgroundImage: `radial-gradient(circle at ${
              index === 0 ? "12%" : "88%"
            } 62%, ${hueHex(hue, 70, 50)}55, rgba(11,15,23,0) 42%)`,
          }}
        />
      ))}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          {emblem ? (
            // eslint-disable-next-line @next/next/no-img-element -- Satori draws <img>, not next/image
            <img
              src={emblem.src}
              width={emblem.width}
              height={emblem.height}
              alt=""
              style={{ marginRight: 20, borderRadius: emblem.radius }}
            />
          ) : null}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 32, fontWeight: 600, lineHeight: 1.1 }}>
              {leagueName}
            </span>
            <span style={{ fontSize: 24, color: COLOR.muted, lineHeight: 1.3 }}>
              {kicker}
            </span>
          </div>
        </div>
        {pill ? (
          <span
            style={{
              display: "flex",
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: pillGold ? COLOR.accent : COLOR.fg,
              border: `2px solid ${pillGold ? COLOR.accent : COLOR.line}`,
              backgroundColor: pillGold ? "rgba(242,177,52,0.12)" : "rgba(18,26,41,0.8)",
              borderRadius: 999,
              padding: "6px 24px",
            }}
          >
            {pill}
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        {children}
      </div>
    </div>
  );
}

/** A team crest: the logo, or the initials on the team's own colour. */
function OgCrest({ team, size }: { team: OgTeam; size: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        borderRadius: Math.round(size * 0.18),
        border: "3px solid rgba(255,255,255,0.16)",
        backgroundImage: `linear-gradient(135deg, ${hueHex(team.hue, 62, 46)}, ${hueHex(team.hue, 62, 28)})`,
        boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        fontSize: Math.round(size * 0.38),
        fontWeight: 600,
        // The site crest's ink: white, or near-black on the yellows.
        color: crestInk(team.hue),
      }}
    >
      {team.logo ? (
        // eslint-disable-next-line @next/next/no-img-element -- Satori draws <img>, not next/image
        <img
          src={team.logo}
          width={size}
          height={size}
          alt=""
          style={{ objectFit: "cover" }}
        />
      ) : (
        teamInitials(team.name)
      )}
    </div>
  );
}

/** Up to two lines of a long name, then an ellipsis. */
function clampStyle(fontSize: number, maxWidth: number) {
  return {
    display: "block",
    fontSize,
    fontWeight: 600,
    lineHeight: 1.12,
    maxWidth,
    lineClamp: 2,
  } as const;
}

const STATUS_COLOR: Record<MatchCardStatus["tone"], string> = {
  upcoming: COLOR.fg,
  live: COLOR.danger,
  final: COLOR.fg,
  pending: COLOR.muted,
};

/** A fixture: both crests facing off, VS or the series score, and its state. */
export function OgMatchCard({
  emblem,
  leagueName,
  seasonName,
  round,
  grandFinal,
  home,
  away,
  score,
  winner,
  status,
}: MatchCardData & OgBrand) {
  // Each side is the same height (the crest, then two lines kept for the
  // name), so the crests line up whichever name wraps.
  const side = (team: OgTeam, won: boolean) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        width: 380,
      }}
    >
      <OgCrest team={team} size={200} />
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          width: 380,
          height: 112,
          marginTop: 26,
        }}
      >
        <div
          style={{
            ...clampStyle(team.name.length > 22 ? 40 : 50, 380),
            textAlign: "center",
            color: won ? COLOR.accent : COLOR.fg,
          }}
        >
          {team.name}
        </div>
      </div>
    </div>
  );
  return (
    <OgFrame
      emblem={emblem}
      leagueName={leagueName}
      kicker={seasonName}
      pill={round}
      pillGold={grandFinal}
      glows={[home.hue, away.hue]}
    >
      <div
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            padding: "0 8px",
          }}
        >
          {side(home, winner === "home")}
          {/* As tall as a crest, so VS or the score sits level with both. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 260,
              height: 200,
            }}
          >
            {score ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  fontSize: 150,
                  fontWeight: 600,
                  lineHeight: 1,
                }}
              >
                <span
                  style={{ color: winner === "home" ? COLOR.accent : COLOR.fg }}
                >
                  {score.home}
                </span>
                <div
                  style={{
                    width: 40,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: COLOR.muted,
                    margin: "0 26px",
                  }}
                />
                <span
                  style={{ color: winner === "away" ? COLOR.accent : COLOR.fg }}
                >
                  {score.away}
                </span>
              </div>
            ) : (
              <span
                style={{
                  fontSize: 120,
                  fontWeight: 600,
                  lineHeight: 1,
                  color: COLOR.muted,
                }}
              >
                VS
              </span>
            )}
          </div>
          {side(away, winner === "away")}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 34,
          fontWeight: 600,
          letterSpacing: 1,
          color: STATUS_COLOR[status.tone],
        }}
      >
        {status.tone === "live" ? (
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 999,
              backgroundColor: COLOR.danger,
              marginRight: 16,
            }}
          />
        ) : null}
        {status.text}
      </div>
    </OgFrame>
  );
}

/** A chip of one fact under a name: "5W 1D 2L", "2nd of 6", "Champion". */
function OgChip({ children, gold }: { children: ReactNode; gold?: boolean }) {
  return (
    <span
      style={{
        display: "flex",
        fontSize: 30,
        fontWeight: 600,
        color: gold ? COLOR.accent : COLOR.fg,
        border: `2px solid ${gold ? COLOR.accent : COLOR.line}`,
        backgroundColor: gold ? "rgba(242,177,52,0.12)" : "rgba(18,26,41,0.85)",
        borderRadius: 14,
        padding: "6px 20px",
        marginRight: 14,
        marginBottom: 14,
      }}
    >
      {children}
    </span>
  );
}

/** A team: crest, name, its season facts and roster. */
export function OgTeamCard({
  emblem,
  leagueName,
  seasonName,
  team,
  facts,
  goldFact,
  captain,
  roster,
}: TeamCardData & OgBrand) {
  return (
    <OgFrame
      emblem={emblem}
      leagueName={leagueName}
      kicker={seasonName}
      glows={[team.hue]}
    >
      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          padding: "0 8px",
        }}
      >
        <OgCrest team={team} size={260} />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginLeft: 56,
            flex: 1,
          }}
        >
          <div style={{ ...clampStyle(team.name.length > 24 ? 60 : 76, 700) }}>
            {team.name}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", marginTop: 26 }}>
            {goldFact ? <OgChip gold>{goldFact}</OgChip> : null}
            {facts.map((fact) => (
              <OgChip key={fact}>{fact}</OgChip>
            ))}
          </div>
          <div
            style={{
              display: "block",
              fontSize: 28,
              color: COLOR.muted,
              lineHeight: 1.35,
              maxWidth: 700,
              lineClamp: 2,
              marginTop: 6,
            }}
          >
            {/* A no-break space keeps each dot on its name's line. */}
            {[`Captain ${captain}`, ...roster].join("\u00a0· ")}
          </div>
        </div>
      </div>
    </OgFrame>
  );
}

/** A player: avatar, name, their league facts and their latest team. */
export function OgPlayerCard({
  emblem,
  leagueName,
  name,
  avatar,
  facts,
  team,
  teamSeason,
}: PlayerCardData & OgBrand) {
  return (
    <OgFrame
      emblem={emblem}
      leagueName={leagueName}
      kicker="Player profile"
      glows={team ? [team.hue] : []}
    >
      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          padding: "0 8px",
        }}
      >
        <div
          style={{
            width: 260,
            height: 260,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            borderRadius: 40,
            border: "3px solid rgba(255,255,255,0.16)",
            backgroundColor: COLOR.surface,
            boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
            fontSize: 100,
            fontWeight: 600,
            color: COLOR.muted,
          }}
        >
          {avatar ? (
            // eslint-disable-next-line @next/next/no-img-element -- Satori draws <img>, not next/image
            <img
              src={avatar}
              width={260}
              height={260}
              alt=""
              style={{ objectFit: "cover" }}
            />
          ) : (
            teamInitials(name)
          )}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginLeft: 56,
            flex: 1,
          }}
        >
          <div style={{ ...clampStyle(name.length > 20 ? 64 : 80, 700) }}>
            {name}
          </div>
          {facts.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", marginTop: 26 }}>
              {facts.map((fact) => (
                <OgChip key={fact}>{fact}</OgChip>
              ))}
            </div>
          ) : null}
          {team ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                marginTop: 10,
              }}
            >
              <OgCrest team={team} size={56} />
              <div
                style={{
                  display: "block",
                  fontSize: 30,
                  fontWeight: 600,
                  marginLeft: 18,
                  maxWidth: 560,
                  lineClamp: 1,
                }}
              >
                {teamSeason ? `${team.name} · ${teamSeason}` : team.name}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </OgFrame>
  );
}

/** A season: its name and phase, and the champion once there is one. */
export function OgSeasonCard({
  emblem,
  leagueName,
  seasonName,
  kicker,
  facts,
  champion,
}: SeasonCardData & OgBrand) {
  return (
    <OgFrame
      emblem={emblem}
      leagueName={leagueName}
      kicker={kicker}
      glows={champion ? [champion.hue] : []}
    >
      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          padding: "0 8px",
        }}
      >
        {/* The champion's crest, else the league's emblem in its place. */}
        {champion ? (
          <OgCrest team={champion} size={260} />
        ) : emblem ? (
          // eslint-disable-next-line @next/next/no-img-element -- Satori draws <img>, not next/image
          <img
            src={emblem.src}
            width={260}
            height={Math.round((260 * emblem.height) / emblem.width)}
            alt=""
            style={{ borderRadius: Math.round((emblem.radius * 260) / emblem.width) }}
          />
        ) : null}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginLeft: champion || emblem ? 56 : 0,
            flex: 1,
          }}
        >
          <div style={{ ...clampStyle(seasonName.length > 22 ? 72 : 92, 760) }}>
            {seasonName}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", marginTop: 26 }}>
            {champion ? <OgChip gold>{`Champion: ${champion.name}`}</OgChip> : null}
            {facts.map((fact) => (
              <OgChip key={fact}>{fact}</OgChip>
            ))}
          </div>
        </div>
      </div>
    </OgFrame>
  );
}
