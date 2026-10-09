import { Button } from "@/components/ui/button";

import { Empty, muted } from "../components/page";
import { Link } from "../routing";

export const NotFound = ({ what = "Page" }: { what?: string }) => (
  <Empty title={`${what} not found`}>
    <p className={muted}>
      It may have been removed, or the roots were rescanned.
    </p>
    <Button asChild variant="outline">
      <Link to="/">Back to overview</Link>
    </Button>
  </Empty>
);
