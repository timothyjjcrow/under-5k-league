import { Card, CardBody, Skeleton } from "@/components/ui";

// Generic page skeleton shown while a route's data loads — a title bar plus a
// grid of card placeholders. Better perceived performance than a bare spinner.
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2.5">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardBody className="space-y-3">
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
