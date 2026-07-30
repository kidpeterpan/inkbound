import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type {
  SettingDefinitionItem,
  SettingDefinitionGroup,
  SettingDefinitionAction,
  SettingDefinitionControl,
} from "obsidian";
import { resolveOutputPath, summarizeWarnings, DEFAULT_SETTINGS } from "../src/settings-core";
import { EpubExportSettingTab } from "../src/settings";
import EpubExportPlugin from "../src/main";
import {
  NOTICES,
  SETTINGS,
  type ChainableControl,
  setRequestUrlImpl,
  resetRequestUrlImpl,
} from "./fixtures/obsidian-stub";

// Flattens getSettingDefinitions()'s nested groups into a single ordered list
// of leaf items (control-bearing definitions and actions), the same order a
// declarative-search index would see them in.
function flattenDefinitions(
  defs: SettingDefinitionItem[]
): (SettingDefinitionControl | SettingDefinitionAction)[] {
  const out: (SettingDefinitionControl | SettingDefinitionAction)[] = [];
  for (const def of defs) {
    if ("items" in def && Array.isArray((def as SettingDefinitionGroup).items)) {
      out.push(...flattenDefinitions((def as SettingDefinitionGroup).items ?? []));
    } else if ("control" in def && def.control) {
      out.push(def as SettingDefinitionControl);
    } else if ("action" in def && typeof def.action === "function") {
      out.push(def as SettingDefinitionAction);
    }
  }
  return out;
}

describe("resolveOutputPath", () => {
  it("expands empty folder to ~/Downloads", () => {
    expect(resolveOutputPath("", "my_book", "/Users/pan")).toBe("/Users/pan/Downloads/my_book.epub");
  });
  it("expands leading tilde", () => {
    expect(resolveOutputPath("~/books", "x", "/Users/pan")).toBe("/Users/pan/books/x.epub");
  });
  it("keeps absolute paths", () => {
    expect(resolveOutputPath("/tmp/out", "x", "/Users/pan")).toBe("/tmp/out/x.epub");
  });
});

describe("summarizeWarnings", () => {
  it("is null when there are no warnings", () => {
    expect(summarizeWarnings([])).toBeNull();
  });
  it("counts warnings and points at the console", () => {
    expect(summarizeWarnings(["a", "b"])).toBe("Exported with 2 warnings — details in developer console.");
  });
  it("uses singular 'warning' wording for exactly one warning", () => {
    expect(summarizeWarnings(["a"])).toBe("Exported with 1 warning — details in developer console.");
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("matches the spec defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      outputFolder: "",
      linkDepth: 1,
      language: "th",
      fallbackAuthor: "",
      booxUrl: "",
      pushAfterExport: false,
    });
  });
});

// ── EpubExportSettingTab ─────────────────────────────────────────────────
//
// `app` is never touched by display() itself (containerEl comes from
// PluginSettingTab; the only thing display() reads off `this.plugin` is
// `.settings` and `.saveSettings()`), so a real vault-stub App isn't needed
// here — `{} as never` mirrors the cast-through-`never` pattern main.test.ts
// uses for the same "stub is nominally incompatible with the real .d.ts"
// reason.

describe("EpubExportSettingTab", () => {
  let saveCalls: number;

  function makeTab(overrides: Partial<typeof DEFAULT_SETTINGS> = {}) {
    const plugin = new EpubExportPlugin({} as never, {} as never);
    plugin.settings = { ...DEFAULT_SETTINGS, ...overrides };
    plugin.saveSettings = async () => {
      saveCalls++;
    };
    const tab = new EpubExportSettingTab({} as never, plugin);
    tab.display();
    return { plugin, tab };
  }

  function controlFor(name: string): ChainableControl {
    const setting = SETTINGS.find((s) => s.nameEl.textContent === name);
    if (!setting?.control) throw new Error(`no control registered for setting "${name}"`);
    return setting.control;
  }

  beforeEach(() => {
    NOTICES.length = 0;
    SETTINGS.length = 0;
    saveCalls = 0;
  });

  afterEach(() => {
    resetRequestUrlImpl();
  });

  it("case 1: renders a setting for each of the six fields plus the BooxDrop heading and Test-connection button", () => {
    makeTab();
    expect(SETTINGS.map((s) => s.nameEl.textContent)).toEqual([
      "Output folder",
      "Default link depth",
      "Language (dc:language)",
      "Fallback author",
      "BooxDrop",
      "Device URL",
      "Push after export",
      "Test connection",
    ]);
  });

  it("case 1b: the BooxDrop section header is rendered as a heading via setHeading()", () => {
    makeTab();
    const heading = SETTINGS.find((s) => s.nameEl.textContent === "BooxDrop");
    expect(heading?.isHeading).toBe(true);
  });

  it("case 2a: changing the output folder writes settings and saves", () => {
    const { plugin } = makeTab();
    controlFor("Output folder").onChangeFn?.("~/exports");
    expect(plugin.settings.outputFolder).toBe("~/exports");
    expect(saveCalls).toBe(1);
  });

  it("case 2b: changing the fallback author writes settings and saves", () => {
    const { plugin } = makeTab();
    controlFor("Fallback author").onChangeFn?.("Jane Doe");
    expect(plugin.settings.fallbackAuthor).toBe("Jane Doe");
    expect(saveCalls).toBe(1);
  });

  it("case 2c: changing the language to a non-empty value writes settings and saves", () => {
    const { plugin } = makeTab();
    controlFor("Language (dc:language)").onChangeFn?.("en");
    expect(plugin.settings.language).toBe("en");
    expect(saveCalls).toBe(1);
  });

  it("case 3: clearing the language field falls back to 'th'", () => {
    const { plugin } = makeTab({ language: "en" });
    controlFor("Language (dc:language)").onChangeFn?.("");
    expect(plugin.settings.language).toBe("th");
    expect(saveCalls).toBe(1);
  });

  it("case 4: the Boox URL is trimmed before being stored, and saves", () => {
    const { plugin } = makeTab();
    controlFor("Device URL").onChangeFn?.("  http://192.168.1.42:8085  ");
    expect(plugin.settings.booxUrl).toBe("http://192.168.1.42:8085");
    expect(saveCalls).toBe(1);
  });

  it("case 5: the link-depth slider is limited to 1-3 and stores a number on change", () => {
    const { plugin } = makeTab();
    const control = controlFor("Default link depth");
    expect(control.limits).toEqual([1, 3, 1]);
    control.onChangeFn?.(3);
    expect(plugin.settings.linkDepth).toBe(3);
    expect(saveCalls).toBe(1);
  });

  it("case 6: the push toggle flips pushAfterExport and saves", () => {
    const { plugin } = makeTab({ pushAfterExport: false });
    controlFor("Push after export").onChangeFn?.(true);
    expect(plugin.settings.pushAfterExport).toBe(true);
    expect(saveCalls).toBe(1);
  });

  it("case 7: test connection with no device URL set shows a notice", async () => {
    makeTab({ booxUrl: "" });
    await controlFor("Test connection").onClickFn?.(new MouseEvent("click"));
    expect(NOTICES).toEqual(["Set the device URL first."]);
  });

  it("case 8: test connection reachable shows a reachable notice", async () => {
    setRequestUrlImpl(async () => ({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "",
      json: null,
    }));
    makeTab({ booxUrl: "http://192.168.1.42:8085" });
    await controlFor("Test connection").onClickFn?.(new MouseEvent("click"));
    expect(NOTICES.some((n) => n.includes("reachable") && !n.includes("NOT"))).toBe(true);
  });

  it("case 9: test connection unreachable (request throws) shows a NOT-reachable notice", async () => {
    setRequestUrlImpl(async () => {
      throw new Error("network down");
    });
    makeTab({ booxUrl: "http://192.168.1.42:8085" });
    await controlFor("Test connection").onClickFn?.(new MouseEvent("click"));
    expect(NOTICES.some((n) => n.includes("NOT reachable"))).toBe(true);
  });

  // ── getSettingDefinitions() (declarative settings-search API, Obsidian 1.13+) ──

  it("case 10: getSettingDefinitions returns one definition per setting, plus the BooxDrop group and the Test-connection action", () => {
    const { tab } = makeTab();
    const flat = flattenDefinitions(tab.getSettingDefinitions());
    expect(flat.map((d) => d.name)).toEqual([
      "Output folder",
      "Default link depth",
      "Language (dc:language)",
      "Fallback author",
      "Device URL",
      "Push after export",
      "Test connection",
    ]);
  });

  it("case 11: every control definition's key matches a DEFAULT_SETTINGS key, and the set of keys is exactly DEFAULT_SETTINGS' keys", () => {
    const { tab } = makeTab();
    const flat = flattenDefinitions(tab.getSettingDefinitions());
    const keys = flat
      .filter((d): d is SettingDefinitionControl => "control" in d && Boolean(d.control))
      .map((d) => d.control.key);
    expect(new Set(keys)).toEqual(new Set(Object.keys(DEFAULT_SETTINGS)));
  });

  it("case 12: the link-depth slider definition carries the 1-3 bounds", () => {
    const { tab } = makeTab();
    const flat = flattenDefinitions(tab.getSettingDefinitions());
    const linkDepth = flat.find((d) => d.name === "Default link depth") as SettingDefinitionControl;
    expect(linkDepth.control).toMatchObject({ type: "slider", key: "linkDepth", min: 1, max: 3, step: 1 });
  });

  it("case 13: the BooxDrop group is a declarative group headed 'BooxDrop'", () => {
    const { tab } = makeTab();
    const group = tab
      .getSettingDefinitions()
      .find((d) => "heading" in d && d.heading === "BooxDrop") as SettingDefinitionGroup;
    expect(group).toBeDefined();
    expect(group.type).toBe("group");
  });

  it("case 14: the declarative Test-connection action reaches the same code path as the display() button (reachable case)", async () => {
    setRequestUrlImpl(async () => ({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "",
      json: null,
    }));
    const { tab } = makeTab({ booxUrl: "http://192.168.1.42:8085" });
    const flat = flattenDefinitions(tab.getSettingDefinitions());
    const testAction = flat.find((d) => d.name === "Test connection") as SettingDefinitionAction;
    await testAction.action(document.createElement("div"), 0);
    expect(NOTICES.some((n) => n.includes("reachable") && !n.includes("NOT"))).toBe(true);
  });

  it("case 15: the declarative Test-connection action shows the same no-device-URL notice as the button", async () => {
    const { tab } = makeTab({ booxUrl: "" });
    const flat = flattenDefinitions(tab.getSettingDefinitions());
    const testAction = flat.find((d) => d.name === "Test connection") as SettingDefinitionAction;
    await testAction.action(document.createElement("div"), 0);
    expect(NOTICES).toEqual(["Set the device URL first."]);
  });
});
