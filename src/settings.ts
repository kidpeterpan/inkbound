import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type EpubExportPlugin from "./main";
import { BooxDropClient } from "./booxdrop";
import { obsidianHttp } from "./http";

export type { EpubExportSettings } from "./settings-core";
export { DEFAULT_SETTINGS, resolveOutputPath, summarizeWarnings } from "./settings-core";

export class EpubExportSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: EpubExportPlugin
  ) {
    super(app, plugin);
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

    new Setting(containerEl).setName("Test connection").addButton((b) =>
      b.setButtonText("Test").onClick(async () => {
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
      })
    );
  }
}
