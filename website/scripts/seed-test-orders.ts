/**
 * Seed realistic test orders directly into Supabase via the service role API.
 *
 * Usage:
 *   cd website && npx tsx scripts/seed-test-orders.ts
 *
 * Creates 50 orders spanning all 5 states with a mix of statuses, shirt counts,
 * jewel rates, name corrections, and printer batches.
 *
 * All test records use:
 *   - Order numbers: TEST-SEED-2026-NNN
 *   - Customer emails: seed-NNN@test.example.com
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
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
    headers: {
      apikey: SB_KEY!,
      Authorization: `Bearer ${SB_KEY}`,
    },
  });
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

async function sbPatch(table: string, filter: string, data: unknown): Promise<void> {
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
// Pricing constants
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
// Static data: customers, addresses
// ---------------------------------------------------------------------------
const CUSTOMER_FIRST = [
  "Emma", "Olivia", "Ava", "Sophia", "Mia", "Isabella", "Charlotte", "Amelia",
  "Harper", "Evelyn", "Abigail", "Emily", "Elizabeth", "Sofia", "Avery",
  "Ella", "Scarlett", "Grace", "Chloe", "Victoria", "Riley", "Aria", "Lily",
  "Aubrey", "Zoey", "Penelope", "Lillian", "Addison", "Layla", "Natalie",
  "Camila", "Hannah", "Brooklyn", "Zoe", "Nora", "Leah", "Savannah", "Audrey",
  "Claire", "Eleanor", "Skylar", "Ellie", "Samantha", "Stella", "Paisley",
  "Violet", "Mila", "Allison", "Alexa", "Anna",
];

const CUSTOMER_LAST = [
  "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Wilson", "Anderson",
  "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez",
  "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis",
  "Robinson", "Walker", "Young", "Allen", "King", "Wright", "Scott",
  "Torres", "Nguyen", "Hill", "Flores", "Green", "Adams", "Nelson",
  "Baker", "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts",
  "Turner", "Phillips",
];

// City/zip pairs by state
const STATE_CITIES: Record<string, Array<{ city: string; zip: string }>> = {
  MN: [
    { city: "Minneapolis", zip: "55401" },
    { city: "Saint Paul", zip: "55101" },
    { city: "Duluth", zip: "55802" },
    { city: "Rochester", zip: "55901" },
    { city: "Bloomington", zip: "55420" },
    { city: "Plymouth", zip: "55441" },
    { city: "Woodbury", zip: "55125" },
    { city: "Maple Grove", zip: "55369" },
    { city: "Eden Prairie", zip: "55344" },
    { city: "Edina", zip: "55424" },
  ],
  KY: [
    { city: "Louisville", zip: "40202" },
    { city: "Lexington", zip: "40507" },
    { city: "Bowling Green", zip: "42101" },
    { city: "Covington", zip: "41011" },
    { city: "Frankfort", zip: "40601" },
    { city: "Florence", zip: "41042" },
    { city: "Georgetown", zip: "40324" },
    { city: "Elizabethtown", zip: "42701" },
    { city: "Owensboro", zip: "42301" },
    { city: "Richmond", zip: "40475" },
  ],
  LA: [
    { city: "New Orleans", zip: "70112" },
    { city: "Baton Rouge", zip: "70801" },
    { city: "Shreveport", zip: "71101" },
    { city: "Lafayette", zip: "70501" },
    { city: "Mandeville", zip: "70471" },
    { city: "Metairie", zip: "70001" },
    { city: "Kenner", zip: "70062" },
    { city: "Bossier City", zip: "71111" },
    { city: "Lake Charles", zip: "70601" },
    { city: "Monroe", zip: "71201" },
  ],
  NE: [
    { city: "Omaha", zip: "68102" },
    { city: "Lincoln", zip: "68508" },
    { city: "Grand Island", zip: "68801" },
    { city: "Kearney", zip: "68847" },
    { city: "Norfolk", zip: "68701" },
    { city: "Bellevue", zip: "68005" },
    { city: "Hastings", zip: "68901" },
    { city: "Fremont", zip: "68025" },
    { city: "Columbus", zip: "68601" },
    { city: "Papillion", zip: "68046" },
  ],
  OR: [
    { city: "Portland", zip: "97201" },
    { city: "Eugene", zip: "97401" },
    { city: "Salem", zip: "97301" },
    { city: "Bend", zip: "97701" },
    { city: "Medford", zip: "97501" },
    { city: "Hillsboro", zip: "97123" },
    { city: "Gresham", zip: "97030" },
    { city: "Beaverton", zip: "97005" },
    { city: "Corvallis", zip: "97330" },
    { city: "Albany", zip: "97321" },
  ],
};

const STREET_NAMES = [
  "Oak Ave", "Elm St", "Pine Rd", "Maple Dr", "Cedar Ln", "Birch Way",
  "Spruce Ct", "Walnut St", "Ash Blvd", "Willow Rd", "Poplar Ave",
  "Hickory Ln", "Sycamore St", "Magnolia Dr", "Dogwood Pl", "Redwood Ave",
  "Juniper Way", "Sequoia Ct", "Aspen Rd", "Chestnut Blvd", "Cottonwood St",
  "Linden Ln", "Cypress Ave", "Hawthorn Dr", "Basswood Pl",
];

// Shirt sizes with weights (youth sizes more common for lower levels)
const SIZES_YOUTH = ["YS", "YM", "YL"] as const;
const SIZES_ADULT = ["S", "M", "L", "XL"] as const;
const SIZES_ALL = [...SIZES_YOUTH, ...SIZES_ADULT] as const;
type ShirtSize = (typeof SIZES_ALL)[number];

// ---------------------------------------------------------------------------
// Athlete data by state (sourced from seed-test-data.sh / real winners)
// ---------------------------------------------------------------------------
const ATHLETES_BY_STATE: Record<
  string,
  Array<{ name: string; level: string; preferYouthSize: boolean }>
> = {
  MN: [
    { name: "Mia Jennen", level: "Xcel Silver", preferYouthSize: true },
    { name: "Annie Jennen", level: "Xcel Gold", preferYouthSize: true },
    { name: "Katy Jennen", level: "Xcel Platinum", preferYouthSize: false },
    { name: "Andi Novak", level: "Level 6", preferYouthSize: true },
    { name: "Kayla Rogers", level: "Level 7", preferYouthSize: false },
    { name: "Nevaeh Halvorson", level: "Level 8", preferYouthSize: false },
    { name: "Mallory Dionne", level: "Xcel Bronze", preferYouthSize: true },
    { name: "Brooklyn Chumley", level: "Level 9", preferYouthSize: false },
    { name: "Izzy Klaphake", level: "Xcel Silver", preferYouthSize: true },
    { name: "Marlie Ophus", level: "Level 6", preferYouthSize: true },
    { name: "Lettie Schendzielos", level: "Xcel Gold", preferYouthSize: false },
    { name: "Libby Maciej", level: "Level 7", preferYouthSize: false },
    { name: "Avery Lindquist", level: "Xcel Bronze", preferYouthSize: true },
    { name: "Quinn Petersen", level: "Level 8", preferYouthSize: false },
    { name: "Paige Holmstrom", level: "Level 6", preferYouthSize: true },
  ],
  KY: [
    { name: "Eve Phelan", level: "Xcel Gold", preferYouthSize: true },
    { name: "Anna-Claire Gann", level: "Xcel Silver", preferYouthSize: true },
    { name: "Hayley Mouser", level: "Level 7", preferYouthSize: false },
    { name: "Jayda Greenlee", level: "Xcel Gold", preferYouthSize: true },
    { name: "Penelope Sekulski", level: "Level 8", preferYouthSize: false },
    { name: "Embry Frazier", level: "Xcel Bronze", preferYouthSize: true },
    { name: "Kinslee Barnett", level: "Level 6", preferYouthSize: true },
    { name: "Rylan Combs", level: "Level 9", preferYouthSize: false },
    { name: "Tatum Marcum", level: "Xcel Platinum", preferYouthSize: false },
    { name: "Mackenzie Prater", level: "Level 7", preferYouthSize: true },
    { name: "Gracyn Compton", level: "Xcel Silver", preferYouthSize: true },
    { name: "Avery Stamper", level: "Level 8", preferYouthSize: false },
  ],
  LA: [
    { name: "Abby Ponson", level: "Level 6", preferYouthSize: true },
    { name: "Adalyn Walker", level: "Xcel Gold", preferYouthSize: true },
    { name: "Addie Lejeune", level: "Level 7", preferYouthSize: false },
    { name: "Addison Dickey", level: "Level 8", preferYouthSize: false },
    { name: "Addi Laigast", level: "Xcel Silver", preferYouthSize: false },
    { name: "Abigail Waguespack", level: "Level 6", preferYouthSize: true },
    { name: "Camille Tureaud", level: "Xcel Bronze", preferYouthSize: true },
    { name: "Ellie Chiasson", level: "Level 9", preferYouthSize: false },
    { name: "Madeleine Boudreaux", level: "Xcel Gold", preferYouthSize: true },
    { name: "Sophie Arceneaux", level: "Level 7", preferYouthSize: false },
    { name: "Claire Thibodaux", level: "Xcel Platinum", preferYouthSize: false },
    { name: "Lila Fontenot", level: "Level 6", preferYouthSize: true },
  ],
  NE: [
    { name: "Abigail Ramos", level: "Xcel Gold", preferYouthSize: false },
    { name: "Aaliyah Souza", level: "Level 6", preferYouthSize: false },
    { name: "Addi Watson", level: "Xcel Silver", preferYouthSize: true },
    { name: "Adaline Lambert", level: "Level 7", preferYouthSize: false },
    { name: "Abby Mckim", level: "Level 8", preferYouthSize: false },
    { name: "Addie Hix", level: "Level 9", preferYouthSize: false },
    { name: "A'Lauric Dennard", level: "Level 6", preferYouthSize: true },
    { name: "Brianna Stoltz", level: "Xcel Bronze", preferYouthSize: true },
    { name: "Kenna Friesen", level: "Level 7", preferYouthSize: false },
    { name: "Tessa Rasmussen", level: "Xcel Silver", preferYouthSize: true },
    { name: "Mackenzie Lund", level: "Level 8", preferYouthSize: false },
    { name: "Payton Heuermann", level: "Xcel Gold", preferYouthSize: false },
  ],
  OR: [
    { name: "Addie Peterson", level: "Level 6", preferYouthSize: true },
    { name: "Abby Gagnier", level: "Xcel Gold", preferYouthSize: true },
    { name: "Abby Khamvongsa", level: "Level 7", preferYouthSize: false },
    { name: "Addie Gerasimenko", level: "Xcel Silver", preferYouthSize: true },
    { name: "Kara Helgerson", level: "Level 8", preferYouthSize: false },
    { name: "Maya Yamamoto", level: "Xcel Bronze", preferYouthSize: true },
    { name: "Sophia Nakagawa", level: "Level 9", preferYouthSize: false },
    { name: "Ella Gustafson", level: "Level 6", preferYouthSize: true },
    { name: "Lily Sorensen", level: "Xcel Platinum", preferYouthSize: false },
    { name: "Hailey Reinhardt", level: "Level 7", preferYouthSize: false },
    { name: "Brooke Halverson", level: "Xcel Silver", preferYouthSize: true },
    { name: "Jenna Torgerson", level: "Level 8", preferYouthSize: false },
  ],
};

// Back IDs by state (from seed-test-data.sh comments + data patterns)
// Meet IDs: MN=17, KY=18, LA=19, NE=20, OR=21
// Back IDs: MN Xcel=1, MN 6-10=2, KY Xcel=3, KY 2-10=4,
//            LA Xcel=5, LA 1-10=6, NE Xcel=7, NE 2-5=8, NE 6-10=9,
//            OR Xcel=10, OR 2-10=13
const STATE_META: Record<
  string,
  { meetId: number; meetName: string; xcelBackId: number; levelBackId: number }
> = {
  MN: {
    meetId: 17,
    meetName: "USAG W Gymnastics - 2026 MN - March 20",
    xcelBackId: 1,
    levelBackId: 2,
  },
  KY: {
    meetId: 18,
    meetName: "USAG W Gymnastics - 2026 KY - March 14-16",
    xcelBackId: 3,
    levelBackId: 4,
  },
  LA: {
    meetId: 19,
    meetName: "USAG W Gymnastics - 2026 LA - March 20-22",
    xcelBackId: 5,
    levelBackId: 6,
  },
  NE: {
    meetId: 20,
    meetName: "USAG W Gymnastics - 2026 NE - March 14-15",
    xcelBackId: 7,
    levelBackId: 9,
  },
  OR: {
    meetId: 21,
    meetName: "USAG W Gymnastics - 2026 OR - March 13-21",
    xcelBackId: 10,
    levelBackId: 13,
  },
};

// ---------------------------------------------------------------------------
// Deterministic-ish RNG (seeded, reproducible across runs with same seed)
// ---------------------------------------------------------------------------
let rngState = 42;
function rng(): number {
  rngState = (rngState * 1664525 + 1013904223) & 0xffffffff;
  return (rngState >>> 0) / 0xffffffff;
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
function pickIdx<T>(arr: readonly T[]): [T, number] {
  const i = Math.floor(rng() * arr.length);
  return [arr[i], i];
}

// ---------------------------------------------------------------------------
// Order plan: 50 orders with predetermined shapes
// ---------------------------------------------------------------------------
// Status distribution: 15 paid, 10 processing, 10 shipped, 10 delivered, 3 cancelled, 2 refunded
// Shirt distribution:  30 single, 15 two-shirt, 5 three-shirt
// States cycle to spread evenly: MN MN MN MN ... KY KY ... etc.

type OrderStatus = "paid" | "processing" | "shipped" | "delivered" | "cancelled" | "refunded";
type ProductionStatus = "pending" | "queued" | "at_printer" | "printed" | "packed" | "cancelled";

interface OrderPlan {
  seq: number; // 1-50
  state: keyof typeof STATE_META;
  status: OrderStatus;
  shirtCount: 1 | 2 | 3;
}

function buildOrderPlans(): OrderPlan[] {
  const states: Array<keyof typeof STATE_META> = ["MN", "KY", "LA", "NE", "OR"];
  const statusBlocks: Array<[OrderStatus, number]> = [
    ["paid", 15],
    ["processing", 10],
    ["shipped", 10],
    ["delivered", 10],
    ["cancelled", 3],
    ["refunded", 2],
  ];
  // shirt count pattern: 30×1, 15×2, 5×3 (interleaved)
  const shirtCounts: Array<1 | 2 | 3> = [
    ...Array<1>(30).fill(1),
    ...Array<2>(15).fill(2),
    ...Array<3>(5).fill(3),
  ];
  // Shuffle shirtCounts deterministically
  for (let i = shirtCounts.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shirtCounts[i], shirtCounts[j]] = [shirtCounts[j], shirtCounts[i]];
  }

  const plans: OrderPlan[] = [];
  let seq = 1;
  let stateIdx = 0;
  let shirtIdx = 0;
  for (const [status, count] of statusBlocks) {
    for (let i = 0; i < count; i++) {
      plans.push({
        seq,
        state: states[stateIdx % states.length],
        status,
        shirtCount: shirtCounts[shirtIdx % shirtCounts.length],
      });
      seq++;
      stateIdx++;
      shirtIdx++;
    }
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------
function daysAgo(n: number, hourOffset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(d.getHours() - hourOffset);
  return d.toISOString();
}

function paidAt(status: OrderStatus, seq: number): string {
  // Older statuses were paid longer ago
  const baseAge: Record<OrderStatus, number> = {
    paid: 0,
    processing: 3,
    shipped: 7,
    delivered: 14,
    cancelled: 5,
    refunded: 10,
  };
  return daysAgo(baseAge[status], seq % 12);
}

function shippedAt(paidIso: string): string {
  const d = new Date(paidIso);
  d.setDate(d.getDate() + 3);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Build a single shirt item
// ---------------------------------------------------------------------------
function buildItem(
  state: keyof typeof STATE_META,
  athleteIdx: number,
  hasJewel: boolean,
  correctedName?: string
): {
  athleteName: string;
  correctedName?: string;
  meetId: number;
  meetName: string;
  backId: number;
  shirtSize: ShirtSize;
  shirtColor: string;
  hasJewel: boolean;
  unitPrice: number;
  jewelPrice: number;
  productionStatus: ProductionStatus;
} {
  const meta = STATE_META[state];
  const athletes = ATHLETES_BY_STATE[state];
  const athlete = athletes[athleteIdx % athletes.length];

  const isXcel = athlete.level.toLowerCase().includes("xcel");
  const backId = isXcel ? meta.xcelBackId : meta.levelBackId;

  let size: ShirtSize;
  if (athlete.preferYouthSize) {
    size = pick(SIZES_YOUTH);
  } else {
    // Adults: slight bias toward M/L
    const r = rng();
    if (r < 0.2) size = "S";
    else if (r < 0.5) size = "M";
    else if (r < 0.75) size = "L";
    else if (r < 0.9) size = "XL";
    else size = pick(SIZES_YOUTH);
  }

  const color = rng() < 0.65 ? "white" : "grey";

  return {
    athleteName: athlete.name,
    correctedName,
    meetId: meta.meetId,
    meetName: meta.meetName,
    backId,
    shirtSize: size,
    shirtColor: color,
    hasJewel,
    unitPrice: SHIRT_PRICE,
    jewelPrice: hasJewel ? JEWEL_PRICE : 0,
    productionStatus: "pending",
  };
}

// ---------------------------------------------------------------------------
// Derive production_status for items based on order status
// ---------------------------------------------------------------------------
function itemProductionStatus(orderStatus: OrderStatus): ProductionStatus {
  switch (orderStatus) {
    case "paid":
      return "pending";
    case "processing":
      // Mix of queued and at_printer
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
// Build status history entries for an order
// ---------------------------------------------------------------------------
function buildStatusHistory(
  orderId: number,
  status: OrderStatus
): Array<{
  order_id: number;
  old_status: string | null;
  new_status: string;
  changed_by: string;
  reason: string;
}> {
  const history: ReturnType<typeof buildStatusHistory> = [];

  history.push({
    order_id: orderId,
    old_status: null,
    new_status: "paid",
    changed_by: "system",
    reason: "Test: Stripe checkout completed",
  });

  if (status === "paid") return history;

  history.push({
    order_id: orderId,
    old_status: "paid",
    new_status: "processing",
    changed_by: "test-seed",
    reason: "Test: Items queued for printing",
  });

  if (status === "processing") return history;

  if (status === "cancelled") {
    history.push({
      order_id: orderId,
      old_status: "paid",
      new_status: "cancelled",
      changed_by: "admin",
      reason: "Test: Customer requested cancellation",
    });
    return history;
  }

  if (status === "refunded") {
    history.push({
      order_id: orderId,
      old_status: "paid",
      new_status: "processing",
      changed_by: "test-seed",
      reason: "Test: Items queued for printing",
    });
    history.push({
      order_id: orderId,
      old_status: "processing",
      new_status: "refunded",
      changed_by: "admin",
      reason: "Test: Refund issued",
    });
    return history;
  }

  history.push({
    order_id: orderId,
    old_status: "processing",
    new_status: "shipped",
    changed_by: "test-seed",
    reason: "Test: Shipped via USPS",
  });

  if (status === "shipped") return history;

  history.push({
    order_id: orderId,
    old_status: "shipped",
    new_status: "delivered",
    changed_by: "system",
    reason: "Test: EasyPost delivery confirmed",
  });

  return history;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("=== Seeding 50 test orders ===\n");

  const plans = buildOrderPlans();
  const states = Object.keys(STATE_META) as Array<keyof typeof STATE_META>;

  // Track IDs for batch linking later
  const orderIdsByStatus: Record<string, number[]> = {
    processing: [],
    shipped: [],
    delivered: [],
  };

  // Athlete index counters per state to cycle through without repeating too fast
  const athleteCounters: Record<string, number> = {
    MN: 0, KY: 0, LA: 0, NE: 0, OR: 0,
  };

  // Jewel counter: target ~40% jewel rate
  let jewelCount = 0;
  let totalItems = 0;

  const allStatusHistory: Array<{
    order_id: number;
    old_status: string | null;
    new_status: string;
    changed_by: string;
    reason: string;
  }> = [];

  const allItems: Array<{
    order_id: number;
    athlete_name: string;
    corrected_name?: string;
    meet_id: number;
    meet_name: string;
    back_id: number;
    shirt_size: string;
    shirt_color: string;
    has_jewel: boolean;
    unit_price: number;
    jewel_price: number;
    production_status: string;
  }> = [];

  const orderIds: number[] = [];

  // --- Insert orders ---
  console.log("Inserting orders...");
  for (const plan of plans) {
    const { seq, state, status, shirtCount } = plan;
    const padded = String(seq).padStart(3, "0");
    const orderNum = `TEST-SEED-2026-${padded}`;
    const email = `seed-${padded}@test.example.com`;

    const [firstName, fIdx] = pickIdx(CUSTOMER_FIRST);
    const lastName = CUSTOMER_LAST[fIdx % CUSTOMER_LAST.length];
    const customerName = `${firstName} ${lastName}`;
    const phone = `555-${String(2000 + seq).padStart(4, "0")}`;

    const cityInfo = pick(STATE_CITIES[state]);
    const streetNum = 100 + (seq * 17) % 900;
    const streetName = pick(STREET_NAMES);
    const address = `${streetNum} ${streetName}`;

    // Compute jewel assignments: aim for ~40% overall
    // Simple rule: give jewel to first item in an order, ~40% probability
    const itemJewels: boolean[] = [];
    for (let i = 0; i < shirtCount; i++) {
      const wantJewel = rng() < 0.4;
      itemJewels.push(wantJewel);
    }

    // Subtotal
    const jewelCountForOrder = itemJewels.filter(Boolean).length;
    const subtotal = shirtCount * SHIRT_PRICE + jewelCountForOrder * JEWEL_PRICE;
    const shippingCost = calcShipping(shirtCount);
    const total = subtotal + shippingCost;

    // Timestamps
    const paidIso = paidAt(status, seq);
    const shippedIso =
      status === "shipped" || status === "delivered"
        ? shippedAt(paidIso)
        : undefined;

    // Tracking numbers for shipped/delivered
    const trackingNumber =
      status === "shipped" || status === "delivered"
        ? `TEST94001118992231${String(seq).padStart(5, "0")}`
        : undefined;

    const orderPayload: Record<string, unknown> = {
      order_number: orderNum,
      customer_name: `Test: ${customerName}`,
      customer_email: email,
      customer_phone: phone,
      shipping_name: customerName,
      shipping_address_line1: address,
      shipping_city: cityInfo.city,
      shipping_state: state,
      shipping_zip: cityInfo.zip,
      subtotal,
      shipping_cost: shippingCost,
      tax: 0,
      total,
      status,
      paid_at: paidIso,
      created_at: paidIso,
    };

    if (shippedIso) {
      orderPayload.shipped_at = shippedIso;
      orderPayload.tracking_number = trackingNumber;
      orderPayload.carrier = "USPS";
    }

    const [inserted] = await sbInsert<Array<{ id: number }>>("orders", orderPayload);
    const orderId = inserted.id;
    orderIds.push(orderId);

    console.log(`  Order ${padded} (${status}, ${state}, ${shirtCount} shirt${shirtCount > 1 ? "s" : ""}): id=${orderId}`);

    // Track IDs for later batch linking
    if (status === "processing") orderIdsByStatus.processing.push(orderId);
    if (status === "shipped") orderIdsByStatus.shipped.push(orderId);
    if (status === "delivered") orderIdsByStatus.delivered.push(orderId);

    // Build items
    const prodStatus = itemProductionStatus(status);
    for (let i = 0; i < shirtCount; i++) {
      const athleteIdx = athleteCounters[state]++;
      const hasJewel = itemJewels[i];

      // ~10% chance of a name correction on non-cancelled orders
      let correctedName: string | undefined;
      if (status !== "cancelled" && status !== "refunded" && rng() < 0.1) {
        // Simple correction: add a nickname-style variant
        const athletes = ATHLETES_BY_STATE[state];
        const athlete = athletes[athleteIdx % athletes.length];
        const parts = athlete.name.split(" ");
        correctedName = parts[0].slice(0, -1) + " " + parts[1]; // drop last char of first name
      }

      const item = buildItem(state, athleteIdx, hasJewel, correctedName);

      allItems.push({
        order_id: orderId,
        athlete_name: item.athleteName,
        ...(item.correctedName ? { corrected_name: item.correctedName } : {}),
        meet_id: item.meetId,
        meet_name: item.meetName,
        back_id: item.backId,
        shirt_size: item.shirtSize,
        shirt_color: item.shirtColor,
        has_jewel: item.hasJewel,
        unit_price: item.unitPrice,
        jewel_price: item.jewelPrice,
        production_status: prodStatus,
      });

      if (hasJewel) jewelCount++;
      totalItems++;
    }

    // Build status history
    allStatusHistory.push(...buildStatusHistory(orderId, status));
  }

  // --- Insert all order items in one batch ---
  console.log(`\nInserting ${allItems.length} order items...`);
  // Insert in chunks of 50 to avoid request size limits
  const CHUNK = 50;
  for (let i = 0; i < allItems.length; i += CHUNK) {
    await sbInsert("order_items", allItems.slice(i, i + CHUNK));
  }
  console.log(`  Inserted ${allItems.length} items (${jewelCount}/${totalItems} with jewel = ${Math.round((jewelCount / totalItems) * 100)}%)`);

  // --- Insert all status history entries ---
  console.log(`\nInserting ${allStatusHistory.length} status history entries...`);
  for (let i = 0; i < allStatusHistory.length; i += CHUNK) {
    await sbInsert("order_status_history", allStatusHistory.slice(i, i + CHUNK));
  }
  console.log(`  Inserted ${allStatusHistory.length} history entries`);

  // --- Printer batches ---
  console.log("\nInserting printer batches...");

  type BatchRow = { id: number };

  const [b1] = await sbInsert<BatchRow[]>("printer_batches", {
    batch_name: "TEST-SEED-Batch-MN-2026",
    screen_printer: "printer_2",
    status: "queued",
    notes: "Test seed: MN Xcel + Level backs",
    created_by: "test-seed",
  });
  console.log(`  Batch 1 (queued, MN): id=${b1.id}`);

  const [b2] = await sbInsert<BatchRow[]>("printer_batches", {
    batch_name: "TEST-SEED-Batch-KY-LA-2026",
    screen_printer: "printer_2",
    status: "at_printer",
    sent_at: daysAgo(4),
    notes: "Test seed: KY + LA backs at printer",
    created_by: "test-seed",
  });
  console.log(`  Batch 2 (at_printer, KY+LA): id=${b2.id}`);

  const [b3] = await sbInsert<BatchRow[]>("printer_batches", {
    batch_name: "TEST-SEED-Batch-NE-OR-2026",
    screen_printer: "printer_1",
    status: "returned",
    sent_at: daysAgo(10),
    returned_at: daysAgo(5),
    notes: "Test seed: NE + OR completed backs",
    created_by: "test-seed",
  });
  console.log(`  Batch 3 (returned, NE+OR): id=${b3.id}`);

  // Link backs to batches
  await sbInsert("printer_batch_backs", [
    { batch_id: b1.id, back_id: STATE_META.MN.xcelBackId, shirt_count: 6 },
    { batch_id: b1.id, back_id: STATE_META.MN.levelBackId, shirt_count: 4 },
    { batch_id: b2.id, back_id: STATE_META.KY.xcelBackId, shirt_count: 4 },
    { batch_id: b2.id, back_id: STATE_META.LA.xcelBackId, shirt_count: 3 },
    { batch_id: b2.id, back_id: STATE_META.LA.levelBackId, shirt_count: 5 },
    { batch_id: b3.id, back_id: STATE_META.NE.levelBackId, shirt_count: 4 },
    { batch_id: b3.id, back_id: STATE_META.OR.xcelBackId, shirt_count: 3 },
    { batch_id: b3.id, back_id: STATE_META.OR.levelBackId, shirt_count: 4 },
  ]);
  console.log("  Linked 8 backs to batches");

  // Link processing order items to batch 1/2
  // Batch 1 gets the first half of processing orders (queued), batch 2 gets at_printer
  if (orderIdsByStatus.processing.length > 0) {
    const halfLen = Math.ceil(orderIdsByStatus.processing.length / 2);
    const queuedIds = orderIdsByStatus.processing.slice(0, halfLen);
    const atPrinterIds = orderIdsByStatus.processing.slice(halfLen);

    if (queuedIds.length > 0) {
      await sbPatch(
        "order_items",
        `order_id=in.(${queuedIds.join(",")})&production_status=eq.queued`,
        { printer_batch_id: b1.id }
      );
    }
    if (atPrinterIds.length > 0) {
      await sbPatch(
        "order_items",
        `order_id=in.(${atPrinterIds.join(",")})&production_status=eq.at_printer`,
        { printer_batch_id: b2.id }
      );
    }
    console.log("  Linked processing items to batches 1 & 2");
  }

  // --- Summary ---
  console.log("\n=== Summary ===");
  const statusCounts: Record<string, number> = {};
  for (const p of plans) {
    statusCounts[p.status] = (statusCounts[p.status] ?? 0) + 1;
  }
  for (const [status, count] of Object.entries(statusCounts)) {
    console.log(`  ${status.padEnd(12)}: ${count} orders`);
  }
  console.log(`  Total orders : ${plans.length}`);
  console.log(`  Total items  : ${allItems.length}`);
  console.log(`  Jewel rate   : ${Math.round((jewelCount / totalItems) * 100)}%`);
  console.log(`  States       : ${states.join(", ")}`);
  console.log("\nDone. Cleanup with: bash supabase/cleanup-test-data.sh");
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
