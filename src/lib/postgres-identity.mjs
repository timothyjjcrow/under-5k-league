/**
 * Return a stable, credential-free identity for one PostgreSQL target.
 *
 * Recognized managed-provider pooled/direct URLs can differ in password, port,
 * query string and host form without changing logical database identity. Neon
 * and Supabase have explicit normalization rules below. For every unknown
 * provider, hostname and effective port remain part of identity: assuming two
 * ports or lookalike hosts reach the same cluster would make a backup receipt
 * portable to a target it never protected.
 */
export function postgresDatabaseIdentity(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return null;
  }

  const database = decode(url.pathname.replace(/^\//, ""));
  let user = decode(url.username);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const effectivePort = url.port || "5432";
  if (!database || !user || !hostname) return null;

  let endpoint = hostname;
  const supabasePooler = hostname.endsWith(".pooler.supabase.com");
  const supabaseDirect = hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/);
  if (supabasePooler && user.includes(".")) {
    const separator = user.indexOf(".");
    const projectRef = user.slice(separator + 1).toLowerCase();
    user = user.slice(0, separator);
    if (!projectRef || !user) return null;
    endpoint = `supabase:${projectRef}`;
  } else if (supabaseDirect) {
    endpoint = `supabase:${supabaseDirect[1]}`;
  } else if (hostname.endsWith(".neon.tech")) {
    const labels = hostname.split(".");
    labels[0] = labels[0].replace(/-pooler$/, "");
    endpoint = labels.join(".");
  } else {
    endpoint = `${hostname}:${effectivePort}`;
  }

  // JSON is unambiguous even when a legal user/database contains punctuation.
  return JSON.stringify({ database, endpoint, user });
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
