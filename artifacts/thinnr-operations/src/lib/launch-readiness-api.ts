import { officeRequest, type OfficeRequestMessages } from '@/lib/office-api';

export type ReadinessStatus = 'pass' | 'warn' | 'fail' | 'manual';
export type ReadinessSection = 'app' | 'stripe_live' | 'stripe_test' | 'warehouse' | 'email' | 'sms';

export interface ReadinessCheck {
  id: string;
  section: ReadinessSection;
  label: string;
  status: ReadinessStatus;
  detail: string;
  fix: string | null;
  copyValue?: string;
}

export interface LaunchReadiness {
  checkedAt: string;
  mode: 'test' | 'live' | null;
  checks: ReadinessCheck[];
}

const MESSAGES: OfficeRequestMessages = {
  unconfigured: 'The launch readiness check is not available in this environment.',
  signedOut: 'Your session has ended. Sign in again to continue.',
  unreachable: 'Could not reach the launch readiness check. Check your connection and try again.',
  failed: 'The launch readiness check failed',
};

export const fetchLaunchReadiness = () =>
  officeRequest<LaunchReadiness>('/api/hq/system-health/launch-readiness', MESSAGES);
