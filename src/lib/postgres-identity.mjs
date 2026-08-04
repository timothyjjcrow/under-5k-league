/**
 * Return a stable, credential-free identity for one PostgreSQL target.
 *
 * Pooled and direct URLs normally differ in password, port, query string and
 * (for Neon) a `-pooler` host suffix. Those are connection details, not
 * database identity. The user, database and logical endpoint must still agree.
 * Supabase's transaction pooler encodes the project ref in the username, so
 * normalize that common shape as well.
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
  if (!database || !user || !hostname) return null;

  let endpoint = hostname;
  const supabasePooler = hostname.endsWith(".pooler.supabase.com");
  if (supabasePooler && user.includes(".")) {
    const separator = user.indexOf(".");
    const projectRef = user.slice(separator + 1).toLowerCase();
    user = user.slice(0, separator);
    if (!projectRef || !user) return null;
    endpoint = `supabase:${projectRef}`;
  } else {
    const supabaseDirect = hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/);
    if (supabaseDirect) {
      endpoint = `supabase:${supabaseDirect[1]}`;
    } else {
      const labels = hostname.split(".");
      labels[0] = labels[0].replace(/-pooler$/, "");
      endpoint = labels.join(".");
    }
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
