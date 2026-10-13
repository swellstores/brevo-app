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

    // step output is stored with the run, so keep only flags here, never the API key
    const check = await step.do('load settings', async () => {
      const settings = getSettings(await req.swell.settings());
      return { enabled: settings.enabled, has_api_key: Boolean(settings.api_key) };
    });

    // throw so the run ends as failed instead of completed
    if (!check.enabled) {
      console.log('Brevo: import skipped, the app is disabled in settings');
      throw new Error('Import not started: the Brevo app is disabled in its settings.');
    }

    if (!check.has_api_key) {
      console.error('Brevo: import skipped, missing API key in app settings');
      throw new Error('Import not started: add your Brevo API key in the app settings.');
    }

    let totals = emptyStats();
    let lastId: string | null = null;

    for (let page = 1; ; page++) {
      const afterId = lastId;
      const result: PageResult = await step.do(
        `page ${page}`,
        { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } },
        async () => {
          // settings are read in each page so the API key stays out of step output;
          // stop sending if the app was disabled while the import was running
          const settings = getSettings(await req.swell.settings());
          if (!settings.enabled) {
            return { ...emptyStats(), count: 0, last_id: null, disabled: true };
          }
          if (!settings.api_key) {
            return { ...emptyStats(), count: 0, last_id: null, missing_api_key: true };
          }
          const accounts = await fetchAccounts(req.swell, afterId);
          const stats = await importPage(accounts, settings, onlyOptin);
          return { ...stats, count: accounts.length, last_id: accounts[accounts.length - 1]?.id ?? null };
        },
      );

      if (result.disabled || result.missing_api_key) {
        const reason = result.disabled ? 'the app was disabled in settings' : 'the API key was removed from settings';
        console.log(`Brevo: import stopped at page ${page}, ${reason}`);
        throw new Error(
          `Import stopped: ${reason}. Before stopping: added to list ${totals.imported}, ` +
            `synced ${totals.upserted}, skipped ${totals.skipped}, failed ${totals.failed}.`,
        );
      }

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
