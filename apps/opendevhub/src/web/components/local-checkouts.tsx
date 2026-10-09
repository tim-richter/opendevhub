import { GitBranchIcon } from "lucide-react";
import { Link } from "react-router";

import type { ForgejoPullDetails } from "../../shared/forgejo";
import {
  checkoutCounts,
  checkoutOf,
  checkoutPath,
  checkoutTone,
} from "../checkouts";
import { useDash } from "../dashboard-context";
import { useForgejoCheckouts } from "../hooks/use-forgejo-checkouts";
import { StatusDot, TONE_LABEL } from "./status";

const LIMIT = 3;

/** The running local checkouts of a pull request's own branch, so the PR page leads to the agents on it. */
export const LocalCheckouts = ({
  details,
}: {
  details: ForgejoPullDetails;
}) => {
  const { snapshot } = useDash();
  const links = useForgejoCheckouts(details);
  const exact = links.data?.matches.filter((m) => m.exact) ?? [];
  const rows = exact.flatMap((m) => {
    const view = snapshot?.projects.find((p) => p.project.id === m.projectId);
    const checkout = view && checkoutOf(view, m.directory);
    return view && checkout ? [{ checkout, view }] : [];
  });
  if (rows.length === 0) {
    return null;
  }
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span>Checked out here:</span>
      {rows.slice(0, LIMIT).map(({ view, checkout }) => {
        const n = checkoutCounts(view, checkout.directory);
        const tone = checkoutTone(view, checkout.directory);
        return (
          <Link
            key={`${view.project.id}:${checkout.directory}`}
            to={checkoutPath(view.project.id, checkout.target)}
            className="text-foreground inline-flex items-center gap-1.5 hover:underline"
            title={TONE_LABEL[tone]}
          >
            <StatusDot tone={tone} />
            <GitBranchIcon className="text-muted-foreground size-3.5" />
            {view.project.name} › {checkout.label}
            {n.attention > 0 && (
              <span className="text-attention font-medium">
                · {n.attention} {n.attention === 1 ? "needs" : "need"} you
              </span>
            )}
            {n.attention === 0 && n.running > 0 && (
              <span className="text-muted-foreground">
                · {n.running} working
              </span>
            )}
          </Link>
        );
      })}
      {rows.length > LIMIT && <span>+{rows.length - LIMIT} more</span>}
    </p>
  );
};
