/**
 * Static folder tree for the Drive-style files preview page.
 *
 * Mockup only: nothing is stored or served — names, sizes, and dates are
 * set dressing, and "public" share links point at a clearly fake domain
 * (thinnr.example.com) so nobody mistakes them for live URLs. Modified
 * labels stay at or before the fixed demo anchor (Aug 22, 2026).
 */

export type DriveFileKind = 'doc' | 'sheet' | 'slides' | 'pdf' | 'image' | 'video';

export interface DriveFile {
  id: string;
  name: string;
  kind: DriveFileKind;
  size: string;
  modifiedLabel: string;
  /** Share slug — rendered as https://drive.thinnr.example.com/share/<id>. */
  shareId: string;
}

export interface DriveFolder {
  id: string;
  name: string;
  folders: DriveFolder[];
  files: DriveFile[];
}

export const DRIVE_SHARE_BASE = 'https://drive.thinnr.example.com/share';

export const DRIVE_ROOT: DriveFolder = {
  id: 'root',
  name: 'HQ Drive',
  folders: [
    {
      id: 'brand-kit',
      name: 'Brand kit',
      folders: [
        {
          id: 'logos',
          name: 'Logos',
          folders: [],
          files: [
            { id: 'f-wordmark', name: 'thinnr-wordmark.svg', kind: 'image', size: '18 KB', modifiedLabel: 'Jul 30, 2026', shareId: 'brand-wordmark-4e21' },
            { id: 'f-mark', name: 'thinnr-mark-navy.png', kind: 'image', size: '52 KB', modifiedLabel: 'Jul 30, 2026', shareId: 'brand-mark-9b07' },
          ],
        },
        {
          id: 'templates',
          name: 'Templates',
          folders: [],
          files: [
            { id: 'f-onepager', name: 'provider-one-pager.pdf', kind: 'pdf', size: '1.2 MB', modifiedLabel: 'Aug 11, 2026', shareId: 'tpl-onepager-77c3' },
            { id: 'f-deck', name: 'office-intro-deck.slides', kind: 'slides', size: '4.8 MB', modifiedLabel: 'Aug 14, 2026', shareId: 'tpl-deck-52aa' },
          ],
        },
      ],
      files: [
        { id: 'f-guidelines', name: 'brand-guidelines-v3.pdf', kind: 'pdf', size: '3.1 MB', modifiedLabel: 'Jun 19, 2026', shareId: 'brand-guide-08d4' },
      ],
    },
    {
      id: 'provider-onboarding',
      name: 'Provider onboarding',
      folders: [
        {
          id: 'welcome-packets',
          name: 'Welcome packets',
          folders: [],
          files: [
            { id: 'f-packet-core', name: 'welcome-packet-core.pdf', kind: 'pdf', size: '2.4 MB', modifiedLabel: 'Aug 3, 2026', shareId: 'pkt-core-3f61' },
            { id: 'f-packet-concierge', name: 'welcome-packet-concierge.pdf', kind: 'pdf', size: '2.9 MB', modifiedLabel: 'Aug 3, 2026', shareId: 'pkt-concierge-b1e8' },
          ],
        },
      ],
      files: [
        { id: 'f-code-poster', name: 'provider-code-frontdesk-poster.pdf', kind: 'pdf', size: '860 KB', modifiedLabel: 'Aug 17, 2026', shareId: 'code-poster-6a90' },
        { id: 'f-quickstart', name: 'front-desk-quickstart.doc', kind: 'doc', size: '96 KB', modifiedLabel: 'Aug 12, 2026', shareId: 'quickstart-d2c5' },
      ],
    },
    {
      id: 'care-team',
      name: 'Care team resources',
      folders: [],
      files: [
        { id: 'f-transcript-review', name: 'coach-transcript-review-guide.doc', kind: 'doc', size: '124 KB', modifiedLabel: 'Aug 8, 2026', shareId: 'transcript-guide-4410' },
        { id: 'f-escalation', name: 'escalation-flow.pdf', kind: 'pdf', size: '540 KB', modifiedLabel: 'Jul 22, 2026', shareId: 'escalation-97fe' },
        { id: 'f-walkthrough', name: 'office-dashboard-walkthrough.video', kind: 'video', size: '182 MB', modifiedLabel: 'Aug 5, 2026', shareId: 'walkthrough-c380' },
      ],
    },
    {
      id: 'hq-internal',
      name: 'HQ internal',
      folders: [
        {
          id: 'board-updates',
          name: 'Board updates',
          folders: [],
          files: [
            { id: 'f-aug-metrics', name: 'aug-2026-account-metrics.sheet', kind: 'sheet', size: '210 KB', modifiedLabel: 'Aug 22, 2026', shareId: 'metrics-aug26-1157' },
          ],
        },
      ],
      files: [
        { id: 'f-hiring', name: 'provider-success-hiring-plan.doc', kind: 'doc', size: '88 KB', modifiedLabel: 'Aug 19, 2026', shareId: 'hiring-plan-72b3' },
      ],
    },
  ],
  files: [],
};

/** Follow a path of folder ids from the root; null when the path breaks. */
export function findFolderPath(pathIds: string[]): DriveFolder[] | null {
  const chain: DriveFolder[] = [DRIVE_ROOT];
  let current = DRIVE_ROOT;
  for (const id of pathIds) {
    const next = current.folders.find((folder) => folder.id === id);
    if (!next) return null;
    chain.push(next);
    current = next;
  }
  return chain;
}
