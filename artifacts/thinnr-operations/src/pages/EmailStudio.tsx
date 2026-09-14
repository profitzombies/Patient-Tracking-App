import { useEffect, useState, useMemo } from 'react';
import { EMAIL_TEMPLATE_CATALOG, renderEmailTemplate, type EmailTemplateId } from '@workspace/email-templates';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SectionCard, MICRO_LABEL } from '@/components/patient/heritage';
import { copyText } from '@/components/admin/primitives';
import { Copy, Check, Code, AlignLeft, Smartphone, Monitor } from 'lucide-react';
import { Link } from 'wouter';

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      onClick={async () => {
        const ok = await copyText(text);
        setStatus(ok ? 'copied' : 'failed');
        window.setTimeout(() => setStatus('idle'), 2000);
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.06em] text-foreground shadow-xs transition hover:bg-accent hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-live="polite"
      title={`Copy ${label.toLowerCase()} to clipboard`}
      type="button"
    >
      {status === 'copied' ? <Check size={12} className="text-primary" aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      <span>{status === 'copied' ? 'Copied' : status === 'failed' ? 'Couldn’t copy' : label}</span>
    </button>
  );
}

export default function EmailStudio() {
  // ?template=<id> opens a specific proof so links to one email can be shared.
  const [selectedId, setSelectedId] = useState<EmailTemplateId>(() => {
    const requested = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('template');
    return EMAIL_TEMPLATE_CATALOG.find(t => t.id === requested)?.id ?? EMAIL_TEMPLATE_CATALOG[0].id;
  });

  // Set Document Title
  useEffect(() => {
    const originalTitle = document.title;
    document.title = 'THINNR Email Studio | Proofing Desk';
    const meta = document.createElement('meta');
    meta.name = 'description';
    meta.content = 'Owner-facing proofing desk for THINNR transactional emails.';
    document.head.appendChild(meta);
    return () => {
      document.title = originalTitle;
      document.head.removeChild(meta);
    };
  }, []);

  const template = useMemo(() => {
    return EMAIL_TEMPLATE_CATALOG.find(t => t.id === selectedId) ?? EMAIL_TEMPLATE_CATALOG[0];
  }, [selectedId]);

  const preview = useMemo(() => {
    return renderEmailTemplate(template.id, template.sampleVariables);
  }, [template]);

  return (
    <div className="flex min-h-[100dvh] flex-col md:flex-row bg-[#f2f3f4] text-[#26364b] font-sans">
      <aside className="w-full md:w-[280px] shrink-0 border-b md:border-b-0 md:border-r border-[#d8e0e9] bg-[#fdfcf9] flex flex-col h-auto md:h-[100dvh] md:sticky top-0 z-10">
        <div className="p-5 border-b border-[#d8e0e9]">
          <Link href="/" className="inline-flex items-center gap-2 text-navy hover:opacity-80 transition-opacity">
            <div className="flex h-6 w-6 items-center justify-center rounded-sm bg-navy text-white font-serif font-bold text-xs">
              TH
            </div>
            <span className="font-serif font-semibold text-sm tracking-wide">Operations</span>
          </Link>
          <h1 className="mt-6 text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">
            Email Studio
          </h1>
            <p className="mt-1 text-xs text-muted-foreground">Proofing desk</p>
            <p className="mt-4 rounded-md border border-accent-border bg-accent px-3 py-2 text-[10px] font-semibold leading-relaxed text-navy">
              Fictional samples only. No sends, recipient data, or delivery history.
            </p>
        </div>
        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {EMAIL_TEMPLATE_CATALOG.map(item => {
            const isActive = item.id === selectedId;
            return (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`w-full text-left px-3 py-2.5 rounded-md text-sm font-medium transition-colors border ${
                  isActive 
                    ? 'bg-[#e3ecf7] text-[#315eae] border-[#b7cbe8]' 
                    : 'bg-transparent text-foreground border-transparent hover:bg-[#f5f7f9] hover:border-[#d8e0e9]'
                }`}
              >
                {item.name}
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-[1200px] mx-auto p-4 md:p-8 space-y-6">
          <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">Template Proof</p>
              <h2 className="mt-1 font-serif text-[26px] font-bold leading-tight tracking-[-.01em] text-navy">
                {template.name}
              </h2>
            </div>
            <div className="flex items-center gap-2 bg-white rounded-md border border-[#d8e0e9] px-3 py-2 shadow-soft max-w-full">
              <span className={`${MICRO_LABEL} shrink-0`}>Subject</span>
              <span className="font-mono text-xs font-medium text-navy truncate">{preview.subject}</span>
              <div className="ml-2 pl-2 border-l border-border shrink-0">
                <CopyButton text={preview.subject} label="Copy subject" />
              </div>
            </div>
          </header>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 space-y-6">
              <SectionCard title="Metadata">
                <div className="p-4 space-y-4 text-sm">
                  <div>
                    <h3 className={MICRO_LABEL}>Purpose</h3>
                    <p className="mt-1 text-foreground leading-relaxed">{template.purpose}</p>
                  </div>
                  <hr className="border-border" />
                  <div>
                    <h3 className={MICRO_LABEL}>Trigger</h3>
                    <p className="mt-1 text-foreground leading-relaxed">{template.trigger}</p>
                  </div>
                  <hr className="border-border" />
                  <div>
                    <h3 className={MICRO_LABEL}>Audience</h3>
                    <p className="mt-1 text-foreground leading-relaxed">{template.audience}</p>
                  </div>
                  <hr className="border-border" />
                  <div>
                    <h3 className={MICRO_LABEL}>Inbox preview</h3>
                    <p className="mt-1 text-foreground leading-relaxed">{preview.previewText}</p>
                  </div>
                </div>
              </SectionCard>

              <SectionCard title="Sample Variables">
                <div className="p-4">
                  <div className="p-3 overflow-x-auto text-[11px] font-mono rounded-md border border-border bg-white text-[#26364b] shadow-inner">
                    <pre>{JSON.stringify(template.sampleVariables, null, 2)}</pre>
                  </div>
                </div>
              </SectionCard>
            </div>

            <div className="lg:col-span-2">
              <SectionCard 
                title="Rendering" 
                action={<CopyButton text={preview.html} label="Copy HTML" />}
                className="h-full flex flex-col min-h-[600px]"
              >
                <Tabs defaultValue="desktop" className="flex flex-col flex-1 h-full w-full border-t border-border">
                  <div className="px-4 py-2 border-b border-border bg-[#f9faf8]">
                    <TabsList className="bg-[#e5edf7] p-1 h-auto">
                      <TabsTrigger value="desktop" className="text-xs py-1.5 px-3 data-[state=active]:bg-white data-[state=active]:text-primary data-[state=active]:shadow-sm"><Monitor size={14} className="mr-1.5" /> Desktop</TabsTrigger>
                      <TabsTrigger value="mobile" className="text-xs py-1.5 px-3 data-[state=active]:bg-white data-[state=active]:text-primary data-[state=active]:shadow-sm"><Smartphone size={14} className="mr-1.5" /> Mobile</TabsTrigger>
                      <TabsTrigger value="html" className="text-xs py-1.5 px-3 data-[state=active]:bg-white data-[state=active]:text-primary data-[state=active]:shadow-sm"><Code size={14} className="mr-1.5" /> HTML</TabsTrigger>
                      <TabsTrigger value="text" className="text-xs py-1.5 px-3 data-[state=active]:bg-white data-[state=active]:text-primary data-[state=active]:shadow-sm"><AlignLeft size={14} className="mr-1.5" /> Text</TabsTrigger>
                    </TabsList>
                  </div>

                  <div className="p-4 bg-[#f2f3f4] flex-1 flex flex-col items-center justify-start overflow-hidden">
                    <TabsContent value="desktop" className="w-full h-full min-h-[500px] m-0 data-[state=inactive]:hidden flex flex-col rounded-md shadow-lifted border border-border overflow-hidden bg-white">
                      <iframe
                        title="Desktop Preview"
                        srcDoc={preview.html}
                        className="w-full flex-1 border-0 bg-white"
                        sandbox="allow-same-origin"
                      />
                    </TabsContent>
                    
                     <TabsContent value="mobile" className="w-full max-w-[375px] h-full min-h-[500px] m-0 data-[state=inactive]:hidden flex flex-col rounded-md shadow-lifted border border-border overflow-hidden bg-white shrink-0">
                      <div className="bg-navy px-4 py-1.5 text-center flex justify-between items-center shrink-0">
                         <span className="text-[9px] text-white/70">9:41</span>
                         <span className="text-[9px] text-white/70 tracking-widest" aria-hidden="true">•••</span>
                      </div>
                      <iframe
                        title="Mobile Preview"
                        srcDoc={preview.html}
                        className="w-full flex-1 border-0 bg-white"
                        sandbox="allow-same-origin"
                      />
                    </TabsContent>

                    <TabsContent value="html" className="w-full h-full min-h-[500px] m-0 data-[state=inactive]:hidden flex flex-col">
                      <div className="w-full flex-1 overflow-auto bg-white rounded-md border border-border p-4 shadow-inner">
                        <pre className="text-xs font-mono text-[#26364b] whitespace-pre-wrap break-all">
                          {preview.html}
                        </pre>
                      </div>
                    </TabsContent>

                    <TabsContent value="text" className="w-full h-full min-h-[500px] m-0 data-[state=inactive]:hidden flex flex-col relative">
                      <div className="absolute top-4 right-4">
                        <CopyButton text={preview.text} label="Copy Text" />
                      </div>
                      <div className="w-full flex-1 overflow-auto bg-white rounded-md border border-border p-6 shadow-inner">
                        <pre className="text-sm font-mono text-[#26364b] whitespace-pre-wrap font-medium">
                          {preview.text}
                        </pre>
                      </div>
                    </TabsContent>
                  </div>
                </Tabs>
              </SectionCard>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
