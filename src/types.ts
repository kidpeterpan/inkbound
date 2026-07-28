export interface ExportMeta {
  title: string;
  author: string;
  language: string;
  coverBytes?: Uint8Array;
  coverExt?: "jpg" | "png";
}

export interface ExportUnit {
  path: string;      // vault-relative path of the source note
  title: string;     // chapter title
  markdown: string;  // raw note body
}

export interface ExportJob {
  meta: ExportMeta;
  units: ExportUnit[];
  warnings: string[];
}
