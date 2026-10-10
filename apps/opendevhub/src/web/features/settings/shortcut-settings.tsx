import { Kbd, KbdGroup } from "@/components/ui/kbd";

import { isMac, keyLabel, SHORTCUT_GROUPS } from "../../shell/shortcuts";
import type { ShortcutKey } from "../../shell/shortcuts";
import { SettingsBlock, SettingsHeader, SettingsList } from "./settings-layout";

const Keys = ({ keys, mac }: { keys: ShortcutKey[]; mac: boolean }) => (
  <KbdGroup>
    {keys.map((key) => (
      <Kbd key={key} className="min-w-6">
        {keyLabel(key, mac)}
      </Kbd>
    ))}
  </KbdGroup>
);

export const ShortcutSettings = () => {
  const mac = isMac();
  return (
    <>
      <SettingsHeader
        title="Shortcuts"
        description="Keyboard shortcuts that work across opendevhub. Single-key shortcuts are ignored while you type in a field."
      />
      {SHORTCUT_GROUPS.map((group) => (
        <SettingsBlock key={group.title} title={group.title} hint={group.hint}>
          <SettingsList>
            {group.shortcuts.map((s) => (
              <li
                key={s.label}
                className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm"
              >
                <span>{s.label}</span>
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Keys keys={s.keys} mac={mac} />
                  {s.alt && (
                    <>
                      <span>/</span>
                      <Keys keys={s.alt} mac={mac} />
                    </>
                  )}
                </span>
              </li>
            ))}
          </SettingsList>
        </SettingsBlock>
      ))}
    </>
  );
};
