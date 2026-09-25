import { readPoolDiagnostics } from "@/lib/prisma";
import { readDatabaseDiagnostics } from "@/lib/db-observability";

/** Called only after AdminPage's authorization check. Never expose raw engine
 * metrics, labels, queries or caught error objects to a client component. */
export async function DatabaseHealth() {
  const pool = await readPoolDiagnostics();
  const sample = readDatabaseDiagnostics();
  const wait = pool?.connectionWait;
  const averageWait = wait?.count && wait.totalMs !== null
    ? `${(wait.totalMs / wait.count).toFixed(1)} ms` : "No sample";
  const number = (value: number | null | undefined) => value == null ? "Unavailable" : value.toLocaleString("en-US");
  return (
    <details className="rounded-lg border border-line p-3 text-sm">
      <summary className="cursor-pointer py-1 font-semibold">Database performance</summary>
      <p className="mt-3 text-xs text-muted">
        These measurements cover this server instance. Pool counters restart with
        the instance. Recent query summaries are also saved to hosting logs.
        Slow queries and connection failures are separate signals.
      </p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
        <div><dt className="text-muted">Queries waiting for a connection</dt><dd className="font-semibold">{number(pool?.queriesWaiting)}</dd></div>
        <div><dt className="text-muted">Average connection wait</dt><dd className="font-semibold">{averageWait}</dd></div>
        <div><dt className="text-muted">Busy / open connections</dt><dd className="font-semibold">{number(pool?.connectionsBusy)} / {number(pool?.connectionsOpen)}</dd></div>
        <div><dt className="text-muted">Pool timeouts in this sample</dt><dd>{number(sample.poolTimeouts)}</dd></div>
        <div><dt className="text-muted">Unreachable database in this sample</dt><dd>{number(sample.unreachable)}</dd></div>
        <div><dt className="text-muted">Public data refreshes / shared waits</dt><dd>{number(sample.refreshes)} / {number(sample.sharedRefreshes)}</dd></div>
      </dl>
      {sample.oversizedSnapshots > 0 ? (
        <p className="mt-3 text-warning">A public data snapshot exceeded the cache size budget. All results are still included; check the hosting performance summary before expanding the history.</p>
      ) : null}
    </details>
  );
}
