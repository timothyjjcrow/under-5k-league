import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { shouldRenderTeamLogo, teamLogoBackingShown } from "./team-logo-image";
import { TeamCrest } from "./ui";
import { crestInk, hashHue } from "@/lib/team-hues";
import {
  jsxElements,
  parseSource,
  propsOwner,
  propValue,
  type JsxElementInfo,
} from "../../test/support/jsx-elements";
import {
  sourceFiles,
  type SourceFile,
} from "../../test/support/source-files";

describe("TeamCrest", () => {
  it("renders a configured logo as a decorative, privacy-safe image", () => {
    const html = renderToStaticMarkup(
      createElement(TeamCrest, {
        name: "Ancient Defenders",
        seed: "team-1",
        logoUrl: " https://cdn.example.com/logo.png ",
        size: 48,
      }),
    );

    expect(html).toContain("<img");
    expect(html).toContain('src="https://cdn.example.com/logo.png"');
    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/referrer[Pp]olicy="no-referrer"/);
    expect(html).toContain('width="48"');
    expect(html).toContain('height="48"');
    expect(html).toContain('style="width:48px;height:48px');
    expect(html).toContain('style="width:100%;height:100%"');
    expect(html).toContain("object-contain");
    // The monogram stays mounted underneath so an errored image can reveal it.
    expect(html).toContain("AD");
  });

  it("can crop a configured logo to fill its crest", () => {
    const html = renderToStaticMarkup(
      createElement(TeamCrest, {
        name: "Ancient Defenders",
        seed: "team-1",
        logoUrl: "https://cdn.example.com/wide-logo.png",
        size: 64,
        imageFit: "cover",
      }),
    );

    expect(html).toContain("object-cover");
    expect(html).not.toContain("object-contain");
  });

  it("keeps the generated monogram when no usable logo URL exists", () => {
    const html = renderToStaticMarkup(
      createElement(TeamCrest, {
        name: "Ancient Defenders",
        seed: "team-1",
        logoUrl: "   ",
      }),
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("AD");
  });

  it("wears its season hue, with the hash hue as the fallback", () => {
    const html = renderToStaticMarkup(
      createElement(TeamCrest, { name: "Radiant Rush", seed: "cmteam1" }),
    );

    // The root layout's stylesheet sets --team-hue on this attribute.
    expect(html).toContain('data-team-hue="cmteam1"');
    expect(html).toContain(
      `hsl(var(--team-hue, ${hashHue("cmteam1")}) 62% 46%)`,
    );
  });

  it("inks its initials to read on its hue, falling back with the hue", () => {
    // White initials were about 2:1 on a yellow crest. The stylesheet sets
    // --team-ink beside --team-hue; without it the hash hue's ink applies.
    const html = renderToStaticMarkup(
      createElement(TeamCrest, { name: "Radiant Rush", seed: "cmteam1" }),
    );
    expect(html).toContain(
      `color:var(--team-ink, ${crestInk(hashHue("cmteam1"))})`,
    );
    expect(html).not.toContain("text-white");
  });

  it("skips small words so a season's crests don't share letters", () => {
    const monogram = (name: string) =>
      renderToStaticMarkup(
        createElement(TeamCrest, { name, seed: "t" }),
      ).replace(/<[^>]+>/g, "");

    expect(monogram("Sisters of the Veil")).toBe("SV");
    expect(monogram("The Radiant Rush")).toBe("RR");
    expect(monogram("Tim's Team")).toBe("TI");
  });

  it("hides only the image URL that failed so the monogram can show", () => {
    expect(shouldRenderTeamLogo("https://cdn.example/logo.png", null)).toBe(
      true,
    );
    expect(
      shouldRenderTeamLogo(
        "https://cdn.example/logo.png",
        "https://cdn.example/logo.png",
      ),
    ).toBe(false);
    expect(
      shouldRenderTeamLogo(
        "https://cdn.example/new-logo.png",
        "https://cdn.example/logo.png",
      ),
    ).toBe(true);

    // Node component tests have no DOM image loader, so pin the event wiring
    // that connects a browser load failure to the tested visibility rule.
    const source = readFileSync(
      join(__dirname, "team-logo-image.tsx"),
      "utf8",
    );
    expect(source).toContain("onError={() => setFailedSrc(src)}");
    expect(source).toContain(
      "if (!shouldRenderTeamLogo(src, failedSrc)) return null",
    );

    const crestSource = readFileSync(join(__dirname, "ui.tsx"), "utf8");
    expect(crestSource).toContain(
      "<TeamLogoImage key={src} src={src} size={size} fit={imageFit} />",
    );
  });

  it("shows the monogram until the logo has loaded", () => {
    // The logo's dark backing used to paint from the first frame, so a lazy
    // logo read as an empty box in the bracket and results until it arrived.
    const html = renderToStaticMarkup(
      createElement(TeamCrest, {
        name: "Vegan Squadron",
        seed: "team-vs",
        logoUrl: "https://i.imgur.com/logo.png",
      }),
    );
    expect(html).toContain("<img");
    expect(html).not.toContain("bg-surface-2");
    expect(html).toContain("VS");

    const src = "https://i.imgur.com/logo.png";
    expect(teamLogoBackingShown(src, null)).toBe(false);
    expect(teamLogoBackingShown(src, src)).toBe(true);
    // A new URL starts over: its own load decides.
    expect(teamLogoBackingShown("https://i.imgur.com/new.png", src)).toBe(false);

    // No DOM image loader here: pin the wiring from the browser's load events
    // (and a logo that settled before hydration) to the tested rule.
    const source = readFileSync(
      join(__dirname, "team-logo-image.tsx"),
      "utf8",
    );
    expect(source).toContain("onLoad={() => setLoadedSrc(src)}");
    expect(source).toContain("ref={readSettled}");
    expect(source).toContain(
      'teamLogoBackingShown(src, loadedSrc) ? "bg-surface-2" : ""',
    );
    expect(source).toMatch(
      /if \(img\.naturalWidth > 0\) setLoadedSrc\(src\);\s*else setFailedSrc\(src\);/,
    );
  });

  it("uses larger, crop-filled crests for the primary team views", () => {
    const crestWithName = (source: string, nameProp: string) =>
      (source.match(/<TeamCrest[\s\S]*?\/>/g) ?? []).find((crest) =>
        crest.includes(nameProp),
      );

    const teamsPage = readFileSync(
      join(__dirname, "../app/teams/page.tsx"),
      "utf8",
    );
    // The index cards went three across on a desktop with a 56px crest.
    const cardCrest = crestWithName(teamsPage, "name={t.name}");
    expect(cardCrest).toContain("size={56}");
    expect(cardCrest).toContain('imageFit="cover"');
    expect(teamsPage).toContain("md:grid-cols-2");

    const teamPage = readFileSync(
      join(__dirname, "../app/teams/[id]/page.tsx"),
      "utf8",
    );
    // Phones get a 64px crest so the names beside it have room; tablets and
    // up get a 96px one. Both fill with the logo.
    const heroCrests = (teamPage.match(/<TeamCrest[\s\S]*?\/>/g) ?? []).filter(
      (crest) => crest.includes("name={team.name}"),
    );
    expect(heroCrests).toHaveLength(2);
    const [phoneCrest, heroCrest] = heroCrests;
    expect(phoneCrest).toContain("size={64}");
    expect(phoneCrest).toContain("sm:hidden");
    expect(heroCrest).toContain("size={96}");
    expect(heroCrest).toMatch(/className="hidden [^"]*sm:grid/);
    for (const crest of heroCrests) expect(crest).toContain('imageFit="cover"');
  });

  it("gets its season hues from a stylesheet every page carries", () => {
    // Without it every crest silently falls back to its hash hue, and the
    // look-alike greens come back with nothing failing.
    const layout = readFileSync(join(__dirname, "../app/layout.tsx"), "utf8");
    expect(layout).toContain("getTeamHueStyleSheet().catch(");
    expect(layout).toContain(
      "<style dangerouslySetInnerHTML={{ __html: teamHueCss }} />",
    );
  });
});

/** Read a team's published hue or ink (CSS custom properties). */
const HUE_READERS = new Set(["teamHueVar", "teamInkVar"]);
/** team-tint.ts helpers: they return `data-team-hue` WITH their style, so
 *  spreading one onto an element names its team (team-tint.test.ts). */
const PAINTERS = new Set(["teamTint", "teamStripe"]);
/** Where the helpers themselves live. */
const HUE_MODULES = new Set(["src/lib/team-hues.ts", "src/lib/team-tint.ts"]);

function calleeOf(node: ts.Node): string | null {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    ? node.expression.text
    : null;
}

/** Each element painted with a team's hue, and each way one goes wrong. */
function huePainting(file: SourceFile) {
  const source = parseSource(file);
  const elements = new Map<ts.Node, JsxElementInfo>(
    jsxElements(file, source).map((el) => [el.node, el]),
  );
  const painted = new Set<JsxElementInfo>();
  const problems: string[] = [];
  const at = (node: ts.Node) =>
    `${file.path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const walk = (node: ts.Node, visit: (n: ts.Node) => void) => {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  };

  // Variables holding a team's hue (`const hue = teamHueVar(team.id)`), or
  // built from one, with the team id each reads, within their own block.
  type HueVariable = { name: string; team: string; scope: ts.Node; init: ts.Node };
  const variables: HueVariable[] = [];
  const isDeclaredName = (id: ts.Identifier) => {
    const parent = id.parent;
    return (
      ((ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isJsxAttribute(parent)) &&
        parent.name === id) ||
      (ts.isPropertyAccessExpression(parent) && parent.name === id)
    );
  };
  const variableAt = (id: ts.Identifier) =>
    variables.find(
      (v) =>
        v.name === id.text &&
        !isDeclaredName(id) &&
        id.pos >= v.scope.pos &&
        id.end <= v.scope.end,
    );
  /** The team ids a piece of code reads a hue for, outside any JSX in it
   *  (an element's own props are checked at the element). */
  const teamsIn = (node: ts.Node) => {
    const teams = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
        return;
      }
      const callee = calleeOf(n);
      if (callee && HUE_READERS.has(callee)) {
        teams.add((n as ts.CallExpression).arguments[0]?.getText(source) ?? "");
      } else if (ts.isIdentifier(n)) {
        const variable = variableAt(n);
        if (variable) teams.add(variable.team);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return teams;
  };
  for (let grew = true; grew; ) {
    grew = false;
    walk(source, (n) => {
      if (
        !ts.isVariableDeclaration(n) ||
        !ts.isIdentifier(n.name) ||
        !n.initializer ||
        variables.some((v) => v.init === n.initializer)
      ) {
        return;
      }
      const teams = teamsIn(n.initializer);
      if (teams.size === 0) return;
      if (teams.size > 1) {
        problems.push(`${at(n)}: ${n.name.text} mixes teams' hues`);
        return;
      }
      let scope: ts.Node = n;
      while (!ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      variables.push({ name: n.name.text, team: [...teams][0], scope, init: n.initializer });
      grew = true;
    });
  }

  walk(source, (n) => {
    const callee = calleeOf(n);
    let team: string | null = null;
    if (callee && HUE_READERS.has(callee)) {
      team = (n as ts.CallExpression).arguments[0]?.getText(source) ?? "";
    } else if (ts.isIdentifier(n)) {
      team = variableAt(n)?.team ?? null;
    } else if (callee && PAINTERS.has(callee)) {
      const owner = propsOwner(n);
      let spread = false;
      for (let up: ts.Node = n; up && !ts.isJsxAttributes(up); up = up.parent) {
        if (ts.isJsxSpreadAttribute(up)) spread = true;
      }
      if (owner && spread) painted.add(elements.get(owner)!);
      else problems.push(`${at(n)}: spread ${callee}(…) onto the element it paints`);
      return;
    }
    if (team === null) return;
    // Building a hue variable is checked where the variable is used (but a
    // read inside an element's props is that element's, wherever it sits).
    for (let up: ts.Node | undefined = n; up; up = up.parent) {
      if (ts.isJsxElement(up) || ts.isJsxSelfClosingElement(up)) break;
      if (variables.some((v) => v.init === up)) return;
    }
    const owner = propsOwner(n);
    if (!owner) {
      problems.push(`${at(n)}: a team hue read outside an element's props`);
      return;
    }
    const element = elements.get(owner)!;
    const named = propValue(element.attributes.get("data-team-hue"));
    if (named !== team) {
      problems.push(
        `${element.at}: <${element.tag}> paints ${team}'s hue but names ${named ?? "no team"} in data-team-hue`,
      );
    }
    painted.add(element);
  });
  return { painted: [...painted], problems: [...new Set(problems)] };
}

describe("team hues across the site", () => {
  const files = sourceFiles(["src/**/*.ts", "src/**/*.tsx"], 300).filter(
    (f) => !HUE_MODULES.has(f.path),
  );
  const results = files.map(huePainting);
  const painted = results.flatMap((r) => r.painted);

  it("finds the team-coloured elements it polices", () => {
    // Crests, glows, washes, stripes and the tale-of-the-tape bars.
    expect(painted.length).toBeGreaterThanOrEqual(11);
    const where = new Set(painted.map((el) => el.at.split(":")[0]));
    for (const file of [
      "src/components/ui.tsx",
      "src/app/teams/[id]/page.tsx",
      "src/app/matches/[id]/scoreboard.tsx",
      "src/app/matches/[id]/tale-of-the-tape.tsx",
      "src/app/matches/[id]/matchup-card.tsx",
      "src/app/matches/[id]/scouting-report.tsx",
      "src/app/matches/[id]/box-score.tsx",
    ]) {
      expect(where.has(file), file).toBe(true);
    }
  });

  it("names its own team on every element it paints", () => {
    // The layout's stylesheet sets --team-hue (and --team-ink) only on
    // elements carrying data-team-hue, so an element that reads the hue
    // without naming its team silently shows the fallback, or another
    // team's hue inherited from an ancestor.
    expect(results.flatMap((r) => r.problems)).toEqual([]);
  });

  it("catches an element that paints without naming its team", () => {
    const check = (text: string) =>
      huePainting({ path: "src/fixture.tsx", text }).problems;
    expect(
      check(
        "const a = (id: string) => <div style={{ color: `hsl(${teamHueVar(id)} 50% 50%)` }} />;",
      ),
    ).toHaveLength(1);
    expect(
      check(
        "function B({ id, other }: { id: string; other: string }) { const hue = teamHueVar(id); return <i data-team-hue={other} style={{ color: `hsl(${hue} 50% 50%)` }} />; }",
      ),
    ).toHaveLength(1);
    expect(
      check("const c = (id: string) => <div className={teamTint(id).toString()} />;"),
    ).toHaveLength(1);
    expect(
      check(
        "const d = (id: string) => <div data-team-hue={id} style={{ color: `hsl(${teamHueVar(id)} 50% 50%)` }} />;",
      ),
    ).toEqual([]);
  });
});
