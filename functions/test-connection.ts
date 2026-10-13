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
    if (err instanceof BrevoError && err.ipBlocked) {
      return {
        message:
          'Brevo blocked the request because it came from an IP address that is not authorized. ' +
          'Swell has no fixed IP addresses to add, so turn off blocking of unknown IP addresses in ' +
          'Brevo → Security → Authorized IPs, then run Test connection again.',
      };
    }
    if (err instanceof BrevoError && err.status === 401) {
      return { message: 'Brevo rejected the API key. Check it in Brevo → Settings → SMTP & API → API Keys.' };
    }
    return { message: `Brevo request failed: ${err instanceof Error ? err.message : err}` };
  }
}
