/** Keep offset pagination bounded and reject ambiguous/repeated parameters. */
export function listPage(value: string | string[] | undefined): number {
  return typeof value === "string" && /^[1-9]\d{0,3}$/.test(value)
    ? Number(value)
    : 1;
}
