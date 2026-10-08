import { SettingsIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { ProjectView } from "../../shared/types";
import { ChecksSettings } from "./checks-settings";
import { Tip } from "./tip";

/** A gear in the project's header that opens its settings. */
export const ProjectSettingsButton = ({ view }: { view: ProjectView }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tip label="Project settings">
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground"
          aria-label="Project settings"
          onClick={() => setOpen(true)}
        >
          <SettingsIcon />
        </Button>
      </Tip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Project settings</DialogTitle>
            <DialogDescription>{view.project.name}</DialogDescription>
          </DialogHeader>
          {/* Mounted per opening, so the checks are fetched fresh. */}
          {open && <ChecksSettings projectId={view.project.id} />}
        </DialogContent>
      </Dialog>
    </>
  );
};
