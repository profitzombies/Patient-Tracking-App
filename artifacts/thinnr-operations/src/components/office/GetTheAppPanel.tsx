/**
 * "Get the app" — the front-desk QR panel on the office Patients page.
 *
 * HQ sets the App Store and Google Play listing links once (organization
 * settings); every office renders one QR code per store from exactly that
 * link, encoded locally (see lib/qr). A link HQ has not added yet shows a
 * short notice in place of the code. The print action opens a clean
 * one-page sheet (both codes + the practice name) in a new tab and triggers
 * the browser's print dialog, which also covers "save as PDF".
 *
 * The codes point at the store listings only — patients still get connected
 * to the practice through the phone-number invitation.
 */
import { useMemo } from 'react';
import { Printer, Smartphone } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { getGetOfficeSettingsQueryKey, getOfficeSettings } from '@workspace/api-client-react';
import { useSession } from '@/contexts/session';
import { demoOfficeSettings } from '@/data/hq/demo-office-settings';
import { APP_STORE_LABELS, STORE_LINK_MISSING, storeLinksOf, type StoreLink } from '@/lib/org-policy';
import { escapeAttr, qrMatrix, qrPath, qrSvgMarkup, qrViewBox } from '@/lib/qr';
import { BTN_SECONDARY, PANEL_LABEL } from '@/components/patient/heritage';
import { useToast } from '@/hooks/use-toast';

// ─── QR rendering ────────────────────────────────────────────────────────────

export function QrCodeSvg({ value, label, className }: { value: string; label: string; className?: string }) {
  const matrix = useMemo(() => qrMatrix(value), [value]);
  return (
    <svg
      viewBox={qrViewBox(matrix.size)}
      className={className}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      data-qr-value={value}
      data-qr-size={matrix.size}
    >
      <path d={qrPath(matrix)} fill="#203b64" />
    </svg>
  );
}

function StoreCode({ link }: { link: StoreLink }) {
  const labels = APP_STORE_LABELS[link.kind];
  return (
    <figure className="flex w-[7.25rem] flex-col items-center" data-testid={`store-code-${link.kind}`}>
      <div className="grid h-[6.25rem] w-[6.25rem] place-items-center rounded-md border border-border bg-white p-1.5">
        {link.url ? (
          <QrCodeSvg value={link.url} label={`${labels.store} QR code — scan to install the THINNR app`} className="h-full w-full" />
        ) : (
          <p className="text-center text-[10px] font-medium leading-snug text-muted-foreground" data-testid={`store-code-missing-${link.kind}`}>
            {STORE_LINK_MISSING}
          </p>
        )}
      </div>
      <figcaption className="mt-1.5 text-center">
        <span className="block text-[11px] font-semibold leading-tight text-navy">{labels.store}</span>
        <span className="block text-[10px] leading-tight text-muted-foreground">{labels.short}</span>
      </figcaption>
    </figure>
  );
}

// ─── Print sheet ─────────────────────────────────────────────────────────────

/** Standalone HTML for the front-desk sheet: both codes, practice name, nothing else. */
export function buildAppSheetHtml(practiceName: string, links: StoreLink[]): string {
  const codes = links
    .map((link) => {
      const labels = APP_STORE_LABELS[link.kind];
      const body = link.url
        ? qrSvgMarkup(link.url, 240, `${labels.store} QR code`)
        : `<p class="missing">${escapeAttr(STORE_LINK_MISSING)}</p>`;
      return (
        `<figure>${body}<figcaption><b>${escapeAttr(labels.store)}</b><span>${escapeAttr(labels.device)}</span></figcaption></figure>`
      );
    })
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Get the THINNR app — ${escapeAttr(practiceName)}</title>
<style>
  @page { size: letter portrait; margin: 0.75in; }
  html, body { margin: 0; padding: 0; background: #fff; color: #203b64; font-family: Inter, "Helvetica Neue", Arial, sans-serif; }
  main { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 48px 32px; box-sizing: border-box; }
  .kicker { font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #6b7a90; margin: 0 0 12px; }
  h1 { font-family: "Playfair Display", Georgia, serif; font-size: 40px; line-height: 1.1; margin: 0 0 10px; }
  .practice { font-size: 18px; margin: 0 0 40px; color: #40506a; }
  .codes { display: flex; gap: 64px; justify-content: center; flex-wrap: wrap; }
  figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 14px; }
  figure svg { display: block; border: 1px solid #d9dee8; border-radius: 12px; }
  .missing { width: 240px; height: 240px; box-sizing: border-box; margin: 0; display: grid; place-items: center; border: 1px dashed #b9c2d2; border-radius: 12px; color: #6b7a90; font-size: 14px; padding: 24px; }
  figcaption b { display: block; font-size: 20px; }
  figcaption span { display: block; font-size: 13px; color: #6b7a90; margin-top: 2px; }
  .how { margin: 44px 0 0; font-size: 14px; color: #40506a; max-width: 30rem; line-height: 1.5; }
  @media print { main { min-height: auto; } }
</style>
</head>
<body>
<main>
  <p class="kicker">THINNR</p>
  <h1>Get the app</h1>
  <p class="practice">${escapeAttr(practiceName)}</p>
  <div class="codes">${codes}</div>
  <p class="how">Open your phone’s camera, point it at the code for your phone, and tap the link to install. Sign in with the mobile number the office has on file to get connected.</p>
</main>
</body>
</html>`;
}

function openPrintSheet(html: string): boolean {
  const sheet = window.open('', '_blank', 'noopener=no');
  if (!sheet) return false;
  sheet.document.open();
  sheet.document.write(html);
  sheet.document.close();
  sheet.focus();
  // Let the new document lay out (and fonts settle) before the print dialog.
  sheet.setTimeout(() => sheet.print(), 250);
  return true;
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export interface GetTheAppPanelProps {
  practiceName: string;
  hq: Parameters<typeof storeLinksOf>[0] | null;
  /** Live fetch still pending or failed → an honest placeholder, never demo links. */
  status?: 'ready' | 'loading' | 'error';
  className?: string;
}

export function GetTheAppPanel({ practiceName, hq, status = 'ready', className = '' }: GetTheAppPanelProps) {
  const { toast } = useToast();
  const links = hq ? storeLinksOf(hq) : null;
  const anyCode = Boolean(links?.some((link) => link.url));

  const print = () => {
    if (!links) return;
    if (!openPrintSheet(buildAppSheetHtml(practiceName, links))) {
      toast({
        variant: 'destructive',
        title: 'Couldn’t open the print sheet',
        description: 'Your browser blocked the new tab. Allow pop-ups for this site and try again.',
      });
    }
  };

  return (
    <section
      className={`rounded-lg border border-card-border bg-card px-4 py-3 shadow-soft ${className}`}
      aria-labelledby="get-the-app-title"
      data-testid="panel-get-the-app"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id="get-the-app-title" className="flex items-center gap-1.5 font-serif text-[15px] font-bold leading-snug text-navy">
            <Smartphone size={14} aria-hidden="true" className="text-primary" />
            Get the app
          </h2>
          <p className="mt-0.5 max-w-[26ch] text-[11px] leading-snug text-muted-foreground">
            Patients scan from their phone to install THINNR.
          </p>
        </div>
        <button
          type="button"
          className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`}
          onClick={print}
          disabled={!links || !anyCode}
          aria-disabled={!links || !anyCode ? true : undefined}
          title={anyCode ? 'Print or save a one-page sheet for the front desk' : 'Available once HQ adds a store link'}
          data-testid="button-print-app-sheet"
        >
          <Printer size={13} aria-hidden="true" className="mr-1.5" />
          Print sheet
        </button>
      </div>
      <div className="mt-3 flex items-start gap-4">
        {links ? (
          links.map((link) => <StoreCode key={link.kind} link={link} />)
        ) : (
          <p className={`${PANEL_LABEL} py-6`} role="status" data-testid="text-get-the-app-status">
            {status === 'error' ? 'Couldn’t load HQ’s store links.' : 'Loading store links…'}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The Patients page wiring: signed-in offices read the live HQ value from the
 * office settings endpoint (HQ drill-ins pass the office they are viewing);
 * the guided demo shows the seeded placeholder links. Signed-in HQ staff who
 * have not drilled into an office see nothing rather than demo links.
 * Signed-in provider staff do not see the panel on their roster (owner
 * request, 2026-09-28); their store links stay in Office settings.
 */
export function OfficeGetTheAppPanel({ liveEnabled, liveOffice, className }: { liveEnabled: boolean; liveOffice: string | null; className?: string }) {
  const { authStatus, authRole, authUser } = useSession();
  const hiddenForProvider = authStatus === 'signed-in' && authRole === 'provider_staff';
  const params = liveOffice ? { office: liveOffice } : undefined;
  const query = useQuery({
    queryKey: [...getGetOfficeSettingsQueryKey(params), authUser?.id],
    queryFn: () => getOfficeSettings(params),
    enabled: liveEnabled && !hiddenForProvider,
    staleTime: 60_000,
  });

  if (hiddenForProvider) return null;
  if (liveEnabled) {
    const data = query.data;
    return (
      <GetTheAppPanel
        practiceName={data?.office.officeName ?? 'Your practice'}
        hq={data?.hq ?? null}
        status={query.isError ? 'error' : 'loading'}
        className={className}
      />
    );
  }
  if (authStatus === 'signed-in') return null;
  const demo = demoOfficeSettings();
  return <GetTheAppPanel practiceName={demo.office.officeName} hq={demo.hq} className={className} />;
}
