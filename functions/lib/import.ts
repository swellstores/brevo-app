import { BrevoError, brevoRequest, buildContactAttributes, upsertContact, type BrevoSettings } from './brevo';

// accounts loaded per workflow step
export const PAGE_SIZE = 100;

// parallel Brevo calls for contacts that are upserted one by one
const CONCURRENCY = 5;

const ACCOUNT_FIELDS = 'id,email,first_name,last_name,phone,email_optin,sms_optin,shipping,billing';

export interface ImportStats {
  imported: number;
  upserted: number;
  skipped: number;
  failed: number;
}

export interface PageResult extends ImportStats {
  count: number;
  last_id: string | null;
  // set when the app was disabled before the page was sent
  disabled?: boolean;
  // set when the API key was removed before the page was sent
  missing_api_key?: boolean;
}

export function emptyStats(): ImportStats {
  return { imported: 0, upserted: 0, skipped: 0, failed: 0 };
}

export function addStats(total: ImportStats, page: ImportStats): ImportStats {
  return {
    imported: total.imported + page.imported,
    upserted: total.upserted + page.upserted,
    skipped: total.skipped + page.skipped,
    failed: total.failed + page.failed,
  };
}

// next page of accounts after the given id, oldest first
export async function fetchAccounts(
  swell: { get(url: string, query?: object): Promise<any> },
  afterId: string | null,
  limit = PAGE_SIZE,
): Promise<any[]> {
  const query: any = { sort: 'id asc', limit, fields: ACCOUNT_FIELDS };
  if (afterId) {
    query.where = { id: { $gt: afterId } };
  }
  const page = await swell.get('/accounts', query);
  return page?.results || [];
}

// split accounts into list imports (opted in, list set), single upserts and skipped
export function partitionAccounts(accounts: any[], settings: BrevoSettings, onlyOptin: boolean) {
  const toImport: any[] = [];
  const toUpsert: any[] = [];
  let skipped = 0;

  for (const account of accounts) {
    if (!account?.email || (onlyOptin && account.email_optin !== true)) {
      skipped++;
    } else if (account.email_optin === true && settings.list_id) {
      toImport.push(account);
    } else {
      toUpsert.push(account);
    }
  }

  return { toImport, toUpsert, skipped };
}

// add opted-in accounts to the list with one Brevo import job; returns the number that failed.
// Retryable errors fail the step so the workflow retries the page; other errors (e.g. the list was deleted)
// count the page's accounts as failed and the import continues, like the one-by-one path.
export async function importToList(accounts: any[], settings: BrevoSettings): Promise<number> {
  if (!accounts.length || !settings.list_id) {
    return 0;
  }
  let result: any;
  try {
    result = await brevoRequest(settings.api_key, 'POST', '/contacts/import', {
      jsonBody: accounts.map((account) => ({
        email: account.email,
        attributes: buildContactAttributes(account, settings),
      })),
      listIds: [settings.list_id],
      updateExistingContacts: true,
      emptyContactsAttributes: false,
      disableNotification: true,
    });
  } catch (err) {
    if (err instanceof BrevoError && err.retryable) {
      throw err;
    }
    console.error(
      `Brevo: import job for ${accounts.length} contacts failed:`,
      err instanceof Error ? err.message : err,
    );
    return accounts.length;
  }
  console.log(`Brevo: import job ${result?.processId} queued for ${accounts.length} contacts`);
  return 0;
}

// upsert accounts one by one; returns the number that failed with a non-retryable error
export async function upsertEach(accounts: any[], settings: BrevoSettings): Promise<number> {
  let failed = 0;
  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const batch = accounts.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((account) => upsertContact(account, settings)));
    results.forEach((result, j) => {
      if (result.status === 'fulfilled') {
        return;
      }
      // retryable errors fail the step so the workflow retries the page
      if (result.reason instanceof BrevoError && result.reason.retryable) {
        throw result.reason;
      }
      failed++;
      console.error(`Brevo: import of ${batch[j].email} failed:`, result.reason?.message || result.reason);
    });
  }
  return failed;
}

// sync one page of accounts to Brevo
export async function importPage(accounts: any[], settings: BrevoSettings, onlyOptin: boolean): Promise<ImportStats> {
  const { toImport, toUpsert, skipped } = partitionAccounts(accounts, settings, onlyOptin);
  const importFailed = await importToList(toImport, settings);
  const upsertFailed = await upsertEach(toUpsert, settings);
  return {
    imported: toImport.length - importFailed,
    upserted: toUpsert.length - upsertFailed,
    skipped,
    failed: importFailed + upsertFailed,
  };
}
