export type OfficeAccessSlot = 'bank' | 'card_primary' | 'card_backup';
export type OfficeAccessStepId =
  | 'connect'
  | 'bank'
  | 'card_primary'
  | 'card_backup'
  | 'plan'
  | 'disclosure';

export interface OfficeAccessSnapshot {
  office: { providerId: string; officeName: string };
  complete: boolean;
  connectAlreadyDone: boolean;
  steps: Array<{
    id: OfficeAccessStepId;
    status: 'done' | 'pending' | 'todo' | 'blocked';
    detail: string | null;
  }>;
  connect: {
    state: 'not_started' | 'action_required' | 'pending' | 'ready';
    sandbox: boolean;
  };
  instruments: Array<{
    slot: OfficeAccessSlot;
    kind: 'bank' | 'card';
    brand: string | null;
    last4: string;
    expMonth: number | null;
    expYear: number | null;
    bankName: string | null;
    verificationStatus: 'verified' | 'pending' | 'failed';
    verificationDeadline: string | null;
    addedAt: string;
  }>;
  plan: {
    selected: 'monthly' | 'yearly' | null;
    monthlyPriceCents: number;
    yearlyPriceCents: number;
    priceCents: number;
    firstChargeAt: string | null;
    includedPeriodDays: number;
    nextPeriodEndsAt: string | null;
  };
  disclosure: { text: string; version: number; acknowledgedAt: string | null };
  bank: {
    verificationPending: boolean;
    deadline: string | null;
    overdue: boolean;
    windowHours: number;
    verificationUrl: string | null;
  };
  balance: {
    state: 'setup_incomplete' | 'included_period' | 'paid_current' | 'past_due' | 'restricted';
    outstanding: boolean;
    amountCents: number;
    graceEndsAt: string | null;
  };
  canManage: boolean;
  canChoosePlan: boolean;
}

export interface OfficeAccessSetupIntent {
  clientSecret: string;
  setupIntentId: string;
  publishableKey: string;
  slot: OfficeAccessSlot;
}