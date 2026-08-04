const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
const LOCAL_PART = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;
const DOMAIN_LABEL = /^[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i;
const DATA_LOCATIONS = /^[A-Z][A-Z .,'()&/-]*$/i;

/**
 * Normalize the one public privacy-request address used by the environment
 * gate and the rendered notice. Deliberately accepts only a plain ASCII
 * mailbox: display names, comments, whitespace and URL-like values do not
 * belong in a mailto link or a production configuration field.
 */
export function normalizePrivacyContactEmail(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value !== value.trim() || value.length > MAX_EMAIL_LENGTH) return null;

  const pieces = value.split("@");
  if (pieces.length !== 2) return null;
  const [local, domain] = pieces;
  if (
    !local ||
    local.length > MAX_LOCAL_LENGTH ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !LOCAL_PART.test(local)
  ) {
    return null;
  }

  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) {
    return null;
  }
  return value;
}

/**
 * Public, operator-supplied countries where league-controlled copies
 * live. The validator cannot prove geography, but it can refuse vague,
 * multiline, URL-like, or placeholder text before that text becomes policy.
 */
export function normalizePrivacyDataLocations(value) {
  if (typeof value !== "string" || value.length < 2 || value.length > 160) {
    return null;
  }
  if (
    value !== value.trim() ||
    !DATA_LOCATIONS.test(value) ||
    /(?:unknown|placeholder|change[- ]?me|replace|your[- ]?location|todo|tbd)/i.test(
      value,
    )
  ) {
    return null;
  }
  return value;
}
