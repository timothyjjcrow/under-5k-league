import Link from "next/link";
import { buttonClasses } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <h1 className="text-3xl font-bold">404</h1>
      <p className="text-muted">That page doesn&apos;t exist.</p>
      <Link href="/" className={buttonClasses("secondary")}>
        Back to home
      </Link>
    </div>
  );
}
