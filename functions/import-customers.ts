import { getSettings } from './lib/brevo';
import { PAGE_SIZE, addStats, emptyStats, fetchAccounts, importPage, type PageResult } from './lib/import';

export const config: SwellConfig = {
  kind: 'workflow',
  description: 'Import existing customers into Brevo',
  action: true,
};

export default class ImportCustomers {
  async run(req: SwellWorkflowRequest, step: SwellWorkflowStep) {
    const onlyOptin = (req.data as any)?.only_optin === true;

    const rawSettings = await step.do('load settings', async () => req.swell.settings());
    const settings = getSettings(rawSettings);

    if (!settings.api_key) {
      console.error('Brevo: import skipped, missing API key in app settings');
      return { error: 'missing_api_key' };
    }

    let totals = emptyStats();
    let lastId: string | null = null;

    for (let page = 1; ; page++) {
      const afterId = lastId;
      const result: PageResult = await step.do(
        `page ${page}`,
        { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } },
        async () => {
          const accounts = await fetchAccounts(req.swell, afterId);
          const stats = await importPage(accounts, settings, onlyOptin);
          return { ...stats, count: accounts.length, last_id: accounts[accounts.length - 1]?.id ?? null };
        },
      );

      totals = addStats(totals, result);
      lastId = result.last_id;

      if (result.count < PAGE_SIZE || !lastId) {
        break;
      }
    }

    console.log(
      `Brevo: import finished. Added to list: ${totals.imported}, synced: ${totals.upserted}, ` +
        `skipped: ${totals.skipped}, failed: ${totals.failed}`,
    );
    return totals;
  }
}
