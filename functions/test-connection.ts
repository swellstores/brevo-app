import { BrevoError, getSettings, testConnection } from './lib/brevo';

export const config: SwellConfig = {
  description: 'Check the Brevo API key and email list',
  action: true,
};

export default async function (req: SwellRequest) {
  const settings = getSettings(await req.swell.settings());

  if (!settings.api_key) {
    return { message: 'Add your Brevo API key and save the settings first.' };
  }

  try {
    return { message: await testConnection(settings) };
  } catch (err) {
    if (err instanceof BrevoError && err.status === 401) {
      return { message: 'Brevo rejected the API key. Check it in Brevo → Settings → SMTP & API → API Keys.' };
    }
    return { message: `Brevo request failed: ${err instanceof Error ? err.message : err}` };
  }
}
