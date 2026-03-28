/**
 * Get the public URL for a state's front-of-shirt design PDF.
 * Fronts are stored in the public "shirt-fronts" bucket.
 */
export function getFrontUrl(state: string): string {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  // State abbreviation from meet_name: "USAG W Gymnastics - 2026 MN - March 20" → "MN"
  const abbrev = extractStateAbbrev(state);
  return `${supabaseUrl}/storage/v1/object/public/shirt-fronts/${abbrev}.pdf`;
}

/**
 * Extract state abbreviation from various formats.
 * "MN" → "MN", "Minnesota" → "MN", "USAG W Gymnastics - 2026 MN - March 20" → "MN"
 */
function extractStateAbbrev(input: string): string {
  // If it's already a 2-letter code
  if (/^[A-Z]{2}$/.test(input)) return input;

  // If it's a meet name, extract from "2026 MN" portion
  const meetMatch = input.match(/\d{4}\s+([A-Z]{2})/);
  if (meetMatch) return meetMatch[1];

  // If it's a full state name, map it
  const STATE_ABBREVS: Record<string, string> = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
    colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
    hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
    kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
    massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
    missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
    oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
    vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
    wisconsin: "WI", wyoming: "WY",
  };

  return STATE_ABBREVS[input.toLowerCase()] || input;
}
