// The main menu folds its groups away (apps/web/src/screens/AppShell.tsx) and remembers which ones a person opened.
// The feature tests click pages by name, so they start with every group open; tests/menu.spec.ts covers the folding.
import { BASE_URL } from './env.js';

export const MENU_GROUPS = [
  'Business development',
  'Estimation',
  'Tenders and BOQ',
  'Rates and resources',
  'Estimation reports',
  'Projects',
  'Cost and cash',
  'Contract',
  'Site',
  'Documents and design',
  'Procurement and stores',
  'People',
  'Accounts',
  'Transactions',
  'Tax',
  'Assets',
  'Books and statements',
  'Reports',
  'Administration',
  // The project workspace (on a project's pages).
  'Plan and progress',
  'Buy and store',
  'Money and contract',
  'Site and documents',
];

export const menuOpen = (baseURL: string = BASE_URL) => ({
  cookies: [],
  origins: [
    {
      origin: new URL(baseURL).origin,
      // Pop-up notices off (Settings → This device): they repeat names the tests look up by text. The tests of the
      // notices themselves (leaving.spec.ts) start with them on.
      localStorage: [
        { name: 'aerolith.nav.open', value: JSON.stringify(MENU_GROUPS) },
        { name: 'aerolith.toasts', value: 'off' },
      ],
    },
  ],
});
