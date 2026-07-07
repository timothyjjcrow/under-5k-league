import Link from "next/link";
import { Card, CardBody, buttonClasses } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-16">
      <Card>
        <CardBody className="flex flex-col items-center gap-4 py-10 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-xl bg-brand text-xl font-bold text-brand-fg">
            5K
          </div>
          <div>
            <div className="text-4xl font-bold tracking-tight">404</div>
            <p className="mt-1 text-muted">
              This page is lost in the fog of war.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Link href="/" className={buttonClasses("primary")}>
              Back to home
            </Link>
            <Link href="/players" className={buttonClasses("secondary")}>
              Browse players
            </Link>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
