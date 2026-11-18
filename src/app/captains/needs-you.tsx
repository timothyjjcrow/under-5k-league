import { CaptainTodoItem } from "@/components/captain-todo-item";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { captainsMatchHref } from "@/lib/captains";
import type { CaptainTodoRow } from "@/lib/captains-service";
import { captainTodoCountLine, captainTodoHref } from "@/lib/captain-todos";
import { MATCH_ANCHOR } from "@/lib/match-anchors";

/**
 * Everything waiting on the captain across their team's open matches
 * (`loadCaptainTodoRows`, the match page's own rule). A standin line opens
 * the game on the Standins page, where every standin control lives; a time
 * change opens that match's controls on this page, at its Reschedule card.
 */
export function NeedsYou({ todos }: { todos: CaptainTodoRow[] }) {
  return (
    <Card
      tone={todos.length > 0 ? "feature" : "default"}
      id="needs-you"
      className="scroll-mt-24"
    >
      <CardHeader
        headingLevel={2}
        title="Needs you"
        subtitle={
          todos.length > 0
            ? `${captainTodoCountLine(todos.length)} across your team's matches`
            : "Standin cover, standin requests and ready checks across every match"
        }
      />
      <CardBody>
        {todos.length > 0 ? (
          <ul aria-label="Needs you" className="space-y-3 text-sm">
            {todos.map((row) => (
              <CaptainTodoItem
                key={`${row.matchId}-${row.todo.kind}`}
                todo={row.todo}
                href={captainTodoHref(
                  row.todo.kind,
                  row.matchId,
                  captainsMatchHref(row.matchId, MATCH_ANCHOR.reschedule),
                )}
                context={`${row.roundLabel} vs ${row.opponentName}:`}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            <span aria-hidden>✓ </span>Nothing needs you right now. Players
            who can&apos;t make a match, the other captain&apos;s standin
            requests and ready checks show up here.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
