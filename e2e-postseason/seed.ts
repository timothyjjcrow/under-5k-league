// seed-fixture intentionally uses Math.random for visual variety. Browser
// assertions need the same standings and bracket on every run, so install a
// tiny seeded generator before loading that script. Keep this local to the
// postseason child process; application randomness is untouched.
export {};

let state = 0x5eed1234;
Math.random = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 0x1_0000_0000;
};

async function bootstrap() {
  await import("../scripts/seed-fixture");
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
