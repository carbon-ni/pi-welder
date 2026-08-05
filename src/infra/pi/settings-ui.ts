import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";

import type { WelderContext } from "./contracts.ts";
import type { WelderSettingItem } from "../../welder-settings.ts";

/**
 * Open the /welder-settings toggle list. All pi-tui coupling lives here.
 * `onChange` fires per toggle; the caller owns persistence and runtime effects.
 */
export async function openWelderSettings(
  ctx: WelderContext,
  items: WelderSettingItem[],
  onChange: (id: string, value: string) => void,
): Promise<void> {
  const custom = ctx.ui.custom;
  if (!custom) return;

  await custom<undefined>((_tui, _theme, _kb, done) => {
    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, newValue) => {
        list.updateValue(id, newValue);
        onChange(id, newValue);
      },
      () => done(undefined),
      { enableSearch: true },
    );
    return list;
  });
}
