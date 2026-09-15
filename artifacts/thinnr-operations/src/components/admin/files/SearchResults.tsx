import { FileTable } from './FileTable';
import type { HqFile, HqFolder } from '@workspace/api-client-react';

interface Props {
  query: string;
  files: HqFile[];
  loading: boolean;
  /** Server or network failure message; shown instead of a misleading empty result. */
  error?: string | null;
  onOpen(file: HqFile): void;
  onFolder(folder: HqFolder): void;
  onDownload?(file: HqFile): void;
  downloadingId?: string | null;
}

export function SearchResults({ query, files, loading, error = null, onOpen, onFolder, onDownload, downloadingId = null }: Props) {
  if (error) return <p role="alert" className="py-8 text-center text-xs text-destructive">{error}</p>;
  if (loading) return <p className="py-8 text-center text-xs text-muted-foreground">Searching…</p>;
  if (!files.length) return <p className="py-8 text-center text-xs text-muted-foreground">No files match “{query}”.</p>;
  return <FileTable files={files} downloadingId={downloadingId} onOpen={onOpen} onFolder={onFolder} onDownload={onDownload} showPath compactActions={!onDownload} />;
}