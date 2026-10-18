import { Button } from "@opendevhub/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@opendevhub/ui/dialog";
import { HistoryIcon } from "lucide-react";
import { useState } from "react";

import type { ActivityFilter } from "../../../shared/activity";
import { Tip } from "../../components/tip";
import { ActivityFeed } from "./activity-feed";

interface ActivityProps {
  filter: ActivityFilter;
  /** What the activity is of, named under the dialog's title. */
  subject: string;
  empty?: string;
}

/** A small header button that opens the activity of one project, task or entity in a dialog. */
export const ActivityButton = (props: ActivityProps) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tip label="Activity">
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground"
          aria-label="Activity"
          onClick={() => setOpen(true)}
        >
          <HistoryIcon />
        </Button>
      </Tip>
      <ActivityDialog {...props} open={open} onOpenChange={setOpen} />
    </>
  );
};

/** The activity dialog, opened from elsewhere, such as a menu item. */
export const ActivityDialog = (
  props: ActivityProps & {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }
) => {
  const { open } = props;
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Activity</DialogTitle>
          <DialogDescription>{props.subject}</DialogDescription>
        </DialogHeader>
        {/* Mounted per opening, so the feed only polls while it's shown. */}
        {open && (
          <ActivityFeed
            bare
            filter={props.filter}
            empty={props.empty}
            className="-mx-6 -mb-6 min-h-0 overflow-y-auto border-t"
          />
        )}
      </DialogContent>
    </Dialog>
  );
};
