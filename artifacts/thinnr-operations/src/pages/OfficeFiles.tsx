import { openDownload } from '@/components/admin/files/utils';
import React, { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useLocation, useSearch } from 'wouter';
import type { HqFile } from '@workspace/api-client-react';
import { PageHeader } from '@/components/admin/primitives';
import { FileDetailDialog } from '@/components/admin/files/FileDetailDialog';
import { FileTable } from '@/components/admin/files/FileTable';
import { FolderGrid } from '@/components/admin/files/FolderGrid';
import { SearchResults } from '@/components/admin/files/SearchResults';
import { BTN_SECONDARY, SectionCard } from '@/components/patient/heritage';
import { useToast } from '@/hooks/use-toast';
import { useLiveOfficeScope } from '@/hooks/use-live-office-scope';
import {
  fetchOfficeFileContent,
  fetchOfficeFileDownload,
  fetchOfficeFiles,
  officeFilesQueryKey,
  officeFileSearchQueryKey,
  OfficeFilesError,
  searchOfficeFiles,
} from '@/lib/office-files';

export default function OfficeFiles() {
  const { liveEnabled, liveOffice, isDemo, isResolving, authUserId } = useLiveOfficeScope();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const search = useSearch();
  const folderId = new URLSearchParams(search).get('folder');
  const [fileSearch, setFileSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState<HqFile | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const listing = useQuery({
    queryKey: [...officeFilesQueryKey(liveOffice, folderId), authUserId],
    queryFn: () => fetchOfficeFiles(folderId, liveOffice),
    enabled: liveEnabled,
    retry: (count, error) => !(error instanceof OfficeFilesError && (error.status === 401 || error.status === 403)) && count < 2,
  });
  const fileSearchResult = useQuery({
    queryKey: [...officeFileSearchQueryKey(liveOffice, debouncedSearch), authUserId],
    queryFn: () => searchOfficeFiles(debouncedSearch, liveOffice),
    enabled: liveEnabled && debouncedSearch.length > 0,
    retry: (count, error) => !(error instanceof OfficeFilesError && (error.status === 401 || error.status === 403)) && count < 2,
  });

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(fileSearch.trim()), 250);
    return () => clearTimeout(timer);
  }, [fileSearch]);

  const goFolder = (id: string | null) => {
    setSelectedFile(null);
    setFileSearch('');
    setDebouncedSearch('');
    navigate(id ? `/files?folder=${encodeURIComponent(id)}` : '/files', { replace: true });
  };

  const handleDownload = async (file: HqFile) => {
    try {
      setDownloadingId(file.id);
      const result = await fetchOfficeFileDownload(file.id, liveOffice);
      openDownload(result.url);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Download failed',
        description: error instanceof Error ? error.message : 'Could not generate a download link.',
      });
    } finally {
      setDownloadingId(null);
    }
  };
  const loadContent = useCallback(
    (fileId: string) => fetchOfficeFileContent(fileId, liveOffice),
    [liveOffice],
  );
  const permissionError = listing.error instanceof OfficeFilesError && listing.error.status === 403
    ? listing.error
    : null;
  const data = listing.data;

  return (
    <div className="mx-auto max-w-[1320px] space-y-6 px-4 py-6 sm:px-5 sm:py-7 md:px-8">
      <PageHeader
        kicker="Office"
        title="Files"
        sub="Browse, preview, and download files shared by HQ. Your office can view these files but cannot change them."
      />
      <div role="search" className="mb-4 flex max-w-xl items-center gap-2">
        <label htmlFor="office-file-search" className="sr-only">Search files</label>
        <input id="office-file-search" type="search" value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setFileSearch(''); }} placeholder="Search files by name" className="h-10 flex-1 rounded-md border border-input bg-white px-3 text-sm" />
        {fileSearch && <button type="button" aria-label="Clear search" className={`${BTN_SECONDARY} h-10 px-3 text-lg`} onClick={() => setFileSearch('')}>×</button>}
      </div>
      <SectionCard
        title={fileSearch.trim() ? `Results for “${fileSearch.trim()}”` : 'HQ Drive'}
        sub={<span className="flex flex-wrap items-center gap-1" aria-label="Folder path"><button type="button" className="text-xs text-primary hover:underline" onClick={() => goFolder(null)}>Files</button>{data?.breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.id}><ChevronRight size={11} /><button type="button" className={index === data.breadcrumbs.length - 1 ? 'text-xs font-semibold text-navy' : 'text-xs text-primary hover:underline'} onClick={() => goFolder(crumb.id)}>{crumb.name}</button></React.Fragment>)}</span>}
      >
        {isResolving && <p className="px-5 py-8 text-xs text-muted-foreground">Checking your sign-in…</p>}
        {isDemo && <p className="px-5 py-8 text-xs text-muted-foreground">Sign in to see the files HQ shares with your office.</p>}
        {!isDemo && !isResolving && !liveEnabled && <p role="alert" className="px-5 py-8 text-xs text-muted-foreground">Open a provider account to see its shared files.</p>}
        {liveEnabled && permissionError && <p role="alert" className="px-5 py-8 text-xs text-muted-foreground">{permissionError.message}</p>}
        {liveEnabled && !permissionError && (
          <div className="px-5 py-4">
            {fileSearch.trim() ? (
              <SearchResults
                query={fileSearch.trim()}
                files={fileSearchResult.data?.files ?? []}
                loading={fileSearchResult.isLoading || debouncedSearch !== fileSearch.trim()}
                error={fileSearchResult.isError ? (fileSearchResult.error instanceof Error ? fileSearchResult.error.message : 'Could not search files right now.') : null}
                onOpen={setSelectedFile}
                onFolder={(folder) => goFolder(folder.id)}
                onDownload={handleDownload}
                downloadingId={downloadingId}
              />
            ) : listing.isPending ? (
              <p className="py-6 text-center text-xs text-muted-foreground">Loading files...</p>
            ) : listing.isError ? (
              <p role="alert" className="py-6 text-center text-xs text-destructive">{listing.error instanceof Error ? listing.error.message : 'Failed to load files.'}</p>
            ) : !data?.files.length && !data?.folders.length ? (
              <p className="py-6 text-center text-xs text-muted-foreground">Nothing here yet.</p>
            ) : data ? (
              <div className="space-y-4">
                <FolderGrid folders={data.folders} onOpen={(folder) => goFolder(folder.id)} />
                <FileTable files={data.files} downloadingId={downloadingId} onOpen={setSelectedFile} onDownload={handleDownload} />
              </div>
            ) : null}
          </div>
        )}
      </SectionCard>
      <FileDetailDialog
        file={selectedFile}
        open={selectedFile !== null}
        onOpenChange={(open) => { if (!open) setSelectedFile(null); }}
        onDownload={handleDownload}
        onFolder={(folder) => goFolder(folder.id)}
        readOnly
        loadContent={loadContent}
      />
    </div>
  );
}