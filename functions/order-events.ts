import { handleError, handleEventError, loadSettings, syncOrder, trackEvent } from './lib/brevo';

export const config: SwellConfig = {
  description: 'Track order lifecycle events and sync orders in Brevo',
  model: {
    events: ['order.submitted', 'order.delivered', 'order.canceled'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const eventType = data.$event?.type;

  const settings = await loadSettings(swell);
  if (!settings) {
    return;
  }

  const order = await swell.get('/orders/{id}', {
    id: data.id,
    expand: ['account', 'items.product', 'items.variant'],
  });

  if (!order) {
    console.error(`Brevo: order ${data.id} not found`);
    return;
  }

  // event and order sync are independent: one failing does not skip the other.
  // The order sync is an upsert, so it runs first: a retryable failure there is thrown before the event
  // is sent, and a retry only repeats the upsert. The event is retried only on a 429 (see handleEventError).
  try {
    await syncOrder(order, settings);
  } catch (err) {
    handleError(`order sync for order ${data.id}`, err);
  }

  try {
    await trackEvent(eventType, order, settings);
  } catch (err) {
    handleEventError(`${eventType} for order ${data.id}`, err);
  }
}
