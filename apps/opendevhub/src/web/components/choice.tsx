import { Fragment } from "react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface ChoiceOption {
  value: string;
  label: string;
  title?: string;
  /** Consecutive options with the same group render under one heading. */
  group?: string;
}

// Radix Select reserves "" for "no value", but our selects use "" as a real option ("default").
const EMPTY = "\u0000";

const groups = (options: ChoiceOption[]) => {
  const runs: { group?: string; items: ChoiceOption[] }[] = [];
  for (const option of options) {
    const last = runs.at(-1);
    if (last && last.group === option.group) {
      last.items.push(option);
    } else {
      runs.push({ group: option.group, items: [option] });
    }
  }
  return runs;
};

/** A shadcn Select over a flat option list, where "" is an ordinary value. */
export const Choice = (props: {
  value: string;
  options: ChoiceOption[];
  onChange: (value: string) => void;
  label?: string;
  id?: string;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
}) => {
  const {
    value,
    options,
    onChange,
    label,
    id,
    disabled,
    size = "sm",
    className,
  } = props;
  return (
    <Select
      value={value === "" ? EMPTY : value}
      onValueChange={(v) => onChange(v === EMPTY ? "" : v)}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        size={size}
        aria-label={label}
        className={className}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {groups(options).map(({ group, items }, index) => {
          const rendered = items.map((o) => (
            <SelectItem
              key={o.value}
              value={o.value === "" ? EMPTY : o.value}
              title={o.title}
            >
              {o.label}
            </SelectItem>
          ));
          return group ? (
            <SelectGroup key={`group:${group}`}>
              <SelectLabel>{group}</SelectLabel>
              {rendered}
            </SelectGroup>
          ) : (
            // Runs are positional: an ungrouped run never moves without its neighbours.
            // oxlint-disable-next-line react/no-array-index-key
            <Fragment key={`run:${index}`}>{rendered}</Fragment>
          );
        })}
      </SelectContent>
    </Select>
  );
};
