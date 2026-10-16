import { Button } from "@opendevhub/ui/button";
import { Input } from "@opendevhub/ui/input";
import {
  GripVerticalIcon,
  LayersIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { CheckWhere } from "../../../shared/types";
import { Choice } from "../../components/choice";
import { emptyRow, moveRow, newKey, shiftRow } from "./checks-draft";
import type { DraftGroup, DraftRow } from "./checks-draft";

const WHERE_OPTIONS = [
  { label: "Container", value: "container" },
  {
    label: "This machine",
    title:
      "For docker build / docker compose: runs in the checkout's folder on this machine",
    value: "host",
  },
];

const ROW_GRID =
  "grid grid-cols-[1.5rem_8rem_minmax(0,1fr)_8.5rem_5.5rem_auto] items-center gap-2 max-md:grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1fr)_auto]";

/** Where a group sits among the others, for screen-reader announcements. */
const groupLabel = (g: DraftGroup | undefined): string =>
  !g || g.loose ? "no group" : `group ${g.name.trim() || "without a name"}`;

/**
 * The checks being edited, in their groups. Rows reorder by dragging their handle, or with the arrow
 * keys on it; past the end of a group they move into the next one.
 */
export const ChecksEditor = (props: {
  draft: DraftGroup[];
  onChange: (draft: DraftGroup[]) => void;
  /** Shown at the right of the Add group button: the form's own actions. */
  actions: ReactNode;
}) => {
  const { draft, onChange } = props;
  const root = useRef<HTMLDivElement>(null);
  const hintId = useId();
  /** The handle to focus once a keyboard move has rendered: a row that changes group is mounted again. */
  const refocus = useRef<number>(undefined);
  useLayoutEffect(() => {
    if (refocus.current === undefined) {
      return;
    }
    root.current
      ?.querySelector<HTMLElement>(`[data-handle="${refocus.current}"]`)
      ?.focus();
    refocus.current = undefined;
  });
  const [dragging, setDragging] = useState<number>();
  const [announcement, setAnnouncement] = useState("");
  const [focusGroup, setFocusGroup] = useState<number>();
  const hasGroups = draft.some((g) => !g.loose);

  const patchGroup = (key: number, patch: Partial<DraftGroup>) =>
    onChange(draft.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  const patchRow = (key: number, patch: Partial<DraftRow>) =>
    onChange(
      draft.map((g) => ({
        ...g,
        rows: g.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
      }))
    );
  const removeRow = (key: number) =>
    onChange(
      draft.map((g) => ({ ...g, rows: g.rows.filter((r) => r.key !== key) }))
    );
  const addRow = (groupKey: number) =>
    onChange(
      draft.map((g) =>
        g.key === groupKey ? { ...g, rows: [...g.rows, emptyRow()] } : g
      )
    );
  const addGroup = () => {
    const key = newKey();
    setFocusGroup(key);
    onChange([...draft, { key, name: "", rows: [emptyRow()] }]);
  };

  const describe = (next: DraftGroup[], rowKey: number) => {
    const group = next.find((g) => g.rows.some((r) => r.key === rowKey));
    const index = group?.rows.findIndex((r) => r.key === rowKey) ?? 0;
    const name = group?.rows[index]?.name.trim() || "Check";
    setAnnouncement(
      `${name} moved to position ${index + 1} of ${group?.rows.length ?? 0} in ${groupLabel(group)}`
    );
  };

  const onHandleKey = (e: KeyboardEvent, rowKey: number) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
      return;
    }
    e.preventDefault();
    const next = shiftRow(draft, rowKey, e.key === "ArrowUp" ? -1 : 1);
    if (next === draft) {
      return;
    }
    onChange(next);
    describe(next, rowKey);
    refocus.current = rowKey;
  };

  const onRowDragOver = (e: DragEvent, groupKey: number, index: number) => {
    if (dragging === undefined) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    const below = e.clientY > box.top + box.height / 2;
    const group = draft.find((g) => g.key === groupKey);
    const from = group?.rows.findIndex((r) => r.key === dragging) ?? -1;
    // Within one group the row's own slot is gone after it's lifted out.
    let to = below ? index + 1 : index;
    if (from !== -1 && from < to) {
      to -= 1;
    }
    const next = moveRow(draft, dragging, groupKey, to);
    if (next !== draft) {
      onChange(next);
    }
  };

  const onGroupDragOver = (e: DragEvent, group: DraftGroup) => {
    if (dragging === undefined) {
      return;
    }
    e.preventDefault();
    if (group.rows.some((r) => r.key === dragging)) {
      return;
    }
    onChange(moveRow(draft, dragging, group.key, group.rows.length));
  };

  return (
    <div ref={root} className="flex flex-col gap-3">
      {draft.map((group) => {
        const showLoose =
          !group.loose ||
          !hasGroups ||
          group.rows.length > 0 ||
          dragging !== undefined;
        if (!showLoose) {
          return (
            <Button
              key={group.key}
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground w-fit"
              onClick={() => addRow(group.key)}
            >
              <PlusIcon /> Add a check without a group
            </Button>
          );
        }
        return (
          <section
            key={group.key}
            aria-label={groupLabel(group)}
            onDragOver={(e) => onGroupDragOver(e, group)}
            onDrop={(e) => e.preventDefault()}
            className={cn(
              "flex flex-col rounded-lg transition-colors duration-150",
              hasGroups && "border",
              group.loose && hasGroups && "border-dashed",
              dragging !== undefined && "border-ring/40"
            )}
          >
            {!group.loose && (
              <GroupHeader
                group={group}
                autoFocus={focusGroup === group.key}
                onRename={(name) => patchGroup(group.key, { name })}
                onRemove={() =>
                  onChange(draft.filter((g) => g.key !== group.key))
                }
              />
            )}
            {group.loose && hasGroups && (
              <p className="text-muted-foreground px-3 pt-2.5 text-xs font-medium">
                Not in a group
              </p>
            )}
            <ul className={cn("flex flex-col", hasGroups && "px-3 pt-2")}>
              {group.rows.map((row, index) => (
                <CheckRowEditor
                  key={row.key}
                  row={row}
                  lifted={dragging === row.key}
                  hintId={hintId}
                  onPatch={(patch) => patchRow(row.key, patch)}
                  onRemove={() => removeRow(row.key)}
                  onHandleKey={(e) => onHandleKey(e, row.key)}
                  onDragStart={(e) => {
                    const li = e.currentTarget.closest("li");
                    if (li) {
                      e.dataTransfer.setDragImage(li, 12, 16);
                    }
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", row.name);
                    setDragging(row.key);
                  }}
                  onDragEnd={() => {
                    if (dragging !== undefined) {
                      describe(draft, dragging);
                    }
                    setDragging(undefined);
                  }}
                  onDragOver={(e) => onRowDragOver(e, group.key, index)}
                />
              ))}
              {group.rows.length === 0 && (
                <li className="text-muted-foreground rounded-md border border-dashed px-3 py-2.5 text-center text-xs">
                  {group.loose
                    ? "Drop a check here to take it out of its group"
                    : "Drop a check here, or add one"}
                </li>
              )}
            </ul>
            <div className={cn(hasGroups ? "px-1.5 pb-1.5" : "pt-1")}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => addRow(group.key)}
              >
                <PlusIcon /> Add check
              </Button>
            </div>
          </section>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={addGroup}>
          <LayersIcon /> Add group
        </Button>
        <span className="flex-1" />
        {props.actions}
      </div>
      <p id={hintId} className="sr-only">
        Press the up and down arrow keys to move the check, also into the group
        before or after.
      </p>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
};

const GroupHeader = (props: {
  group: DraftGroup;
  autoFocus: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
}) => {
  const { group } = props;
  const count = group.rows.length;
  return (
    <div className="bg-muted/50 flex items-center gap-2 rounded-t-lg border-b px-3 py-1.5">
      <span className="flex w-6 shrink-0 justify-center">
        <LayersIcon className="text-muted-foreground size-4" />
      </span>
      <Input
        aria-label="Group name"
        placeholder="Group name"
        // Only a group just added takes the focus, so its name can be typed at once.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={props.autoFocus}
        value={group.name}
        onChange={(e) => props.onRename(e.target.value)}
        className="hover:border-input focus-visible:border-ring field-sizing-content h-7 w-auto max-w-64 min-w-28 border-transparent bg-transparent px-1.5 font-semibold shadow-none dark:bg-transparent"
      />
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {count} {count === 1 ? "check" : "checks"}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground ml-auto"
        aria-label={`Remove group ${group.name || "without a name"} and its checks`}
        title="Remove this group and its checks"
        onClick={props.onRemove}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
};

const CheckRowEditor = (props: {
  row: DraftRow;
  lifted: boolean;
  hintId: string;
  onPatch: (patch: Partial<DraftRow>) => void;
  onRemove: () => void;
  onHandleKey: (e: KeyboardEvent) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
}) => {
  const { row } = props;
  return (
    <li
      onDragOver={props.onDragOver}
      className={cn(
        ROW_GRID,
        "py-1.5 transition-opacity duration-150 max-md:border-b max-md:pb-3",
        props.lifted && "opacity-40"
      )}
    >
      <button
        type="button"
        draggable
        data-handle={row.key}
        aria-label={`Move ${row.name || "check"}`}
        aria-roledescription="sortable"
        aria-describedby={props.hintId}
        title="Drag, or use the arrow keys, to move"
        onKeyDown={props.onHandleKey}
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex h-8 cursor-grab items-center justify-center rounded-md outline-none focus-visible:ring-[3px] active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <Input
        aria-label="Name"
        placeholder="name"
        value={row.name}
        onChange={(e) => props.onPatch({ name: e.target.value })}
        className="h-8"
      />
      <Input
        aria-label="Command"
        placeholder="pnpm test"
        value={row.command}
        onChange={(e) => props.onPatch({ command: e.target.value })}
        className="h-8 font-mono text-xs max-md:col-span-3 max-md:col-start-2 max-md:row-start-2"
      />
      <Choice
        label="Where it runs"
        value={row.where}
        onChange={(v) => props.onPatch({ where: v as CheckWhere })}
        options={WHERE_OPTIONS}
        className="w-full max-md:col-start-2 max-md:row-start-3"
      />
      <Input
        aria-label="Timeout in seconds"
        title="Timeout in seconds"
        type="number"
        min={1}
        value={row.timeout}
        onChange={(e) => props.onPatch({ timeout: e.target.value })}
        className="h-8 max-md:col-start-3 max-md:row-start-3"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${row.name || "check"}`}
        className="text-muted-foreground max-md:col-start-4 max-md:row-start-1"
        onClick={props.onRemove}
      >
        <Trash2Icon />
      </Button>
    </li>
  );
};
