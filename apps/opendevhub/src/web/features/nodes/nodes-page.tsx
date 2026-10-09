import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import type { NodeView } from "../../../shared/types";
import { addNode, removeNode } from "../../api";
import {
  Chip,
  muted,
  Note,
  Page,
  PageHeader,
  Section,
} from "../../components/page";
import { useDash } from "../../dashboard-context";
import { formatNodeStats, nodeStateClass, nodeStateLabel } from "./nodes";

const NodeRow = (props: { node: NodeView; onRemove?: () => void }) => {
  const { node } = props;
  const stats = formatNodeStats(node.stats);
  return (
    <div className="flex flex-col gap-1 border-b px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{node.label}</span>
        {node.ssh && node.ssh !== node.label && (
          <span className="text-muted-foreground font-mono text-sm">
            {node.ssh}
          </span>
        )}
        <Chip variant="outline" className={nodeStateClass(node.state)}>
          {nodeStateLabel(node.state)}
        </Chip>
        {props.onRemove && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7"
            onClick={props.onRemove}
          >
            Remove
          </Button>
        )}
      </div>
      {stats && <span className={cn(muted, "tabular-nums")}>{stats}</span>}
      {node.reason &&
        (node.state === "connecting" ? (
          <Note>{node.reason}</Note>
        ) : (
          <Note error>{node.reason}</Note>
        ))}
    </div>
  );
};

export const NodesPage = () => {
  const { snapshot, report } = useDash();
  const [ssh, setSsh] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<NodeView>();
  const nodes = snapshot?.nodes ?? [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (ssh.trim() === "") {
      setError(
        "Enter an ssh destination, such as tim@workstation or an alias from ~/.ssh/config."
      );
      return;
    }
    setBusy(true);
    try {
      await addNode(ssh.trim(), label.trim() || undefined);
      setSsh("");
      setLabel("");
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async () => {
    if (!removing) {
      return;
    }
    const { id } = removing;
    setRemoving(undefined);
    await removeNode(id).catch(report);
  };

  return (
    <Page>
      <PageHeader
        title="Nodes"
        description="Machines that run task environments, reached over ssh. Choose one in the New task form."
      />

      <Section title="Machines">
        {nodes.map((node) => (
          <NodeRow
            key={node.id}
            node={node}
            onRemove={node.id === "local" ? undefined : () => setRemoving(node)}
          />
        ))}
      </Section>

      <Section
        title="Add a node"
        hint="needs Docker, the devcontainer CLI and git ≥ 2.48 on the machine, and an ssh key that works without a prompt"
      >
        <form
          className="flex flex-wrap items-end gap-3 px-4 py-3"
          onSubmit={(e) => void submit(e)}
        >
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor="node-ssh">ssh destination</Label>
            <Input
              id="node-ssh"
              placeholder="tim@workstation"
              value={ssh}
              onChange={(e) => {
                setSsh(e.target.value);
                setError(undefined);
              }}
              aria-invalid={!!error}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex min-w-40 flex-col gap-1.5">
            <Label htmlFor="node-label">Label (optional)</Label>
            <Input
              id="node-label"
              placeholder="Workstation"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Connecting…" : "Add node"}
          </Button>
        </form>
        {error && (
          <Note error className="mx-4 mb-3">
            {error}
          </Note>
        )}
      </Section>

      <Dialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removing?.label}?</DialogTitle>
            <DialogDescription>
              opendevhub disconnects and forgets this node. Nothing on the
              machine is deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(undefined)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmRemove()}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
};
