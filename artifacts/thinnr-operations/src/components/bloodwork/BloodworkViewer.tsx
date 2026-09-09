import { useEffect, useState, useRef } from 'react';
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut, Loader2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { getBloodworkFilePage, getBloodworkFileSource, type BloodworkReport, type BloodworkFile } from '@workspace/api-client-react';

interface BloodworkViewerProps {
  patientId: string;
  office: string | null;
  report: BloodworkReport;
  files: BloodworkFile[];
  initialPage?: { fileId: string, page: number };
  onClose: () => void;
}

export function BloodworkViewer({ patientId, office, report, files, initialPage, onClose }: BloodworkViewerProps) {
  const [pages, setPages] = useState<{ fileId: string; page: number }[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [zoom, setZoom] = useState(1);
  const activeUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list: { fileId: string; page: number }[] = [];
    // Sort files by position
    const sortedFiles = [...files].sort((a, b) => a.position - b.position);
    for (const file of sortedFiles) {
      for (let i = 1; i <= file.pageCount; i++) {
        list.push({ fileId: file.id, page: i });
      }
    }
    setPages(list);
    
    if (initialPage) {
      const idx = list.findIndex(p => p.fileId === initialPage.fileId && p.page === initialPage.page);
      if (idx !== -1) {
        setCurrentIndex(idx);
      }
    } else {
      setCurrentIndex(0);
    }
  }, [files, initialPage]);

  useEffect(() => {
    if (pages.length === 0) return;
    const current = pages[currentIndex];
    
    let isMounted = true;
    setLoading(true);
    setError(false);
    
    getBloodworkFilePage(
      patientId, 
      report.id, 
      current.fileId, 
      current.page, 
      office ? { office } : undefined,
      { responseType: 'blob' }
    )
      .then((blob) => {
        if (!isMounted) return;
        const url = URL.createObjectURL(blob);
        if (activeUrlRef.current) URL.revokeObjectURL(activeUrlRef.current);
        activeUrlRef.current = url;
        setBlobUrl(url);
        setLoading(false);
        setZoom(1);
      })
      .catch(() => {
        if (isMounted) {
          setError(true);
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [currentIndex, pages, patientId, office, report.id]);

  useEffect(() => {
    // Revoke on close
    return () => {
      mountedRef.current = false;
      if (activeUrlRef.current) {
        URL.revokeObjectURL(activeUrlRef.current);
        activeUrlRef.current = null;
      }
    };
  }, []);

  const handleNext = () => setCurrentIndex((c) => Math.min(pages.length - 1, c + 1));
  const handlePrev = () => setCurrentIndex((c) => Math.max(0, c - 1));

  // Handle keyboard events (escape, arrows, plus/minus for zoom)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') handleNext();
      if (e.key === 'ArrowLeft') handlePrev();
      if (e.key === '=' || e.key === '+') setZoom((z) => Math.min(3, z + 0.25));
      if (e.key === '-' || e.key === '_') setZoom((z) => Math.max(0.5, z - 0.25));
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Focus trap and block body scroll
  useEffect(() => {
    const originalStyle = window.getComputedStyle(document.body).overflow;
    document.body.style.overflow = 'hidden';
    containerRef.current?.focus();
    
    return () => {
      document.body.style.overflow = originalStyle;
    };
  }, []);

  const handleDownload = async () => {
    if (pages.length === 0 || downloading) return;
    const current = pages[currentIndex];
    const file = files.find(f => f.id === current.fileId);
    if (!file) return;

    try {
      setDownloading(true);
      const blob = await getBloodworkFileSource(
        patientId,
        report.id,
        current.fileId,
        office ? { office } : undefined,
        { responseType: 'blob' }
      );
      // The initiating actor may have switched while the private source was
      // downloading. Never create/click a link after this viewer is gone.
      if (!mountedRef.current) return;
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Provide a sensible default extension based on MIME if possible, or just the original report kind
      const ext = file.mimeType.includes('pdf') ? 'pdf' : file.mimeType.includes('png') ? 'png' : 'jpg';
      a.download = `bloodwork-${report.id}-${current.fileId}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (mountedRef.current) console.error('Download failed', e);
    } finally {
      if (mountedRef.current) setDownloading(false);
    }
  };

  return createPortal(
    <div 
      ref={containerRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white backdrop-blur-sm outline-none" 
      role="dialog" 
      aria-modal="true" 
      aria-label="Bloodwork source viewer"
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4">
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold">{report.title}</span>
          <span className="text-xs text-white/50">
            Page {currentIndex + 1} of {pages.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} className="p-2 text-white/70 hover:text-white" aria-label="Zoom out"><ZoomOut size={18} /></button>
          <button onClick={() => setZoom((z) => Math.min(3, z + 0.25))} className="p-2 text-white/70 hover:text-white" aria-label="Zoom in"><ZoomIn size={18} /></button>
          <button 
            onClick={handleDownload}
            disabled={downloading}
            className="p-2 text-white/70 hover:text-white disabled:opacity-50"
            title="Download source"
            aria-label="Download original source file"
          >
            {downloading ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
          </button>
          <div className="mx-2 h-4 w-px bg-white/20" />
          <button onClick={onClose} className="p-2 text-white/70 hover:text-white" aria-label="Close viewer"><X size={20} /></button>
        </div>
      </header>

      <div className="relative flex flex-1 items-center justify-center overflow-auto">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/20 border-t-white" />
          </div>
        )}
        
        {error && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white/50">
            <X size={48} className="mb-4" />
            <p>Could not load page image</p>
          </div>
        )}

        {blobUrl && !loading && !error && (
          <div className="flex min-h-full min-w-full items-center justify-center p-4">
            <img 
              src={blobUrl} 
              alt={`Page ${currentIndex + 1}`} 
              className="max-w-none transition-transform duration-200"
              style={{ 
                transform: `scale(${zoom})`,
                transformOrigin: 'center center',
                maxHeight: zoom === 1 ? '100%' : 'none',
                maxWidth: zoom === 1 ? '100%' : 'none'
              }}
            />
          </div>
        )}
      </div>

      <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
        <button 
          onClick={handlePrev} 
          disabled={currentIndex === 0}
          className="pointer-events-auto rounded-full bg-black/50 p-3 text-white backdrop-blur hover:bg-black/70 disabled:opacity-0 transition-opacity"
          aria-label="Previous page"
        >
          <ChevronLeft size={24} />
        </button>
      </div>
      
      <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none">
        <button 
          onClick={handleNext} 
          disabled={currentIndex === pages.length - 1}
          className="pointer-events-auto rounded-full bg-black/50 p-3 text-white backdrop-blur hover:bg-black/70 disabled:opacity-0 transition-opacity"
          aria-label="Next page"
        >
          <ChevronRight size={24} />
        </button>
      </div>
    </div>,
    document.body
  );
}
