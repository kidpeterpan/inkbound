export interface ExportMeta {
  title: string;
  author: string;
  language: string;
  coverBytes?: Uint8Array;
  coverExt?: "jpg" | "png";
}
