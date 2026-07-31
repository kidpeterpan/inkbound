import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type EpubExportPlugin from "./main";
import { BooxDropClient } from "./booxdrop";
import { obsidianHttp } from "./http";

import { coerceBacklinkPosition } from "./settings-core";

export type { BacklinkPosition, EpubExportSettings } from "./settings-core";
export {
  DEFAULT_SETTINGS,
  coerceBacklinkPosition,
  resolveOutputPath,
  summarizeWarnings,
} from "./settings-core";

// Single source for the dropdown's choices so display() and
// getSettingDefinitions() can never drift on labels or allowed values.
const BACKLINK_POSITION_OPTIONS: Record<string, string> = {
  start: "Start of chapter",
  end: "End of chapter",
  both: "Both",
  none: "None (no backlink list)",
};

export class EpubExportSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: EpubExportPlugin
  ) {
    super(app, plugin);
  }

  // Shared by display()'s "Test" button and getSettingDefinitions()'s "Test
  // connection" action so the two rendering paths (imperative and
  // declarative) can never drift on what testing the connection actually
  // does.
  private async testBooxConnection(): Promise<void> {
    const s = this.plugin.settings;
    if (!s.booxUrl) {
      new Notice("Set the device URL first.");
      return;
    }
    const ok = await new BooxDropClient(s.booxUrl, obsidianHttp).testConnection();
    new Notice(
      ok
        ? "BooxDrop reachable ✓"
        : "BooxDrop NOT reachable — check Wi-Fi, IP, and that BooxDrop is open on the device."
    );
  }

  // Declarative counterpart to display(), read by Obsidian 1.13+ to index
  // this plugin's settings for the global settings search. Older Obsidian
  // (down to minAppVersion 1.5.0) never calls this and keeps using display()
  // as-is; 1.13+ renders from these definitions instead (display() is then
  // only a fallback, per SettingTab.display()'s own doc comment) but the
  // default getControlValue/setControlValue (PluginSettingTab reads/writes
  // `this.plugin.settings[key]`) means the `key` of every control below must
  // — and does — match an EpubExportSettings field name exactly, so the two
  // paths can't drift on where a value lives.
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Output folder",
        desc: "Absolute path or ~/…; empty = ~/Downloads. Existing .epub files are overwritten.",
        control: { type: "text", key: "outputFolder" },
      },
      {
        name: "Default link depth",
        desc: "How far 'note + linked notes' follows wikilinks (1–3).",
        control: { type: "slider", key: "linkDepth", min: 1, max: 3, step: 1 },
      },
      {
        name: "Backlink listing position",
        desc: 'Where each chapter shows the "Linked from:" list of chapters that link to it.',
        control: { type: "dropdown", key: "backlinkPosition", options: BACKLINK_POSITION_OPTIONS },
      },
      {
        name: "Language (dc:language)",
        control: { type: "text", key: "language" },
      },
      {
        name: "Fallback author",
        desc: "Used when a note/folder has no author frontmatter.",
        control: { type: "text", key: "fallbackAuthor" },
      },
      {
        type: "group",
        heading: "BooxDrop",
        items: [
          {
            name: "Device URL",
            desc: "Shown on the Boox in the BooxDrop app, e.g. http://192.168.1.42:8085",
            control: { type: "text", key: "booxUrl" },
          },
          {
            name: "Push after export",
            control: { type: "toggle", key: "pushAfterExport" },
          },
          {
            name: "Test connection",
            // Declared `void`-returning per SettingDefinitionAction, but this
            // is an async function — TypeScript allows a Promise-returning
            // function where `void` is expected, and returning the real
            // promise (rather than fire-and-forget `void this.testBooxConnection()`)
            // lets callers (and tests) `await` it deterministically instead
            // of racing the Notice against whatever runs next.
            action: async (): Promise<void> => {
              await this.testBooxConnection();
            },
          },
        ],
      },
    ];
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Absolute path or ~/…; empty = ~/Downloads. Existing .epub files are overwritten.")
      .addText((t) =>
        t.setValue(s.outputFolder).onChange((v) => {
          s.outputFolder = v;
          void save();
        })
      );

    new Setting(containerEl)
      .setName("Default link depth")
      .setDesc("How far 'note + linked notes' follows wikilinks (1–3).")
      .addSlider((sl) =>
        sl
          .setLimits(1, 3, 1)
          .setValue(s.linkDepth)
          .onChange((v) => {
            s.linkDepth = v;
            void save();
          })
      );

    new Setting(containerEl)
      .setName("Backlink listing position")
      .setDesc('Where each chapter shows the "Linked from:" list of chapters that link to it.')
      .addDropdown((d) =>
        d
          .addOptions(BACKLINK_POSITION_OPTIONS)
          .setValue(s.backlinkPosition)
          .onChange((v) => {
            s.backlinkPosition = coerceBacklinkPosition(v);
            void save();
          })
      );

    new Setting(containerEl).setName("Language (dc:language)").addText((t) =>
      t.setValue(s.language).onChange((v) => {
        s.language = v || "th";
        void save();
      })
    );

    new Setting(containerEl)
      .setName("Fallback author")
      .setDesc("Used when a note/folder has no author frontmatter.")
      .addText((t) =>
        t.setValue(s.fallbackAuthor).onChange((v) => {
          s.fallbackAuthor = v;
          void save();
        })
      );

    new Setting(containerEl).setName("BooxDrop").setHeading();

    new Setting(containerEl)
      .setName("Device URL")
      .setDesc("Shown on the Boox in the BooxDrop app, e.g. http://192.168.1.42:8085")
      .addText((t) =>
        t
          .setPlaceholder("http://192.168.1.42:8085")
          .setValue(s.booxUrl)
          .onChange((v) => {
            s.booxUrl = v.trim();
            void save();
          })
      );

    new Setting(containerEl).setName("Push after export").addToggle((tg) =>
      tg.setValue(s.pushAfterExport).onChange((v) => {
        s.pushAfterExport = v;
        void save();
      })
    );

    new Setting(containerEl)
      .setName("Test connection")
      .addButton((b) => b.setButtonText("Test").onClick(() => this.testBooxConnection()));
  }
}
