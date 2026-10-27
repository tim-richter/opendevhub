import { Button } from "@opendevhub/ui/button";
import { CheckIcon, Undo2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { HunkTarget } from "./review";

/** How long a first click on Undo waits for its confirming second click. */
const CONFIRM_MS = 3000;

export type StageChange = (
  action: "stage" | "unstage" | "discard",
  target: { file?: string; hunk?: number; paths?: string[] }
) => void;

/** How a diff list lets its hunks and files be kept or undone; without it the diffs are read-only. */
export interface HunkControls {
  /** The diffs shown are the ones in the index. */
  staged: boolean;
  disabled: boolean;
  change: StageChange;
}

/** Stage and Discard for one hunk, like the accept and reject buttons of an AI code editor. Discard asks twice: it can't be undone. */
export const HunkButtons = (props: {
  target: HunkTarget;
  disabled: boolean;
  change: StageChange;
}) => {
  const { target, disabled, change } = props;
  const [sure, setSure] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const { file, hunk } = target;

  if (target.staged) {
    return (
      <div className="flex items-center justify-end gap-1.5 px-3 py-1.5 font-sans">
        <span className="text-ok inline-flex items-center gap-1 text-xs">
          <CheckIcon className="size-3.5" aria-hidden /> Staged
        </span>
        <Button
          variant="outline"
          size="xs"
          disabled={disabled}
          onClick={() => change("unstage", { file, hunk })}
        >
          Unstage
        </Button>
      </div>
    );
  }
  return (
    <div className="flex justify-end gap-1.5 px-3 py-1.5 font-sans">
      <Button
        variant={sure ? "destructive" : "outline"}
        size="xs"
        disabled={disabled}
        onBlur={() => setSure(false)}
        onClick={() => {
          if (!sure) {
            setSure(true);
            timer.current = setTimeout(() => setSure(false), CONFIRM_MS);
            return;
          }
          clearTimeout(timer.current);
          setSure(false);
          change("discard", { file, hunk });
        }}
      >
        <Undo2Icon aria-hidden /> {sure ? "Really discard?" : "Discard"}
      </Button>
      <Button
        size="xs"
        className="bg-ok hover:bg-ok/90 text-white"
        disabled={disabled}
        onClick={() => change("stage", { file, hunk })}
      >
        <CheckIcon aria-hidden /> Stage
      </Button>
    </div>
  );
};

/** Keep or unstage a whole file; sits in the file's header. */
export const FileKeepButton = (props: {
  file: string;
  controls: HunkControls;
}) => {
  const { file, controls } = props;
  const { staged, disabled, change } = controls;
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={disabled}
      onClick={() => change(staged ? "unstage" : "stage", { paths: [file] })}
    >
      {staged ? "Unstage file" : "Stage file"}
    </Button>
  );
};
