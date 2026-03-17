import { config } from "../../package.json";
import { PDFDocument } from "pdf-lib";
import { getLocaleID, getString } from "../utils/locale";

type SplitMode = "main" | "sections";
type ScanStatus = "idle" | "scanning" | "ready" | "error";

interface ReaderSplitState {
  mode: SplitMode;
  status: ScanStatus;
  pageCount?: number;
  detectedReferencePage: number | null;
  detectedAppendixPage: number | null;
  detectedFirstBackMatterPage: number | null;
  detectedSafeTrimPage: number | null;
  referencePageInput: string;
  appendixPageInput: string;
  hasAutoScanned: boolean;
  skipAutoScan: boolean;
  generatedOutputs: GeneratedOutput[];
  message: string;
  error: string;
}

interface PreviewResult {
  outputs: SplitOutputSpec[];
  notes: string[];
  errors: string[];
  canSplit: boolean;
}

interface SplitOutputSpec {
  suffix: "main" | "reference" | "appendix";
  filename: string;
  title: string;
  startPage: number;
  endPage: number;
}

interface SplitPlan {
  outputs: SplitOutputSpec[];
  errors: string[];
}

interface GeneratedOutput {
  itemID: number;
  filename: string;
  suffix: SplitOutputSpec["suffix"];
  startPage: number;
  endPage: number;
}

interface PageSnapshot {
  fullText: string;
  topText: string;
  lines: PageLine[];
  pageStats: PageStats;
}

interface ReferenceBlock {
  startPage: number | null;
  endPage: number | null;
  startRatio: number | null;
}

interface ReferenceSignals {
  hasHeading: boolean;
  yearCount: number;
  yearTailCount: number;
  inlineCitationCount: number;
  citationHints: number;
  authorLikeCount: number;
  refLikeLineCount: number;
  refDensity: number;
  citationMetaDensity: number;
  hangingIndentScore: number;
  latePagePrior: number;
  score: number;
}

interface AppendixSignals {
  hasHeading: boolean;
  sectionPattern: boolean;
  runningHead: boolean;
  sectionKeywordHits: number;
  refPenalty: number;
  latePagePrior: number;
  score: number;
}

interface DetectResult {
  referenceStartPage: number | null;
  appendixStartPage: number | null;
  firstBackMatterPage: number | null;
  safeTrimPage: number | null;
  referenceBlock: ReferenceBlock;
}

interface PageLine {
  text: string;
  normalizedText: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

interface PageStats {
  lineCount: number;
  avgLineLength: number;
  medianFontSize: number;
  maxFontSize: number;
  columnCount: 1 | 2;
}

interface ReaderLike {
  itemID?: number;
  tabID?: string;
  _tabID?: string;
  navigate?: (options: { pageIndex: number }) => Promise<void> | void;
  _iframeWindow?: {
    wrappedJSObject?: any;
    PDFViewerApplication?: any;
  };
}

const HTML_NS = "http://www.w3.org/1999/xhtml";
const READER_SECTION_ID = "pdf-split-tool";
const ROOT_CLASS = "pdf-split-tool";
const STYLESHEET_ID = `${config.addonRef}-reader-pane-style`;
const PLUGIN_ICON_16 = `chrome://${config.addonRef}/content/icons/reader16.png`;
const PLUGIN_ICON_20 = `chrome://${config.addonRef}/content/icons/reader20.png`;
const states = new Map<number, ReaderSplitState>();

const referenceKeywords = [
  "references",
  "bibliography",
  "works cited",
  "literature cited",
];

const appendixKeywords = [
  "appendix",
  "appendices",
  "supplementary",
  "supplemental material",
];

function buildKeywordPatterns(keywords: string[]) {
  return keywords.map((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?:^|\\b)(?:\\d+[.)\\]]\\s*)?${escaped}(?:\\b|\\s)`,
      "i",
    );
  });
}

const referenceKeywordPatterns = buildKeywordPatterns(referenceKeywords);
const appendixKeywordPatterns = buildKeywordPatterns(appendixKeywords);

function defaultState(): ReaderSplitState {
  return {
    mode: "main",
    status: "idle",
    detectedReferencePage: null,
    detectedAppendixPage: null,
    detectedFirstBackMatterPage: null,
    detectedSafeTrimPage: null,
    referencePageInput: "",
    appendixPageInput: "",
    hasAutoScanned: false,
    skipAutoScan: false,
    generatedOutputs: [],
    message: getString("tool-status-idle"),
    error: "",
  };
}

function getState(item: Zotero.Item): ReaderSplitState {
  const current = states.get(item.id);
  if (current) {
    return current;
  }
  const next = defaultState();
  states.set(item.id, next);
  return next;
}

function isPDFItem(item?: Zotero.Item | null): item is Zotero.Item {
  return hasPDFContent(item);
}

function hasPDFContent(item?: Zotero.Item | null) {
  if (!item) {
    return false;
  }
  const attachmentContentType = (item as any).attachmentContentType;
  return typeof (item as any).isPDFAttachment === "function"
    ? (item as any).isPDFAttachment()
    : attachmentContentType === "application/pdf";
}

async function resolvePDFItem(item?: Zotero.Item | null) {
  if (!item) {
    return null;
  }
  const candidate = item as Zotero.Item;
  if (hasPDFContent(candidate)) {
    return candidate;
  }
  if (!candidate.isRegularItem()) {
    return null;
  }

  const bestAttachment = await candidate.getBestAttachment();
  if (bestAttachment && isPDFItem(bestAttachment)) {
    return bestAttachment;
  }

  const attachmentIDs = candidate.getAttachments(false);
  for (const attachmentID of attachmentIDs) {
    const attachment = Zotero.Items.get(attachmentID);
    if (attachment && isPDFItem(attachment)) {
      return attachment;
    }
  }

  return null;
}

function createHTML<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
) {
  return doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
}

function basename(item: Zotero.Item) {
  const filename = (item as any).attachmentFilename || item.getField("title");
  return String(filename || "document.pdf").replace(/\.pdf$/i, "");
}

function getItemFilename(item: Zotero.Item) {
  const filename = (item as any).attachmentFilename || item.getField("title");
  return String(filename || "");
}

function buildOutputFilename(base: string, suffix: SplitOutputSpec["suffix"]) {
  return `${base}-${suffix}.pdf`;
}

function getGeneratedSuffix(filename: string) {
  const match = filename.match(/-(main|reference|appendix)(?:-\d+)?\.pdf$/i);
  return (match?.[1]?.toLowerCase() as SplitOutputSpec["suffix"] | undefined) || null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGeneratedSplitPDF(item: Zotero.Item) {
  return Boolean(getGeneratedSuffix(getItemFilename(item)));
}

function getSourceStem(item: Zotero.Item) {
  const base = basename(item);
  return isGeneratedSplitPDF(item)
    ? base.replace(/-(main|reference|appendix)(?:-\d+)?$/i, "")
    : base;
}

function getGeneratedOutputMatcher(item: Zotero.Item) {
  return new RegExp(
    `^${escapeRegExp(getSourceStem(item))}-(main|reference|appendix)(?:-\\d+)?\\.pdf$`,
    "i",
  );
}

function getLeafFilename(path: string) {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

function parsePageInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return Number.NaN;
  }
  return parsed;
}

function statusLabel(status: ScanStatus) {
  switch (status) {
    case "scanning":
      return getString("tool-status-scanning");
    case "ready":
      return getString("tool-status-ready");
    case "error":
      return getString("tool-status-error");
    default:
      return getString("tool-status-idle");
  }
}

function getReaderForItem(item: Zotero.Item): ReaderLike | null {
  const selectedTabID = ztoolkit.getGlobal("Zotero_Tabs")?.selectedID;
  const selectedReader =
    selectedTabID && typeof Zotero.Reader?.getByTabID === "function"
      ? (Zotero.Reader.getByTabID(selectedTabID) as ReaderLike | undefined)
      : undefined;
  if (selectedReader?.itemID === item.id) {
    return selectedReader;
  }

  const readerByItem =
    typeof (Zotero.Reader as any)?.getByItemID === "function"
      ? ((Zotero.Reader as any).getByItemID(item.id) as ReaderLike | undefined)
      : undefined;
  if (readerByItem) {
    return readerByItem;
  }

  const readerPool = ((Zotero.Reader as any)?._readers ||
    (Zotero.Reader as any)?._instances ||
    []) as ReaderLike[];
  return readerPool.find((reader) => reader.itemID === item.id) || null;
}

async function waitForViewerApplication(reader: ReaderLike) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const iframeWindow =
      reader._iframeWindow?.wrappedJSObject || reader._iframeWindow;
    const app = iframeWindow?.PDFViewerApplication;
    if (app?.pdfLoadingTask && app?.pdfViewer) {
      await app.pdfLoadingTask.promise;
      if (app.pdfViewer.pagesPromise) {
        await app.pdfViewer.pagesPromise;
      }
      return app;
    }
    await Zotero.Promise.delay(150);
  }
  throw new Error(getString("tool-status-reader-not-ready"));
}

async function readPageTexts(item: Zotero.Item) {
  const reader = getReaderForItem(item);
  if (!reader) {
    throw new Error(getString("tool-status-open-reader"));
  }

  const app = await waitForViewerApplication(reader);
  const pdfDocument = app.pdfDocument;
  const pdfViewer = app.pdfViewer;
  const pageCount = Number(
    pdfDocument?.numPages || pdfViewer?._pages?.length || 0,
  );
  const pages: PageSnapshot[] = [];

  for (let index = 0; index < pageCount; index += 1) {
    const pageView = pdfViewer?._pages?.[index];
    const pdfPage =
      pageView?.pdfPage ||
      (pdfDocument ? await pdfDocument.getPage(index + 1) : null);
    if (!pdfPage) {
      pages.push({
        fullText: "",
        topText: "",
        lines: [],
        pageStats: {
          lineCount: 0,
          avgLineLength: 0,
          medianFontSize: 0,
          maxFontSize: 0,
          columnCount: 1,
        },
      });
      continue;
    }
    const textContent = await pdfPage.getTextContent();
    const items = (textContent?.items || [])
      .map((part: any) => ({
        text: String(part?.str || ""),
        x: Number(part?.transform?.[4] || 0),
        y: Number(part?.transform?.[5] || 0),
        width: Number(part?.width || 0),
        height: Number(part?.height || 0),
        fontSize: Math.max(
          Math.abs(Number(part?.transform?.[0] || 0)),
          Math.abs(Number(part?.transform?.[3] || 0)),
          Number(part?.height || 0),
          1,
        ),
      }))
      .filter((part: { text: string }) => part.text.trim().length > 0);

    const lines = buildPageLines(items);
    const fullText = normalizeText(lines.map((part) => part.text).join(" "));
    const topText = extractTopText(lines);
    pages.push({
      fullText,
      topText,
      lines,
      pageStats: buildPageStats(lines),
    });
  }

  return {
    pageCount,
    pages,
  };
}

function normalizeText(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function compactText(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function averageNumber(values: number[]) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function medianNumber(values: number[]) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function bucketNumber(value: number, size: number) {
  return Math.round(value / size) * size;
}

function buildPageLines(
  items: Array<{
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fontSize: number;
  }>,
) {
  const rows: Array<{
    y: number;
    items: typeof items;
  }> = [];
  const sortedItems = [...items].sort((left, right) => {
    if (Math.abs(right.y - left.y) > 1.5) {
      return right.y - left.y;
    }
    return left.x - right.x;
  });

  for (const item of sortedItems) {
    const tolerance = Math.max(2, Math.min(6, item.fontSize * 0.35));
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (row) {
      row.items.push(item);
      row.y = averageNumber(row.items.map((part) => part.y));
    } else {
      rows.push({
        y: item.y,
        items: [item],
      });
    }
  }

  const lines: PageLine[] = [];
  for (const row of rows.sort((left, right) => right.y - left.y)) {
    const rowItems = [...row.items].sort((left, right) => left.x - right.x);
    let segment: typeof rowItems = [];

    const flushSegment = () => {
      if (!segment.length) {
        return;
      }
      const text = segment
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) {
        segment = [];
        return;
      }
      lines.push({
        text,
        normalizedText: normalizeText(text),
        x: Math.min(...segment.map((part) => part.x)),
        y: averageNumber(segment.map((part) => part.y)),
        width: segment.reduce((sum, part) => sum + part.width, 0),
        height: Math.max(...segment.map((part) => Math.max(part.height, part.fontSize))),
        fontSize: medianNumber(segment.map((part) => part.fontSize)),
      });
      segment = [];
    };

    for (const item of rowItems) {
      if (!segment.length) {
        segment.push(item);
        continue;
      }
      const previous = segment[segment.length - 1];
      const gap = item.x - (previous.x + previous.width);
      const splitThreshold = Math.max(28, previous.fontSize * 2.2);
      if (gap > splitThreshold) {
        flushSegment();
      }
      segment.push(item);
    }
    flushSegment();
  }

  return lines;
}

function estimateColumnCount(lines: PageLine[]): 1 | 2 {
  const longLines = lines.filter((line) => line.text.length >= 24);
  if (longLines.length < 8) {
    return 1;
  }
  const buckets = new Map<number, number>();
  for (const line of longLines) {
    const bucket = bucketNumber(line.x, 24);
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  }
  const dominantBuckets = Array.from(buckets.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2);
  if (dominantBuckets.length < 2) {
    return 1;
  }
  const [leftBucket, rightBucket] = dominantBuckets;
  const separated = Math.abs(rightBucket[0] - leftBucket[0]) >= 120;
  const bothFrequent =
    leftBucket[1] >= Math.ceil(longLines.length * 0.18) &&
    rightBucket[1] >= Math.ceil(longLines.length * 0.18);
  return separated && bothFrequent ? 2 : 1;
}

function buildPageStats(lines: PageLine[]): PageStats {
  return {
    lineCount: lines.length,
    avgLineLength: averageNumber(lines.map((line) => line.text.length)),
    medianFontSize: medianNumber(lines.map((line) => line.fontSize)),
    maxFontSize: Math.max(0, ...lines.map((line) => line.fontSize)),
    columnCount: estimateColumnCount(lines),
  };
}

function extractTopText(lines: PageLine[]) {
  return lines
    .slice(0, 8)
    .map((line) => line.normalizedText)
    .filter(Boolean)
    .join(" ");
}

function countMatches(text: string, pattern: RegExp) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function matchesKeywordPatterns(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function getHeadingLines(page: PageSnapshot, count = 6) {
  return page.lines.slice(0, count).filter((line) => line.normalizedText);
}

function isLikelyHeadingLine(line: PageLine, stats: PageStats) {
  if (!line.text.trim()) {
    return false;
  }
  if (line.text.length > 140) {
    return false;
  }
  if (/[.;:]$/.test(line.text.trim()) && line.text.length > 50) {
    return false;
  }
  return (
    line.fontSize >= stats.medianFontSize * 1.04 ||
    line.text.length <= Math.max(40, stats.avgLineLength * 0.75)
  );
}

function isStrongReferenceHeading(line: PageLine, stats: PageStats) {
  return (
    referenceKeywords.includes(line.normalizedText) &&
    isLikelyHeadingLine(line, stats) &&
    line.fontSize >= Math.max(stats.medianFontSize * 1.08, 9)
  );
}

function lineLooksLikeReferenceEntry(line: PageLine) {
  const text = line.text.trim();
  if (text.length < 24) {
    return false;
  }
  if (/^(?:\[\d{1,3}\]|\d{1,3}[.)])\s+\S/.test(text)) {
    return true;
  }
  const hasYear = /\b(?:19|20)\d{2}[a-z]?\b/.test(text);
  const hasYearTail = /,\s(?:19|20)\d{2}[a-z]?\./i.test(text);
  const hasAuthorPattern =
    /\b[A-Z][a-z-]+,\s(?:[A-Z]\.\s*){1,3}/.test(text) ||
    /\b[A-Z][a-z-]+,\s[A-Z][a-z-]+/.test(text);
  const hasVenueMeta =
    /\b(?:doi|arxiv|conference|proceedings|journal|openreview|pp\.|vol\.|neurips|icml|iclr|cvpr|iccv|eccv|acl|emnlp|naacl|aaai|ijcai|kdd|www|sigir|icassp)\b/i.test(
      text,
    );
  const commaCount = countMatches(text, /,/g);
  const titleHints = countMatches(
    text,
    /\b(?:press|systems|learning|introduction|transactions|review|university|model|language|agent)\b/gi,
  );
  return (
    (hasYearTail && (hasAuthorPattern || hasVenueMeta || commaCount >= 3)) ||
    (hasYear && hasAuthorPattern && (hasVenueMeta || commaCount >= 4)) ||
    (hasVenueMeta && hasYear && commaCount >= 3) ||
    (hasAuthorPattern && titleHints >= 2 && hasYear)
  );
}

function lineLooksLikeAppendixHeading(line: PageLine, stats: PageStats) {
  if (!isLikelyHeadingLine(line, stats)) {
    return false;
  }
  return (
    appendixKeywordPatterns.some((pattern) => pattern.test(line.normalizedText)) ||
    /^([A-H]|[IVX]{1,4})(\.\d+)*[.)]?\s+[A-Z]/.test(line.text.trim()) ||
    /\b(?:implementation details?|proofs?|additional (?:results|experiments|ablations|analysis|details)|more results|supplementary material|reproducibility checklist|broader impact|limitations)\b/i.test(
      line.text,
    )
  );
}

function computeHangingIndentScore(page: PageSnapshot) {
  const lines = page.lines.filter((line) => line.text.length >= 28);
  if (lines.length < 4) {
    return 0;
  }
  let hangingPairs = 0;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const current = lines[index];
    const next = lines[index + 1];
    if (Math.abs(current.y - next.y) > Math.max(current.height, next.height) * 1.6) {
      continue;
    }
    if (next.x - current.x >= 10 && next.text.length >= 24) {
      hangingPairs += 1;
    }
  }
  return clampNumber(hangingPairs / Math.max(lines.length / 2, 1), 0, 1);
}

function getBoundaryRatio(
  page: PageSnapshot,
  matcher: (line: PageLine, stats: PageStats) => boolean,
) {
  if (!page.lines.length) {
    return null;
  }
  const index = page.lines.findIndex((line) => matcher(line, page.pageStats));
  if (index < 0) {
    return 0;
  }
  return clampNumber(index / Math.max(page.lines.length, 1), 0, 1);
}

function getHeadingWindow(page: PageSnapshot) {
  const base =
    getHeadingLines(page)
      .map((line) => line.text)
      .join(" ") || page.fullText.slice(0, 700);
  return normalizeText(base)
    .replace(/\bpublished as a conference paper at [a-z0-9 .:-]+/g, " ")
    .replace(/\barxiv:[^\s]+\b/g, " ")
    .replace(/\b(?:preprint|technical report)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getReferenceSignals(
  page: PageSnapshot,
  pageNumber: number,
  pageCount: number,
): ReferenceSignals {
  const text = page.fullText;
  const headingWindow = getHeadingWindow(page);
  const lineCount = Math.max(page.pageStats.lineCount, 1);
  const refLikeLineCount = page.lines.filter(lineLooksLikeReferenceEntry).length;
  const yearCount = countMatches(text, /\b(?:19|20)\d{2}\b/g);
  const yearTailCount = countMatches(text, /,\s(?:19|20)\d{2}[a-z]?\./g);
  const inlineCitationCount = countMatches(
    text,
    /\((?:[^)]*?,\s)?(?:19|20)\d{2}[a-z]?\)/g,
  );
  const citationHints = countMatches(
    text,
    /\b(?:arxiv|conference|proceedings|journal|openreview|doi|et al|pp\.|vol\.|learning representations|neural information processing systems)\b/g,
  );
  const authorInitials = countMatches(
    text,
    /\b[a-z][a-z-]+,\s(?:[a-z]\.\s*){1,3}/g,
  );
  const authorFullNames = countMatches(
    text,
    /\b[a-z][a-z-]+,\s[a-z][a-z-]+/g,
  );
  const authorListHints = countMatches(text, /\b(?:and|et al|in|url)\b/g);
  const authorLikeCount = authorInitials + authorFullNames;
  const refDensity = refLikeLineCount / lineCount;
  const citationMetaDensity = clampNumber(
    (citationHints + yearTailCount + refLikeLineCount) /
      Math.max(lineCount * 1.5, 1),
    0,
    1,
  );
  const hangingIndentScore = computeHangingIndentScore(page);
  const hasHeading = getHeadingLines(page).some((line) =>
    isStrongReferenceHeading(line, page.pageStats),
  );
  const latePagePrior =
    pageNumber >= Math.max(3, Math.floor(pageCount * 0.65))
      ? 1
      : pageNumber >= Math.max(3, Math.floor(pageCount * 0.45))
      ? 0.5
      : 0;
  const inlinePenalty =
    inlineCitationCount >= Math.max(4, refLikeLineCount * 2) && refDensity < 0.12
      ? 1.5
      : 0;

  let score =
    (hasHeading ? 6 : 0) +
    4 * refDensity +
    2 * hangingIndentScore +
    2 * citationMetaDensity +
    latePagePrior;
  if (yearTailCount >= 4) {
    score += 1.5;
  } else if (yearTailCount >= 2) {
    score += 0.75;
  }
  if (refLikeLineCount >= 4) {
    score += 1;
  }
  if (authorListHints >= 8) {
    score += 0.5;
  }
  if (appendixKeywordPatterns.some((pattern) => pattern.test(headingWindow))) {
    score -= 2.5;
  }
  score -= inlinePenalty;

  return {
    hasHeading,
    yearCount,
    yearTailCount,
    inlineCitationCount,
    citationHints,
    authorLikeCount,
    refLikeLineCount,
    refDensity,
    citationMetaDensity,
    hangingIndentScore,
    latePagePrior,
    score,
  };
}

function scoreReferencePage(
  page: PageSnapshot,
  pageNumber: number,
  pageCount: number,
) {
  return getReferenceSignals(page, pageNumber, pageCount).score;
}

function looksLikeReferencePage(
  page: PageSnapshot,
  pageNumber: number,
  pageCount: number,
) {
  const signals = getReferenceSignals(page, pageNumber, pageCount);
  return signals.hasHeading || signals.score >= 5.5;
}

function looksLikeReferenceContinuation(
  page: PageSnapshot,
  pageNumber: number,
  pageCount: number,
) {
  const signals = getReferenceSignals(page, pageNumber, pageCount);
  return (
    signals.score >= 3 ||
    signals.refDensity >= 0.14 ||
    (signals.yearTailCount >= 1 &&
      (signals.authorLikeCount >= 3 || signals.citationHints >= 2)) ||
    (signals.refLikeLineCount >= 2 && signals.yearCount >= 3)
  );
}

function hasReferenceSignalDrop(
  previousSignals: ReferenceSignals | null,
  currentSignals: ReferenceSignals,
  appendixScore: number,
) {
  if (!previousSignals) {
    return false;
  }

  const previousWasStrong =
    previousSignals.score >= 5 ||
    previousSignals.refDensity >= 0.18 ||
    previousSignals.refLikeLineCount >= 3;
  const currentIsWeak =
    currentSignals.yearTailCount === 0 &&
    currentSignals.yearCount <= 1 &&
    currentSignals.citationHints <= 1 &&
    currentSignals.authorLikeCount <= 1 &&
    currentSignals.refDensity < 0.08;

  return previousWasStrong && currentIsWeak && appendixScore >= 2;
}

function getAppendixSignals(
  page: PageSnapshot,
  pageNumber: number,
  pageCount: number,
) : AppendixSignals {
  const headingWindow = getHeadingWindow(page);
  const referenceSignals = getReferenceSignals(page, pageNumber, pageCount);
  const headingLines = getHeadingLines(page);
  const hasHeading = headingLines.some((line) =>
    appendixKeywordPatterns.some((pattern) => pattern.test(line.normalizedText)),
  );
  const sectionPattern = headingLines.some((line) =>
    /^([A-H]|[IVX]{1,4})(\.\d+)*[.)]?\s+[A-Z]/.test(line.text.trim()),
  );
  const runningHead =
    appendixKeywordPatterns.some((pattern) => pattern.test(page.topText)) &&
    !hasHeading;
  const sectionKeywordHits = countMatches(
    headingWindow,
    /\b(?:implementation details?|proofs?|additional|supplementary|supplemental|more results|ablation|reproducibility checklist|broader impact|limitations|prompts?|pseudo\s*code|algorithm|analysis|hyperparameters?)\b/gi,
  );
  const latePagePrior =
    pageNumber >= Math.max(3, Math.floor(pageCount * 0.7))
      ? 1
      : pageNumber >= Math.max(3, Math.floor(pageCount * 0.45))
      ? 0.5
      : 0;
  const refPenalty = clampNumber(
    referenceSignals.refDensity * 3 + referenceSignals.score * 0.25,
    0,
    4,
  );
  let score =
    (hasHeading ? 6 : 0) +
    (sectionPattern ? 4 : 0) +
    (runningHead ? 2 : 0) +
    Math.min(sectionKeywordHits, 3) * 1.25 +
    latePagePrior -
    refPenalty;
  if (referenceKeywords.some((keyword) => headingWindow.includes(keyword))) {
    score -= 2;
  }

  return {
    hasHeading,
    sectionPattern,
    runningHead,
    sectionKeywordHits,
    refPenalty,
    latePagePrior,
    score,
  };
}

function scoreAppendixHeading(
  page: PageSnapshot,
  pageNumber: number,
  pageCount: number,
) {
  return getAppendixSignals(page, pageNumber, pageCount).score;
}

function looksLikeAppendixHeading(
  page: PageSnapshot,
  pageNumber: number,
  pageCount: number,
) {
  const signals = getAppendixSignals(page, pageNumber, pageCount);
  return signals.hasHeading || signals.sectionPattern || signals.score >= 4.5;
}

function looksLikeAppendixPage(
  page: PageSnapshot,
  pageNumber: number,
  pageCount: number,
) {
  return looksLikeAppendixHeading(page, pageNumber, pageCount);
}

function detectAppendixAfterReferences(
  pages: PageSnapshot[],
  referenceBlock: ReferenceBlock,
) {
  if (!referenceBlock.startPage || !referenceBlock.endPage) {
    return null;
  }

  const pageCount = pages.length;
  const nextPage = referenceBlock.endPage + 1;
  if (nextPage > pageCount) {
    return null;
  }

  for (let index = nextPage - 1; index < pageCount; index += 1) {
    const page = pages[index];
    const pageNumber = index + 1;
    const appendixSignals = getAppendixSignals(page, pageNumber, pageCount);
    if (
      appendixSignals.hasHeading ||
      appendixSignals.sectionPattern ||
      (appendixSignals.score >= 3 &&
        !looksLikeReferenceContinuation(page, pageNumber, pageCount))
    ) {
      return pageNumber;
    }
    if (!looksLikeReferenceContinuation(page, pageNumber, pageCount)) {
      return pageNumber;
    }
  }

  return null;
}

function getReferenceWindowScores(
  pages: PageSnapshot[],
  signals = pages.map((page, index) =>
    getReferenceSignals(page, index + 1, pages.length),
  ),
) {
  return pages.map((_, index) => {
    const current = signals[index]?.score || 0;
    const next = signals[index + 1]?.score || 0;
    const nextTwo = signals[index + 2]?.score || 0;
    return 0.6 * current + 0.3 * next + 0.1 * nextTwo;
  });
}

function detectReferenceBlock(pages: PageSnapshot[]): ReferenceBlock {
  if (!pages.length) {
    return {
      startPage: null,
      endPage: null,
      startRatio: null,
    };
  }

  const pageCount = pages.length;
  const signals = pages.map((page, index) =>
    getReferenceSignals(page, index + 1, pageCount),
  );
  const windowScores = getReferenceWindowScores(pages, signals);

  let startPage: number | null = null;
  for (let index = 0; index < pageCount; index += 1) {
    const pageNumber = index + 1;
    const signal = signals[index];
    const stableNeighborCount = [signal, signals[index + 1], signals[index + 2]].filter(
      (candidate) =>
        candidate &&
        (candidate.score >= 3 || candidate.refDensity >= 0.14 || candidate.hasHeading),
    ).length;
    const lateEnough = pageNumber >= Math.max(3, Math.floor(pageCount * 0.35));
    if (!lateEnough) {
      continue;
    }
    if (
      (signal.hasHeading && windowScores[index] >= 4.5 && stableNeighborCount >= 2) ||
      (windowScores[index] >= 4.75 && stableNeighborCount >= 2)
    ) {
      startPage = pageNumber;
      break;
    }
  }

  if (!startPage) {
    startPage = detectSectionStart(pages, referenceKeywords, {
      detector: looksLikeReferencePage,
    });
  }

  if (!startPage) {
    return {
      startPage: null,
      endPage: null,
      startRatio: null,
    };
  }

  let endPage = startPage;
  let previousSignals: ReferenceSignals | null = signals[startPage - 1] || null;
  for (let index = startPage; index < pageCount; index += 1) {
    const page = pages[index];
    const pageNumber = index + 1;
    const referenceSignals = signals[index];
    const appendixSignals = getAppendixSignals(page, pageNumber, pageCount);
    const currentContinuation =
      referenceSignals.score >= 3 ||
      referenceSignals.refDensity >= 0.14 ||
      windowScores[index] >= 3.5;
    const nextSignals = signals[index + 1];
    const nextContinuation = Boolean(
      nextSignals &&
        (nextSignals.score >= 3 || nextSignals.refDensity >= 0.14),
    );

    if (
      appendixSignals.score >= 4.5 &&
      referenceSignals.refDensity < 0.1 &&
      !currentContinuation
    ) {
      break;
    }

    if (hasReferenceSignalDrop(previousSignals, referenceSignals, appendixSignals.score)) {
      break;
    }

    if (currentContinuation || (nextContinuation && referenceSignals.score >= 1.5)) {
      endPage = pageNumber;
      previousSignals = referenceSignals;
      continue;
    }

    break;
  }

  return {
    startPage,
    endPage,
    startRatio: getBoundaryRatio(pages[startPage - 1], (line, stats) =>
      isStrongReferenceHeading(line, stats) || lineLooksLikeReferenceEntry(line),
    ),
  };
}

function detectSectionStart(
  pages: PageSnapshot[],
  keywords: string[],
  options: {
    startPage?: number;
    maxChars?: number;
    detector?: (
      page: PageSnapshot,
      pageNumber: number,
      pageCount: number,
    ) => boolean;
  } = {},
) {
  const startIndex = Math.max((options.startPage || 1) - 1, 0);
  const maxChars = options.maxChars || 1600;
  const patterns = buildKeywordPatterns(keywords);

  for (let index = startIndex; index < pages.length; index += 1) {
    const sample = `${pages[index].topText} ${pages[index].fullText.slice(0, maxChars)}`.trim();
    if (
      patterns.some((pattern) => pattern.test(sample)) ||
      options.detector?.(pages[index], index + 1, pages.length)
    ) {
      return index + 1;
    }
  }

  return null;
}

function minPositiveNumber(...values: Array<number | null | undefined>) {
  const filtered = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return filtered.length ? Math.min(...filtered) : null;
}

function pickAppendixBoundaryRatio(
  pages: PageSnapshot[],
  appendixStartPage: number | null,
) {
  if (!appendixStartPage) {
    return null;
  }
  return getBoundaryRatio(pages[appendixStartPage - 1], (line, stats) =>
    lineLooksLikeAppendixHeading(line, stats),
  );
}

function computeSafeTrimPage(
  firstBackMatterPage: number | null,
  boundaryRatio: number | null,
  confidence: number,
  pageCount: number,
) {
  if (!firstBackMatterPage) {
    return null;
  }
  if (firstBackMatterPage >= pageCount) {
    return firstBackMatterPage;
  }
  if (boundaryRatio === null) {
    return firstBackMatterPage;
  }
  if (boundaryRatio <= 0.3) {
    return firstBackMatterPage;
  }
  if (boundaryRatio >= 0.55) {
    return Math.min(pageCount, firstBackMatterPage + 1);
  }
  return confidence >= 6
    ? firstBackMatterPage
    : Math.min(pageCount, firstBackMatterPage + 1);
}

function detectAppendixStart(
  pages: PageSnapshot[],
  referenceBlock: ReferenceBlock,
) {
  const pageCount = pages.length;
  const signals = pages.map((page, index) =>
    getAppendixSignals(page, index + 1, pageCount),
  );
  const referenceSignals = pages.map((page, index) =>
    getReferenceSignals(page, index + 1, pageCount),
  );
  const windowScores = signals.map((signal, index) => {
    const next = signals[index + 1]?.score || 0;
    const nextTwo = signals[index + 2]?.score || 0;
    return 0.6 * signal.score + 0.3 * next + 0.1 * nextTwo;
  });

  if (referenceBlock.endPage) {
    for (let index = referenceBlock.endPage; index < pageCount; index += 1) {
      const signal = signals[index];
      const refSignal = referenceSignals[index];
      if (
        (signal.hasHeading || signal.sectionPattern) &&
        refSignal.refDensity < 0.12
      ) {
        return index + 1;
      }
      if (windowScores[index] >= 3.25 && refSignal.refDensity < 0.1) {
        return index + 1;
      }
    }
  }

  const startIndex = Math.max(0, Math.floor(pageCount * 0.35) - 1);
  for (let index = startIndex; index < pageCount; index += 1) {
    const signal = signals[index];
    const stableNeighbors = [signal, signals[index + 1], signals[index + 2]].filter(
      (candidate) =>
        candidate &&
        (candidate.score >= 3 ||
          candidate.hasHeading ||
          candidate.sectionPattern),
    ).length;
    if (
      (signal.hasHeading ||
        signal.sectionPattern ||
        windowScores[index] >= 4.5) &&
      stableNeighbors >= 1 &&
      referenceSignals[index].refDensity < 0.16
    ) {
      return index + 1;
    }
  }

  return null;
}

function detectBackMatter(pages: PageSnapshot[]): DetectResult {
  const referenceBlock = detectReferenceBlock(pages);
  const referenceStartPage = referenceBlock.startPage;
  const appendixStartPage =
    detectAppendixAfterReferences(pages, referenceBlock) ||
    detectAppendixStart(pages, referenceBlock) ||
    detectSectionStart(pages, appendixKeywords, {
      startPage: referenceBlock.endPage ? referenceBlock.endPage + 1 : 1,
      detector: looksLikeAppendixPage,
    });
  const firstBackMatterPage = minPositiveNumber(
    referenceStartPage,
    appendixStartPage,
  );
  const appendixBoundaryRatio = pickAppendixBoundaryRatio(
    pages,
    appendixStartPage,
  );
  const boundaryRatio =
    firstBackMatterPage === referenceStartPage
      ? referenceBlock.startRatio
      : appendixBoundaryRatio;
  const confidencePage = firstBackMatterPage
    ? pages[firstBackMatterPage - 1]
    : null;
  const confidence =
    confidencePage && firstBackMatterPage
      ? firstBackMatterPage === referenceStartPage
        ? getReferenceSignals(
            confidencePage,
            firstBackMatterPage,
            pages.length,
          ).score
        : getAppendixSignals(
            confidencePage,
            firstBackMatterPage,
            pages.length,
          ).score
      : 0;

  return {
    referenceStartPage,
    appendixStartPage,
    firstBackMatterPage,
    safeTrimPage: computeSafeTrimPage(
      firstBackMatterPage,
      boundaryRatio,
      confidence,
      pages.length,
    ),
    referenceBlock,
  };
}

async function scanItem(item: Zotero.Item, state: ReaderSplitState) {
  state.status = "scanning";
  state.error = "";
  state.skipAutoScan = false;
  state.generatedOutputs = [];
  state.message = getString("tool-status-scanning");

  try {
    const { pageCount, pages } = await readPageTexts(item);
    const detection = detectBackMatter(pages);
    const referencePage = detection.referenceStartPage;
    const appendixPage = detection.appendixStartPage;

    state.status = "ready";
    state.pageCount = pageCount;
    state.detectedReferencePage = referencePage;
    state.detectedAppendixPage = appendixPage;
    state.detectedFirstBackMatterPage = detection.firstBackMatterPage;
    state.detectedSafeTrimPage = detection.safeTrimPage;
    state.referencePageInput = referencePage ? String(referencePage) : "";
    state.appendixPageInput = appendixPage ? String(appendixPage) : "";
    state.message = buildDetectionMessage(detection, pageCount);
    state.error = "";
  } catch (error) {
    state.status = "error";
    state.error =
      error instanceof Error ? error.message : getString("tool-status-error");
    state.message = getString("tool-status-error");
  }
}

function buildDetectionMessage(
  detection: DetectResult,
  pageCount: number,
) {
  if (!detection.referenceStartPage && !detection.appendixStartPage) {
    return getString("tool-status-not-found", {
      args: { pageCount },
    });
  }
  return getString("tool-status-detected", {
    args: {
      referencePage: detection.referenceStartPage || "-",
      appendixPage: detection.appendixStartPage || "-",
      safeTrimPage: detection.safeTrimPage || "-",
      pageCount,
    },
  });
}

function buildPreview(item: Zotero.Item, state: ReaderSplitState): PreviewResult {
  const plan = buildSplitPlan(item, state);
  const notes: string[] = [];
  if (state.mode === "sections" && !state.referencePageInput.trim()) {
    notes.push(getString("preview-reference-missing"));
  }
  if (
    state.detectedSafeTrimPage &&
    state.detectedFirstBackMatterPage &&
    state.detectedSafeTrimPage !== state.detectedFirstBackMatterPage
  ) {
    notes.push(
      getString("preview-safe-trim-note", {
        args: { safeTrimPage: state.detectedSafeTrimPage },
      }),
    );
  }
  if (state.skipAutoScan) {
    notes.push(getString("preview-generated-note"));
  }

  return {
    outputs: plan.outputs,
    notes,
    errors: plan.errors,
    canSplit:
      Boolean(state.pageCount) &&
      plan.errors.length === 0 &&
      plan.outputs.length > 0,
  };
}

function buildSplitPlan(item: Zotero.Item, state: ReaderSplitState): SplitPlan {
  const errors: string[] = [];
  const referencePage = parsePageInput(state.referencePageInput);
  const appendixPage = parsePageInput(state.appendixPageInput);
  const pageCount = state.pageCount;
  const name = basename(item);
  const manualFirstBackMatterPage = minPositiveNumber(referencePage, appendixPage);
  const usesDetectedPages =
    (referencePage || null) === state.detectedReferencePage &&
    (appendixPage || null) === state.detectedAppendixPage;

  if (Number.isNaN(referencePage)) {
    errors.push(getString("validation-reference-invalid"));
  }
  if (Number.isNaN(appendixPage)) {
    errors.push(getString("validation-appendix-invalid"));
  }
  if (pageCount) {
    if (referencePage && referencePage > pageCount) {
      errors.push(
        getString("validation-reference-range", { args: { pageCount } }),
      );
    }
    if (appendixPage && appendixPage > pageCount) {
      errors.push(
        getString("validation-appendix-range", { args: { pageCount } }),
      );
    }
  }
  if (referencePage && referencePage <= 1) {
    errors.push(getString("validation-reference-position"));
  }
  if (referencePage && appendixPage && appendixPage <= referencePage) {
    errors.push(getString("validation-overlap"));
  }
  if (!referencePage && appendixPage) {
    errors.push(getString("validation-appendix-without-reference"));
  }

  const outputs: SplitOutputSpec[] = [];
  if (!pageCount) {
    return { outputs, errors };
  }

  const pushOutput = (
    suffix: SplitOutputSpec["suffix"],
    startPage: number,
    endPage: number,
  ) => {
    if (startPage > endPage) {
      return;
    }
    outputs.push({
      suffix,
      filename: buildOutputFilename(name, suffix),
      title: buildOutputFilename(name, suffix).replace(/\.pdf$/i, ""),
      startPage,
      endPage,
    });
  };

  if (state.mode === "main") {
    const trimStartPage =
      manualFirstBackMatterPage ||
      (usesDetectedPages
        ? state.detectedSafeTrimPage || state.detectedFirstBackMatterPage
        : null);
    pushOutput("main", 1, trimStartPage ? trimStartPage - 1 : pageCount);
    return { outputs, errors };
  }

  pushOutput("main", 1, referencePage ? referencePage - 1 : pageCount);
  if (referencePage) {
    pushOutput(
      "reference",
      referencePage,
      appendixPage ? appendixPage - 1 : pageCount,
    );
    if (appendixPage) {
      pushOutput("appendix", appendixPage, pageCount);
    }
  }

  return { outputs, errors };
}

async function jumpToPage(item: Zotero.Item, page: number | null) {
  if (page === null) {
    return;
  }
  if (Number.isNaN(page)) {
    throw new Error(getString("tool-status-invalid"));
  }

  const reader = getReaderForItem(item);
  if (!reader) {
    throw new Error(getString("tool-status-open-reader"));
  }

  const tabID = reader.tabID || reader._tabID;
  if (tabID && ztoolkit.getGlobal("Zotero_Tabs")?.selectedID !== tabID) {
    ztoolkit.getGlobal("Zotero_Tabs").select(tabID);
    await Zotero.Promise.delay(100);
  }

  if (typeof reader.navigate !== "function") {
    throw new Error(getString("tool-status-reader-not-ready"));
  }

  await reader.navigate({ pageIndex: page - 1 });
}

async function runSplit(item: Zotero.Item, state: ReaderSplitState) {
  const plan = buildSplitPlan(item, state);
  if (plan.errors.length || !plan.outputs.length) {
    throw new Error(plan.errors[0] || getString("tool-status-invalid"));
  }

  const sourcePath = await item.getFilePathAsync();
  if (!sourcePath) {
    throw new Error(getString("tool-status-source-missing"));
  }

  const sourceBytes = await readPDFBytes(sourcePath);
  const sourceDoc = await PDFDocument.load(sourceBytes, {
    ignoreEncryption: true,
  });

  const createdFiles: string[] = [];
  const generatedOutputs: GeneratedOutput[] = [];
  for (const output of plan.outputs) {
    const outputBytes = await createSplitPDF(sourceDoc, output);
    const outputPath = await createUniqueSiblingPath(sourcePath, output.filename);
    await IOUtils.write(outputPath, outputBytes);
    const createdItem = await attachGeneratedFile(item, outputPath, output.title);
    const createdFilename = getLeafFilename(outputPath);
    createdFiles.push(createdFilename);
    generatedOutputs.push({
      itemID: createdItem.id,
      filename: createdFilename,
      suffix: output.suffix,
      startPage: output.startPage,
      endPage: output.endPage,
    });
  }

  state.status = "ready";
  state.error = "";
  state.generatedOutputs = generatedOutputs;
  state.message = getString("tool-status-split-success", {
    args: {
      count: createdFiles.length,
      files: createdFiles.join(", "),
    },
  });
}

async function collectGeneratedOutputs(item: Zotero.Item) {
  const matcher = getGeneratedOutputMatcher(item);
  const candidates: Zotero.Item[] = [];

  if (item.parentItemID) {
    const parentItem = item.parentItem;
    if (parentItem) {
      for (const attachmentID of parentItem.getAttachments(false)) {
        const attachment = Zotero.Items.get(attachmentID);
        if (!attachment || !hasPDFContent(attachment)) {
          continue;
        }
        candidates.push(attachment);
      }
    }
  } else if (isGeneratedSplitPDF(item)) {
    candidates.push(item);
  }

  return candidates
    .map((attachment) => {
      const filename = getItemFilename(attachment);
      const suffix = getGeneratedSuffix(filename);
      if (!suffix || !matcher.test(filename)) {
        return null;
      }
      return {
        itemID: attachment.id,
        filename,
        suffix,
        startPage: 0,
        endPage: 0,
      } satisfies GeneratedOutput;
    })
    .filter((record): record is GeneratedOutput => Boolean(record))
    .sort((left, right) => left.filename.localeCompare(right.filename));
}

async function refreshGeneratedOutputs(item: Zotero.Item, state: ReaderSplitState) {
  state.generatedOutputs = await collectGeneratedOutputs(item);
}

async function deleteGeneratedOutputs(item: Zotero.Item, state: ReaderSplitState) {
  const generatedOutputs = await collectGeneratedOutputs(item);
  if (!generatedOutputs.length) {
    throw new Error(getString("tool-status-delete-generated-none"));
  }

  let deletedFiles = 0;
  let deletedItems = 0;
  for (const output of generatedOutputs) {
    const attachment = Zotero.Items.get(output.itemID);
    if (!attachment) {
      continue;
    }

    let fileDeleted = false;
    try {
      fileDeleted = await attachment.deleteAttachmentFile();
    } catch (error) {
      fileDeleted = false;
    }

    if (!fileDeleted) {
      const path = await attachment.getFilePathAsync();
      if (path && (await IOUtils.exists(path))) {
        await IOUtils.remove(path);
        fileDeleted = true;
      }
    }

    if (fileDeleted) {
      deletedFiles += 1;
    }

    const erased = await attachment.erase();
    if (erased) {
      deletedItems += 1;
    }
    states.delete(attachment.id);
  }

  state.generatedOutputs = [];
  state.status = "ready";
  state.error = "";
  state.message = getString("tool-status-delete-generated-success", {
    args: {
      fileCount: deletedFiles,
      itemCount: deletedItems,
    },
  });
}

async function readPDFBytes(path: string) {
  const bytes: any = await IOUtils.read(path);
  if (bytes && bytes instanceof Uint8Array) {
    return new Uint8Array(bytes);
  }
  if (typeof ArrayBuffer !== "undefined" && bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(bytes as any)) {
    const view = bytes as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  if (typeof bytes === "string") {
    return Uint8Array.from(Array.from(bytes, (char) => char.charCodeAt(0) & 0xff));
  }
  throw new Error(
    `${getString("tool-status-source-read-failed")} (${Object.prototype.toString.call(bytes)})`,
  );
}

async function createSplitPDF(
  sourceDoc: PDFDocument,
  output: SplitOutputSpec,
) {
  const targetDoc = await PDFDocument.create();
  const pageIndexes = Array.from(
    { length: output.endPage - output.startPage + 1 },
    (_, index) => output.startPage - 1 + index,
  );
  const pages = await targetDoc.copyPages(sourceDoc, pageIndexes);
  for (const page of pages) {
    targetDoc.addPage(page);
  }
  return targetDoc.save();
}

async function createUniqueSiblingPath(sourcePath: string, filename: string) {
  const sourceFile = Zotero.File.pathToFile(sourcePath);
  const parent = sourceFile.parent;
  if (!parent) {
    throw new Error(getString("tool-status-output-dir-missing"));
  }

  const match = filename.match(/^(.*?)(\.pdf)$/i);
  const base = match ? match[1] : filename;
  const extension = match ? match[2] : "";
  let attempt = 1;

  while (true) {
    const candidate = parent.clone();
    const candidateName =
      attempt === 1 ? `${base}${extension}` : `${base}-${attempt}${extension}`;
    candidate.append(candidateName);
    if (!(await IOUtils.exists(candidate.path))) {
      return candidate.path;
    }
    attempt += 1;
  }
}

async function attachGeneratedFile(
  item: Zotero.Item,
  path: string,
  title: string,
) {
  const parentItemID = item.parentItemID || undefined;
  return Zotero.Attachments.linkFromFile({
    file: path,
    parentItemID,
    title,
    collections: parentItemID ? undefined : item.getCollections(),
    contentType: "application/pdf",
  });
}

async function openAttachmentInReader(itemID: number) {
  const item = Zotero.Items.get(itemID);
  if (!item) {
    throw new Error(getString("tool-status-open-generated-missing"));
  }

  if (typeof Zotero.Reader?.open === "function") {
    await Zotero.Reader.open(itemID, undefined, {
      openInBackground: false,
      allowDuplicate: true,
    });
    return;
  }

  await Zotero.FileHandlers.open(item, {
    openInWindow: false,
  });
}

function createCard(doc: Document, title: string) {
  const card = createHTML(doc, "section");
  card.className = `${ROOT_CLASS}__card`;
  const heading = createHTML(doc, "h3");
  heading.className = `${ROOT_CLASS}__card-title`;
  heading.textContent = title;
  card.appendChild(heading);
  return card;
}

function renderMessage(
  body: XUL.Box,
  message: string,
  options: {
    setL10nArgs?: (value: string) => void;
    setSectionSummary?: (value: string) => void;
  } = {},
  status: ScanStatus = "idle",
) {
  const doc = body.ownerDocument as Document;
  const root = createHTML(doc, "div");
  root.className = ROOT_CLASS;

  const statusNode = createHTML(doc, "div");
  statusNode.className = `${ROOT_CLASS}__status`;
  statusNode.dataset.status = status;
  statusNode.textContent = message;
  root.appendChild(statusNode);

  body.replaceChildren(root as any);
  options.setL10nArgs?.(
    JSON.stringify({
      status: statusLabel(status),
    }),
  );
  options.setSectionSummary?.(message);
}

function createButton(
  doc: Document,
  label: string,
  action: () => void | Promise<void>,
  variant: "default" | "primary" | "subtle" | "danger-subtle" = "default",
) {
  const button = createHTML(doc, "button");
  button.type = "button";
  button.className = `${ROOT_CLASS}__button`;
  button.dataset.variant = variant;
  button.textContent = label;
  button.addEventListener("click", () => {
    void action();
  });
  return button;
}

function createModeOption(
  doc: Document,
  itemID: number,
  value: SplitMode,
  selected: SplitMode,
  label: string,
  onChange: () => void,
) {
  const wrapper = createHTML(doc, "label");
  wrapper.className = `${ROOT_CLASS}__mode-option`;

  const input = createHTML(doc, "input");
  input.type = "radio";
  input.name = `${config.addonRef}-mode-${itemID}`;
  input.value = value;
  input.checked = selected === value;
  input.addEventListener("change", onChange);

  const text = createHTML(doc, "span");
  text.textContent = label;

  wrapper.append(input, text);
  return wrapper;
}

function createFieldRow(
  doc: Document,
  label: string,
  value: string,
  onInput: (value: string) => void,
  onJump: () => Promise<void>,
) {
  const row = createHTML(doc, "div");
  row.className = `${ROOT_CLASS}__field-row`;

  const labelNode = createHTML(doc, "label");
  labelNode.className = `${ROOT_CLASS}__field-label`;
  labelNode.textContent = label;

  const controls = createHTML(doc, "div");
  controls.className = `${ROOT_CLASS}__field-controls`;

  const input = createHTML(doc, "input");
  input.type = "number";
  input.min = "1";
  input.placeholder = "-";
  input.className = `${ROOT_CLASS}__input`;
  input.value = value;
  input.addEventListener("input", () => onInput(input.value));

  const jumpButton = createButton(doc, getString("action-jump"), async () => {
    await onJump();
  });

  controls.append(input, jumpButton);
  row.append(labelNode, controls);
  return row;
}

function renderBusy(
  body: XUL.Box,
  options: {
    setL10nArgs?: (value: string) => void;
    setSectionSummary?: (value: string) => void;
  },
  message: string,
) {
  const doc = body.ownerDocument as Document;
  const root = createHTML(doc, "div");
  root.className = ROOT_CLASS;

  const status = createHTML(doc, "div");
  status.className = `${ROOT_CLASS}__status`;
  status.dataset.status = "scanning";
  status.textContent = message;
  root.appendChild(status);

  body.replaceChildren(root as any);
  options.setL10nArgs?.(
    JSON.stringify({
      status: getString("tool-status-scanning"),
    }),
  );
  options.setSectionSummary?.(message);
}

function renderSection(
  body: XUL.Box,
  item: Zotero.Item,
  state: ReaderSplitState,
  options: {
    setL10nArgs?: (value: string) => void;
    setSectionSummary?: (value: string) => void;
  } = {},
) {
  const doc = body.ownerDocument as Document;
  const root = createHTML(doc, "div");
  root.className = ROOT_CLASS;
  const preview = buildPreview(item, state);
  const isLightweightGeneratedView = state.skipAutoScan && !state.pageCount;

  const status = createHTML(doc, "div");
  status.className = `${ROOT_CLASS}__status`;
  status.dataset.status = state.status;
  status.textContent = state.error || state.message;
  root.appendChild(status);

  const metaRow = createHTML(doc, "div");
  metaRow.className = `${ROOT_CLASS}__meta`;
  if (state.pageCount) {
    const pagePill = createHTML(doc, "div");
    pagePill.className = `${ROOT_CLASS}__meta-pill`;
    pagePill.textContent = getString("meta-page-count", {
      args: { pageCount: state.pageCount },
    });
    metaRow.appendChild(pagePill);
  }
  if (state.skipAutoScan) {
    const skipPill = createHTML(doc, "div");
    skipPill.className = `${ROOT_CLASS}__meta-pill`;
    skipPill.dataset.tone = "muted";
    skipPill.textContent = getString("meta-generated-pdf");
    metaRow.appendChild(skipPill);
  }
  if (metaRow.childElementCount) {
    root.appendChild(metaRow);
  }

  if (!isLightweightGeneratedView) {
    const modeCard = createCard(doc, getString("mode-title"));
    const modeGroup = createHTML(doc, "div");
    modeGroup.className = `${ROOT_CLASS}__mode-group`;
    modeGroup.appendChild(
      createModeOption(doc, item.id, "main", state.mode, getString("mode-main"), () => {
        state.mode = "main";
        state.error = "";
        state.generatedOutputs = [];
        if (state.status === "error") {
          state.status = "ready";
        }
        renderSection(body, item, state, options);
      }),
    );
    modeGroup.appendChild(
      createModeOption(
        doc,
        item.id,
        "sections",
        state.mode,
        getString("mode-sections"),
        () => {
          state.mode = "sections";
          state.error = "";
          state.generatedOutputs = [];
          if (state.status === "error") {
            state.status = "ready";
          }
          renderSection(body, item, state, options);
        },
      ),
    );
    modeCard.appendChild(modeGroup);
    root.appendChild(modeCard);

    const detectedCard = createCard(doc, getString("detected-pages-title"));
    detectedCard.appendChild(
      createFieldRow(
        doc,
        getString("detected-reference-page"),
        state.referencePageInput,
        (value) => {
          state.referencePageInput = value;
          state.error = "";
          state.generatedOutputs = [];
          if (state.status === "error") {
            state.status = "ready";
          }
          renderSection(body, item, state, options);
        },
        async () => {
          try {
            await jumpToPage(item, parsePageInput(state.referencePageInput));
          } catch (error) {
            state.status = "error";
            state.error =
              error instanceof Error
                ? error.message
                : getString("tool-status-error");
            renderSection(body, item, state, options);
          }
        },
      ),
    );
    detectedCard.appendChild(
      createFieldRow(
        doc,
        getString("detected-appendix-page"),
        state.appendixPageInput,
        (value) => {
          state.appendixPageInput = value;
          state.error = "";
          state.generatedOutputs = [];
          if (state.status === "error") {
            state.status = "ready";
          }
          renderSection(body, item, state, options);
        },
        async () => {
          try {
            await jumpToPage(item, parsePageInput(state.appendixPageInput));
          } catch (error) {
            state.status = "error";
            state.error =
              error instanceof Error
                ? error.message
                : getString("tool-status-error");
            renderSection(body, item, state, options);
          }
        },
      ),
    );
    root.appendChild(detectedCard);
  }

  const previewCard = createCard(doc, getString("preview-title"));
  if (preview.errors.length) {
    const errors = createHTML(doc, "ul");
    errors.className = `${ROOT_CLASS}__errors`;
    for (const error of preview.errors) {
      const li = createHTML(doc, "li");
      li.textContent = error;
      errors.appendChild(li);
    }
    previewCard.appendChild(errors);
  }
  const previewList = createHTML(doc, "div");
  previewList.className = `${ROOT_CLASS}__preview-list`;
  for (const output of preview.outputs) {
    const generatedOutput = state.generatedOutputs.find(
      (record) => record.suffix === output.suffix,
    );
    const row = createHTML(doc, "div");
    row.className = `${ROOT_CLASS}__preview-row`;

    const summary = createHTML(doc, "div");
    summary.className = `${ROOT_CLASS}__preview-summary`;

    const filename = createHTML(doc, "div");
    filename.className = `${ROOT_CLASS}__preview-filename`;
    filename.textContent = generatedOutput?.filename || output.filename;

    const range = createHTML(doc, "div");
    range.className = `${ROOT_CLASS}__preview-range`;
    range.textContent = getString("preview-range", {
      args: {
        startPage: output.startPage,
        endPage: output.endPage === state.pageCount ? "end" : output.endPage,
      },
    });

    summary.append(filename, range);
    row.appendChild(summary);

    if (generatedOutput) {
      const openButton = createButton(
        doc,
        getString("action-open-result"),
        async () => {
          try {
            await openAttachmentInReader(generatedOutput.itemID);
          } catch (error) {
            state.status = "error";
            state.error =
              error instanceof Error
                ? error.message
                : getString("tool-status-error");
            renderSection(body, item, state, options);
          }
        },
        "subtle",
      );
      row.appendChild(openButton);
    }
    previewList.appendChild(row);
  }
  for (const note of preview.notes) {
    const noteNode = createHTML(doc, "div");
    noteNode.className = `${ROOT_CLASS}__preview-note`;
    noteNode.textContent = note;
    previewList.appendChild(noteNode);
  }
  if (!preview.outputs.length && !preview.notes.length) {
    const emptyNode = createHTML(doc, "div");
    emptyNode.className = `${ROOT_CLASS}__empty`;
    emptyNode.textContent = getString("preview-empty");
    previewList.appendChild(emptyNode);
  }
  previewCard.appendChild(previewList);
  if (state.generatedOutputs.length) {
    const previewActions = createHTML(doc, "div");
    previewActions.className = `${ROOT_CLASS}__preview-actions`;
    const deleteButton = createButton(
      doc,
      getString("action-delete-generated"),
      async () => {
        try {
          state.status = "scanning";
          state.error = "";
          state.message = getString("tool-status-deleting-generated");
          renderBusy(body, options, state.message);
          await deleteGeneratedOutputs(item, state);
          renderSection(body, item, state, options);
        } catch (error) {
          state.status = "error";
          state.error =
            error instanceof Error ? error.message : getString("tool-status-error");
          renderSection(body, item, state, options);
        }
      },
      "danger-subtle",
    );
    deleteButton.dataset.size = "small";
    deleteButton.disabled = state.status === "scanning";
    previewActions.appendChild(deleteButton);
    previewCard.appendChild(previewActions);
  }
  root.appendChild(previewCard);

  const actionRow = createHTML(doc, "div");
  actionRow.className = `${ROOT_CLASS}__actions`;

  const scanButton = createButton(
    doc,
    isLightweightGeneratedView
      ? getString("action-scan-anyway")
      : state.status === "scanning"
      ? getString("action-scanning")
      : getString("action-rescan"),
    async () => {
      state.generatedOutputs = [];
      renderBusy(body, options, getString("tool-status-scanning"));
      await scanItem(item, state);
      renderSection(body, item, state, options);
    },
  );
  scanButton.disabled = state.status === "scanning";
  actionRow.appendChild(scanButton);

  if (!isLightweightGeneratedView) {
    const splitButton = createButton(doc, getString("action-split"), async () => {
      try {
        state.status = "scanning";
        state.error = "";
        state.generatedOutputs = [];
        state.message = getString("tool-status-splitting");
        renderBusy(body, options, state.message);
        await runSplit(item, state);
        renderSection(body, item, state, options);
      } catch (error) {
        state.status = "error";
        state.error =
          error instanceof Error ? error.message : getString("tool-status-error");
        renderSection(body, item, state, options);
      }
    });
    splitButton.disabled = !preview.canSplit || state.status === "scanning";
    splitButton.dataset.variant = "primary";
    actionRow.appendChild(splitButton);
  }
  root.appendChild(actionRow);

  body.replaceChildren(root as any);
  options.setL10nArgs?.(
    JSON.stringify({
      status: statusLabel(state.status),
    }),
  );
  options.setSectionSummary?.(
    preview.errors[0] || preview.outputs[0]?.filename || preview.notes[0] || state.message,
  );
}

export class PDFSplitTool {
  static registerStyleSheet(win: _ZoteroTypes.MainWindow) {
    if (win.document.getElementById(STYLESHEET_ID)) {
      return;
    }
    const link = ztoolkit.UI.createElement(win.document, "link", {
      properties: {
        id: STYLESHEET_ID,
        type: "text/css",
        rel: "stylesheet",
        href: `chrome://${config.addonRef}/content/zoteroPane.css`,
      },
    });
    win.document.documentElement?.appendChild(link);
  }

  static registerReaderItemPaneSection() {
    Zotero.ItemPaneManager.registerSection({
      paneID: READER_SECTION_ID,
      pluginID: config.addonID,
      header: {
        l10nID: getLocaleID("reader-section-title"),
        l10nArgs: JSON.stringify({ status: getString("tool-status-idle") }),
        icon: PLUGIN_ICON_16,
      },
      sidenav: {
        l10nID: getLocaleID("reader-section-sidenav"),
        icon: PLUGIN_ICON_20,
      },
      bodyXHTML: `<html:div class="${ROOT_CLASS}"></html:div>`,
      onItemChange: ({ item, setEnabled, tabType }: any) => {
        setEnabled(tabType === "reader");
        return true;
      },
      onRender: ({ body, item, setL10nArgs, setSectionSummary }: any) => {
        renderMessage(
          body,
          getString("tool-status-resolving"),
          { setL10nArgs, setSectionSummary },
          "scanning",
        );
      },
      onAsyncRender: async ({
        body,
        item,
        setL10nArgs,
        setSectionSummary,
      }: any) => {
        const pdfItem = await resolvePDFItem(item);
        if (!pdfItem) {
          renderMessage(
            body,
            getString("tool-status-no-pdf"),
            { setL10nArgs, setSectionSummary },
            "error",
          );
          return;
        }
        const state = getState(pdfItem);
        if (!state.hasAutoScanned && isGeneratedSplitPDF(pdfItem)) {
          state.hasAutoScanned = true;
          state.skipAutoScan = true;
          state.status = "idle";
          state.message = getString("tool-status-generated-skip");
          state.error = "";
        } else if (!state.hasAutoScanned) {
          state.hasAutoScanned = true;
          state.skipAutoScan = false;
          renderBusy(
            body,
            { setL10nArgs, setSectionSummary },
            getString("tool-status-scanning"),
          );
          await scanItem(pdfItem, state);
        }
        await refreshGeneratedOutputs(pdfItem, state);
        renderSection(body, pdfItem, state, {
          setL10nArgs,
          setSectionSummary,
        });
      },
    });
  }

  static unregisterReaderItemPaneSection() {
    states.clear();
    if (typeof Zotero.ItemPaneManager.unregisterSection === "function") {
      Zotero.ItemPaneManager.unregisterSection(READER_SECTION_ID);
    }
  }
}
