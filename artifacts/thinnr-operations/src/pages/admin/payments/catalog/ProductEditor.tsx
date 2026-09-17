/**
 * Full-page product editor at /catalog/products/new and /catalog/products/:id.
 * Same two-column shape as the Training video editor: pictures and details on
 * the left, uploads and status on the right. New products save first, then
 * unlock image uploads (images need a product id to attach to).
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { ImagePlus, Star, Trash2, Upload } from 'lucide-react';
import { AdminPage } from '@/components/admin/primitives';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, SectionCard } from '@/components/patient/heritage';
import { MoneyInput } from '@/components/billing/MoneyInput';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useHqCatalog, useHqCatalogMutations, useHqProduct } from '@/hooks/use-billing';
import { centsToDollarsInput, formatCents, formatDateTime, parseDollarsToCents } from '@/lib/billing-format';
import {
  CADENCE_WEEKS,
  COACH_SIGNAL_LABELS,
  COACH_SUGGESTION_SIGNALS,
  EMPTY_COACH_SUGGESTION,
  type BillingSettings,
  type CadenceWeeks,
  type CatalogProductDetail,
  type CoachSuggestionSignal,
  type ProductCategory,
  type ProductFactRow,
  type ProductFaq,
  type ProductImage,
  type ProductStatus,
} from '@/lib/billing-types';
import { DEMO_CATALOG } from '../demo-data';
import { useBillingSandbox } from '../use-billing-sandbox';
import { ErrorBox, Gate, Header, Preview } from './../shared';
import {
  CADENCE_LABEL,
  FIELD_LABEL,
  PRODUCT_CATEGORY_LABEL,
  PRODUCT_STATUS_HELP,
  PRODUCT_STATUS_LABEL,
  ProductStatusPill,
  ProductThumb,
  productMath,
  type FeeSettings,
} from './shared';

export const MAX_PRODUCT_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

export function ProductEditorPage({ params }: { params: { productId?: string } }) {
  const productId = params.productId && params.productId !== 'new' ? params.productId : null;
  return <Gate>{(demo, canWrite) => <EditorLoader demo={demo} canWrite={canWrite} productId={productId} />}</Gate>;
}

function demoDetail(productId: string | null): CatalogProductDetail | null {
  const product = DEMO_CATALOG.products.find((p) => p.id === productId);
  return product ? { ...product, images: [] } : null;
}

function EditorLoader({ demo, canWrite, productId }: { demo: boolean; canWrite: boolean; productId: string | null }) {
  const catalog = useHqCatalog();
  const product = useHqProduct(demo ? null : productId);
  const sandbox = useBillingSandbox();
  const settings = demo ? DEMO_CATALOG.settings : catalog.data?.settings;
  const detail = demo ? demoDetail(productId) : product.data?.product ?? null;
  const loading = !demo && (catalog.isPending || (productId !== null && product.isPending));
  const error = !demo ? catalog.error ?? product.error : null;
  if (loading)
    return (
      <AdminPage>
        <Skeleton className="h-96" />
      </AdminPage>
    );
  if (error || !settings)
    return (
      <AdminPage>
        <Header title="Product" sub="" tabs={false} back={{ href: '/catalog', label: '← Back to product catalog' }} sandbox={sandbox.data?.sandbox} />
        <ErrorBox
          error={error ?? new Error('The catalog could not be loaded.')}
          retry={() => {
            void catalog.refetch();
            void product.refetch();
          }}
        />
      </AdminPage>
    );
  if (productId && !detail)
    return (
      <AdminPage>
        <Header title="Product not found" sub="It may have been removed from the catalog." tabs={false} back={{ href: '/catalog', label: '← Back to product catalog' }} />
      </AdminPage>
    );
  return <Editor key={detail?.id ?? 'new'} demo={demo} canWrite={canWrite} product={detail} settings={settings} sandbox={sandbox.data?.sandbox} />;
}

interface Draft {
  name: string;
  description: string;
  floor: string;
  hard: string;
  category: ProductCategory;
  tagline: string;
  format: string;
  /** One benefit per line. */
  benefits: string;
  how_to_take: string;
  facts_title: string;
  /** One row per line: "Name — detail" (detail optional). */
  facts: string;
  /** Blank-line-separated blocks: question on the first line, answer below. */
  faqs: string;
  disclaimer: string;
  cadences: CadenceWeeks[];
  default_cadence: CadenceWeeks;
  /** Coach suggestion rule: which patient signals make the coach offer this product. */
  coach_signals: CoachSuggestionSignal[];
  coach_avoid_signals: CoachSuggestionSignal[];
  coach_phrasing: string;
  coach_bloodwork_covered: boolean;
  /** One conversation phrase per line. */
  coach_topics: string;
}

const FACT_SEPARATOR = ' — ';

export function factsToText(facts: ProductFactRow[]): string {
  return facts.map((fact) => (fact.detail ? `${fact.name}${FACT_SEPARATOR}${fact.detail}` : fact.name)).join('\n');
}
export function parseFacts(text: string): ProductFactRow[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(FACT_SEPARATOR);
      if (at === -1) return { name: line, detail: null };
      const detail = line.slice(at + FACT_SEPARATOR.length).trim();
      return { name: line.slice(0, at).trim(), detail: detail || null };
    });
}
export function faqsToText(faqs: ProductFaq[]): string {
  return faqs.map((faq) => `${faq.question}\n${faq.answer}`).join('\n\n');
}
export function parseFaqs(text: string): ProductFaq[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [question, ...rest] = block.split('\n');
      return { question: question.trim(), answer: rest.join('\n').trim() };
    });
}
export function parseLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function draftOf(product: CatalogProductDetail | null): Draft {
  return {
    name: product?.name ?? '',
    description: product?.description ?? '',
    floor: centsToDollarsInput(product?.floor_price_cents),
    hard: centsToDollarsInput(product?.hard_cost_cents),
    category: product?.category ?? 'supplement',
    tagline: product?.tagline ?? '',
    format: product?.format ?? '',
    benefits: (product?.benefits ?? []).join('\n'),
    how_to_take: product?.how_to_take ?? '',
    facts_title: product?.facts_title ?? '',
    facts: factsToText(product?.facts ?? []),
    faqs: faqsToText(product?.faqs ?? []),
    disclaimer: product?.disclaimer ?? '',
    cadences: product?.offered_cadences_weeks ?? [...CADENCE_WEEKS],
    default_cadence: product?.default_cadence_weeks ?? 4,
    coach_signals: product?.coach_suggestion?.signals ?? EMPTY_COACH_SUGGESTION.signals,
    coach_avoid_signals: product?.coach_suggestion?.avoid_signals ?? EMPTY_COACH_SUGGESTION.avoid_signals,
    coach_phrasing: product?.coach_suggestion?.phrasing ?? '',
    coach_bloodwork_covered: product?.coach_suggestion?.bloodwork_covered ?? false,
    coach_topics: (product?.coach_suggestion?.topics ?? []).join('\n'),
  };
}

function Editor({
  demo,
  canWrite,
  product,
  settings,
  sandbox,
}: {
  demo: boolean;
  canWrite: boolean;
  product: CatalogProductDetail | null;
  settings: FeeSettings & Pick<BillingSettings, 'subscribe_save_enabled' | 'subscribe_save_percent'>;
  sandbox?: boolean;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const mutations = useHqCatalogMutations();
  const [draft, setDraft] = useState<Draft>(() => draftOf(product));
  const [saved, setSaved] = useState<Draft>(() => draftOf(product));
  const savedRef = useRef(saved);
  const [error, setError] = useState<string | null>(null);
  const [startAsDraft, setStartAsDraft] = useState(false);
  const productVersion = product ? `${product.id}:${product.updated_at}` : 'new';
  useEffect(() => {
    // A server save (status change, image edits) refreshes the baseline without discarding unsaved typing.
    const next = draftOf(product);
    const previous = savedRef.current;
    savedRef.current = next;
    setSaved(next);
    setDraft((current) => (isEqual(current, previous) ? next : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productVersion]);
  const dirty = !isEqual(draft, saved);
  const parsedFloor = parseDollarsToCents(draft.floor);
  const parsedHard = parseDollarsToCents(draft.hard);
  const math = parsedFloor.ok ? productMath(parsedFloor.cents, parsedHard.ok ? parsedHard.cents : null, settings) : null;
  const readOnly = !canWrite;
  const pending = mutations.create.isPending || mutations.update.isPending;
  const previewOnly = () => {
    toast({ title: 'Preview only', description: 'Sign in to change the live catalog.' });
  };

  const save = () => {
    if (!draft.name.trim()) {
      setError('Enter a product name.');
      return;
    }
    if (!parsedFloor.ok) {
      setError(`Floor price: ${parsedFloor.error}`);
      return;
    }
    if (!parsedHard.ok) {
      setError(`Hard cost: ${parsedHard.error}`);
      return;
    }
    if (draft.cadences.length === 0) {
      setError('Offer at least one subscription cadence.');
      return;
    }
    if (!draft.cadences.includes(draft.default_cadence)) {
      setError('The default cadence must be one of the offered cadences.');
      return;
    }
    const faqs = parseFaqs(draft.faqs);
    if (faqs.some((faq) => !faq.answer)) {
      setError('Every FAQ needs an answer on the line below its question.');
      return;
    }
    setError(null);
    if (demo) {
      previewOnly();
      return;
    }
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      floor_price_cents: parsedFloor.cents,
      hard_cost_cents: parsedHard.cents,
      category: draft.category,
      tagline: draft.tagline.trim(),
      format: draft.format.trim(),
      benefits: parseLines(draft.benefits),
      how_to_take: draft.how_to_take.trim(),
      facts_title: draft.facts_title.trim(),
      facts: parseFacts(draft.facts),
      faqs,
      disclaimer: draft.disclaimer.trim(),
      offered_cadences_weeks: [...draft.cadences].sort((x, y) => x - y),
      default_cadence_weeks: draft.default_cadence,
      coach_suggestion: {
        signals: draft.coach_signals,
        avoid_signals: draft.coach_avoid_signals,
        phrasing: draft.coach_phrasing.trim(),
        bloodwork_covered: draft.coach_bloodwork_covered,
        topics: parseLines(draft.coach_topics).map((topic) => topic.toLowerCase()),
      },
    };
    const fail = (err: Error) => setError(err.message);
    if (product) {
      mutations.update.mutate(
        { productId: product.id, ...body },
        { onSuccess: () => toast({ variant: 'success', title: 'Product saved' }), onError: fail },
      );
    } else {
      mutations.create.mutate(
        { ...body, status: startAsDraft ? 'draft' : 'active' },
        {
          onSuccess: (result) => {
            toast({ variant: 'success', title: startAsDraft ? 'Draft saved' : 'Product added', description: 'You can add pictures now.' });
            navigate(`/catalog/products/${result.product.id}`, { replace: true });
          },
          onError: fail,
        },
      );
    }
  };
  const setStatus = (status: ProductStatus) => {
    if (!product) return;
    if (demo) {
      previewOnly();
      return;
    }
    mutations.setStatus.mutate(
      { productId: product.id, status },
      {
        onSuccess: () => toast({ variant: 'success', title: `${product.name} is now ${PRODUCT_STATUS_LABEL[status].toLowerCase()}` }),
        onError: (err) => toast({ variant: 'destructive', title: 'Status not changed', description: err.message }),
      },
    );
  };

  return (
    <AdminPage>
      <Header
        title={product ? product.name : 'New product'}
        sub={product ? `Last changed ${formatDateTime(product.updated_at)}` : 'Name it, set the floor and cost, then add pictures.'}
        tabs={false}
        sandbox={sandbox}
        back={{ href: '/catalog', label: '← Back to product catalog' }}
        action={
          <div className="flex items-center gap-3">
            {product && <ProductStatusPill status={product.status} testId="pill-product-status" />}
            {dirty && (
              <button type="button" className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground" onClick={() => setDraft(saved)}>
                Discard
              </button>
            )}
            {canWrite && (
              <button
                type="button"
                className={`${BTN_PRIMARY} h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50`}
                data-testid="button-catalog-save"
                disabled={pending || (product !== null && !dirty)}
                onClick={save}
              >
                {pending ? 'Saving…' : product ? 'Save changes' : startAsDraft ? 'Save draft' : 'Add product'}
              </button>
            )}
          </div>
        }
      />
      {demo && <Preview />}
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 lg:flex-row">
        <div className="flex min-w-0 flex-col gap-6 lg:w-[60%]">
          <Gallery product={product} demo={demo} canWrite={canWrite} mutations={mutations} draftName={draft.name} />
          <SectionCard title="Details" sub="What offices and patients see on the pay page.">
            <div className="space-y-5 p-5">
              <label className="block">
                <span className={FIELD_LABEL}>Name</span>
                <input
                  data-testid="input-catalog-name"
                  className={`${INPUT_CLASS} h-9 w-full`}
                  value={draft.name}
                  disabled={readOnly}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                <label className="block">
                  <span className={FIELD_LABEL}>Tagline</span>
                  <input
                    data-testid="input-catalog-tagline"
                    className={`${INPUT_CLASS} h-9 w-full`}
                    value={draft.tagline}
                    disabled={readOnly}
                    maxLength={120}
                    placeholder="e.g. Metabolic & Appetite Support"
                    onChange={(e) => setDraft((d) => ({ ...d, tagline: e.target.value }))}
                  />
                </label>
                <label className="block">
                  <span className={FIELD_LABEL}>Category</span>
                  <select
                    data-testid="select-catalog-category"
                    className={`${INPUT_CLASS} h-9 w-full`}
                    value={draft.category}
                    disabled={readOnly}
                    onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value as ProductCategory }))}
                  >
                    {(Object.keys(PRODUCT_CATEGORY_LABEL) as ProductCategory[]).map((category) => (
                      <option key={category} value={category}>
                        {PRODUCT_CATEGORY_LABEL[category]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block">
                <span className={FIELD_LABEL}>Description</span>
                <textarea
                  data-testid="input-catalog-description"
                  className={`${INPUT_CLASS} min-h-[96px] w-full resize-y py-2 leading-relaxed`}
                  value={draft.description}
                  disabled={readOnly}
                  maxLength={2000}
                  placeholder="One or two sentences on what it does and who it is for."
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                />
                <span className="mt-1 block text-right text-[10px] text-muted-foreground">{draft.description.length}/2000</span>
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className={FIELD_LABEL}>Floor price</span>
                  <MoneyInput
                    data-testid="input-catalog-floor"
                    value={draft.floor}
                    disabled={readOnly}
                    invalid={draft.floor !== '' && !parsedFloor.ok}
                    onChange={(e) => setDraft((d) => ({ ...d, floor: e.target.value }))}
                  />
                  <span className="mt-1 block text-[11px] text-muted-foreground">The lowest list price; THINNR keeps 60% of it.</span>
                </label>
                <label className="block">
                  <span className={FIELD_LABEL}>Hard cost</span>
                  <MoneyInput
                    data-testid="input-catalog-hard-cost"
                    value={draft.hard}
                    disabled={readOnly}
                    invalid={draft.hard !== '' && !parsedHard.ok}
                    onChange={(e) => setDraft((d) => ({ ...d, hard: e.target.value }))}
                  />
                  <span className="mt-1 block text-[11px] text-muted-foreground">What each unit costs THINNR to supply.</span>
                </label>
              </div>
            </div>
          </SectionCard>
          <SectionCard title="Product page" sub="The full page patients read in the app. Drafted from the program documents; every field is yours to edit.">
            <div className="space-y-5 p-5" data-testid="catalog-product-page">
              <label className="block">
                <span className={FIELD_LABEL}>Format</span>
                <input
                  data-testid="input-catalog-format"
                  className={`${INPUT_CLASS} h-9 w-full`}
                  value={draft.format}
                  disabled={readOnly}
                  maxLength={160}
                  placeholder="e.g. Dietary Supplement · 60 Vegetarian Capsules"
                  onChange={(e) => setDraft((d) => ({ ...d, format: e.target.value }))}
                />
              </label>
              <LinesField
                testId="input-catalog-benefits"
                label="Benefits"
                help="One benefit per line."
                value={draft.benefits}
                disabled={readOnly}
                onChange={(benefits) => setDraft((d) => ({ ...d, benefits }))}
              />
              <label className="block">
                <span className={FIELD_LABEL}>How to take it</span>
                <textarea
                  data-testid="input-catalog-how-to-take"
                  className={`${INPUT_CLASS} min-h-[72px] w-full resize-y py-2 leading-relaxed`}
                  value={draft.how_to_take}
                  disabled={readOnly}
                  maxLength={1000}
                  onChange={(e) => setDraft((d) => ({ ...d, how_to_take: e.target.value }))}
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-[220px_minmax(0,1fr)]">
                <label className="block">
                  <span className={FIELD_LABEL}>Facts heading</span>
                  <input
                    data-testid="input-catalog-facts-title"
                    className={`${INPUT_CLASS} h-9 w-full`}
                    value={draft.facts_title}
                    disabled={readOnly}
                    maxLength={80}
                    placeholder="Key Ingredients"
                    onChange={(e) => setDraft((d) => ({ ...d, facts_title: e.target.value }))}
                  />
                </label>
                <LinesField
                  testId="input-catalog-facts"
                  label="Supplement facts / ingredients"
                  help={`One row per line as "Name${FACT_SEPARATOR}detail"; the detail is optional.`}
                  value={draft.facts}
                  disabled={readOnly}
                  onChange={(facts) => setDraft((d) => ({ ...d, facts }))}
                />
              </div>
              <LinesField
                testId="input-catalog-faqs"
                label="FAQs"
                help="Question on one line, its answer on the next; leave a blank line between questions."
                value={draft.faqs}
                disabled={readOnly}
                tall
                onChange={(faqs) => setDraft((d) => ({ ...d, faqs }))}
              />
              <label className="block">
                <span className={FIELD_LABEL}>Disclaimer</span>
                <textarea
                  data-testid="input-catalog-disclaimer"
                  className={`${INPUT_CLASS} min-h-[60px] w-full resize-y py-2 leading-relaxed`}
                  value={draft.disclaimer}
                  disabled={readOnly}
                  maxLength={600}
                  onChange={(e) => setDraft((d) => ({ ...d, disclaimer: e.target.value }))}
                />
              </label>
            </div>
          </SectionCard>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <UploadCard product={product} demo={demo} canWrite={canWrite} mutations={mutations} />
          <SectionCard title="Fee math" sub="Updates as you type, using the current program settings.">
            <dl className="grid grid-cols-3 gap-3 p-5 text-xs" data-testid="catalog-live-math">
              <div>
                <dt className={FIELD_LABEL}>THINNR share</dt>
                <dd className="font-serif text-lg font-bold text-navy">{math ? formatCents(math.share) : '—'}</dd>
              </div>
              <div>
                <dt className={FIELD_LABEL}>Office minimum</dt>
                <dd className="font-serif text-lg font-bold text-navy">{math ? formatCents(math.minimum) : '—'}</dd>
              </div>
              <div>
                <dt className={FIELD_LABEL}>HQ profit / unit</dt>
                <dd className={`font-serif text-lg font-bold ${math && math.profit !== null && math.profit < 0 ? 'text-destructive' : 'text-navy'}`}>
                  {math && math.profit !== null ? formatCents(math.profit) : '—'}
                </dd>
              </div>
            </dl>
          </SectionCard>
          <SectionCard title="Subscription plans" sub="Which renewal cadences patients may pick when an office sells this on subscription.">
            <fieldset className="space-y-3 p-5" data-testid="catalog-cadences">
              <legend className="sr-only">Offered cadences</legend>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {CADENCE_WEEKS.map((weeks) => (
                  <label key={weeks} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      data-testid={`checkbox-cadence-${weeks}`}
                      checked={draft.cadences.includes(weeks)}
                      disabled={readOnly}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          cadences: e.target.checked ? [...d.cadences, weeks].sort((x, y) => x - y) : d.cadences.filter((w) => w !== weeks),
                        }))
                      }
                    />
                    <span>{CADENCE_LABEL[weeks]}</span>
                  </label>
                ))}
              </div>
              <label className="block">
                <span className={FIELD_LABEL}>Preselected cadence</span>
                <select
                  data-testid="select-default-cadence"
                  className={`${INPUT_CLASS} h-9 w-full`}
                  value={draft.default_cadence}
                  disabled={readOnly}
                  onChange={(e) => setDraft((d) => ({ ...d, default_cadence: Number(e.target.value) as CadenceWeeks }))}
                >
                  {CADENCE_WEEKS.map((weeks) => (
                    <option key={weeks} value={weeks} disabled={!draft.cadences.includes(weeks)}>
                      {CADENCE_LABEL[weeks]}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-[11px] text-muted-foreground">
                {settings.subscribe_save_enabled
                  ? `Subscribe and save is on: every cadence is quoted ${settings.subscribe_save_percent}% under the office price.`
                  : 'Subscribe and save is off in program settings, so subscriptions charge the full office price.'}
              </p>
            </fieldset>
          </SectionCard>
          <SectionCard
            title="Coach suggestions"
            sub="When the patient's own account data may prompt the coach to mention this product. The coach only ever offers curated products, at most one per reply, and never claims a product treats a lab result."
          >
            <div className="space-y-4 p-5" data-testid="catalog-coach-suggestion">
              <SignalPicker
                label="Suggest when"
                help="Any one of these signals makes the product eligible. Leave all unchecked to suggest only when the conversation brings it up."
                testId="coach-signal"
                selected={draft.coach_signals}
                readOnly={readOnly}
                onChange={(coach_signals) => setDraft((d) => ({ ...d, coach_signals }))}
              />
              <SignalPicker
                label="Never suggest when"
                help="Contraindication flags: any one of these blocks the product entirely, even when the patient asks about it."
                testId="coach-avoid"
                selected={draft.coach_avoid_signals}
                readOnly={readOnly}
                onChange={(coach_avoid_signals) => setDraft((d) => ({ ...d, coach_avoid_signals }))}
              />
              <label className="block">
                <span className={FIELD_LABEL}>Conversation topics</span>
                <textarea
                  data-testid="input-coach-topics"
                  className={`${INPUT_CLASS} min-h-[72px] w-full resize-y py-2 leading-relaxed`}
                  value={draft.coach_topics}
                  disabled={readOnly}
                  placeholder={'One phrase per line, e.g.\nalways hungry\nportion control'}
                  onChange={(e) => setDraft((d) => ({ ...d, coach_topics: e.target.value }))}
                />
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  When the patient's message contains one of these phrases, the coach may bring the product up even without an account signal. Matching is by whole words, case does not matter.
                </span>
              </label>
              <label className="block">
                <span className={FIELD_LABEL}>How the coach talks about it</span>
                <textarea
                  data-testid="input-coach-phrasing"
                  className={`${INPUT_CLASS} min-h-[60px] w-full resize-y py-2 leading-relaxed`}
                  value={draft.coach_phrasing}
                  disabled={readOnly}
                  maxLength={400}
                  placeholder="One or two sentences of guidance, e.g. frame it as support for the routine they already have."
                  onChange={(e) => setDraft((d) => ({ ...d, coach_phrasing: e.target.value }))}
                />
              </label>
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  data-testid="checkbox-coach-bloodwork-covered"
                  className="mt-0.5"
                  checked={draft.coach_bloodwork_covered}
                  disabled={readOnly}
                  onChange={(e) => setDraft((d) => ({ ...d, coach_bloodwork_covered: e.target.checked }))}
                />
                <span>
                  The product page content explicitly covers the bloodwork markers checked above.
                  <span className="block text-[11px] text-muted-foreground">
                    Unchecked, a bloodwork signal only lets the coach say the marker is worth asking the provider about.
                  </span>
                </span>
              </label>
            </div>
          </SectionCard>
          {product ? (
            <SectionCard title="Status" sub={PRODUCT_STATUS_HELP[product.status]}>
              <div className="flex flex-wrap gap-2 p-5">
                {product.status === 'draft' && <StatusButton label="Publish" primary onClick={() => setStatus('active')} disabled={readOnly} />}
                {product.status === 'active' && <StatusButton label="Retire" onClick={() => setStatus('retired')} disabled={readOnly} />}
                {product.status === 'retired' && <StatusButton label="Reactivate" primary onClick={() => setStatus('active')} disabled={readOnly} />}
                {product.status !== 'archived' ? (
                  <StatusButton label="Archive" onClick={() => setStatus('archived')} disabled={readOnly} testId="button-product-archive" />
                ) : (
                  <StatusButton label="Restore" primary onClick={() => setStatus('retired')} disabled={readOnly} />
                )}
              </div>
            </SectionCard>
          ) : (
            <SectionCard title="Status" sub="New products go live for offices as soon as they are added, unless you keep them as a draft.">
              <label className="flex items-start gap-3 p-5 text-xs">
                <input type="checkbox" className="mt-0.5" checked={startAsDraft} disabled={readOnly} onChange={(e) => setStartAsDraft(e.target.checked)} data-testid="checkbox-start-draft" />
                <span>
                  <b className="block font-semibold text-navy">Save as a draft</b>
                  <span className="text-muted-foreground">Offices will not see it until you publish.</span>
                </span>
              </label>
            </SectionCard>
          )}
        </div>
      </div>
    </AdminPage>
  );
}

function StatusButton({ label, onClick, primary, disabled, testId }: { label: string; onClick(): void; primary?: boolean; disabled?: boolean; testId?: string }) {
  return (
    <button type="button" className={`${primary ? BTN_PRIMARY : BTN_SECONDARY} h-9 px-3.5 disabled:opacity-50`} onClick={onClick} disabled={disabled} data-testid={testId}>
      {label}
    </button>
  );
}

type Mutations = ReturnType<typeof useHqCatalogMutations>;

function Gallery({ product, demo, canWrite, mutations, draftName }: { product: CatalogProductDetail | null; demo: boolean; canWrite: boolean; mutations: Mutations; draftName: string }) {
  const { toast } = useToast();
  const images = product?.images ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = images.find((i) => i.id === selectedId) ?? images.find((i) => i.is_default) ?? images[0] ?? null;
  const busy = mutations.removeImage.isPending || mutations.setDefaultImage.isPending;
  const act = (kind: 'default' | 'remove', image: ProductImage) => {
    if (!product) return;
    if (demo) {
      toast({ title: 'Preview only', description: 'Sign in to change the live catalog.' });
      return;
    }
    const mutation = kind === 'default' ? mutations.setDefaultImage : mutations.removeImage;
    mutation.mutate(
      { productId: product.id, imageId: image.id },
      {
        onSuccess: () => {
          if (kind === 'remove') setSelectedId(null);
          toast({ variant: 'success', title: kind === 'default' ? 'Default picture updated' : 'Picture removed' });
        },
        onError: (err) => toast({ variant: 'destructive', title: 'Picture not updated', description: err.message }),
      },
    );
  };
  return (
    <SectionCard title="Pictures" sub={images.length ? `${images.length} of ${MAX_PRODUCT_IMAGES} · the starred picture is the default offices and patients see.` : 'No pictures yet.'}>
      <div className="p-5">
        <ProductThumb src={selected?.url ?? null} name={product?.name || draftName || 'Product'} size="lg" className="max-h-[420px]" />
        {images.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-3" aria-label="Product pictures">
            {images.map((image, index) => (
              <li key={image.id} className="relative" data-testid={`image-${image.id}`}>
                <button
                  type="button"
                  aria-label={`Show picture ${index + 1}${image.is_default ? ' (default)' : ''}`}
                  aria-pressed={selected?.id === image.id}
                  className={`block overflow-hidden rounded-md border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected?.id === image.id ? 'border-primary' : 'border-transparent'}`}
                  onClick={() => setSelectedId(image.id)}
                >
                  <img src={image.url} alt="" className="h-16 w-16 object-cover" />
                </button>
                {image.is_default && (
                  <span className="absolute -left-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm" title="Default picture">
                    <Star size={11} aria-hidden="true" className="fill-current" />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {selected && canWrite && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`} disabled={busy || selected.is_default} onClick={() => act('default', selected)} data-testid="button-image-default">
              <Star size={12} aria-hidden="true" />
              {selected.is_default ? 'Default picture' : 'Make default'}
            </button>
            <button type="button" className={`${BTN_SECONDARY} h-8 px-3 text-[11px] text-destructive`} disabled={busy} onClick={() => act('remove', selected)} data-testid="button-image-remove">
              <Trash2 size={12} aria-hidden="true" />
              Remove
            </button>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function UploadCard({ product, demo, canWrite, mutations }: { product: CatalogProductDetail | null; demo: boolean; canWrite: boolean; mutations: Mutations }) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; fraction: number } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const count = product?.images.length ?? 0;
  const remaining = Math.max(0, MAX_PRODUCT_IMAGES - count);
  const enabled = Boolean(product) && canWrite && remaining > 0 && !progress;
  const reason = !product
    ? 'Save the product first, then add pictures.'
    : !canWrite
      ? 'Your HQ role can view pictures but not change them.'
      : remaining === 0
        ? `This product already has ${MAX_PRODUCT_IMAGES} pictures. Remove one to add another.`
        : null;

  const upload = async (files: File[]) => {
    if (!product || !enabled) return;
    if (demo) {
      toast({ title: 'Preview only', description: 'Sign in to change the live catalog.' });
      return;
    }
    setFailure(null);
    const accepted = files.slice(0, remaining);
    const rejected = accepted.find((file) => !ACCEPTED.includes(file.type) || file.size > MAX_IMAGE_BYTES);
    if (rejected) {
      setFailure(!ACCEPTED.includes(rejected.type) ? `${rejected.name} is not a JPEG, PNG or WebP image.` : `${rejected.name} is larger than 10 MB.`);
      return;
    }
    if (files.length > remaining) toast({ title: `Only ${remaining} more picture${remaining === 1 ? '' : 's'} fit`, description: 'The extra files were skipped.' });
    for (const [index, file] of accepted.entries()) {
      setProgress({ done: index, total: accepted.length, fraction: 0 });
      try {
        await mutations.uploadImage.mutateAsync({
          productId: product.id,
          file,
          onProgress: (fraction) => setProgress({ done: index, total: accepted.length, fraction }),
        });
      } catch (err) {
        setFailure(err instanceof Error ? err.message : 'The picture could not be uploaded.');
        break;
      }
    }
    setProgress(null);
    if (inputRef.current) inputRef.current.value = '';
  };
  const pct = progress ? Math.round(((progress.done + progress.fraction) / progress.total) * 100) : 0;
  return (
    <SectionCard title="Add pictures" sub={`Up to ${MAX_PRODUCT_IMAGES} per product · JPEG, PNG or WebP · 10 MB each`}>
      <div className="p-5">
        <div
          data-testid="dropzone-product-images"
          className={`rounded-md border border-dashed p-5 text-center transition-colors ${
            dragOver ? 'border-primary bg-accent/40' : 'border-border bg-secondary/50'
          } ${enabled ? 'cursor-pointer' : 'opacity-70'}`}
          onClick={(event) => {
            if (!enabled) return;
            if ((event.target as HTMLElement).closest('button, input, a')) return;
            inputRef.current?.click();
          }}
          onDragEnter={(event) => {
            if (!enabled) return;
            event.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(event) => {
            if (!enabled) return;
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(event) => {
            if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node)) return;
            setDragOver(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            if (!enabled) return;
            void upload(Array.from(event.dataTransfer.files ?? []));
          }}
        >
          {progress ? (
            <div className="space-y-2" data-testid="progress-product-images">
              <p className="text-xs font-medium text-foreground">
                Uploading picture {progress.done + 1} of {progress.total}… {pct}%
              </p>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Upload progress">
                <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              {enabled ? <Upload size={16} className="text-muted-foreground" aria-hidden="true" /> : <ImagePlus size={16} className="text-muted-foreground" aria-hidden="true" />}
              <p className="text-xs font-medium text-foreground">{enabled ? 'Drag pictures here' : reason}</p>
              {enabled && (
                <>
                  <button type="button" className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`} onClick={() => inputRef.current?.click()} data-testid="button-browse-images">
                    Browse files
                  </button>
                  <p className="text-[10px] text-muted-foreground">
                    {remaining} more picture{remaining === 1 ? '' : 's'} can be added
                  </p>
                </>
              )}
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED.join(',')}
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            disabled={!enabled}
            onChange={(event) => void upload(Array.from(event.target.files ?? []))}
          />
        </div>
        {failure && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {failure}
          </p>
        )}
      </div>
    </SectionCard>
  );
}

function LinesField({
  testId,
  label,
  help,
  value,
  disabled,
  tall,
  onChange,
}: {
  testId: string;
  label: string;
  help: string;
  value: string;
  disabled: boolean;
  tall?: boolean;
  onChange: (value: string) => void;
}) {
  const helpId = `${testId}-help`;
  return (
    <label className="block">
      <span className={FIELD_LABEL}>{label}</span>
      <textarea
        data-testid={testId}
        aria-describedby={helpId}
        className={`${INPUT_CLASS} ${tall ? 'min-h-[160px]' : 'min-h-[96px]'} w-full resize-y py-2 leading-relaxed`}
        value={value}
        disabled={disabled}
        maxLength={6000}
        onChange={(e) => onChange(e.target.value)}
      />
      <span id={helpId} className="mt-1 block text-[11px] text-muted-foreground">
        {help}
      </span>
    </label>
  );
}

function isEqual(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function SignalPicker({
  label,
  help,
  testId,
  selected,
  readOnly,
  onChange,
}: {
  label: string;
  help: string;
  testId: string;
  selected: CoachSuggestionSignal[];
  readOnly: boolean;
  onChange: (next: CoachSuggestionSignal[]) => void;
}) {
  return (
    <fieldset className="space-y-2" data-testid={`${testId}-picker`}>
      <legend className={FIELD_LABEL}>{label}</legend>
      <p className="text-[11px] text-muted-foreground">{help}</p>
      <div className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2">
        {COACH_SUGGESTION_SIGNALS.map((signal) => (
          <label key={signal} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              data-testid={`checkbox-${testId}-${signal}`}
              checked={selected.includes(signal)}
              disabled={readOnly}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? COACH_SUGGESTION_SIGNALS.filter((id) => id === signal || selected.includes(id))
                    : selected.filter((id) => id !== signal),
                )
              }
            />
            <span>{COACH_SIGNAL_LABELS[signal]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
