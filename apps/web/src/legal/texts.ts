// The legal documents' text (docs/wave9-plan.md step 9b.3). DRAFTS shaped to Indian law as commonly applied — the
// Digital Personal Data Protection Act 2023, the Information Technology Act 2000 and its rules, the Indian Contract
// Act 1872, the Arbitration and Conciliation Act 1996 — written without a lawyer. They must be reviewed by one before
// any customer accepts them; each page says so until an admin marks its version reviewed. Words in [square brackets]
// are for the provider to fill in. Changing a text means a new version in packages/shared/src/legal.ts.
import type { LegalKey } from '@aerolith/shared';

export interface LegalSection {
  heading: string;
  paragraphs: string[];
  /** Points, shown as a list after the paragraphs. */
  points?: string[];
}

export interface LegalText {
  summary: string;
  sections: LegalSection[];
}

const PROVIDER = '[Provider legal name], [registered address]';
const COURTS = '[City], India';
const GRIEVANCE = '[Grievance Officer name], [email address], [postal address]';

export const LEGAL_TEXTS: Record<LegalKey, LegalText> = {
  'terms-of-service': {
    summary:
      'The rules for everyone who signs in to Aerolith Core: who may use it, keeping your account safe, what you may not do, and what happens if something goes wrong.',
    sections: [
      {
        heading: '1. Who these terms are between',
        paragraphs: [
          `Aerolith Core is provided by ${PROVIDER} ("we", "us"). Your company or organisation ("the Customer") subscribes to it and lets you use it. These terms apply to you personally each time you sign in. By accepting them you agree to them; if you do not agree, do not use the service and tell your administrator.`,
          'If you use Aerolith Core on behalf of the Customer, the Customer is also bound by its subscription terms with us. If these terms and the subscription terms differ, the subscription terms prevail between us and the Customer.',
        ],
      },
      {
        heading: '2. Who may use it',
        paragraphs: [
          'Only people the Customer has given an account may use Aerolith Core, and only for the Customer’s work. You must be at least 18 years old. An account is for one person: do not share your password, authenticator or recovery codes, and do not let anyone else work as you.',
        ],
      },
      {
        heading: '3. Keeping your account safe',
        paragraphs: [
          'Choose a password you do not use elsewhere, set up two-factor sign-in when asked, and sign out on shared devices. Tell your administrator at once if you think someone else has used your account or knows your password. Records show who did what: anything done in your name is taken to be done by you until you report otherwise.',
        ],
      },
      {
        heading: '4. What you may not do',
        paragraphs: ['When using Aerolith Core you must not:'],
        points: [
          'enter anything unlawful, false or misleading, or that you have no right to enter;',
          'try to see or change records you have not been given access to, or get round any limit on your access;',
          'copy, decompile, reverse engineer or resell the software, except as the law expressly allows;',
          'probe, scan or test its security, or overload it, except with our written permission;',
          'upload anything containing viruses or other harmful code;',
          'use it in a way that breaks the Information Technology Act 2000, its rules, or any other law that applies.',
        ],
      },
      {
        heading: '5. The Customer’s records',
        paragraphs: [
          'What you and your colleagues enter belongs to the Customer. The Customer decides who sees it, how long it is kept, and what happens to it when someone leaves. Our privacy policy explains how personal data in it is handled.',
        ],
      },
      {
        heading: '6. Figures the software works out',
        paragraphs: [
          'Aerolith Core calculates tax, statutory and financial figures from rules built into it and the settings the Customer chooses. Those rules change, and their application depends on facts the software cannot know. The Customer remains responsible for checking figures with its accountant before filing a return, paying a due or relying on a report.',
        ],
      },
      {
        heading: '7. Changes and availability',
        paragraphs: [
          'We improve Aerolith Core over time and may change or remove features. We aim to keep it available but do not promise it will always be free of interruption or error. Planned maintenance is announced in the app where possible.',
        ],
      },
      {
        heading: '8. Suspension',
        paragraphs: [
          'The Customer’s administrator may end your access at any time. We may suspend an account that appears to be misused or at risk, and will tell the Customer why unless the law prevents it.',
        ],
      },
      {
        heading: '9. Liability',
        paragraphs: [
          'Aerolith Core is provided for the Customer’s business. To the extent the law allows, we are not liable to you personally for any loss arising from your use of it; our responsibilities to the Customer are set out in its subscription terms. Nothing in these terms limits liability that cannot be limited by law.',
        ],
      },
      {
        heading: '10. Law, courts and grievances',
        paragraphs: [
          `These terms are governed by the laws of India. Subject to any dispute resolution clause in the Customer’s subscription terms, the courts at ${COURTS} have jurisdiction.`,
          `For a complaint about the service or its content, write to our Grievance Officer: ${GRIEVANCE}. We acknowledge a complaint within 24 hours and aim to resolve it within 15 days.`,
        ],
      },
      {
        heading: '11. Changes to these terms',
        paragraphs: [
          'When these terms change, the new version is shown the next time you sign in and you are asked to accept it before carrying on. The date of each version is shown at the top.',
        ],
      },
    ],
  },

  'privacy-policy': {
    summary:
      'What personal data Aerolith Core holds, why, who sees it, how long it is kept, how it is protected, and the rights you have under the Digital Personal Data Protection Act 2023.',
    sections: [
      {
        heading: '1. Who is responsible',
        paragraphs: [
          'Two kinds of personal data pass through Aerolith Core, and a different party is responsible for each:',
        ],
        points: [
          'The Customer’s business records — staff, workers, suppliers, clients, flat buyers and everything entered about them. The Customer decides why and how these are processed, so the Customer is the Data Fiduciary for them; we process them only on the Customer’s instructions, as its Data Processor.',
          `Account and licence data — your name, username or email, sign-in records and settings. For these, ${PROVIDER} is the Data Fiduciary.`,
        ],
      },
      {
        heading: '2. What we hold',
        paragraphs: [],
        points: [
          'Account details: name, username, email address, role, password (stored only as a one-way hash), two-factor settings.',
          'Sign-in records: when you signed in, from which IP address and on which kind of device, so you and your administrator can spot a sign-in that was not yours.',
          'Activity records: what was created, changed, approved or deleted, by whom and when (the audit trail), kept because the Customer’s books and approvals must be traceable.',
          'Interface settings: your favourite pages, grid layouts, language and similar choices.',
          'Business records the Customer enters, which may include personal data such as names, addresses, phone numbers, PAN, bank account details, wages, attendance and photographs from sites.',
          'Technical logs: request references and error reports used to keep the service running and to investigate faults.',
        ],
      },
      {
        heading: '3. Why we use it',
        paragraphs: [
          'To give you and the Customer the service; to keep it secure (detecting misuse, locking accounts after repeated wrong passwords); to keep records the law or the Customer’s auditors require; to send messages you or the Customer asked for (password links, the morning email, approvals); and to fix faults. We rely on your consent, given when you accept this policy, and on the legitimate uses allowed by section 7 of the Digital Personal Data Protection Act 2023, including the Customer’s employment purposes.',
          'We do not sell personal data, use it for advertising, or use the Customer’s records for any purpose of our own.',
        ],
      },
      {
        heading: '4. Who sees it',
        paragraphs: [
          'Within the Customer, people see records according to the roles and permissions the Customer’s administrator gives them; some details (such as buyers’ PAN and suppliers’ bank account numbers) are hidden from those without the right to see them.',
          'Outside the Customer, personal data is shared only with: service providers who host or run the service or send email for it, under written terms that bind them to this policy; the Customer’s own auditors and advisers when the Customer exports records for them; and authorities when the law requires it.',
          'If the Customer runs Aerolith Core on its own server, its records stay on that server and we do not see them unless the Customer gives us access for support.',
        ],
      },
      {
        heading: '5. How long it is kept',
        paragraphs: [
          'Business records are kept for as long as the Customer keeps its subscription and decides, subject to laws that require books, tax records and labour registers to be kept for set periods (commonly eight years for books of account). When a subscription ends, the Customer can export its records; after the period stated in the subscription terms they are deleted, with backups overwritten in the normal cycle. Account and sign-in records are kept while the account exists and for up to one year after, to answer questions about past access.',
        ],
      },
      {
        heading: '6. How it is protected',
        paragraphs: [
          'Each customer’s records are kept in a separate database. Connections are encrypted; passwords are stored only as hashes; two-factor sign-in is available and can be made compulsory; access is limited by role and logged; backups are taken nightly and tested by restoring them. No system is perfectly secure: if a personal data breach happens, we will inform the Customer, the Data Protection Board of India and the affected people as the law requires.',
        ],
      },
      {
        heading: '7. Your rights',
        paragraphs: [
          'Under the Digital Personal Data Protection Act 2023 you may ask for a summary of the personal data held about you and how it is processed; ask for it to be corrected, completed or brought up to date; ask for it to be erased where it is no longer needed and no law requires keeping it; withdraw consent (which does not affect what was lawfully done before); nominate someone to exercise these rights if you die or cannot; and complain about how a request was handled.',
          'For the Customer’s business records, send your request to the Customer, which is responsible for them; we will help it respond. For account and licence data, write to our Grievance Officer. If you are not satisfied with the answer, you may complain to the Data Protection Board of India.',
        ],
      },
      {
        heading: '8. Where it is stored',
        paragraphs: [
          'Data is stored in India unless the Customer chooses otherwise. Any transfer outside India will be only to a country the Government of India has not restricted under section 16 of the Act.',
        ],
      },
      {
        heading: '9. Children',
        paragraphs: [
          'Aerolith Core is for work and is not meant for anyone under 18. The Customer must not enter a child’s personal data without verifiable parental consent where the law requires it.',
        ],
      },
      {
        heading: '10. Contact',
        paragraphs: [`Grievance Officer: ${GRIEVANCE}.`],
      },
      {
        heading: '11. Changes to this policy',
        paragraphs: [
          'When this policy changes in a way that matters, the new version is shown at your next sign-in for you to accept. The date of each version is shown at the top.',
        ],
      },
    ],
  },

  'terms-and-conditions': {
    summary:
      'The commercial terms between the Customer and the provider: the subscription, fees and GST, trial, renewal and ending, the Customer’s records, support, confidentiality and liability.',
    sections: [
      {
        heading: '1. The agreement',
        paragraphs: [
          `These terms are an agreement between ${PROVIDER} ("we") and the company or organisation whose administrator accepts them ("the Customer"). The administrator confirms they have authority to bind the Customer. Together with the licence terms, the order or invoice for the subscription and our privacy policy, they are the whole agreement and replace anything said or written before about the same subject.`,
        ],
      },
      {
        heading: '2. The subscription',
        paragraphs: [
          'The subscription gives the Customer the right to use Aerolith Core for the plan, number of user seats and period shown on its order or licence. Seats are for named people; a seat freed by deactivating a user can be given to another.',
        ],
      },
      {
        heading: '3. Trial',
        paragraphs: [
          'A trial lets the Customer try the service free for the period stated. At its end the service becomes read-only until a subscription starts; records entered during the trial are kept for the period stated in the trial notice and then deleted if no subscription follows.',
        ],
      },
      {
        heading: '4. Fees, GST and payment',
        paragraphs: [
          'Fees are as on the order and exclude GST, which is added at the rate in force. Invoices are payable within 30 days unless the order says otherwise. If an invoice is unpaid 15 days after we remind the Customer in writing, we may make the service read-only until it is paid. Tax deducted at source must be deposited and its certificate given to us within the time the law allows.',
        ],
      },
      {
        heading: '5. Term, renewal and ending',
        paragraphs: [
          'The subscription runs for the period on the order and renews for the same period unless either side gives 30 days’ written notice before it ends. Either side may end it at once by notice if the other materially breaches these terms and does not put it right within 30 days of being told. Ending does not affect fees already due.',
        ],
      },
      {
        heading: '6. The Customer’s records',
        paragraphs: [
          'The Customer owns its records. During the subscription and for 60 days after it ends, the Customer can export them (books as CSV and the full database backup). After that we delete them, except where the law requires us to keep something. The Customer grants us the right to process its records only to provide the service, as our privacy policy describes.',
        ],
      },
      {
        heading: '7. The Customer’s responsibilities',
        paragraphs: [],
        points: [
          'Giving access only to its own people, and removing it when they leave.',
          'Checking tax, statutory and financial figures with its accountant before relying on them; the software’s rules are aids, not professional advice.',
          'Where it runs the service on its own server: keeping that server secure and up to date, and copying backups and stored documents to another place (a backup on the same machine does not survive the loss of that machine).',
          'Having a lawful basis, and any consent the law requires, for the personal data it enters.',
        ],
      },
      {
        heading: '8. Support',
        paragraphs: [
          'We provide support by email during Indian business hours on working days and make reasonable efforts to answer within one working day and to fix faults that stop the service working. Any guaranteed response or availability level applies only if agreed in writing on the order.',
        ],
      },
      {
        heading: '9. Confidentiality',
        paragraphs: [
          'Each side keeps the other’s confidential information secret, uses it only for this agreement, and shares it only with people who need it and are bound to keep it secret, unless the law requires disclosure. This lasts for five years after the agreement ends, and for as long as the information remains a trade secret.',
        ],
      },
      {
        heading: '10. Warranties and liability',
        paragraphs: [
          'We will provide the service with reasonable skill and care. Apart from that, and to the extent the law allows, the service is provided as it is, without other warranties.',
          'Neither side is liable to the other for indirect or consequential loss, or loss of profit, revenue or goodwill. Each side’s total liability under this agreement in any 12 months is limited to the fees the Customer paid in those 12 months. These limits do not apply to fraud, to a breach of confidentiality, or to anything else the law does not allow to be limited.',
        ],
      },
      {
        heading: '11. Things beyond control',
        paragraphs: [
          'Neither side is responsible for delay or failure caused by events beyond its reasonable control, such as natural disasters, epidemics, war, government action, or the failure of public networks or power, provided it tells the other side promptly and does what it reasonably can to carry on.',
        ],
      },
      {
        heading: '12. Disputes',
        paragraphs: [
          `These terms are governed by the laws of India. The sides will first try to settle a dispute by talking in good faith for 30 days. If that fails, it is referred to arbitration by a sole arbitrator under the Arbitration and Conciliation Act 1996, seated at ${COURTS}, in English. Either side may still ask a court for urgent interim relief.`,
        ],
      },
      {
        heading: '13. Notices and changes',
        paragraphs: [
          'Notices are given by email to the addresses on the order or the administrator’s account. We may change these terms for a renewal by telling the Customer at least 30 days before; the administrator is asked to accept the new version in the app.',
        ],
      },
    ],
  },

  'licence-terms': {
    summary:
      'The terms on which the Aerolith Core software — the web app, the desktop app and the server — is licensed, and the open-source components it includes.',
    sections: [
      {
        heading: '1. The licence',
        paragraphs: [
          `${PROVIDER} grants the Customer a non-exclusive, non-transferable licence, for the period of its subscription, to use Aerolith Core for its own internal business, by up to the number of users its licence allows, and to install the desktop app on its own computers for that purpose. Where the Customer runs the server itself, the licence includes installing and running the server software on machines it controls, for its own use only.`,
        ],
      },
      {
        heading: '2. The licence key',
        paragraphs: [
          'Each installation is activated with the Customer’s licence key. The key is confidential: do not publish it or give it to anyone outside the Customer. A device can be removed from the licence by its administrator. A suspended or revoked licence stops sign-in; an ended licence leaves the records readable for export.',
        ],
      },
      {
        heading: '3. Restrictions',
        paragraphs: ['Except as the law expressly allows, the Customer must not:'],
        points: [
          'copy the software except as needed to install and back it up;',
          'modify, translate, decompile, disassemble or reverse engineer it;',
          'rent, lend, sell, sublicense or host it for anyone outside the Customer;',
          'remove or alter any notice of ownership or licence;',
          'use it to build a competing product.',
        ],
      },
      {
        heading: '4. Open-source components',
        paragraphs: [
          'Aerolith Core includes open-source software from other authors, each under its own licence (such as MIT, BSD, Apache 2.0 and ISC). The list, with each licence and notice in full, is on the Third-party licences page and ships with every installation. Those licences govern those components and are not limited by these terms; nothing here takes away a right they give.',
          'Aerolith Core uses no component whose licence forbids commercial use or would require the Customer’s own records or customisations to be published.',
        ],
      },
      {
        heading: '5. Updates',
        paragraphs: [
          'Updates are part of the licence. They are announced in the app; the Customer chooses automatic or manual updating in its settings. Each update is signed, and the app installs only an update whose signature checks. We support the current version and the one before it.',
        ],
      },
      {
        heading: '6. Ownership',
        paragraphs: [
          'The software, its design and its documentation remain ours (or our licensors’). The Customer owns its records and anything it creates with the software, such as its reports and templates.',
        ],
      },
      {
        heading: '7. Ending',
        paragraphs: [
          'The licence ends when the subscription ends or if the Customer breaches these terms and does not put it right within 30 days of being told. When it ends, the Customer stops using the software (other than to export its records as the subscription terms allow) and uninstalls the desktop app.',
        ],
      },
      {
        heading: '8. Warranty and liability',
        paragraphs: [
          'The warranty and the limits of liability are those in the subscription terms and conditions.',
        ],
      },
      {
        heading: '9. Law',
        paragraphs: [
          `These terms are governed by the laws of India, and disputes are resolved as the subscription terms provide, seated at ${COURTS}.`,
        ],
      },
    ],
  },
};
