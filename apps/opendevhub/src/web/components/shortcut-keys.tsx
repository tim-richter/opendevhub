import { Kbd, KbdGroup } from "@opendevhub/ui/kbd";
import { formatForDisplay } from "@tanstack/react-hotkeys";
import type { HotkeyChord } from "@tanstack/react-hotkeys";

import type { ShortcutId } from "../shell/shortcuts";
import { useBinding } from "../shell/use-shortcut";

/** A hotkey as keycaps, one per key: ⌘ K on a Mac, Ctrl K elsewhere. */
export const HotkeyKeys = ({
  hotkey,
  className,
}: {
  hotkey: HotkeyChord;
  className?: string;
}) => (
  <KbdGroup>
    {formatForDisplay(hotkey, { parts: true }).map((part, i) => (
      // oxlint-disable-next-line no-array-index-key -- a hotkey's parts never reorder
      <Kbd key={i} className={className}>
        {part}
      </Kbd>
    ))}
  </KbdGroup>
);

/** The keycaps for a shortcut as the user has bound it; nothing once it is turned off. */
export const ShortcutKeys = ({
  id,
  className,
}: {
  id: ShortcutId;
  className?: string;
}) => {
  const binding = useBinding(id);
  return binding === null ? null : (
    <HotkeyKeys hotkey={binding} className={className} />
  );
};
