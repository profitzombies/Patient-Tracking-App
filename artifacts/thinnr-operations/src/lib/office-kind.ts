/**
 * What an office's kind takes away from the workspace.
 *
 * A software-only practice bought the platform without being a THINNR
 * reseller, so the reseller material — Training and the Marketing Assets
 * drive — is not part of its product. The server is the authority (the files
 * routes refuse and the training reads come back empty for such an office);
 * this is the client's copy, used to hide the menu rows and send a typed URL
 * to the in-app not-found page instead of an empty screen.
 *
 * An unknown kind reads as reseller, exactly like the server and the HQ
 * account directory: existing offices predate the kind and lose nothing.
 */
import { officeKindOf, type OfficeKind } from '@/data/hq/accounts';

/** Office paths that exist only for THINNR resellers. */
export const RESELLER_ONLY_OFFICE_PATHS = ['/training', '/files'] as const;

/** True when this office's kind includes the reseller material. */
export function officeKindHasResellerContent(kind: OfficeKind | null | undefined): boolean {
  return officeKindOf(kind) !== 'software';
}

/** True when the location belongs to the reseller-only material. */
export function isResellerOnlyOfficePath(location: string): boolean {
  return RESELLER_ONLY_OFFICE_PATHS.some((path) => location === path || location.startsWith(`${path}/`));
}

/** The nav rows this kind may show: drops the reseller-only ones for software offices. */
export function officeNavItemsForKind<T extends { path: string }>(items: T[], kind: OfficeKind | null | undefined): T[] {
  if (officeKindHasResellerContent(kind)) return items;
  return items.filter((item) => !isResellerOnlyOfficePath(item.path));
}
