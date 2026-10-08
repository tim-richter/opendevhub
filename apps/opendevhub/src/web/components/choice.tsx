import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface ChoiceOption {
  value: string;
  label: string;
  title?: string;
}

// Radix Select reserves "" for "no value", but our selects use "" as a real option ("default").
const EMPTY = "\u0000";

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
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value === "" ? EMPTY : o.value}
            title={o.title}
          >
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
