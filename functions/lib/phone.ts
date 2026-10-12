import { parsePhoneNumberWithError, type CountryCode } from 'libphonenumber-js';

// Formats phone number to E.164 format (Brevo requires a country code for SMS)
export function formatPhone(
  phone: string | null | undefined,
  countryCode?: string,
): string | undefined {
  if (!phone) {
    return undefined;
  }

  try {
    const phoneNumber = parsePhoneNumberWithError(phone, countryCode?.toUpperCase() as CountryCode);
    if (!phoneNumber?.isValid()) {
      return undefined;
    }

    return phoneNumber.number;
  } catch (err) {
    return undefined;
  }
}
