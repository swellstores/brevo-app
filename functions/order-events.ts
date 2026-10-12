import { handleError, loadSettings, syncOrder, trackEvent } from './lib/brevo';

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

  // event and order sync are independent: one failing does not skip the other
  const results = await Promise.allSettled([
    trackEvent(eventType, order, settings),
    syncOrder(order, settings),
  ]);

  const labels = [`${eventType} for order ${data.id}`, `order sync for order ${data.id}`];
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      handleError(labels[i], result.reason);
    }
  });
}
