import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Empty, muted } from "../components/Page";

export function NotFound({ what = "Page" }: { what?: string }) {
  return (
    <Empty title={`${what} not found`}>
      <p className={muted}>It may have been removed, or the roots were rescanned.</p>
      <Button asChild variant="outline">
        <Link to="/">Back to overview</Link>
      </Button>
    </Empty>
  );
}
