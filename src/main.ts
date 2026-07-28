import { Plugin } from "obsidian";

export default class EpubExportPlugin extends Plugin {
  async onload() {
    console.log("epub-export loaded");
  }
}
