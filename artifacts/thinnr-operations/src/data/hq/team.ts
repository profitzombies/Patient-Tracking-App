/**
 * Seed data for the THINNR HQ team page — the company's own staff, distinct
 * from office providers. Edits (invite / role change / remove) are handled by
 * the HQ session context; this module only defines the shape and the seeds.
 */

export type HqRole = 'Owner' | 'Admin' | 'Clinical' | 'Support' | 'Content';

export interface HqTeamMember {
  id: string;
  name: string;
  initials: string;
  role: HqRole;
  /** Human title shown under the name (role is the permission bucket). */
  title: string;
  email: string;
  status: 'active' | 'invited';
  /** Display-only join label anchored to the demo timeline. */
  joinedLabel: string;
}

/** What each role can do — shown in the invite/edit dialogs. */
export const HQ_ROLE_NOTES: Record<HqRole, string> = {
  Owner: 'Full control, including team and org settings. Exactly one owner in this demo.',
  Admin: 'Manage provider accounts, team, and settings.',
  Clinical: 'Review outcomes and coach conversations across accounts.',
  Support: 'View accounts and conversations; handle patient escalations.',
  Content: 'Manage training courses and the shared file library.',
};

export const SEEDED_TEAM: HqTeamMember[] = [
  {
    id: 'hq-t1',
    name: 'Alexandra Reyes',
    initials: 'AR',
    role: 'Owner',
    title: 'Chief Executive',
    email: 'alexandra@thinnr.example.com',
    status: 'active',
    joinedLabel: 'Sep 2024',
  },
  {
    id: 'hq-t2',
    name: 'Dr. Priya Natarajan',
    initials: 'PN',
    role: 'Clinical',
    title: 'Head of Clinical Operations',
    email: 'priya@thinnr.example.com',
    status: 'active',
    joinedLabel: 'Nov 2024',
  },
  {
    id: 'hq-t3',
    name: 'Marcus Webb',
    initials: 'MW',
    role: 'Admin',
    title: 'Provider Success Lead',
    email: 'marcus@thinnr.example.com',
    status: 'active',
    joinedLabel: 'Jan 2025',
  },
  {
    id: 'hq-t4',
    name: 'Jordan Ellis',
    initials: 'JE',
    role: 'Support',
    title: 'Patient Support Lead',
    email: 'jordan@thinnr.example.com',
    status: 'active',
    joinedLabel: 'Mar 2025',
  },
  {
    id: 'hq-t5',
    name: 'Renee Calloway',
    initials: 'RC',
    role: 'Content',
    title: 'Program Content Producer',
    email: 'renee@thinnr.example.com',
    status: 'active',
    joinedLabel: 'Jun 2025',
  },
];

/** The signed-in HQ identity shown in the admin shell header. */
export const HQ_ADMIN_IDENTITY = SEEDED_TEAM[0];
