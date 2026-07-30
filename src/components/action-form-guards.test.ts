import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// SOURCE-LEVEL GUARDS for ActionForm's three load-bearing wirings.
//
// `vitest.config.mts` is `environment: "node"` with no jsdom, so nothing in
// action-form.tsx can be rendered here — reading the source is the only way
// to assert anything about it, and there is no pure function to extract: each
// invariant IS a piece of wiring (where a call sits, which branch a line
// lives in), which is exactly what a render test can't see either.
//
// The three, and what breaks without them:
//
// 1. The onSubmit handler must preventDefault, capture FormData
//    SYNCHRONOUSLY (submitter included), and dispatch inside
//    startTransition. This is the React-19 auto-reset opt-out: React resets
//    uncontrolled fields after ANY completed native <form action> —
//    validation bounces included — which wiped the long /me questionnaire on
//    an { error } result. Remove the manual dispatch and every ActionForm in
//    the app regresses at once, visibly only to the player who just lost
//    ten minutes of typing.
//
// 2. formRef.current?.reset() must run ONLY on the success path. It exists
//    because the manual dispatch above skips React's auto-reset, so success
//    must clear the form by hand — but hoisted out of the success branch it
//    recreates the exact wipe the manual dispatch opted out of.
//
// 3. The action wrapper must convert a REJECTED promise (network drop,
//    server restart mid-deploy) into an { error } result. Unhandled, the
//    rejection propagates to the root error.tsx and replaces the whole page.

const SRC = readFileSync(join(__dirname, "action-form.tsx"), "utf8");

/**
 * The file with whole-line comments dropped. The literals below are QUOTED in
 * the comments that explain them ("Success: clear the form…"), and a guard
 * that miscounted call sites because of prose would just get the explanation
 * deleted.
 */
const CODE = SRC.split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");

/**
 * The `{ … }` block opening at `openAt`, by naive brace balancing (fine here:
 * no string in this file contains a brace, and whole-line comments are
 * already stripped). Returns the body and the index just past the closing
 * brace, so a caller can assert what immediately FOLLOWS a branch.
 */
function braceBlock(src: string, openAt: number): { body: string; endAt: number } {
  if (src[openAt] !== "{") {
    throw new Error(`braceBlock: expected "{" at ${openAt}, got ${src[openAt]}`);
  }
  let depth = 0;
  for (let i = openAt; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return { body: src.slice(openAt + 1, i), endAt: i + 1 };
    }
  }
  throw new Error("braceBlock: unbalanced braces");
}

describe("ActionForm source guards", () => {
  it("finds the wirings it is supposed to be guarding", () => {
    // If the component is rewritten around different primitives, every guard
    // below could pass by matching nothing — which is how a guard rots into
    // decoration. Each anchor must still exist before any assertion about
    // its surroundings means anything.
    for (const anchor of [
      "onSubmit={",
      "useActionState(",
      "formRef.current?.reset()",
      "await action(",
      "if (state.error)",
    ]) {
      expect(
        CODE.indexOf(anchor),
        `Anchor ${JSON.stringify(anchor)} not found in action-form.tsx — ` +
          `re-anchor these guards before trusting them.`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("dispatches manually: preventDefault, sync FormData capture, startTransition", () => {
    const at = CODE.indexOf("onSubmit={");
    const handler = braceBlock(CODE, at + "onSubmit=".length).body;

    expect(
      handler.includes("e.preventDefault()"),
      `onSubmit no longer calls e.preventDefault() — the native form action ` +
        `runs, and React 19's auto-reset wipes typed input on { error } results.`,
    ).toBe(true);

    const capture = handler.indexOf("new FormData(");
    const dispatch = handler.indexOf("startTransition(() => formAction(fd))");
    expect(
      dispatch,
      `onSubmit no longer dispatches via startTransition(() => formAction(fd)) ` +
        `— the manual dispatch IS the React-19 auto-reset opt-out.`,
    ).toBeGreaterThanOrEqual(0);
    // Capture must happen synchronously, BEFORE the transition: the form may
    // re-render mid-transition, and FormData read inside it reads that.
    expect(
      capture >= 0 && capture < dispatch,
      `FormData must be captured synchronously above the startTransition ` +
        `dispatch, not inside it.`,
    ).toBe(true);
    // …and from the event WITH the submitter, or every <SubmitButton> that
    // relies on a name/value pair silently stops sending it.
    expect(
      handler.includes(".submitter"),
      `The FormData capture dropped the submitter — button name/value pairs ` +
        `stop reaching the action.`,
    ).toBe(true);
  });

  it("resets the form ONLY on the success path", () => {
    const RESET = "formRef.current?.reset()";
    // Exactly one call site, so the branch check below covers all of them.
    expect(CODE.split(RESET).length - 1, `expected exactly one ${RESET}`).toBe(1);

    // The effect bails on the initial null state before any branch runs.
    const bail = CODE.indexOf("if (!state) return;");
    const errIf = CODE.indexOf("if (state.error)");
    expect(bail, "the state effect no longer bails on null state").toBeGreaterThanOrEqual(0);
    expect(bail).toBeLessThan(errIf);

    // The error branch must NOT reset (that is the wiped-questionnaire bug)…
    const errBlock = braceBlock(CODE, CODE.indexOf("{", errIf));
    expect(
      errBlock.body.includes(RESET),
      `${RESET} is in the error branch — an { error } result wipes the ` +
        `typed input the manual dispatch exists to preserve.`,
    ).toBe(false);
    expect(errBlock.body).toContain('pushToast("error"');

    // …and the success branch — the else immediately following it — must.
    const after = CODE.slice(errBlock.endAt, errBlock.endAt + 12);
    expect(
      after.includes("else"),
      `if (state.error) no longer has an adjacent else — the success branch ` +
        `this guard pins has moved; re-read the code and re-anchor.`,
    ).toBe(true);
    const elseBlock = braceBlock(CODE, CODE.indexOf("{", errBlock.endAt));
    expect(
      elseBlock.body.includes(RESET),
      `${RESET} left the success branch — success no longer clears the form ` +
        `(the manual dispatch skipped React's auto-reset, so nothing else does).`,
    ).toBe(true);
  });

  it("converts a rejected action promise into an { error } result", () => {
    const call = CODE.indexOf("await action(");
    const tryAt = CODE.lastIndexOf("try {", call);
    expect(
      tryAt >= 0 && call - tryAt < 200,
      `await action(…) is no longer inside a try — a rejected promise ` +
        `propagates to the root error.tsx and replaces the whole page.`,
    ).toBe(true);

    const catchAt = CODE.indexOf("catch", call);
    expect(
      catchAt >= 0 && catchAt - call < 200,
      `No catch follows await action(…) — the rejection-to-toast conversion ` +
        `is gone.`,
    ).toBe(true);
    const catchBlock = braceBlock(CODE, CODE.indexOf("{", catchAt)).body;
    expect(
      catchBlock.includes("return") && catchBlock.includes("error:"),
      `The catch no longer returns an { error: … } ActionResult — it must ` +
        `convert the rejection, not rethrow or swallow it.`,
    ).toBe(true);

    // The wrapper only matters if it is the thing actually dispatched.
    expect(
      CODE.includes("useActionState(safeAction"),
      `useActionState no longer consumes the guarded wrapper — the try/catch ` +
        `above it is decoration if the raw action is dispatched.`,
    ).toBe(true);
  });
});
