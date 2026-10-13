import { formatPhone } from './phone';

const API_BASE = 'https://api.brevo.com/v3';

export interface BrevoSettings {
  api_key: string;
  enabled: boolean;
  sync_contacts: boolean;
  list_id: number | null;
  remove_on_optout: boolean;
  sync_sms: boolean;
  firstname_attribute: string;
  lastname_attribute: string;
  event_checkout_started: boolean;
  event_cart_abandoned: boolean;
  event_order_submitted: boolean;
  event_order_fulfilled: boolean;
  event_order_canceled: boolean;
  sync_orders: boolean;
}

// Error returned by the Brevo API (or a network failure when status is 0)
export class BrevoError extends Error {
  status: number;
  code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(`Brevo ${status}${code ? ` ${code}` : ''}: ${message}`);
    this.name = 'BrevoError';
    this.status = status;
    this.code = code;
  }

  // network errors, rate limits and server errors are worth retrying
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  // 401 from Brevo's Authorized IPs check: the key is valid, but the caller's IP isn't on the allowlist
  get ipBlocked(): boolean {
    return this.status === 401 && /\bIP\b|authori[sz]ed_ips/i.test(this.message);
  }
}

// Swell event → Brevo event name and the setting that turns it on
export const EVENTS: Record<string, { name: string; setting: keyof BrevoSettings }> = {
  'cart.created': { name: 'checkout_started', setting: 'event_checkout_started' },
  'cart.abandoned': { name: 'cart_abandoned', setting: 'event_cart_abandoned' },
  'order.submitted': { name: 'order_submitted', setting: 'event_order_submitted' },
  'order.delivered': { name: 'order_fulfilled', setting: 'event_order_fulfilled' },
  'order.canceled': { name: 'order_canceled', setting: 'event_order_canceled' },
};

// account fields that affect the Brevo contact
const CONTACT_FIELDS = ['email', 'first_name', 'last_name', 'phone', 'email_optin', 'sms_optin', 'shipping', 'billing'];

// parse a Brevo list id; returns null when empty or not a positive integer
export function parseListId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const id = Number(String(value).trim().replace(/^#/, ''));
  return Number.isInteger(id) && id > 0 ? id : null;
}

// read app settings and apply defaults for values the merchant has not saved yet
export function getSettings(all: any): BrevoSettings {
  const raw = all?.brevo || {};
  const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  const text = (value: unknown, fallback: string) =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback;

  return {
    api_key: text(raw.api_key, ''),
    enabled: flag(raw.enabled, true),
    sync_contacts: flag(raw.sync_contacts, true),
    list_id: parseListId(raw.list_id),
    remove_on_optout: flag(raw.remove_on_optout, true),
    sync_sms: flag(raw.sync_sms, false),
    firstname_attribute: text(raw.firstname_attribute, 'FIRSTNAME').toUpperCase(),
    lastname_attribute: text(raw.lastname_attribute, 'LASTNAME').toUpperCase(),
    event_checkout_started: flag(raw.event_checkout_started, true),
    event_cart_abandoned: flag(raw.event_cart_abandoned, true),
    event_order_submitted: flag(raw.event_order_submitted, true),
    event_order_fulfilled: flag(raw.event_order_fulfilled, true),
    event_order_canceled: flag(raw.event_order_canceled, true),
    sync_orders: flag(raw.sync_orders, false),
  };
}

// load settings and check the app can call Brevo
export async function loadSettings(swell: SwellAPI): Promise<BrevoSettings | null> {
  const settings = getSettings(await swell.settings());
  if (!settings.enabled) {
    return null;
  }
  if (!settings.api_key) {
    console.error('Brevo: missing API key in app settings');
    return null;
  }
  return settings;
}

// call the Brevo API; returns parsed JSON or null for empty responses
export async function brevoRequest(
  apiKey: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: object,
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'api-key': apiKey,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err: any) {
    throw new BrevoError(0, 'network_error', err?.message || String(err));
  }

  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    throw new BrevoError(res.status, json?.code, json?.message || text || res.statusText);
  }

  return json;
}

// rethrow errors Swell should retry, log the rest
export function handleError(label: string, err: unknown): void {
  if (err instanceof BrevoError && err.retryable) {
    throw err;
  }
  console.error(`Brevo: ${label} failed:`, err instanceof Error ? err.message : err);
}

// true when the event may change the Brevo contact
export function isContactChange(eventType: string | undefined, data: any): boolean {
  if (eventType !== 'account.updated') {
    return true;
  }
  // account.updated delivers only the changed fields
  return CONTACT_FIELDS.some((field) => data?.[field] !== undefined);
}

// E.164 phone for SMS, only when the customer opted in and SMS sync is on
export function getSmsPhone(account: any, settings: BrevoSettings): string | undefined {
  if (!settings.sync_sms || account?.sms_optin !== true) {
    return undefined;
  }
  const country = account.shipping?.country || account.billing?.country;
  return formatPhone(account.phone || account.shipping?.phone || account.billing?.phone, country);
}

// Brevo contact attributes for a Swell account
export function buildContactAttributes(account: any, settings: BrevoSettings): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (account?.first_name) {
    attributes[settings.firstname_attribute] = account.first_name;
  }
  if (account?.last_name) {
    attributes[settings.lastname_attribute] = account.last_name;
  }
  const sms = getSmsPhone(account, settings);
  if (sms) {
    attributes.SMS = sms;
  }
  return attributes;
}

// create or update the Brevo contact, retrying once without SMS when Brevo rejects the number
export async function upsertContact(account: any, settings: BrevoSettings): Promise<void> {
  const attributes = buildContactAttributes(account, settings);
  const body: any = { email: account.email, attributes, updateEnabled: true };
  if (account.email_optin === true && settings.list_id) {
    body.listIds = [settings.list_id];
  }

  try {
    await brevoRequest(settings.api_key, 'POST', '/contacts', body);
  } catch (err) {
    // Brevo rejects invalid SMS numbers and numbers already used by another contact
    if (!(err instanceof BrevoError) || err.status !== 400 || !attributes.SMS) {
      throw err;
    }
    console.log(`Brevo: SMS rejected for ${account.email}, retrying without it (${err.message})`);
    delete attributes.SMS;
    await brevoRequest(settings.api_key, 'POST', '/contacts', body);
  }

  console.log(`Brevo: synced contact ${account.email}${body.listIds ? ` to list ${settings.list_id}` : ''}`);
}

// remove the contact from the email list
export async function removeFromList(email: string, settings: BrevoSettings): Promise<void> {
  if (!settings.list_id) {
    return;
  }
  try {
    await brevoRequest(
      settings.api_key,
      'PUT',
      `/contacts/${encodeURIComponent(email)}?identifierType=email_id`,
      { unlinkListIds: [settings.list_id] },
    );
    console.log(`Brevo: removed ${email} from list ${settings.list_id}`);
  } catch (err) {
    // contact unknown to Brevo or not in the list: nothing to remove
    if (err instanceof BrevoError && (err.status === 400 || err.status === 404)) {
      console.log(`Brevo: ${email} not removed from list (${err.message})`);
      return;
    }
    throw err;
  }
}

// sync a Swell account to Brevo after an account event
export async function syncAccount(
  eventType: string | undefined,
  changed: any,
  account: any,
  settings: BrevoSettings,
): Promise<void> {
  if (!settings.sync_contacts) {
    return;
  }
  if (!account?.email) {
    console.log('Brevo: account has no email, skipping');
    return;
  }
  if (!isContactChange(eventType, changed)) {
    return;
  }

  await upsertContact(account, settings);

  // opt-out: email_optin changed to false on this update
  if (
    settings.remove_on_optout &&
    eventType === 'account.updated' &&
    changed?.email_optin === false &&
    account.email_optin !== true
  ) {
    await removeFromList(account.email, settings);
  }
}

// cart/order items in a flat format
export function mapItems(items: any[] | undefined): object[] {
  if (!items?.length) {
    return [];
  }
  return items.map((item) => ({
    id: item.id,
    product_id: item.product_id,
    variant_id: item.variant_id,
    name: item.product?.name,
    slug: item.product?.slug,
    sku: item.variant?.sku ?? item.product?.sku,
    image_url: item.variant?.images?.[0]?.file?.url ?? item.product?.images?.[0]?.file?.url,
    quantity: item.quantity,
    price: item.price,
    price_total: item.price_total,
    discount_total: item.discount_total,
  }));
}

// remove undefined values so Brevo gets a compact payload
function compact(value: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null));
}

// Brevo event payload for a cart or order
export function buildEventPayload(eventName: string, record: any, settings: BrevoSettings): object {
  const account = record.account || {};
  const contactProperties = compact({
    [settings.firstname_attribute]: account.first_name,
    [settings.lastname_attribute]: account.last_name,
  });

  return {
    event_name: eventName,
    identifiers: { email_id: account.email },
    ...(Object.keys(contactProperties).length ? { contact_properties: contactProperties } : {}),
    event_properties: compact({
      id: record.id,
      number: record.number,
      status: record.status,
      currency: record.currency,
      grand_total: record.grand_total,
      sub_total: record.sub_total,
      discount_total: record.discount_total,
      tax_total: record.tax_total,
      shipment_total: record.shipment_total,
      coupon_code: record.coupon_code,
      checkout_url: record.checkout_url,
      items: mapItems(record.items),
    }),
  };
}

// send a Brevo event for a Swell cart/order event
export async function trackEvent(eventType: string | undefined, record: any, settings: BrevoSettings): Promise<void> {
  const event = eventType ? EVENTS[eventType] : undefined;
  if (!event) {
    console.log(`Brevo: unsupported event ${eventType}`);
    return;
  }
  if (!settings[event.setting]) {
    return;
  }
  if (!record?.account?.email) {
    console.log(`Brevo: ${event.name} skipped, ${record?.id} has no customer email`);
    return;
  }

  await brevoRequest(settings.api_key, 'POST', '/events', buildEventPayload(event.name, record, settings));
  console.log(`Brevo: tracked ${event.name} for ${record.account.email}`);
}

// Brevo date format: YYYY-MM-DDTHH:mm:ssZ
export function formatDate(value: string | undefined): string {
  const date = value ? new Date(value) : new Date();
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  return valid.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Brevo eCommerce order payload
export function buildOrderPayload(order: any): object {
  return {
    id: String(order.number || order.id),
    createdAt: formatDate(order.date_created),
    updatedAt: formatDate(order.date_updated),
    status: order.status,
    amount: order.grand_total ?? 0,
    identifiers: { email_id: order.account?.email },
    products: (order.items || []).map((item: any) =>
      compact({
        productId: item.product_id,
        variantId: item.variant_id,
        price: item.price ?? 0,
        quantity: item.quantity ?? 1,
      }),
    ),
    ...(order.coupon_code ? { coupons: [order.coupon_code] } : {}),
  };
}

// create or update the order in Brevo eCommerce
export async function syncOrder(order: any, settings: BrevoSettings): Promise<void> {
  if (!settings.sync_orders) {
    return;
  }
  if (!order?.account?.email) {
    console.log(`Brevo: order ${order?.id} has no customer email, not synced`);
    return;
  }
  await brevoRequest(settings.api_key, 'POST', '/orders/status', buildOrderPayload(order));
  console.log(`Brevo: synced order ${order.number || order.id} (${order.status})`);
}

// check the API key and list; returns a message for the merchant
export async function testConnection(settings: BrevoSettings): Promise<string> {
  const account = await brevoRequest(settings.api_key, 'GET', '/account');
  const who = account?.companyName || account?.email || 'your account';
  const notes: string[] = [`Connected to Brevo as ${who}.`];

  if (settings.list_id) {
    try {
      const list = await brevoRequest(settings.api_key, 'GET', `/contacts/lists/${settings.list_id}`);
      notes.push(`Email list: ${list?.name || settings.list_id} (#${settings.list_id}).`);
    } catch (err) {
      // only a 404 means the list doesn't exist; rate limits, network errors and the rest are reported as they are
      if (err instanceof BrevoError && err.status === 404) {
        notes.push(`Email list #${settings.list_id} was not found in Brevo.`);
      } else {
        const reason = err instanceof Error ? err.message : String(err);
        notes.push(`Email list #${settings.list_id} could not be checked, try again: ${reason}`);
      }
    }
  } else {
    notes.push('No email list is set, so opted-in customers are not added to a list.');
  }

  return notes.join(' ');
}
