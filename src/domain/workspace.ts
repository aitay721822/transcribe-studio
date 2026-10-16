import type { Reference } from './models';

export interface ScanStats {
  visited: number;
  files: number;
  scannedFiles: number;
  bytes: number;
  matches: number;
  skipped: number;
  errorCount: number;
  errors: string[];
}
export interface WorkspaceOptions {
  cursor?: string;
  limit?: number;
  rootId?: string;
  directory?: string;
  pathQuery?: string;
  caseSensitive?: boolean;
  offset?: number;
  version?: string;
  signal?: AbortSignal;
  onProgress?: (stats: ScanStats) => void;
}
export interface WorkspaceArgs extends Omit<WorkspaceOptions, 'signal' | 'onProgress'> {
  query?: string;
  relative?: string;
  includeDirectories?: boolean;
}
export interface WorkspaceEntry extends Reference {
  kind?: 'file' | 'directory';
  line?: number;
  text?: string;
  offset?: number;
  unit?: string;
  version?: string;
  citation?: string;
}
interface ScanPage {
  nextCursor: string | null;
  complete: boolean;
  truncated: boolean;
  stats: ScanStats;
  errors: string[];
  cursorExpiresInSeconds: number | null;
}
export interface FileList extends ScanPage {
  files: WorkspaceEntry[];
}
export interface SearchPage extends ScanPage {
  matches: WorkspaceEntry[];
}
export interface FilePage {
  rootId: string;
  relative: string;
  text: string;
  offset: number;
  limit: number;
  nextOffset: number | null;
  version: string;
  unit: string;
  citation: string;
  encoding?: string;
  totalBytes?: number;
  total?: number;
}
export interface WorkspaceResults {
  list: FileList;
  mentions: FileList;
  search: SearchPage;
  read: FilePage;
}
