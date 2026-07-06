// Result returned by server actions used with <ActionForm>. Never throw for
// expected validation failures — return { error } so the UI can toast it.
export type ActionResult = {
  ok?: boolean;
  error?: string;
  message?: string;
} | null;
