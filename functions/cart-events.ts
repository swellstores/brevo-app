import { handleEventError, loadSettings, trackEvent } from './lib/brevo';

export const config: SwellConfig = {
  description: 'Track cart checkout events in Brevo',
  model: {
    events: ['cart.created', 'cart.abandoned'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const eventType = data.$event?.type;

  const settings = await loadSettings(swell);
  if (!settings) {
    return;
  }

  const cart = await swell.get('/carts/{id}', {
    id: data.id,
    expand: ['account', 'items.product', 'items.variant'],
  });

  if (!cart) {
    console.error(`Brevo: cart ${data.id} not found`);
    return;
  }

  try {
    await trackEvent(eventType, cart, settings);
  } catch (err) {
    handleEventError(`${eventType} for cart ${data.id}`, err);
  }
}
