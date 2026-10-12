import { handleError, loadSettings, syncAccount } from './lib/brevo';

export const config: SwellConfig = {
  description: 'Sync customer accounts to Brevo contacts',
  model: {
    events: ['account.created', 'account.updated'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const eventType = data.$event?.type;

  const settings = await loadSettings(swell);
  if (!settings?.sync_contacts) {
    return;
  }

  // account.updated carries only changed fields, so load the full account
  const account = await swell.get('/accounts/{id}', { id: data.id });
  if (!account) {
    console.error(`Brevo: account ${data.id} not found`);
    return;
  }

  try {
    await syncAccount(eventType, data, account, settings);
  } catch (err) {
    handleError(`contact sync for account ${data.id}`, err);
  }
}
