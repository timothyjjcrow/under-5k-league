import { CaptainTodoItem } from "@/components/captain-todo-item";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { captainsMatchHref } from "@/lib/captains";
import type { CaptainTodoRow } from "@/lib/captains-service";
import { CAPTAIN_TODO_CARD, captainTodoCountLine } from "@/lib/captain-todos";
import { MATCH_ANCHOR } from "@/lib/match-anchors";

/**
 * Everything waiting on the captain across their team's open matches
 * (`loadCaptainTodoRows`, the match page's own rule). Each line opens that
 * match's controls on this page, scrolled to the card that answers it.
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
                href={captainsMatchHref(
                  row.matchId,
                  MATCH_ANCHOR[CAPTAIN_TODO_CARD[row.todo.kind]],
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
