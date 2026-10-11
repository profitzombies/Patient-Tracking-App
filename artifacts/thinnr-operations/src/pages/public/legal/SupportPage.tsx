/**
 * /support — the public support URL the store listings point at. Contact
 * details come from HQ's Organization settings (with a default address) so
 * the page needs no code change when the support mailbox moves.
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { LEGAL_DOCUMENTS_EFFECTIVE_DATE, formatEffectiveDate } from '@workspace/legal-documents';
import { BTN_PRIMARY } from '@/components/patient/heritage';
import { publicLegal, type SupportContact } from '@/lib/legal-api';
import { LegalFrame } from './LegalFrame';

export const DEFAULT_SUPPORT_CONTACT: SupportContact = {
  organizationName: 'THINNR',
  email: 'support@trythinnr.com',
  phone: null,
};

const TOPICS = [
  { title: 'Signing in', body: 'Codes arrive by text or email within a minute. Check spam, make sure the number or address matches what your office has on file, and ask your office to update it if not.' },
  { title: 'Your program and plan', body: 'Targets, diet phases, medications and check-ins come from your office. Message your care team from the app for anything about your care.' },
  { title: 'Orders and payments', body: 'Products are sold by your office. Receipts and shipping updates are in the app under Orders; your office can help with refunds and returns.' },
  { title: 'Your data', body: 'Download a copy of your data or close your account from Account in the app, or use the delete-account page below without the app.' },
];

export default function SupportPage() {
  const [contact, setContact] = useState<SupportContact>(DEFAULT_SUPPORT_CONTACT);
  useEffect(() => {
    let active = true;
    publicLegal
      .supportContact()
      .then((loaded) => { if (active && loaded?.email) setContact(loaded); })
      .catch(() => { /* default contact stays on screen */ });
    return () => { active = false; };
  }, []);

  const subject = encodeURIComponent('THINNR app support');
  const mailto = `mailto:${contact.email}?subject=${subject}`;

  return (
    <LegalFrame
      title="Support"
      lede="Help with the THINNR app, for patients and for office staff."
      current="/support"
    >
      <section className="mt-6 rounded-md border border-border bg-background px-4 py-4 sm:px-5">
        <h2 className="font-serif text-[20px] text-navy">Contact us</h2>
        <p className="mt-1 text-sm text-foreground/90">
          Email{' '}
          <a href={mailto} className="font-semibold text-primary underline-offset-2 hover:underline" data-testid="support-email">
            {contact.email}
          </a>
          {contact.phone ? (
            <>
              {' '}or call{' '}
              <a href={`tel:${contact.phone.replace(/[^+\d]/g, '')}`} className="font-semibold text-primary underline-offset-2 hover:underline" data-testid="support-phone">
                {contact.phone}
              </a>
            </>
          ) : null}
          . We answer within two business days.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Please include the name of your office and the phone number or email on your account. Do not include medical details in email; message your care team in the app for anything about your care.
        </p>
        <a href={mailto} className={`${BTN_PRIMARY} mt-4 h-10 px-5`} data-testid="support-email-button">
          Email {contact.organizationName} support
        </a>
      </section>

      <section className="mt-8">
        <h2 className="font-serif text-[20px] text-navy">Common questions</h2>
        <dl className="mt-3 space-y-4">
          {TOPICS.map((topic) => (
            <div key={topic.title}>
              <dt className="text-sm font-semibold text-foreground">{topic.title}</dt>
              <dd className="mt-0.5 text-sm leading-6 text-foreground/80">{topic.body}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-8 border-t border-border pt-6">
        <h2 className="font-serif text-[20px] text-navy">Policies</h2>
        <ul className="mt-3 space-y-1.5 text-sm">
          <li><Link href="~/privacy" className="font-semibold text-primary hover:underline">Privacy Policy</Link></li>
          <li><Link href="~/terms" className="font-semibold text-primary hover:underline">Terms of Use</Link></li>
          <li><Link href="~/health-data" className="font-semibold text-primary hover:underline">Health data notice</Link></li>
          <li><Link href="~/delete-account" className="font-semibold text-primary hover:underline">Delete your account</Link></li>
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          Policies effective {formatEffectiveDate(LEGAL_DOCUMENTS_EFFECTIVE_DATE)}.
        </p>
      </section>
    </LegalFrame>
  );
}
