export const US_STATES = [
  { abbr: 'AL', name: 'Alabama' },
  { abbr: 'AK', name: 'Alaska' },
  { abbr: 'AZ', name: 'Arizona' },
  { abbr: 'AR', name: 'Arkansas' },
  { abbr: 'CA', name: 'California' },
  { abbr: 'CO', name: 'Colorado' },
  { abbr: 'CT', name: 'Connecticut' },
  { abbr: 'DE', name: 'Delaware' },
  { abbr: 'FL', name: 'Florida' },
  { abbr: 'GA', name: 'Georgia' },
  { abbr: 'HI', name: 'Hawaii' },
  { abbr: 'ID', name: 'Idaho' },
  { abbr: 'IL', name: 'Illinois' },
  { abbr: 'IN', name: 'Indiana' },
  { abbr: 'IA', name: 'Iowa' },
  { abbr: 'KS', name: 'Kansas' },
  { abbr: 'KY', name: 'Kentucky' },
  { abbr: 'LA', name: 'Louisiana' },
  { abbr: 'ME', name: 'Maine' },
  { abbr: 'MD', name: 'Maryland' },
  { abbr: 'MA', name: 'Massachusetts' },
  { abbr: 'MI', name: 'Michigan' },
  { abbr: 'MN', name: 'Minnesota' },
  { abbr: 'MS', name: 'Mississippi' },
  { abbr: 'MO', name: 'Missouri' },
  { abbr: 'MT', name: 'Montana' },
  { abbr: 'NE', name: 'Nebraska' },
  { abbr: 'NV', name: 'Nevada' },
  { abbr: 'NH', name: 'New Hampshire' },
  { abbr: 'NJ', name: 'New Jersey' },
  { abbr: 'NM', name: 'New Mexico' },
  { abbr: 'NY', name: 'New York' },
  { abbr: 'NC', name: 'North Carolina' },
  { abbr: 'ND', name: 'North Dakota' },
  { abbr: 'OH', name: 'Ohio' },
  { abbr: 'OK', name: 'Oklahoma' },
  { abbr: 'OR', name: 'Oregon' },
  { abbr: 'PA', name: 'Pennsylvania' },
  { abbr: 'RI', name: 'Rhode Island' },
  { abbr: 'SC', name: 'South Carolina' },
  { abbr: 'SD', name: 'South Dakota' },
  { abbr: 'TN', name: 'Tennessee' },
  { abbr: 'TX', name: 'Texas' },
  { abbr: 'UT', name: 'Utah' },
  { abbr: 'VT', name: 'Vermont' },
  { abbr: 'VA', name: 'Virginia' },
  { abbr: 'WA', name: 'Washington' },
  { abbr: 'WV', name: 'West Virginia' },
  { abbr: 'WI', name: 'Wisconsin' },
  { abbr: 'WY', name: 'Wyoming' },
  { abbr: 'DC', name: 'District of Columbia' },
];

export function normalizeUsState(value: string): string {
  const upper = value.trim().toUpperCase();
  const state = US_STATES.find(s => s.abbr === upper || s.name.toUpperCase() === upper);
  return state ? state.abbr : '';
}

export function usStateName(value: string): string {
  const abbreviation = normalizeUsState(value);
  return US_STATES.find((state) => state.abbr === abbreviation)?.name ?? value;
}

/**
 * US numbers only: drop a leading country code 1 (typed "+1", pasted
 * "1-555-…") and keep at most 10 digits. No US area code starts with 1, so a
 * leading 1 is always the country code — stripping it while the person is
 * still typing keeps "+1" hidden instead of rendering "(1".
 */
function usPhoneDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  return (digits.startsWith('1') ? digits.slice(1) : digits).slice(0, 10);
}

export function formatUsPhone(value: string): string {
  const digits = usPhoneDigits(value);
  if (digits.length === 0) return '';
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

export function normalizeUsPhone(value: string): string {
  return usPhoneDigits(value);
}

export function isValidUsPhone(value: string): boolean {
  return normalizeUsPhone(value).length === 10;
}

export function normalizeUsPostalCode(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 9);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

export function isValidUsPostalCode(value: string): boolean {
  return /^[0-9]{5}(?:-[0-9]{4})?$/.test(normalizeUsPostalCode(value));
}
