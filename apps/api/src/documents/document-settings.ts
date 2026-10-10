// The company's document settings (docs/wave1-plan.md step 13 part 6): its own standard folders for a tender's vault
// (instead of the built-in nine), and how long documents stay in the trash before they are deleted for good. Kept in
// platform.setting; until the admin changes them the built-in folders apply and the trash is kept for ever.
import { BadRequestException } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';

export const MAX_DEPTH = 8;
const MAX_TEMPLATE = 200;
export const TRASH_DAYS = [30, 90, 180, 365] as const;
export const KEY = {
  folders: 'documents.folder_template',
  trashDays: 'documents.trash_days',
} as const;

/** One folder of the template, by its path from the top: "02 Drawings/Structural". */
export interface FolderTemplate {
  path: string;
  restricted: boolean;
}

export const STANDARD_FOLDERS: FolderTemplate[] = [
  { path: '01 Tender notice and documents', restricted: false },
  { path: '02 Drawings', restricted: false },
  { path: '03 Addenda and corrigenda', restricted: false },
  { path: '04 Pre-bid queries and replies', restricted: false },
  { path: '05 Our technical bid', restricted: false },
  { path: '06 Our financial bid', restricted: true },
  { path: '07 Vendor and subcontractor quotes', restricted: true },
  { path: '08 Correspondence', restricted: false },
  { path: '09 Site visit', restricted: false },
];

const bad = (message: string) => new BadRequestException({ code: 'bad_folder_template', message });

/**
 * A template as the admin typed it, made whole: names tidied, parents added before their folders where only the
 * folder was listed, a folder under a restricted one restricted too, repeats (ignoring case) dropped. Order is kept,
 * parents first.
 */
export function normaliseTemplate(list: FolderTemplate[]): FolderTemplate[] {
  const out = new Map<string, FolderTemplate>();
  for (const f of list) {
    const parts = f.path
      .split('/')
      .map((p) => p.trim().replace(/\s+/g, ' '))
      .filter((p) => p.length > 0);
    if (parts.length === 0) throw bad('A folder needs a name.');
    if (parts.length > MAX_DEPTH) throw bad(`Folders go at most ${MAX_DEPTH} deep: "${f.path}".`);
    for (const p of parts)
      if (p === '.' || p === '..' || p.includes('\\') || p.length > 120)
        throw bad(`"${p}" cannot be a folder name (1 to 120 characters, no slashes).`);
    let parent: FolderTemplate | undefined;
    for (let i = 1; i <= parts.length; i++) {
      const key = parts.slice(0, i).join('/').toLowerCase();
      // Under the parent as first written: "Money" then "money/EMD" is "Money/EMD".
      const path = parent ? `${parent.path}/${parts[i - 1]!}` : parts[0]!;
      const restricted = (i === parts.length && f.restricted) || (parent?.restricted ?? false);
      let row = out.get(key);
      if (row) row.restricted ||= restricted;
      else out.set(key, (row = { path, restricted }));
      parent = row;
    }
  }
  // A restriction set on a parent listed after its children reaches them too.
  const rows = [...out.values()];
  for (const r of rows) {
    const parts = r.path.split('/');
    for (let i = 1; i < parts.length && !r.restricted; i++)
      if (out.get(parts.slice(0, i).join('/').toLowerCase())?.restricted) r.restricted = true;
  }
  if (rows.length > MAX_TEMPLATE) throw bad(`A template has at most ${MAX_TEMPLATE} folders.`);
  return rows;
}

async function setting<T>(db: Sql | TransactionSql, key: string): Promise<T | null> {
  const [r] = await db<{ value: T }[]>`SELECT value FROM platform.setting WHERE key = ${key}`;
  return r?.value ?? null;
}

export async function folderTemplate(db: Sql | TransactionSql) {
  const custom = await setting<FolderTemplate[]>(db, KEY.folders);
  return { folders: custom ?? STANDARD_FOLDERS, customised: custom !== null };
}

/** Days a document stays in the trash before it is deleted for good; null: kept for ever. */
export async function trashDays(db: Sql | TransactionSql): Promise<number | null> {
  return setting<number>(db, KEY.trashDays);
}
