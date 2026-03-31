/**
 * Meet name normalization.
 *
 * Canonical format: [Association] [Gender] [Sport] - [Year] [State] - [Dates]
 * Example: "USAG W Gymnastics - 2026 KY - March 14-16"
 *
 * This ensures the same meet always produces the same name regardless of
 * what the inner agent calls it, preventing duplicates in the central database.
 */

const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
};

export interface MeetIdentity {
  association: string;
  gender: string;
  sport: string;
  year: string;
  state: string;
  dates?: string;
}

/**
 * Normalize a state name or abbreviation to a 2-letter code.
 * "Minnesota" -> "MN", "MN" -> "MN", "mn" -> "MN"
 */
export function normalizeState(input: string): string {
  if (!input) return '';
  const trimmed = input.trim();
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return STATE_NAMES[trimmed.toLowerCase()] || trimmed.toUpperCase().slice(0, 2);
}

/**
 * Produce the canonical meet name from structured fields.
 * Format: [Association] [Gender] [Sport] - [Year] [State] - [Dates]
 */
export function normalizeMeetName(identity: MeetIdentity): string {
  const stateAbbrev = normalizeState(identity.state);
  const genderInitial = identity.gender.startsWith('W') || identity.gender.startsWith('w') ? 'W'
    : identity.gender.startsWith('M') || identity.gender.startsWith('m') ? 'M' : 'W';
  const association = (identity.association || 'USAG').toUpperCase();
  const sport = identity.sport || 'Gymnastics';
  const year = identity.year || new Date().getFullYear().toString();

  const base = `${association} ${genderInitial} ${sport} - ${year} ${stateAbbrev}`;

  if (identity.dates) {
    // Strip trailing year from dates: "March 20, 2026" -> "March 20"
    let cleanDates = identity.dates.replace(/,?\s*\d{4}\s*$/, '').trim();
    // Normalize date separators: "March 13 & 21" → "March 13-21"
    cleanDates = normalizeDateSeparators(cleanDates);
    if (cleanDates) return `${base} - ${cleanDates}`;
  }
  return base;
}

/**
 * Normalize date range separators to prevent duplicate meet names.
 * "March 13 & 21" → "March 13-21"
 * "March 13 and 21" → "March 13-21"
 * Collapses extra whitespace around separators.
 */
export function normalizeDateSeparators(dates: string): string {
  return dates
    .replace(/\s*&\s*/g, '-')
    .replace(/\s+and\s+/gi, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
