import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import type { ForgejoPullRequest } from "../../../shared/forgejo";
import { fetchForgejoApprovals } from "../../api";
import { Chip } from "../../components/page";
import { Tip } from "../../components/tip";
import { useForgejoQuery } from "./use-forgejo";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const by = (who: string[]) => (who.length ? ` by ${who.join(", ")}` : "");

/**
 * How an open pull request stands against the approvals its base branch requires. Each load costs a few Forgejo
 * requests, so with `lazy` it waits until it scrolls into view. The list and the pull request page share the result.
 */
export const ForgejoApprovals = ({
  pull,
  lazy = false,
}: {
  pull: ForgejoPullRequest;
  lazy?: boolean;
}) => {
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(!lazy);
  useEffect(() => {
    const element = ref.current;
    if (seen || !element) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  const open = pull.state === "open";
  const { owner, repo } = pull;
  const number = String(pull.number);
  const query = useForgejoQuery(
    ["pull", owner, repo, number, "approvals", pull.updatedAt],
    (signal) => fetchForgejoApprovals(owner, repo, number, signal),
    open && seen
  );
  if (!open) {
    return null;
  }
  if (!query.data) {
    return <span ref={ref} />;
  }
  const { approvedBy, base, changesRequestedBy, required } = query.data;
  const approved = approvedBy.length
    ? `Approved${by(approvedBy)}.`
    : "No approvals yet.";
  if (changesRequestedBy.length) {
    return (
      <Tip label={`Changes requested${by(changesRequestedBy)}.`}>
        <Chip className="bg-destructive/10 text-destructive">
          Changes requested
        </Chip>
      </Tip>
    );
  }
  if (!required) {
    return (
      <Tip label={`${base} requires no approvals. ${approved}`}>
        <Chip>{plural(approvedBy.length, "approval")}</Chip>
      </Tip>
    );
  }
  const met = approvedBy.length >= required;
  return (
    <Tip
      label={`${base} requires ${plural(required, "approval")}. ${approved}`}
    >
      <Chip className={cn(met ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn")}>
        {approvedBy.length}/{required} approvals
      </Chip>
    </Tip>
  );
};
