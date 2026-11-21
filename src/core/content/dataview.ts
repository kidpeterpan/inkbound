import { attributedTo } from "../common/error-text";

export const DATAVIEW_PLACEHOLDER_ATTR = "data-inkbound-dataview";

export type DataviewKind = "query" | "js";

export interface DataviewBlock {
  kind: DataviewKind;
  startLine: number;
  endLine: number;
  prefix: string;
  fence: string;
}

export interface DataviewProtectResult {
  md: string;
  blocks: DataviewBlock[];
}

interface SourceLine {
  text: string;
  terminator: string;
}

interface QuotedText {
  depth: number;
  prefixLength: number;
  content: string;
}

interface ListContext {
  contentColumn: number | null;
  quoteDepth: number;
}

interface OpenFence {
  fenceChar: string;
  fenceLength: number;
  quoteDepth: number;
  containerColumn: number;
  fenceColumn: number;
  startLine: number;
  prefix: string;
  opener: string;
  kind: DataviewKind | null;
  body: string[];
}

type FenceStep =
  { type: "content"; line: string } | { type: "closed"; closer: string } | { type: "container-ended" };

const QUOTE_MARKER = /^ {0,3}> ?/;
const LIST_ITEM_OPENER = /^( *)([-+*]|\d{1,9}[.)])( +|$)/;
const FENCE_OPENER = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSER = /^(`{3,}|~{3,})[ \t]*$/;
const MAX_FENCE_INDENT = 3;
const TAB_WIDTH = 4;

export function protectDataview(md: string, firstIndex = 0): DataviewProtectResult {
  const lines = splitLines(md);
  const blocks = findDataviewBlocks(lines);
  if (blocks.length === 0) return { md, blocks: [] };
  return { md: replaceBlocksWithPlaceholders(lines, blocks, firstIndex), blocks };
}

export function dataviewPlaceholder(index: number): string {
  return `<span ${DATAVIEW_PLACEHOLDER_ATTR}="${index}"></span>`;
}

function splitLines(md: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < md.length) {
    const newline = md.indexOf("\n", start);
    const end = newline === -1 ? md.length : newline + 1;
    const raw = md.slice(start, end);
    const terminator = /\r?\n$/.exec(raw)?.[0] ?? "";
    lines.push({ text: raw.slice(0, raw.length - terminator.length), terminator });
    start = end;
  }
  return lines;
}

function findDataviewBlocks(lines: SourceLine[]): DataviewBlock[] {
  const blocks: DataviewBlock[] = [];
  const listContext: ListContext = { contentColumn: null, quoteDepth: 0 };
  let openFence: OpenFence | null = null;
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const text = lines[lineIndex].text;
    if (openFence === null) {
      openFence = openFenceAt(text, lineIndex, listContext);
      lineIndex++;
      continue;
    }

    const step = continueFence(openFence, text);
    if (step.type === "content") {
      openFence.body.push(step.line);
      lineIndex++;
      continue;
    }
    if (step.type === "closed") {
      recordIfDataview(blocks, openFence, lineIndex, step.closer);
      openFence = null;
      lineIndex++;
      continue;
    }
    recordIfDataview(blocks, openFence, lineIndex - 1, null);
    openFence = null;
  }

  if (openFence !== null) recordIfDataview(blocks, openFence, lines.length - 1, null);
  return blocks;
}

function openFenceAt(text: string, lineIndex: number, listContext: ListContext): OpenFence | null {
  const quoted = stripQuoteMarkers(text, Number.POSITIVE_INFINITY);
  if (quoted.depth !== listContext.quoteDepth) listContext.contentColumn = null;
  if (quoted.content.trim() === "") return null;

  const fenceStart = trackListAndLocateFenceStart(quoted, listContext);
  if (fenceStart === null) return null;

  const candidate = quoted.content.slice(fenceStart);
  const match = FENCE_OPENER.exec(candidate);
  if (!match) return null;

  const [, fenceRun, info] = match;
  const fenceChar = fenceRun[0];
  if (fenceChar === "`" && info.includes("`")) return null;

  return {
    fenceChar,
    fenceLength: fenceRun.length,
    quoteDepth: quoted.depth,
    containerColumn: listContext.contentColumn ?? 0,
    fenceColumn: indentationWidth(quoted.content.slice(0, fenceStart)),
    startLine: lineIndex,
    prefix: text.slice(0, quoted.prefixLength + fenceStart),
    opener: candidate.trimEnd(),
    kind: dataviewKindOf(info),
    body: [],
  };
}

function trackListAndLocateFenceStart(quoted: QuotedText, listContext: ListContext): number | null {
  const listItem = LIST_ITEM_OPENER.exec(quoted.content);
  if (listItem) {
    listContext.contentColumn = listItemContentColumn(listItem);
    listContext.quoteDepth = quoted.depth;
    return listItem[0].length;
  }

  const indentation = leadingWhitespace(quoted.content);
  const indentWidth = indentationWidth(indentation);
  if (listContext.contentColumn !== null && indentWidth < listContext.contentColumn) {
    listContext.contentColumn = null;
  }
  const containerColumn = listContext.contentColumn ?? 0;
  if (indentWidth - containerColumn > MAX_FENCE_INDENT) return null;
  return indentation.length;
}

function listItemContentColumn(listItem: RegExpExecArray): number {
  const [, indent, marker, spacing] = listItem;
  const spacingIsIndentedCode = spacing.length > TAB_WIDTH;
  const effectiveSpacing = spacing === "" || spacingIsIndentedCode ? 1 : spacing.length;
  return indent.length + marker.length + effectiveSpacing;
}

function continueFence(openFence: OpenFence, text: string): FenceStep {
  const quoted = stripQuoteMarkers(text, openFence.quoteDepth);
  if (quoted.depth < openFence.quoteDepth) return { type: "container-ended" };

  const content = quoted.content;
  const isBlank = content.trim() === "";
  const indentWidth = indentationWidth(leadingWhitespace(content));
  if (!isBlank && indentWidth < openFence.containerColumn) return { type: "container-ended" };

  if (closesFence(openFence, content, indentWidth)) return { type: "closed", closer: content.trim() };
  return { type: "content", line: removeIndentation(content, openFence.fenceColumn) };
}

function closesFence(openFence: OpenFence, content: string, indentWidth: number): boolean {
  if (indentWidth - openFence.containerColumn > MAX_FENCE_INDENT) return false;
  const closer = FENCE_CLOSER.exec(content.trimStart());
  if (!closer) return false;
  const closerRun = closer[1];
  return closerRun[0] === openFence.fenceChar && closerRun.length >= openFence.fenceLength;
}

function recordIfDataview(
  blocks: DataviewBlock[],
  openFence: OpenFence,
  endLine: number,
  closer: string | null
): void {
  if (openFence.kind === null) return;
  const closingFence = closer ?? openFence.fenceChar.repeat(openFence.fenceLength);
  blocks.push({
    kind: openFence.kind,
    startLine: openFence.startLine,
    endLine,
    prefix: openFence.prefix,
    fence: [openFence.opener, ...openFence.body, closingFence].join("\n"),
  });
}

function dataviewKindOf(info: string): DataviewKind | null {
  const language = info.trim().split(/\s+/)[0];
  if (language === "dataview") return "query";
  if (language === "dataviewjs") return "js";
  return null;
}

function stripQuoteMarkers(text: string, maxDepth: number): QuotedText {
  let depth = 0;
  let prefixLength = 0;
  while (depth < maxDepth) {
    const marker = QUOTE_MARKER.exec(text.slice(prefixLength));
    if (!marker) break;
    prefixLength += marker[0].length;
    depth++;
  }
  return { depth, prefixLength, content: text.slice(prefixLength) };
}

function leadingWhitespace(text: string): string {
  return /^[ \t]*/.exec(text)?.[0] ?? "";
}

function indentationWidth(whitespace: string): number {
  let columns = 0;
  for (const character of whitespace) {
    columns = character === "\t" ? columns + TAB_WIDTH - (columns % TAB_WIDTH) : columns + 1;
  }
  return columns;
}

function removeIndentation(text: string, columnsToRemove: number): string {
  let columns = 0;
  let index = 0;
  while (index < text.length && columns < columnsToRemove) {
    const character = text[index];
    if (character !== " " && character !== "\t") break;
    columns = character === "\t" ? columns + TAB_WIDTH - (columns % TAB_WIDTH) : columns + 1;
    index++;
  }
  return text.slice(index);
}

function replaceBlocksWithPlaceholders(
  lines: SourceLine[],
  blocks: DataviewBlock[],
  firstIndex: number
): string {
  let output = "";
  let nextLine = 0;
  blocks.forEach((block, index) => {
    output += joinLines(lines.slice(nextLine, block.startLine));
    output += block.prefix + dataviewPlaceholder(firstIndex + index) + lines[block.endLine].terminator;
    nextLine = block.endLine + 1;
  });
  return output + joinLines(lines.slice(nextLine));
}

function joinLines(lines: SourceLine[]): string {
  return lines.map((line) => line.text + line.terminator).join("");
}

export interface SinkBlock {
  index: number;
  kind: DataviewKind;
  notePath: string;
  fence: string;
}

const MARKER_TEXT: Record<DataviewKind, string> = {
  query: "[Dataview query omitted]",
  js: "[DataviewJS omitted]",
};

const WARNING_SUBJECT: Record<DataviewKind, string> = {
  query: "Dataview query",
  js: "DataviewJS",
};

const OMISSION_REASON: Record<DataviewKind, string> = {
  query: "Dataview results are not exported",
  js: "Inkbound never runs DataviewJS",
};

const LOST_PLACEHOLDER_REASON = "it could not be rendered — placeholder lost";

export function resolveDataviewPlaceholders(root: HTMLElement, blocks: readonly SinkBlock[]): string[] {
  return blocks.map((block) => {
    const placeholder = root.querySelector(`[${DATAVIEW_PLACEHOLDER_ATTR}="${block.index}"]`);
    if (placeholder === null) return omissionWarning(block, LOST_PLACEHOLDER_REASON);
    placeBlockAt(placeholder, createOmissionMarker(block.kind));
    return omissionWarning(block, OMISSION_REASON[block.kind]);
  });
}

function omissionWarning(block: SinkBlock, reason: string): string {
  return attributedTo(block.notePath)(`${WARNING_SUBJECT[block.kind]} omitted: ${reason}`);
}

function createOmissionMarker(kind: DataviewKind): HTMLElement {
  const marker = createEl("p");
  marker.className = "omitted";
  marker.textContent = MARKER_TEXT[kind];
  return marker;
}

function placeBlockAt(placeholder: Element, block: HTMLElement): void {
  const parent = placeholder.parentElement;
  if (parent === null || parent.tagName !== "P") {
    placeholder.replaceWith(block);
    return;
  }
  if (holdsOnly(parent, placeholder)) {
    parent.replaceWith(block);
    return;
  }
  placeholder.remove();
  parent.after(block);
}

function holdsOnly(paragraph: Element, placeholder: Element): boolean {
  return Array.from(paragraph.childNodes).every(
    (child) =>
      child === placeholder || (child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() === "")
  );
}
