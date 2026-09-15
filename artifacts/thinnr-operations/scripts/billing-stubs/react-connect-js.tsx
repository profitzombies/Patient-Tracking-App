import type { ReactNode } from 'react';
export function ConnectComponentsProvider({ children }: { children: ReactNode }) { return children; }
export function ConnectAccountOnboarding() { return <div data-testid="stripe-account-onboarding" />; }
export function ConnectAccountManagement() { return <div />; }
export function ConnectBalances() { return <div />; }
export function ConnectDocuments() { return <div />; }
export function ConnectDisputesList() { return <div data-testid="stripe-disputes-list" />; }
export function ConnectNotificationBanner() { return <div />; }
export function ConnectPayouts() { return <div />; }
export function ConnectTaxRegistrations() { return <div />; }
export function ConnectTaxSettings() { return <div />; }