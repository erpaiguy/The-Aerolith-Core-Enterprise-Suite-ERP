// The legal documents a person accepts (docs/wave9-plan.md step 9b.3). Their text lives with the web app; the keys
// and versions are here so the server and the app agree on what is current. Changing a document's text means giving
// it a new version: everyone it applies to accepts it again at their next sign-in.

export type LegalKey =
  'terms-of-service' | 'privacy-policy' | 'terms-and-conditions' | 'licence-terms';

export interface LegalDocument {
  key: LegalKey;
  title: string;
  /** The date this version was written, YYYY-MM-DD. */
  version: string;
  /** Who accepts it: every person who signs in, or the company's administrators on its behalf. */
  acceptedBy: 'everyone' | 'admins';
}

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  {
    key: 'terms-of-service',
    title: 'Terms of service',
    version: '2026-10-20',
    acceptedBy: 'everyone',
  },
  { key: 'privacy-policy', title: 'Privacy policy', version: '2026-10-20', acceptedBy: 'everyone' },
  {
    key: 'terms-and-conditions',
    title: 'Terms and conditions of subscription',
    version: '2026-10-20',
    acceptedBy: 'admins',
  },
  { key: 'licence-terms', title: 'Licence terms', version: '2026-10-20', acceptedBy: 'admins' },
];

export const legalDocument = (key: string): LegalDocument | undefined =>
  LEGAL_DOCUMENTS.find((d) => d.key === key);

/** What a person with this role must accept. */
export const legalFor = (role: string): LegalDocument[] =>
  LEGAL_DOCUMENTS.filter((d) => d.acceptedBy === 'everyone' || role === 'admin');
