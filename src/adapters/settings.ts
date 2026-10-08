import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type EpubExportPlugin from "../main";
import { BooxDropClient } from "../core/delivery/booxdrop";
import { obsidianHttp } from "./http";

import {
  coerceBacklinkPosition,
  coerceTocHeadingDepth,
  coerceEmbedThaiFont,
  coerceGrayscaleImages,
  coerceImageMaxWidth,
  coerceMobileOutputFolder,
  coerceOptimizeImages,
  IMAGE_WIDTH_STEP,
  MAX_IMAGE_MAX_WIDTH,
  MIN_IMAGE_MAX_WIDTH,
} from "../core/delivery/settings-core";

export type { BacklinkPosition, EpubExportSettings } from "../core/delivery/settings-core";
export {
  DEFAULT_SETTINGS,
  coerceBacklinkPosition,
  coerceTocHeadingDepth,
  coerceMobileOutputFolder,
  DEFAULT_MOBILE_OUTPUT_FOLDER,
  resolveOutputPath,
  summarizeWarnings,
} from "../core/delivery/settings-core";

// Single source for the dropdown's choices so display() and
// getSettingDefinitions() can never drift on labels or allowed values.
const BACKLINK_POSITION_OPTIONS: Record<string, string> = {
  start: "Start of chapter",
  end: "End of chapter",
  both: "Both",
  none: "None (no backlink list)",
};

// Dropdown values are strings, hence the string keys for 0-6.
const TOC_DEPTH_OPTIONS: Record<string, string> = {
  "0": "Off — flat TOC",
  "1": "Level 1",
  "2": "Level 2",
  "3": "Level 3",
  "4": "Level 4",
  "5": "Level 5",
  "6": "Level 6",
};

interface SettingText {
  name: string;
  desc?: string;
}

// Single source for each setting's label and description so display() and
// getSettingDefinitions() can never drift on wording — the same rule
// BACKLINK_POSITION_OPTIONS follows for the dropdown's values.
const SETTING_TEXT = {
  outputFolder: {
    name: "Output folder",
    desc: "Absolute path or ~/…; empty = ~/Downloads. Existing .epub files are overwritten.",
  },
  mobileOutputFolder: {
    name: "Output folder (mobile)",
    desc: "Folder inside the vault where mobile saves books; empty = Exports. Mobile has no access outside the vault.",
  },
  linkDepth: {
    name: "Default link depth",
    desc: "How far 'note + linked notes' follows wikilinks (1–3).",
  },
  backlinkPosition: {
    name: "Backlink listing position",
    desc: 'Where each chapter shows the "Linked from:" list of chapters that link to it.',
  },
  tocHeadingDepth: {
    name: "TOC heading depth",
    desc: "Deepest heading level listed under each chapter in the book's table of contents. Off restores the flat chapter-only TOC.",
  },
  embedThaiFont: {
    name: "Embed Thai font",
    desc: "Books whose chapters contain Thai text get Noto Sans Thai embedded (with its OFL license). Off keeps books fontless even when Thai is present.",
  },
  optimizeImages: {
    name: "Optimize images for e-ink",
    desc: "Shrinks PNG and JPEG images wider than the width below so books are smaller and faster to send and open. SVG, GIF and WebP are never changed. Off keeps every image exactly as it is in your vault.",
  },
  imageMaxWidth: {
    name: "Image width (px)",
    desc: "The widest an image may be in the book, from 600 to 3000 pixels (1200 by default). Images already this narrow are left alone.",
  },
  grayscaleImages: {
    name: "Convert images to grayscale",
    desc: "For black-and-white e-ink screens: smaller files, no color. Leave off for a color e-ink device. Only changes images that are shrunk, and only while image optimization is on.",
  },
  language: {
    name: "Language (dc:language)",
  },
  fallbackAuthor: {
    name: "Fallback author",
    desc: "Used when a note/folder has no author frontmatter.",
  },
  booxUrl: {
    name: "Device URL",
    desc: "Shown on the Boox in the BooxDrop app, e.g. http://192.168.1.42:8085",
  },
  pushAfterExport: {
    name: "Push after export",
  },
} as const satisfies Record<string, SettingText>;

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
        ...SETTING_TEXT.outputFolder,
        control: { type: "text", key: "outputFolder" },
      },
      {
        // 008-mobile-support: shown on BOTH platforms, each labeled for the
        // platform it governs. Hiding the inactive one would leave a user
        // unable to explain where their other device's books went.
        ...SETTING_TEXT.mobileOutputFolder,
        control: { type: "text", key: "mobileOutputFolder" },
      },
      {
        ...SETTING_TEXT.linkDepth,
        control: { type: "slider", key: "linkDepth", min: 1, max: 3, step: 1 },
      },
      {
        ...SETTING_TEXT.backlinkPosition,
        control: { type: "dropdown", key: "backlinkPosition", options: BACKLINK_POSITION_OPTIONS },
      },
      {
        ...SETTING_TEXT.tocHeadingDepth,
        control: { type: "dropdown", key: "tocHeadingDepth", options: TOC_DEPTH_OPTIONS },
      },
      {
        ...SETTING_TEXT.embedThaiFont,
        control: { type: "toggle", key: "embedThaiFont" },
      },
      {
        ...SETTING_TEXT.optimizeImages,
        control: { type: "toggle", key: "optimizeImages" },
      },
      {
        // A slider, not a text field: the declarative path stores a control's
        // raw value, and only a slider stores a number. The export pipeline
        // coerces it again at use (coerceImageMaxWidth).
        ...SETTING_TEXT.imageMaxWidth,
        control: {
          type: "slider",
          key: "imageMaxWidth",
          min: MIN_IMAGE_MAX_WIDTH,
          max: MAX_IMAGE_MAX_WIDTH,
          step: IMAGE_WIDTH_STEP,
        },
      },
      {
        ...SETTING_TEXT.grayscaleImages,
        control: { type: "toggle", key: "grayscaleImages" },
      },
      {
        ...SETTING_TEXT.language,
        control: { type: "text", key: "language" },
      },
      {
        ...SETTING_TEXT.fallbackAuthor,
        control: { type: "text", key: "fallbackAuthor" },
      },
      {
        type: "group",
        heading: "BooxDrop",
        items: [
          {
            ...SETTING_TEXT.booxUrl,
            control: { type: "text", key: "booxUrl" },
          },
          {
            ...SETTING_TEXT.pushAfterExport,
            control: { type: "toggle", key: "pushAfterExport" },
          },
          {
            name: "Test connection",
            // Returns void rather than a promise: the plugin review flags
            // Promise-returning functions where the SettingDefinitionAction
            // type declares void. The work still happens — testBooxConnection
            // is fired and awaited internally.
            action: (): void => {
              void this.testBooxConnection();
            },
          },
        ],
      },
    ];
  }

  // display()'s field builders. Each wires the same shape — label, optional
  // description, control, and a save after every change — so a setting is one
  // call and its wording lives only in SETTING_TEXT.
  private baseSetting(containerEl: HTMLElement, field: SettingText): Setting {
    const setting = new Setting(containerEl).setName(field.name);
    if (field.desc) setting.setDesc(field.desc);
    return setting;
  }

  private addTextField(
    containerEl: HTMLElement,
    field: SettingText,
    value: string,
    onInput: (value: string) => void,
    placeholder?: string
  ): void {
    this.baseSetting(containerEl, field).addText((t) => {
      if (placeholder) t.setPlaceholder(placeholder);
      t.setValue(value).onChange((v) => {
        onInput(v);
        void this.plugin.saveSettings();
      });
    });
  }

  private addToggleField(
    containerEl: HTMLElement,
    field: SettingText,
    value: boolean,
    onInput: (value: boolean) => void
  ): void {
    this.baseSetting(containerEl, field).addToggle((t) =>
      t.setValue(value).onChange((v) => {
        onInput(v);
        void this.plugin.saveSettings();
      })
    );
  }

  private addSliderField(
    containerEl: HTMLElement,
    field: SettingText,
    value: number,
    limits: { min: number; max: number; step: number },
    onInput: (value: number) => void
  ): void {
    this.baseSetting(containerEl, field).addSlider((sl) =>
      sl
        .setLimits(limits.min, limits.max, limits.step)
        .setValue(value)
        .onChange((v) => {
          onInput(v);
          void this.plugin.saveSettings();
        })
    );
  }

  private addDropdownField(
    containerEl: HTMLElement,
    field: SettingText,
    value: string,
    options: Record<string, string>,
    onInput: (value: string) => void
  ): void {
    this.baseSetting(containerEl, field).addDropdown((d) =>
      d
        .addOptions(options)
        .setValue(value)
        .onChange((v) => {
          onInput(v);
          void this.plugin.saveSettings();
        })
    );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    this.addTextField(containerEl, SETTING_TEXT.outputFolder, s.outputFolder, (v) => {
      s.outputFolder = v;
    });

    this.addTextField(containerEl, SETTING_TEXT.mobileOutputFolder, s.mobileOutputFolder, (v) => {
      // Coerced on the way in, not just on load: the value is handed to the
      // vault adapter, so a typo like "../" must never reach a write.
      s.mobileOutputFolder = coerceMobileOutputFolder(v);
    });

    this.addSliderField(
      containerEl,
      SETTING_TEXT.linkDepth,
      s.linkDepth,
      { min: 1, max: 3, step: 1 },
      (v) => {
        s.linkDepth = v;
      }
    );

    this.addDropdownField(
      containerEl,
      SETTING_TEXT.backlinkPosition,
      s.backlinkPosition,
      BACKLINK_POSITION_OPTIONS,
      (v) => {
        s.backlinkPosition = coerceBacklinkPosition(v);
      }
    );

    this.addDropdownField(
      containerEl,
      SETTING_TEXT.tocHeadingDepth,
      String(s.tocHeadingDepth),
      TOC_DEPTH_OPTIONS,
      (v) => {
        s.tocHeadingDepth = coerceTocHeadingDepth(Number(v));
      }
    );

    // 006-thai-font FR-009: default ON — books containing Thai get Noto
    // Sans Thai (SIL OFL 1.1) embedded so e-ink renders it consistently.
    this.addToggleField(containerEl, SETTING_TEXT.embedThaiFont, s.embedThaiFont, (v) => {
      s.embedThaiFont = coerceEmbedThaiFont(v);
    });

    // 013-eink-image-optimization: shown through the coercers so a hand-edited
    // data.json cannot break the tab; the export pipeline coerces again at use.
    this.addToggleField(
      containerEl,
      SETTING_TEXT.optimizeImages,
      coerceOptimizeImages(s.optimizeImages),
      (v) => {
        s.optimizeImages = coerceOptimizeImages(v);
      }
    );

    this.addSliderField(
      containerEl,
      SETTING_TEXT.imageMaxWidth,
      coerceImageMaxWidth(s.imageMaxWidth),
      { min: MIN_IMAGE_MAX_WIDTH, max: MAX_IMAGE_MAX_WIDTH, step: IMAGE_WIDTH_STEP },
      (v) => {
        s.imageMaxWidth = coerceImageMaxWidth(v);
      }
    );

    this.addToggleField(
      containerEl,
      SETTING_TEXT.grayscaleImages,
      coerceGrayscaleImages(s.grayscaleImages),
      (v) => {
        s.grayscaleImages = coerceGrayscaleImages(v);
      }
    );

    this.addTextField(containerEl, SETTING_TEXT.language, s.language, (v) => {
      s.language = v || "th";
    });

    this.addTextField(containerEl, SETTING_TEXT.fallbackAuthor, s.fallbackAuthor, (v) => {
      s.fallbackAuthor = v;
    });

    new Setting(containerEl).setName("BooxDrop").setHeading();

    this.addTextField(
      containerEl,
      SETTING_TEXT.booxUrl,
      s.booxUrl,
      (v) => {
        s.booxUrl = v.trim();
      },
      "http://192.168.1.42:8085"
    );

    this.addToggleField(containerEl, SETTING_TEXT.pushAfterExport, s.pushAfterExport, (v) => {
      s.pushAfterExport = v;
    });

    new Setting(containerEl)
      .setName("Test connection")
      .addButton((b) => b.setButtonText("Test").onClick(() => this.testBooxConnection()));
  }
}
