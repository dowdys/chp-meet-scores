/**
 * Seed realistic-volume test orders into Supabase.
 *
 * Usage:
 *   cd website && npx tsx scripts/seed-realistic-orders.ts
 *
 * Queries real winner data from MN, KY, LA, NE meets, then creates ~372
 * orders with ~557 shirts at a 30% conversion rate, realistic statuses,
 * printer batches, and email captures.
 *
 * All test records use:
 *   - Order numbers: TEST-REAL-2026-NNNNN
 *   - Customer emails: *@test.example.com
 *   - Batch names: TEST-REAL-*
 *
 * Cleanup: bash supabase/cleanup-test-data.sh  (matches TEST-* prefix)
 */

import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Load .env.local manually (no dotenv dep needed — matches other scripts)
// ---------------------------------------------------------------------------
function loadEnvLocal(): void {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) {
    console.error("ERROR: .env.local not found at", envPath);
    console.error("  Run this script from the website/ directory.");
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvLocal();

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SB_URL || !SB_KEY) {
  console.error(
    "ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Supabase REST helpers
// ---------------------------------------------------------------------------
async function sbGet<T = unknown>(table: string, params: string): Promise<T> {
  // Request up to 10000 rows (override PostgREST default 1000 limit)
  const separator = params ? "&" : "";
  const res = await fetch(
    `${SB_URL}/rest/v1/${table}?${params}${separator}limit=10000`,
    {
      headers: {
        apikey: SB_KEY!,
        Authorization: `Bearer ${SB_KEY}`,
      },
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${table}: HTTP ${res.status} — ${body}`);
  }
  return res.json() as Promise<T>;
}

async function sbInsert<T = unknown>(table: string, data: unknown): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY!,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`INSERT ${table}: HTTP ${res.status} — ${body}`);
  }
  return res.json() as Promise<T>;
}

async function sbPatch(
  table: string,
  filter: string,
  data: unknown
): Promise<void> {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      apikey: SB_KEY!,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PATCH ${table}: HTTP ${res.status} — ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Batch insert helper — PostgREST caps at ~1000 rows; we batch at 500.
// All items in a batch must have identical keys (PostgREST requirement),
// so we normalize nulls before inserting.
// ---------------------------------------------------------------------------
async function sbBatchInsert<T = unknown>(
  table: string,
  rows: Record<string, unknown>[],
  batchSize = 500
): Promise<T[]> {
  if (rows.length === 0) return [];

  // Collect all keys across all rows so every row has identical keys
  const allKeys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      allKeys.add(key);
    }
  }
  const keyList = Array.from(allKeys);

  // Normalize: ensure every row has every key (null if missing)
  const normalized = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of keyList) {
      out[key] = key in row ? row[key] : null;
    }
    return out;
  });

  const results: T[] = [];
  for (let i = 0; i < normalized.length; i += batchSize) {
    const chunk = normalized.slice(i, i + batchSize);
    const res = await sbInsert<T[]>(table, chunk);
    results.push(...res);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Pricing constants (all in cents)
// ---------------------------------------------------------------------------
const SHIRT_PRICE = 2795;
const JEWEL_PRICE = 450;
const SHIPPING_FIRST = 525;
const SHIPPING_ADDITIONAL = 290;

function calcShipping(shirtCount: number): number {
  if (shirtCount <= 0) return 0;
  return SHIPPING_FIRST + (shirtCount - 1) * SHIPPING_ADDITIONAL;
}

// ---------------------------------------------------------------------------
// Deterministic RNG (seeded, reproducible)
// ---------------------------------------------------------------------------
let rngState = 20260401;
function rng(): number {
  rngState = (rngState * 1664525 + 1013904223) & 0xffffffff;
  return (rngState >>> 0) / 0xffffffff;
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Address pools per state (realistic cities with zip codes)
// ---------------------------------------------------------------------------
const STATE_CITIES: Record<string, Array<{ city: string; zip: string }>> = {
  MN: [
    { city: "Minneapolis", zip: "55401" },
    { city: "Saint Paul", zip: "55101" },
    { city: "Rochester", zip: "55901" },
    { city: "Duluth", zip: "55802" },
    { city: "Bloomington", zip: "55420" },
    { city: "Edina", zip: "55424" },
    { city: "Eagan", zip: "55121" },
    { city: "Plymouth", zip: "55441" },
    { city: "Woodbury", zip: "55125" },
    { city: "Maple Grove", zip: "55369" },
  ],
  KY: [
    { city: "Louisville", zip: "40202" },
    { city: "Lexington", zip: "40507" },
    { city: "Bowling Green", zip: "42101" },
    { city: "Covington", zip: "41011" },
    { city: "Frankfort", zip: "40601" },
    { city: "Richmond", zip: "40475" },
    { city: "Georgetown", zip: "40324" },
    { city: "Florence", zip: "41042" },
    { city: "Henderson", zip: "42420" },
    { city: "Nicholasville", zip: "40356" },
  ],
  LA: [
    { city: "Baton Rouge", zip: "70801" },
    { city: "New Orleans", zip: "70112" },
    { city: "Shreveport", zip: "71101" },
    { city: "Lafayette", zip: "70501" },
    { city: "Mandeville", zip: "70471" },
    { city: "Kenner", zip: "70062" },
    { city: "Lake Charles", zip: "70601" },
    { city: "Monroe", zip: "71201" },
    { city: "Alexandria", zip: "71301" },
    { city: "Hammond", zip: "70401" },
  ],
  NE: [
    { city: "Omaha", zip: "68102" },
    { city: "Lincoln", zip: "68508" },
    { city: "Grand Island", zip: "68801" },
    { city: "Kearney", zip: "68847" },
    { city: "Norfolk", zip: "68701" },
    { city: "North Platte", zip: "69101" },
    { city: "Columbus", zip: "68601" },
    { city: "Bellevue", zip: "68005" },
    { city: "Papillion", zip: "68046" },
    { city: "Fremont", zip: "68025" },
  ],
};

const STREET_NAMES = [
  "Oak Ave", "Elm St", "Pine Rd", "Maple Dr", "Cedar Ln", "Birch Way",
  "Spruce Ct", "Walnut St", "Ash Blvd", "Willow Rd", "Poplar Ave",
  "Hickory Ln", "Sycamore St", "Magnolia Dr", "Dogwood Pl", "Redwood Ave",
  "Juniper Way", "Sequoia Ct", "Aspen Rd", "Chestnut Blvd", "Cottonwood St",
  "Linden Ln", "Cypress Ave", "Hawthorn Dr", "Basswood Pl",
];

// Realistic parent first names
const PARENT_FIRST_NAMES = [
  "Jennifer", "Sarah", "Amanda", "Jessica", "Melissa", "Stephanie", "Nicole",
  "Michelle", "Christina", "Rebecca", "Amy", "Heather", "Amber", "Rachel",
  "Laura", "Angela", "Kimberly", "Crystal", "Andrea", "Katie", "Beth",
  "Megan", "Courtney", "Danielle", "Lindsay", "Holly", "Shannon", "Kelly",
  "Tiffany", "Karen", "Julie", "Mary", "Lisa", "Linda", "Patricia",
  "Ashley", "Brittany", "Erin", "Natalie", "Jill", "Kristen", "Allison",
  "Dana", "Tracy", "Carrie", "Wendy", "Tammy", "Dawn", "Stacy", "Robin",
  "David", "Michael", "Chris", "Jason", "Brian", "Matt", "Kevin", "Mark",
  "Scott", "Jeff", "Ryan", "Josh", "Eric", "Andrew", "Dan", "Rob",
  "Steve", "Tom", "James", "John", "Brad", "Adam", "Tim", "Tony",
  "Greg", "Nathan", "Chad", "Ben", "Derek", "Nick",
];

// Shirt sizes
const SIZES_YOUTH = ["YS", "YM", "YL"] as const;
const SIZES_ADULT_SM = ["S", "M"] as const;
const SIZES_ADULT_MED = ["S", "M", "L"] as const;
const SIZES_ADULT_LG = ["XL", "XXL"] as const;
type ShirtSize = "YS" | "YM" | "YL" | "S" | "M" | "L" | "XL" | "XXL";

// Youth levels get youth sizes more often
const YOUTH_LEVELS = new Set([
  "level 1", "level 2", "level 3", "level 4", "level 5",
  "xcel bronze", "xcel silver", "xcel diamond",
  // Also match raw data patterns
  "xb", "xs", "xd",
]);

function pickSize(level: string): ShirtSize {
  const lowerLevel = level.toLowerCase();

  // Check if this is a "younger" level
  const isYouthLevel = YOUTH_LEVELS.has(lowerLevel) ||
    /^(level\s*)?[1-5]$/.test(lowerLevel) ||
    /xcel\s*(bronze|silver|diamond)/i.test(lowerLevel);

  if (isYouthLevel) {
    // 70% YS/YM/YL, 30% adult S/M
    const r = rng();
    if (r < 0.70) return pick(SIZES_YOUTH);
    return pick(SIZES_ADULT_SM);
  } else {
    // 40% YM/YL, 40% S/M/L, 20% XL/XXL
    const r = rng();
    if (r < 0.40) return pick(["YM", "YL"] as const);
    if (r < 0.80) return pick(SIZES_ADULT_MED);
    return pick(SIZES_ADULT_LG);
  }
}

// ---------------------------------------------------------------------------
// Types for Supabase data
// ---------------------------------------------------------------------------
interface Winner {
  name: string;
  gym: string;
  level: string;
  meet_name: string;
  state: string;
}

interface ShirtBack {
  id: number;
  meet_id: number;
  meet_name: string;
  levels: string[];
  level_group_label: string;
}

interface Meet {
  id: number;
  meet_name: string;
  state: string;
}

type OrderStatus =
  | "pending"
  | "paid"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "refunded";

type ProductionStatus =
  | "pending"
  | "queued"
  | "at_printer"
  | "printed"
  | "packed"
  | "cancelled";

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------
const NOW = new Date();

function daysAgo(n: number, hourOffset = 0): Date {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  d.setHours(d.getHours() - hourOffset);
  return d;
}

function jitter(baseDate: Date, hoursRange: number): Date {
  const d = new Date(baseDate);
  d.setMinutes(d.getMinutes() + Math.floor(rng() * hoursRange * 60));
  return d;
}

// ---------------------------------------------------------------------------
// Determine order status based on age (timeline-based)
// ---------------------------------------------------------------------------
function pickOrderStatus(daysOld: number): OrderStatus {
  const r = rng();

  // 3% cancelled, 2% refunded — applied globally first
  if (r < 0.03) return "cancelled";
  if (r < 0.05) return "refunded";

  if (daysOld >= 14) {
    // Week 1 orders (oldest): 60% delivered, 25% shipped, 10% processing, 5% paid
    const r2 = rng();
    if (r2 < 0.60) return "delivered";
    if (r2 < 0.85) return "shipped";
    if (r2 < 0.95) return "processing";
    return "paid";
  } else if (daysOld >= 7) {
    // Week 2 orders: 40% processing, 30% shipped, 20% paid, 10% delivered
    const r2 = rng();
    if (r2 < 0.40) return "processing";
    if (r2 < 0.70) return "shipped";
    if (r2 < 0.90) return "paid";
    return "delivered";
  } else {
    // Last few days: 70% paid, 20% processing, 10% pending
    const r2 = rng();
    if (r2 < 0.70) return "paid";
    if (r2 < 0.90) return "processing";
    return "pending";
  }
}

// ---------------------------------------------------------------------------
// Production status from order status
// ---------------------------------------------------------------------------
function itemProductionStatus(orderStatus: OrderStatus): ProductionStatus {
  switch (orderStatus) {
    case "pending":
    case "paid":
      return "pending";
    case "processing":
      return rng() < 0.5 ? "queued" : "at_printer";
    case "shipped":
    case "delivered":
      return "packed";
    case "cancelled":
    case "refunded":
      return "cancelled";
  }
}

// ---------------------------------------------------------------------------
// Build status history for a given order
// ---------------------------------------------------------------------------
function buildStatusHistory(
  orderId: number,
  status: OrderStatus,
  createdAt: Date,
  paidDate: Date | null,
  shippedDate: Date | null
): Array<Record<string, unknown>> {
  const history: Array<Record<string, unknown>> = [];

  if (status === "pending") {
    history.push({
      order_id: orderId,
      old_status: null,
      new_status: "pending",
      changed_by: "system",
      reason: "Checkout initiated",
      created_at: createdAt.toISOString(),
    });
    return history;
  }

  // All non-pending orders were paid
  history.push({
    order_id: orderId,
    old_status: null,
    new_status: "paid",
    changed_by: "system",
    reason: "Stripe checkout completed",
    created_at: (paidDate ?? createdAt).toISOString(),
  });

  if (status === "paid") return history;

  if (status === "cancelled") {
    const cancelDate = new Date((paidDate ?? createdAt).getTime() + 3600_000 * (1 + rng() * 24));
    history.push({
      order_id: orderId,
      old_status: "paid",
      new_status: "cancelled",
      changed_by: "admin",
      reason: "Customer requested cancellation",
      created_at: cancelDate.toISOString(),
    });
    return history;
  }

  if (status === "refunded") {
    const procDate = new Date((paidDate ?? createdAt).getTime() + 3600_000 * 12);
    history.push({
      order_id: orderId,
      old_status: "paid",
      new_status: "processing",
      changed_by: "seed-realistic",
      reason: "Items queued for printing",
      created_at: procDate.toISOString(),
    });
    const refundDate = new Date(procDate.getTime() + 3600_000 * 24);
    history.push({
      order_id: orderId,
      old_status: "processing",
      new_status: "refunded",
      changed_by: "admin",
      reason: "Refund issued — customer request",
      created_at: refundDate.toISOString(),
    });
    return history;
  }

  // Processing or further
  const procDate = new Date((paidDate ?? createdAt).getTime() + 3600_000 * (6 + rng() * 18));
  history.push({
    order_id: orderId,
    old_status: "paid",
    new_status: "processing",
    changed_by: "seed-realistic",
    reason: "Items queued for printing",
    created_at: procDate.toISOString(),
  });

  if (status === "processing") return history;

  // Shipped or delivered
  history.push({
    order_id: orderId,
    old_status: "processing",
    new_status: "shipped",
    changed_by: "seed-realistic",
    reason: "Shipped via USPS",
    created_at: (shippedDate ?? new Date(procDate.getTime() + 3600_000 * 72)).toISOString(),
  });

  if (status === "shipped") return history;

  // Delivered
  const deliverDate = new Date(
    (shippedDate ?? new Date(procDate.getTime() + 3600_000 * 72)).getTime() +
      3600_000 * (48 + rng() * 72)
  );
  history.push({
    order_id: orderId,
    old_status: "shipped",
    new_status: "delivered",
    changed_by: "system",
    reason: "EasyPost delivery confirmed",
    created_at: deliverDate.toISOString(),
  });

  return history;
}

// ---------------------------------------------------------------------------
// Match an athlete's level to the correct shirt back
// ---------------------------------------------------------------------------
function findBackForLevel(
  level: string,
  backs: ShirtBack[]
): ShirtBack | undefined {
  // Direct match: athlete level is in the back's levels array
  for (const back of backs) {
    if (back.levels.some((l) => l.toLowerCase() === level.toLowerCase())) {
      return back;
    }
  }

  // Fuzzy match: try common aliases (e.g. "Xcel Bronze" -> "XB")
  const aliases: Record<string, string[]> = {
    "xcel bronze": ["xb", "xcel bronze"],
    "xcel silver": ["xs", "xcel silver"],
    "xcel gold": ["xg", "xcel gold"],
    "xcel platinum": ["xp", "xcel platinum"],
    "xcel diamond": ["xd", "xcel diamond"],
    "xcel sapphire": ["xsa", "xcel sapphire"],
  };

  const lowerLevel = level.toLowerCase();
  const levelAliases = aliases[lowerLevel] ?? [lowerLevel];

  for (const back of backs) {
    for (const alias of levelAliases) {
      if (back.levels.some((l) => l.toLowerCase() === alias)) {
        return back;
      }
    }
  }

  // Broader match: if level contains "xcel" match any back whose label
  // contains "xcel" (case-insensitive)
  if (lowerLevel.includes("xcel")) {
    const xcelBack = backs.find((b) =>
      b.level_group_label.toLowerCase().includes("xcel")
    );
    if (xcelBack) return xcelBack;
  }

  // Numeric level match: extract number, match back that covers that range
  const levelNum = parseInt(level.replace(/\D/g, ""), 10);
  if (!isNaN(levelNum)) {
    for (const back of backs) {
      for (const l of back.levels) {
        const backNum = parseInt(l.replace(/\D/g, ""), 10);
        if (!isNaN(backNum) && backNum === levelNum) return back;
      }
    }
  }

  // Fallback: first back (better than nothing)
  return backs[0];
}

// ---------------------------------------------------------------------------
// Deduplicate winners to unique athletes (name + gym + level per meet)
// ---------------------------------------------------------------------------
function deduplicateWinners(
  winners: Winner[]
): Array<{ name: string; gym: string; level: string; meet_name: string; state: string }> {
  const seen = new Set<string>();
  const unique: typeof winners = [];

  for (const w of winners) {
    const key = `${w.name}|${w.gym}|${w.level}|${w.meet_name}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(w);
    }
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("=== Seeding realistic test orders ===\n");

  const TARGET_STATES = ["MN", "KY", "LA", "NE"];

  // -----------------------------------------------------------------------
  // Step 1: Fetch meets for target states
  // -----------------------------------------------------------------------
  console.log("Fetching meets...");
  const meets = await sbGet<Meet[]>(
    "meets",
    `state=in.(${TARGET_STATES.join(",")})&select=id,meet_name,state`
  );
  console.log(`  Found ${meets.length} meets`);

  if (meets.length === 0) {
    console.error("ERROR: No meets found for states:", TARGET_STATES.join(", "));
    console.error("  Have you published meets for these states?");
    process.exit(1);
  }

  const meetsByState: Record<string, Meet[]> = {};
  for (const m of meets) {
    if (!meetsByState[m.state]) meetsByState[m.state] = [];
    meetsByState[m.state].push(m);
  }

  // -----------------------------------------------------------------------
  // Step 2: Fetch shirt_backs for those meets
  // -----------------------------------------------------------------------
  console.log("Fetching shirt backs...");
  const meetIds = meets.map((m) => m.id);
  const backs = await sbGet<ShirtBack[]>(
    "shirt_backs",
    `meet_id=in.(${meetIds.join(",")})&superseded_at=is.null&select=id,meet_id,meet_name,levels,level_group_label`
  );
  console.log(`  Found ${backs.length} active shirt backs`);

  if (backs.length === 0) {
    console.error("ERROR: No active shirt_backs found for these meets.");
    console.error("  Have you published shirt backs?");
    process.exit(1);
  }

  const backsByMeetId: Record<number, ShirtBack[]> = {};
  for (const b of backs) {
    if (!backsByMeetId[b.meet_id]) backsByMeetId[b.meet_id] = [];
    backsByMeetId[b.meet_id].push(b);
  }

  // -----------------------------------------------------------------------
  // Step 3: Fetch unique winners per state
  // -----------------------------------------------------------------------
  // Note: winners.state uses full names ("Minnesota") while meets.state
  // uses abbreviations ("MN"). We fetch per-meet and map via meet_name.
  console.log("Fetching winners...");

  // Build meet_name -> state abbreviation lookup
  const meetNameToState: Record<string, string> = {};
  for (const m of meets) {
    meetNameToState[m.meet_name] = m.state;
  }

  // Fetch winners per meet (PostgREST 'in' filter for meet_names with
  // special characters like "&" needs each value URL-encoded individually)
  let allWinners: Winner[] = [];
  for (const m of meets) {
    const encoded = encodeURIComponent(m.meet_name);
    const rows = await sbGet<Array<{ name: string; gym: string; level: string; meet_name: string; state: string }>>(
      "winners",
      `meet_name=eq.${encoded}&select=name,gym,level,meet_name,state`
    );
    allWinners.push(...rows);
  }
  console.log(`  Fetched ${allWinners.length} winner rows`);

  const uniqueWinners = deduplicateWinners(allWinners);
  console.log(`  ${uniqueWinners.length} unique athletes across all meets`);

  // Group by state abbreviation (via meet_name lookup, not winner.state)
  const winnersByState: Record<string, typeof uniqueWinners> = {};
  for (const w of uniqueWinners) {
    const stateAbbr = meetNameToState[w.meet_name];
    if (!stateAbbr) continue;
    if (!winnersByState[stateAbbr]) winnersByState[stateAbbr] = [];
    winnersByState[stateAbbr].push({ ...w, state: stateAbbr });
  }

  for (const state of TARGET_STATES) {
    const count = winnersByState[state]?.length ?? 0;
    console.log(`  ${state}: ${count} unique winners`);
  }

  // -----------------------------------------------------------------------
  // Step 4: Build orders
  // -----------------------------------------------------------------------
  console.log("\n--- Building orders ---\n");

  let orderSeq = 0;
  let totalOrders = 0;
  let totalItems = 0;
  let totalJewels = 0;

  const allOrderPayloads: Record<string, unknown>[] = [];
  const allItemPayloads: Array<{
    orderIndex: number; // index into allOrderPayloads for linking after insert
    payload: Record<string, unknown>;
  }> = [];
  const allHistoryPayloads: Array<{
    orderIndex: number;
    entries: Array<Record<string, unknown>>;
  }> = [];
  const allEmailCaptures: Record<string, unknown>[] = [];

  // Track which order indices belong to which status (for batch linking)
  const orderIndicesByStatus: Record<string, number[]> = {
    processing: [],
    shipped: [],
    delivered: [],
  };

  // Track which back_ids appear in which statuses (for batch back counts)
  const batchTracker: Record<string, { backId: number; meetName: string; count: number }[]> = {};

  for (const state of TARGET_STATES) {
    const stateWinners = winnersByState[state];
    if (!stateWinners || stateWinners.length === 0) {
      console.log(`  ${state}: No winners — skipping`);
      continue;
    }

    // Shuffle winners to randomize selection
    const shuffled = shuffle(stateWinners);

    // 30% conversion rate
    const numOrders = Math.round(shuffled.length * 0.3);
    const ordering = shuffled.slice(0, numOrders);
    const nonOrdering = shuffled.slice(numOrders);

    // Map meet_name -> meet for looking up meet_id
    const meetLookup: Record<string, Meet> = {};
    for (const m of meetsByState[state] ?? []) {
      meetLookup[m.meet_name] = m;
    }

    let stateOrders = 0;
    let stateItems = 0;

    for (const athlete of ordering) {
      orderSeq++;
      const padded = String(orderSeq).padStart(5, "0");
      const orderNum = `TEST-REAL-2026-${padded}`;

      // Determine shirt count: 60% 1 shirt, 30% 2 shirts, 10% 3 shirts
      const shirtRoll = rng();
      const shirtCount = shirtRoll < 0.60 ? 1 : shirtRoll < 0.90 ? 2 : 3;

      // Timeline: spread orders over 3 weeks (21 days)
      const daysOld = Math.floor(rng() * 21);
      const createdDate = jitter(daysAgo(daysOld), 8);
      const status = pickOrderStatus(daysOld);

      // Parent name — use athlete's last name
      const athleteLastName = athlete.name.split(" ").slice(-1)[0];
      const parentFirst = pick(PARENT_FIRST_NAMES);
      const customerName = `${parentFirst} ${athleteLastName}`;
      const email = `${athleteLastName.toLowerCase().replace(/[^a-z]/g, "")}-${Math.floor(rng() * 9000 + 1000)}@test.example.com`;
      const phone = `555-${String(1000 + Math.floor(rng() * 9000)).padStart(4, "0")}`;

      // Address
      const cityInfo = pick(STATE_CITIES[state]);
      const streetNum = 100 + Math.floor(rng() * 9900);
      const streetName = pick(STREET_NAMES);
      const address = `${streetNum} ${streetName}`;

      // Find meet and backs for this athlete
      const meet = meetLookup[athlete.meet_name];
      const meetBacks = meet ? backsByMeetId[meet.id] ?? [] : [];

      // Build items
      const items: Record<string, unknown>[] = [];
      let orderJewels = 0;

      for (let i = 0; i < shirtCount; i++) {
        const hasJewel = rng() < 0.40;
        if (hasJewel) orderJewels++;

        const back = findBackForLevel(athlete.level, meetBacks);
        const size = pickSize(athlete.level);
        const color = rng() < 0.65 ? "white" : "grey";
        const prodStatus = itemProductionStatus(status);

        // ~5% name corrections on non-cancelled/refunded
        let correctedName: string | null = null;
        if (
          status !== "cancelled" &&
          status !== "refunded" &&
          rng() < 0.05
        ) {
          const parts = athlete.name.split(" ");
          if (parts.length >= 2 && parts[0].length > 2) {
            correctedName = parts[0].slice(0, -1) + " " + parts.slice(1).join(" ");
          }
        }

        items.push({
          // order_id will be set after insert
          athlete_name: athlete.name,
          corrected_name: correctedName,
          name_correction_reviewed: correctedName ? rng() < 0.5 : false,
          meet_id: meet?.id ?? null,
          meet_name: athlete.meet_name,
          back_id: back?.id ?? null,
          shirt_size: size,
          shirt_color: color,
          has_jewel: hasJewel,
          unit_price: SHIRT_PRICE,
          jewel_price: hasJewel ? JEWEL_PRICE : 0,
          production_status: prodStatus,
          printer_batch_id: null,
        });
      }

      // Calculate totals
      const subtotal = shirtCount * SHIRT_PRICE + orderJewels * JEWEL_PRICE;
      const shippingCost = calcShipping(shirtCount);
      const total = subtotal + shippingCost;

      // Timestamps
      const isPaidStatus = !["pending"].includes(status);
      const paidDate = isPaidStatus
        ? new Date(createdDate.getTime() + Math.floor(rng() * 600_000)) // 0-10 min after created
        : null;

      const isShippedStatus = status === "shipped" || status === "delivered";
      const shippedDate = isShippedStatus
        ? new Date((paidDate ?? createdDate).getTime() + 3600_000 * (48 + rng() * 120))
        : null;

      const trackingNumber = isShippedStatus
        ? `TEST94001118992231${padded}`
        : null;

      const orderPayload: Record<string, unknown> = {
        order_number: orderNum,
        customer_name: customerName,
        customer_email: email,
        customer_phone: phone,
        shipping_name: customerName,
        shipping_address_line1: address,
        shipping_address_line2: null,
        shipping_city: cityInfo.city,
        shipping_state: state,
        shipping_zip: cityInfo.zip,
        subtotal,
        shipping_cost: shippingCost,
        tax: 0,
        total,
        status,
        stripe_session_id: null,
        stripe_payment_intent_id: null,
        easypost_shipment_id: null,
        tracking_number: trackingNumber,
        carrier: isShippedStatus ? "USPS" : null,
        paid_at: paidDate?.toISOString() ?? null,
        shipped_at: shippedDate?.toISOString() ?? null,
        created_at: createdDate.toISOString(),
      };

      const orderIndex = allOrderPayloads.length;
      allOrderPayloads.push(orderPayload);

      // Track status for batch linking
      if (status === "processing") orderIndicesByStatus.processing.push(orderIndex);
      if (status === "shipped") orderIndicesByStatus.shipped.push(orderIndex);
      if (status === "delivered") orderIndicesByStatus.delivered.push(orderIndex);

      // Store items for later (need order_id after insert)
      for (const item of items) {
        allItemPayloads.push({ orderIndex, payload: item });
      }

      // Store history for later
      allHistoryPayloads.push({
        orderIndex,
        entries: [], // filled after order insert when we have IDs
      });

      // Save parameters for building history after IDs are known
      (allHistoryPayloads[allHistoryPayloads.length - 1] as any)._historyParams = {
        status,
        createdAt: createdDate,
        paidDate,
        shippedDate,
      };

      stateOrders++;
      stateItems += shirtCount;
      totalJewels += orderJewels;
    }

    totalOrders += stateOrders;
    totalItems += stateItems;
    console.log(
      `Creating ${state} orders... ${stateOrders} orders, ${stateItems} items`
    );

    // --- Email captures: 15% of non-ordering athletes ---
    const emailCaptureCount = Math.round(nonOrdering.length * 0.15);
    const emailCaptureCandidates = shuffle(nonOrdering).slice(0, emailCaptureCount);

    for (const athlete of emailCaptureCandidates) {
      const lastName = athlete.name.split(" ").slice(-1)[0];
      allEmailCaptures.push({
        email: `${lastName.toLowerCase().replace(/[^a-z]/g, "")}-notify-${Math.floor(rng() * 9000 + 1000)}@test.example.com`,
        phone: null,
        athlete_name: athlete.name,
        state: state,
        association: null,
        year: "2026",
        gym: athlete.gym || null,
        level: athlete.level,
        meet_identifier: athlete.meet_name,
        notified: false,
        notified_at: null,
        source: "website",
        created_at: jitter(daysAgo(Math.floor(rng() * 28)), 12).toISOString(),
      });
    }

    console.log(
      `  + ${emailCaptureCount} email captures from non-ordering athletes`
    );
  }

  // -----------------------------------------------------------------------
  // Step 5: Insert orders in batches
  // -----------------------------------------------------------------------
  console.log(`\nInserting ${allOrderPayloads.length} orders...`);
  const insertedOrders = await sbBatchInsert<{ id: number }>(
    "orders",
    allOrderPayloads,
    500
  );
  console.log(`  Inserted ${insertedOrders.length} orders`);

  // Build order ID map: orderIndex -> database id
  const orderIdMap: number[] = insertedOrders.map((o) => o.id);

  // -----------------------------------------------------------------------
  // Step 6: Insert order items
  // -----------------------------------------------------------------------
  console.log(`Inserting ${allItemPayloads.length} order items...`);
  const itemRows: Record<string, unknown>[] = allItemPayloads.map((ip) => ({
    ...ip.payload,
    order_id: orderIdMap[ip.orderIndex],
  }));
  await sbBatchInsert("order_items", itemRows, 500);
  const jewelPct = totalItems > 0 ? Math.round((totalJewels / totalItems) * 100) : 0;
  console.log(
    `  Inserted ${itemRows.length} items (${totalJewels}/${totalItems} with jewel = ${jewelPct}%)`
  );

  // -----------------------------------------------------------------------
  // Step 7: Insert status history
  // -----------------------------------------------------------------------
  console.log("Building status history...");
  const allHistoryRows: Record<string, unknown>[] = [];

  for (const hp of allHistoryPayloads) {
    const orderId = orderIdMap[hp.orderIndex];
    const params = (hp as any)._historyParams;
    const entries = buildStatusHistory(
      orderId,
      params.status,
      params.createdAt,
      params.paidDate,
      params.shippedDate
    );
    allHistoryRows.push(...entries);
  }

  console.log(`Inserting ${allHistoryRows.length} status history entries...`);
  await sbBatchInsert("order_status_history", allHistoryRows, 500);
  console.log(`  Inserted ${allHistoryRows.length} history entries`);

  // -----------------------------------------------------------------------
  // Step 8: Create printer batches per state
  // -----------------------------------------------------------------------
  console.log("\nCreating printer batches...");

  type BatchRow = { id: number };

  // Collect back_ids from processing/shipped/delivered items for batch linking
  // We create 1-2 batches per state for the earlier (processing+) orders
  const batchConfigs: Array<{
    state: string;
    batchName: string;
    status: "queued" | "at_printer" | "returned";
    sentDaysAgo: number | null;
    returnedDaysAgo: number | null;
    orderIndices: number[];
  }> = [];

  for (const state of TARGET_STATES) {
    // Get order indices for this state that are processing or beyond
    const stateProcessingIndices = orderIndicesByStatus.processing.filter(
      (idx) => allOrderPayloads[idx].shipping_state === state
    );
    const stateShippedIndices = orderIndicesByStatus.shipped.filter(
      (idx) => allOrderPayloads[idx].shipping_state === state
    );
    const stateDeliveredIndices = orderIndicesByStatus.delivered.filter(
      (idx) => allOrderPayloads[idx].shipping_state === state
    );

    const earlyIndices = [...stateShippedIndices, ...stateDeliveredIndices];
    const lateIndices = stateProcessingIndices;

    if (earlyIndices.length > 0) {
      batchConfigs.push({
        state,
        batchName: `TEST-REAL-Batch-${state}-Early-2026`,
        status: "returned",
        sentDaysAgo: 14,
        returnedDaysAgo: 7,
        orderIndices: earlyIndices,
      });
    }

    if (lateIndices.length > 0) {
      batchConfigs.push({
        state,
        batchName: `TEST-REAL-Batch-${state}-Late-2026`,
        status: rng() < 0.5 ? "at_printer" : "queued",
        sentDaysAgo: rng() < 0.5 ? 3 : null,
        returnedDaysAgo: null,
        orderIndices: lateIndices,
      });
    }
  }

  const batchRows: Record<string, unknown>[] = [];
  for (const bc of batchConfigs) {
    batchRows.push({
      batch_name: bc.batchName,
      screen_printer: rng() < 0.5 ? "printer_1" : "printer_2",
      status: bc.status,
      sent_at: bc.sentDaysAgo != null ? daysAgo(bc.sentDaysAgo).toISOString() : null,
      returned_at:
        bc.returnedDaysAgo != null
          ? daysAgo(bc.returnedDaysAgo).toISOString()
          : null,
      notes: `Seed: ${bc.state} ${bc.status} batch`,
      created_by: "seed-realistic",
    });
  }

  const insertedBatches = await sbBatchInsert<BatchRow>("printer_batches", batchRows, 500);
  console.log(`  Created ${insertedBatches.length} printer batches`);

  // Link batch backs: for each batch, figure out which back_ids are involved
  const allBatchBackRows: Record<string, unknown>[] = [];

  for (let bi = 0; bi < batchConfigs.length; bi++) {
    const bc = batchConfigs[bi];
    const batchId = insertedBatches[bi].id;

    // Count shirts per back_id for the orders in this batch
    const backCounts: Record<number, number> = {};
    for (const orderIndex of bc.orderIndices) {
      const orderId = orderIdMap[orderIndex];
      for (const ip of allItemPayloads) {
        if (ip.orderIndex === orderIndex && ip.payload.back_id != null) {
          const backId = ip.payload.back_id as number;
          backCounts[backId] = (backCounts[backId] ?? 0) + 1;
        }
      }
    }

    for (const [backIdStr, count] of Object.entries(backCounts)) {
      allBatchBackRows.push({
        batch_id: batchId,
        back_id: parseInt(backIdStr, 10),
        shirt_count: count,
      });
    }
  }

  if (allBatchBackRows.length > 0) {
    await sbBatchInsert("printer_batch_backs", allBatchBackRows, 500);
    console.log(`  Linked ${allBatchBackRows.length} batch-back associations`);
  }

  // Link order_items to batches
  for (let bi = 0; bi < batchConfigs.length; bi++) {
    const bc = batchConfigs[bi];
    const batchId = insertedBatches[bi].id;
    const orderIds = bc.orderIndices.map((idx) => orderIdMap[idx]);

    if (orderIds.length > 0) {
      const prodStatuses =
        bc.status === "returned"
          ? "packed"
          : bc.status === "at_printer"
            ? "at_printer"
            : "queued";

      await sbPatch(
        "order_items",
        `order_id=in.(${orderIds.join(",")})&production_status=eq.${prodStatuses}`,
        { printer_batch_id: batchId }
      );
    }
  }
  console.log("  Linked items to printer batches");

  // -----------------------------------------------------------------------
  // Step 9: Insert email captures
  // -----------------------------------------------------------------------
  if (allEmailCaptures.length > 0) {
    console.log(`\nInserting ${allEmailCaptures.length} email captures...`);
    await sbBatchInsert("email_captures", allEmailCaptures, 500);
    console.log(`  Inserted ${allEmailCaptures.length} email captures`);
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log("\n=== Summary ===");

  const statusCounts: Record<string, number> = {};
  for (const op of allOrderPayloads) {
    const s = op.status as string;
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }
  for (const [status, count] of Object.entries(statusCounts).sort()) {
    console.log(`  ${status.padEnd(12)}: ${count} orders`);
  }

  const stateCounts: Record<string, { orders: number; items: number }> = {};
  for (let i = 0; i < allOrderPayloads.length; i++) {
    const state = allOrderPayloads[i].shipping_state as string;
    if (!stateCounts[state]) stateCounts[state] = { orders: 0, items: 0 };
    stateCounts[state].orders++;
    stateCounts[state].items += allItemPayloads.filter(
      (ip) => ip.orderIndex === i
    ).length;
  }
  for (const [state, counts] of Object.entries(stateCounts).sort()) {
    console.log(
      `  ${state}: ${counts.orders} orders, ${counts.items} items`
    );
  }

  console.log(`  Total orders : ${totalOrders}`);
  console.log(`  Total items  : ${totalItems}`);
  const finalJewelPct = totalItems > 0 ? Math.round((totalJewels / totalItems) * 100) : 0;
  console.log(
    `  Jewel rate   : ${finalJewelPct}%`
  );
  console.log(`  Email captures: ${allEmailCaptures.length}`);
  console.log(`  Batches      : ${insertedBatches.length}`);
  console.log(`  Batch backs  : ${allBatchBackRows.length}`);
  console.log(`  History rows : ${allHistoryRows.length}`);
  console.log(
    `\nDone. Cleanup with: bash supabase/cleanup-test-data.sh`
  );
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
