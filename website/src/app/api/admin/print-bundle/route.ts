import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/** Strip control characters from user input before rendering to PDF */
function sanitizeForPdf(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1F\x7F]/g, "").trim();
}
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { easypost, SHIRT_PARCEL, FROM_ADDRESS } from "@/lib/easypost";
import { formatPrice } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────

interface OrderItem {
  id: number;
  order_id: number;
  athlete_name: string;
  corrected_name: string | null;
  shirt_size: string;
  shirt_color: string;
  has_jewel: boolean;
  unit_price: number;
  jewel_price: number;
  production_status: string;
  back_id: number | null;
  printer_batch_id: number | null;
  shirt_backs: {
    id: number;
    meet_name: string;
    level_group_label: string;
    design_pdf_url: string | null;
  } | null;
}

interface Order {
  id: number;
  order_number: string;
  customer_name: string;
  customer_email: string;
  shipping_name: string;
  shipping_address_line1: string;
  shipping_address_line2: string | null;
  shipping_city: string;
  shipping_state: string;
  shipping_zip: string;
  total: number;
  status: string;
  easypost_shipment_id: string | null;
  tracking_number: string | null;
  carrier: string | null;
  paid_at: string | null;
  created_at: string;
}

interface OrderWithItems extends Order {
  items: OrderItem[];
  totalItemsInOrder: number;
  labelUrl: string | null;
  labelError: string | null;
  hasJewel: boolean; // true if ANY item in the order has a jewel
  namePosition: { x: number; y: number } | null; // position of first jeweled item's name on back PDF
}

// ─── Main handler ───────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const batchIdParam = request.nextUrl.searchParams.get("batchId");
  if (!batchIdParam || isNaN(Number(batchIdParam))) {
    return NextResponse.json({ error: "batchId required" }, { status: 400 });
  }
  const batchId = Number(batchIdParam);

  const supabase = createServiceClient();

  // 1. Verify batch exists
  const { data: batch, error: batchError } = await supabase
    .from("printer_batches")
    .select("id, batch_name, status")
    .eq("id", batchId)
    .single();

  if (batchError || !batch) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  // 2. Fetch all non-cancelled order items in this batch, with shirt_backs join
  const { data: rawItems, error: itemsError } = await supabase
    .from("order_items")
    .select("*, shirt_backs(id, meet_name, level_group_label, design_pdf_url)")
    .eq("printer_batch_id", batchId)
    .not("production_status", "eq", "cancelled");

  if (itemsError) {
    return NextResponse.json(
      { error: "Failed to fetch order items" },
      { status: 500 }
    );
  }

  const allItems: OrderItem[] = (rawItems || []) as OrderItem[];

  if (allItems.length === 0) {
    return NextResponse.json(
      { error: "No items in this batch" },
      { status: 404 }
    );
  }

  // 3. Group items by order_id
  const orderIdSet = new Set(allItems.map((i) => i.order_id));
  const orderIds = Array.from(orderIdSet);

  // 4. Fetch full order data for each order
  const { data: rawOrders, error: ordersError } = await supabase
    .from("orders")
    .select("*")
    .in("id", orderIds);

  if (ordersError || !rawOrders) {
    return NextResponse.json(
      { error: "Failed to fetch orders" },
      { status: 500 }
    );
  }

  // 5. For each order, count TOTAL items (across all batches) to detect partial orders
  const { data: allOrderItems } = await supabase
    .from("order_items")
    .select("id, order_id")
    .in("order_id", orderIds)
    .not("production_status", "eq", "cancelled");

  const totalItemsByOrder = new Map<number, number>();
  for (const item of allOrderItems || []) {
    totalItemsByOrder.set(
      item.order_id,
      (totalItemsByOrder.get(item.order_id) ?? 0) + 1
    );
  }

  // 6. Build order list with items
  const orders: OrderWithItems[] = (rawOrders as Order[]).map((order) => {
    const items = allItems.filter((i) => i.order_id === order.id);
    return {
      ...order,
      items,
      totalItemsInOrder: totalItemsByOrder.get(order.id) ?? 0,
      labelUrl: null as string | null,
      labelError: null as string | null,
      hasJewel: items.some((i) => i.has_jewel),
      namePosition: null,
    };
  });

  // 7. Sort: non-jewel first (by order number), then jewel (by name position on shirt)
  const nonJewelOrders = orders.filter((o) => !o.hasJewel);
  const jewelOrders = orders.filter((o) => o.hasJewel);

  // Sort non-jewel by order number
  nonJewelOrders.sort((a, b) => a.order_number.localeCompare(b.order_number));

  // For jewel orders, extract name positions from back PDFs for sorting
  await resolveNamePositions(jewelOrders);

  // Sort jewel orders: group by back_id, then within each back sort by position (y desc, x asc)
  // This creates reading order: across then down the shirt
  jewelOrders.sort((a, b) => {
    // Group by back_id first (keeps same-design shirts together)
    const backA = a.items.find((i) => i.has_jewel)?.back_id ?? 0;
    const backB = b.items.find((i) => i.has_jewel)?.back_id ?? 0;
    if (backA !== backB) return backA - backB;

    // Within same back, sort by name position
    if (a.namePosition && b.namePosition) {
      // y descending (top of shirt = higher y in PDF coords where y=0 is bottom), then x ascending
      // Use 15-unit threshold for same-row grouping (~0.2 inches at 72dpi, accounts for font baseline variance)
      if (Math.abs(a.namePosition.y - b.namePosition.y) > 15) {
        return b.namePosition.y - a.namePosition.y; // higher y first (top of shirt)
      }
      return a.namePosition.x - b.namePosition.x; // left to right
    }
    // Orders without position go to end, sorted by order number
    if (a.namePosition && !b.namePosition) return -1;
    if (!a.namePosition && b.namePosition) return 1;
    return a.order_number.localeCompare(b.order_number);
  });

  // Combine: non-jewel first, then jewel
  const sortedOrders = [...nonJewelOrders, ...jewelOrders];

  // 8. Create/fetch EasyPost labels for each order
  for (const order of sortedOrders) {
    try {
      if (order.easypost_shipment_id) {
        const existing = await easypost.Shipment.retrieve(
          order.easypost_shipment_id
        );
        order.labelUrl = existing.postage_label?.label_url || null;
      } else {
        const itemCount = order.items.length;
        const shipment = await easypost.Shipment.create({
          from_address: FROM_ADDRESS,
          to_address: {
            name: order.shipping_name,
            street1: order.shipping_address_line1,
            street2: order.shipping_address_line2 || undefined,
            city: order.shipping_city,
            state: order.shipping_state,
            zip: order.shipping_zip,
            country: "US",
          },
          parcel: {
            ...SHIRT_PARCEL,
            weight: SHIRT_PARCEL.weight * itemCount,
          },
        });

        const boughtShipment = await easypost.Shipment.buy(
          shipment.id,
          shipment.lowestRate()
        );

        await supabase.rpc("save_shipment_and_pack", {
          p_order_id: order.id,
          p_batch_id: batchId,
          p_easypost_shipment_id: boughtShipment.id,
          p_tracking_number: boughtShipment.tracking_code || "",
          p_carrier: boughtShipment.selected_rate?.carrier || "USPS",
        });

        order.labelUrl = boughtShipment.postage_label?.label_url || null;
      }
    } catch (err) {
      order.labelError =
        err instanceof Error ? err.message : "Unknown label error";
    }
  }

  // 9. Generate the PDF — exactly 2 pages per order (label + order sheet)
  const pdfBytes = await buildPrintBundlePdf(batch.batch_name, sortedOrders);

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="print-bundle-batch-${batchId}.pdf"`,
    },
  });
}

// ─── Name Position Resolution ───────────────────────────────────
// Extract where athlete names appear on the shirt back PDFs.
// Cached per back_id so each design PDF is fetched only once.

async function resolveNamePositions(orders: OrderWithItems[]) {
  // Group by back_id to avoid duplicate PDF fetches
  const backIds = new Set<number>();
  for (const order of orders) {
    const jewelItem = order.items.find((i) => i.has_jewel);
    if (jewelItem?.back_id) backIds.add(jewelItem.back_id);
  }

  // Cache: back_id -> Map<uppercased name -> {x, y}>
  const positionCache = new Map<number, Map<string, { x: number; y: number }>>();

  for (const backId of backIds) {
    // Find the PDF URL from any order's item with this back_id
    const sampleItem = orders
      .flatMap((o) => o.items)
      .find((i) => i.back_id === backId && i.shirt_backs?.design_pdf_url);

    const pdfUrl = sampleItem?.shirt_backs?.design_pdf_url;
    if (!pdfUrl) continue;

    try {
      // Validate URL — only allow Supabase storage URLs (our own bucket)
      const pdfUrlObj = new URL(pdfUrl);
      if (!pdfUrlObj.hostname.endsWith("supabase.co")) continue;
      const response = await fetch(pdfUrl, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) continue;
      const pdfBytes = new Uint8Array(await response.arrayBuffer());

      // Use pdfjs-dist to extract text positions
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
      const pdfDoc = await loadingTask.promise;

      const namePositions = new Map<string, { x: number; y: number }>();

      for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const textContent = await page.getTextContent();

        for (const item of textContent.items) {
          if (!("str" in item)) continue;
          const ti = item as { str: string; transform: number[] };
          if (ti.str.trim().length > 0) {
            // Store position keyed by uppercase name
            namePositions.set(ti.str.toUpperCase().trim(), {
              x: ti.transform[4],
              y: ti.transform[5],
            });
          }
        }
      }

      positionCache.set(backId, namePositions);
    } catch {
      // PDF fetch/parse failed — skip this back, orders will fall back to order_number sort
      continue;
    }
  }

  // Assign positions to orders
  for (const order of orders) {
    const jewelItem = order.items.find((i) => i.has_jewel);
    if (!jewelItem?.back_id) continue;

    const positions = positionCache.get(jewelItem.back_id);
    if (!positions) continue;

    const athleteName = (jewelItem.corrected_name ?? jewelItem.athlete_name).toUpperCase().trim();

    // Exact match only — partial matching is too permissive and non-deterministic
    const pos = positions.get(athleteName);

    if (pos) {
      order.namePosition = pos;
    }
  }
}

// ─── PDF Generation ─────────────────────────────────────────────

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;
const LINE_H = 16;

async function buildPrintBundlePdf(
  _batchName: string,
  orders: OrderWithItems[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Courier);
  const boldFont = await doc.embedFont(StandardFonts.CourierBold);

  for (const order of orders) {
    // Page 1: Shipping Label
    await drawLabelPage(doc, font, boldFont, order);

    // Page 2: Order Sheet (with jewel indicators)
    drawOrderSheet(doc, font, boldFont, order);
  }

  return doc.save();
}

// ─── Label Page ─────────────────────────────────────────────────

async function drawLabelPage(
  doc: PDFDocument,
  font: Awaited<ReturnType<typeof PDFDocument.prototype.embedFont>>,
  boldFont: Awaited<ReturnType<typeof PDFDocument.prototype.embedFont>>,
  order: OrderWithItems
) {
  const page = doc.addPage([PAGE_W, PAGE_H]);

  if (order.labelUrl) {
    try {
      // Validate label URL to prevent SSRF — only allow EasyPost domains
      const labelUrlObj = new URL(order.labelUrl);
      if (!labelUrlObj.hostname.endsWith("easypost.com") && !labelUrlObj.hostname.endsWith("easypost-files.superlogistics.com")) {
        throw new Error(`Untrusted label URL domain: ${labelUrlObj.hostname}`);
      }
      const labelResponse = await fetch(order.labelUrl, { signal: AbortSignal.timeout(15000) });
      const labelBytes = new Uint8Array(await labelResponse.arrayBuffer());

      const contentType = labelResponse.headers.get("content-type") || "";
      const isPng =
        order.labelUrl.toLowerCase().includes(".png") ||
        contentType.includes("png");
      const isJpg =
        order.labelUrl.toLowerCase().includes(".jpeg") ||
        order.labelUrl.toLowerCase().includes(".jpg") ||
        contentType.includes("jpeg");

      let labelImage;
      if (isPng) {
        labelImage = await doc.embedPng(labelBytes);
      } else if (isJpg) {
        labelImage = await doc.embedJpg(labelBytes);
      } else {
        try {
          labelImage = await doc.embedPng(labelBytes);
        } catch {
          labelImage = await doc.embedJpg(labelBytes);
        }
      }

      const maxW = PAGE_W - MARGIN * 2;
      const maxH = PAGE_H - MARGIN * 2;
      const scale = Math.min(maxW / labelImage.width, maxH / labelImage.height, 1);
      const drawW = labelImage.width * scale;
      const drawH = labelImage.height * scale;
      const x = (PAGE_W - drawW) / 2;
      const y = (PAGE_H - drawH) / 2;
      page.drawImage(labelImage, { x, y, width: drawW, height: drawH });
    } catch {
      drawCenteredText(page, boldFont, "LABEL FETCH FAILED", PAGE_H / 2 + 40, 18, rgb(0.8, 0, 0));
      drawCenteredText(page, font, `Order: ${order.order_number}`, PAGE_H / 2, 14);
      drawCenteredText(page, font, "Print label manually from EasyPost", PAGE_H / 2 - 30, 12, rgb(0.4, 0.4, 0.4));
    }
  } else if (order.labelError) {
    drawCenteredText(page, boldFont, "LABEL ERROR", PAGE_H / 2 + 60, 20, rgb(0.8, 0, 0));
    drawCenteredText(page, font, `Order: ${order.order_number}`, PAGE_H / 2 + 20, 14);
    const errLines = wrapText(order.labelError, font, 10, PAGE_W - MARGIN * 2);
    let errY = PAGE_H / 2 - 20;
    for (const line of errLines) {
      drawCenteredText(page, font, line, errY, 10, rgb(0.5, 0, 0));
      errY -= LINE_H;
    }
    drawCenteredText(page, font, "Create label manually and re-generate bundle", errY - 20, 10, rgb(0.4, 0.4, 0.4));
  } else {
    drawCenteredText(page, boldFont, "NO LABEL AVAILABLE", PAGE_H / 2, 18, rgb(0.6, 0, 0));
    drawCenteredText(page, font, `Order: ${order.order_number}`, PAGE_H / 2 - 30, 14);
  }
}

// ─── Order Sheet (customer-facing packing slip) ─────────────────

function drawOrderSheet(
  doc: PDFDocument,
  font: Awaited<ReturnType<typeof PDFDocument.prototype.embedFont>>,
  boldFont: Awaited<ReturnType<typeof PDFDocument.prototype.embedFont>>,
  order: OrderWithItems
) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const draw = (
    text: string,
    opts?: {
      size?: number;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      x?: number;
      indent?: number;
    }
  ) => {
    const size = opts?.size ?? 11;
    const f = opts?.bold ? boldFont : font;
    const x = opts?.x ?? opts?.indent ?? MARGIN;
    page.drawText(text, { x, y, size, font: f, color: opts?.color ?? rgb(0, 0, 0) });
  };

  const nl = (count = 1) => {
    y -= LINE_H * count;
  };

  const rule = (char = "=", width = 40) => {
    draw(char.repeat(width), { size: 10 });
    nl();
  };

  // ─── JEWEL ORDER header (if any item has jewel) ───
  if (order.hasJewel) {
    // Draw a prominent JEWEL ORDER banner at the very top
    page.drawRectangle({
      x: MARGIN,
      y: y - 5,
      width: PAGE_W - MARGIN * 2,
      height: 30,
      color: rgb(0.15, 0.15, 0.15),
    });
    page.drawText("★  JEWEL ORDER  ★", {
      x: MARGIN + 10,
      y: y + 3,
      size: 16,
      font: boldFont,
      color: rgb(1, 1, 1),
    });
    nl(2.5);
  }

  // Header
  rule("=", 43);
  draw("   THE STATE CHAMPION", { size: 12, bold: true });
  nl();
  draw("   Championship T-Shirt Order", { size: 10 });
  nl();
  rule("=", 43);
  nl(0.5);

  // Order info
  draw(`Order: ${order.order_number}`, { bold: true });
  nl();
  const orderDate = order.paid_at
    ? new Date(order.paid_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : new Date(order.created_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
  draw(`Date: ${orderDate}`);
  nl();
  nl();

  // Ship-to
  draw("SHIP TO:", { bold: true });
  nl();
  draw(order.shipping_name, { indent: MARGIN + 10 });
  nl();
  draw(order.shipping_address_line1, { indent: MARGIN + 10 });
  nl();
  if (order.shipping_address_line2) {
    draw(order.shipping_address_line2, { indent: MARGIN + 10 });
    nl();
  }
  draw(
    `${order.shipping_city}, ${order.shipping_state} ${order.shipping_zip}`,
    { indent: MARGIN + 10 }
  );
  nl();
  nl();

  // Items with jewel indicators
  const batchItems = order.items;
  draw(`ITEMS (${batchItems.length} shirt${batchItems.length !== 1 ? "s" : ""}):`, {
    bold: true,
  });
  nl();

  for (let i = 0; i < batchItems.length; i++) {
    const item = batchItems[i];
    const displayName = sanitizeForPdf(item.corrected_name ?? item.athlete_name);
    const sizeColor = `${item.shirt_size} ${capitalize(item.shirt_color)}`;

    if (item.has_jewel) {
      // Prominent jewel marker: ★ JEWEL ★ next to the item
      const line = `  ${i + 1}. ${displayName} -- ${sizeColor}`;
      draw(line, { indent: MARGIN + 10, size: 10 });
      // Draw jewel marker to the right
      const lineWidth = font.widthOfTextAtSize(line, 10);
      page.drawText("  ★ JEWEL", {
        x: MARGIN + 10 + lineWidth,
        y,
        size: 10,
        font: boldFont,
        color: rgb(0.7, 0, 0),
      });
    } else {
      const line = `  ${i + 1}. ${displayName} -- ${sizeColor}`;
      draw(line, { indent: MARGIN + 10, size: 10 });
    }
    nl();
  }
  nl(0.5);

  // Partial order warning
  const isPartial = batchItems.length < order.totalItemsInOrder;
  if (isPartial) {
    nl(0.5);
    draw(
      `** PARTIAL ORDER -- ${batchItems.length} of ${order.totalItemsInOrder} shirts in this batch`,
      { size: 10, bold: true, color: rgb(0.7, 0.3, 0) }
    );
    nl();
    draw("   Remaining shirts in a different batch", {
      size: 9,
      indent: MARGIN + 10,
      color: rgb(0.5, 0.3, 0),
    });
    nl();
    nl(0.5);
  }

  // Total
  draw(`Total Paid: ${formatPrice(order.total)}`, { bold: true });
  nl();
  nl();

  // Footer
  draw("Thank you for your order!", { size: 10 });
  nl();
  rule("=", 43);
}

// ─── Helpers ────────────────────────────────────────────────────

function drawCenteredText(
  page: ReturnType<typeof PDFDocument.prototype.addPage>,
  font: Awaited<ReturnType<typeof PDFDocument.prototype.embedFont>>,
  text: string,
  y: number,
  size = 12,
  color = rgb(0, 0, 0)
) {
  const textW = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: (PAGE_W - textW) / 2,
    y,
    size,
    font,
    color,
  });
}

function wrapText(
  text: string,
  font: Awaited<ReturnType<typeof PDFDocument.prototype.embedFont>>,
  size: number,
  maxWidth: number
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
