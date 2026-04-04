import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
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
  shirt_backs: { id: number; meet_name: string; level_group_label: string } | null;
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
  totalItemsInOrder: number; // total items across ALL batches
  labelUrl: string | null;
  labelError: string | null;
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
    .select("*, shirt_backs(id, meet_name, level_group_label)")
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

  // 6. Build order list with items, sorted by order_number
  const orders: OrderWithItems[] = (rawOrders as Order[])
    .map((order) => ({
      ...order,
      items: allItems.filter((i) => i.order_id === order.id),
      totalItemsInOrder: totalItemsByOrder.get(order.id) ?? 0,
      labelUrl: null as string | null,
      labelError: null as string | null,
    }))
    .sort((a, b) => a.order_number.localeCompare(b.order_number));

  // 7. Create/fetch EasyPost labels for each order
  for (const order of orders) {
    try {
      if (order.easypost_shipment_id) {
        // Already has a shipment — retrieve the existing label
        const existing = await easypost.Shipment.retrieve(
          order.easypost_shipment_id
        );
        order.labelUrl = existing.postage_label?.label_url || null;
      } else {
        // Create new shipment + buy label
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

        // Atomically: pack items in this batch, conditionally ship order,
        // save shipment info — all in one transaction via RPC.
        // Prevents orphaned shipments if DB update fails.
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

  // 8. Generate the PDF
  const pdfBytes = await buildPrintBundlePdf(batch.batch_name, orders);

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="print-bundle-batch-${batchId}.pdf"`,
    },
  });
}

// ─── PDF Generation ─────────────────────────────────────────────

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;
const LINE_H = 16;

async function buildPrintBundlePdf(
  batchName: string,
  orders: OrderWithItems[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Courier);
  const boldFont = await doc.embedFont(StandardFonts.CourierBold);

  for (const order of orders) {
    // ─── Page 1: Shipping Label ─────────────────────────────
    await drawLabelPage(doc, font, boldFont, order);

    // ─── Page 2: Order Sheet ────────────────────────────────
    drawOrderSheet(doc, font, boldFont, order);

    // ─── Pages 3+: Per-Shirt Slips ─────────────────────────
    const batchItemCount = order.items.length;

    if (batchItemCount >= 2) {
      // Multi-shirt: one slip per shirt
      for (let i = 0; i < order.items.length; i++) {
        drawShirtSlip(doc, font, boldFont, order, order.items[i], i + 1, batchItemCount);
      }
    } else if (batchItemCount === 1 && order.items[0].has_jewel) {
      // Single shirt with jewel: one jewel flag page
      drawJewelFlagPage(doc, font, boldFont, order, order.items[0]);
    }
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

      // Determine format from URL or content type
      const contentType = labelResponse.headers.get("content-type") || "";
      const isPng =
        order.labelUrl.toLowerCase().includes(".png") ||
        contentType.includes("png");
      const isJpg =
        order.labelUrl.toLowerCase().includes(".jpg") ||
        order.labelUrl.toLowerCase().includes(".jpeg") ||
        contentType.includes("jpeg");

      let labelImage;
      if (isPng) {
        labelImage = await doc.embedPng(labelBytes);
      } else if (isJpg) {
        labelImage = await doc.embedJpg(labelBytes);
      } else {
        // Try PNG first, fall back to JPEG
        try {
          labelImage = await doc.embedPng(labelBytes);
        } catch {
          labelImage = await doc.embedJpg(labelBytes);
        }
      }

      // Scale to fit the page with margins
      const maxW = PAGE_W - MARGIN * 2;
      const maxH = PAGE_H - MARGIN * 2;
      const imgW = labelImage.width;
      const imgH = labelImage.height;
      const scale = Math.min(maxW / imgW, maxH / imgH, 1);
      const drawW = imgW * scale;
      const drawH = imgH * scale;

      // Center on page
      const x = (PAGE_W - drawW) / 2;
      const y = (PAGE_H - drawH) / 2;

      page.drawImage(labelImage, { x, y, width: drawW, height: drawH });
    } catch {
      // If fetching/embedding fails, show error text
      drawCenteredText(
        page,
        boldFont,
        "LABEL FETCH FAILED",
        PAGE_H / 2 + 40,
        18,
        rgb(0.8, 0, 0)
      );
      drawCenteredText(
        page,
        font,
        `Order: ${order.order_number}`,
        PAGE_H / 2,
        14
      );
      drawCenteredText(
        page,
        font,
        "Print label manually from EasyPost",
        PAGE_H / 2 - 30,
        12,
        rgb(0.4, 0.4, 0.4)
      );
    }
  } else if (order.labelError) {
    // Label creation failed
    drawCenteredText(
      page,
      boldFont,
      "LABEL ERROR",
      PAGE_H / 2 + 60,
      20,
      rgb(0.8, 0, 0)
    );
    drawCenteredText(
      page,
      font,
      `Order: ${order.order_number}`,
      PAGE_H / 2 + 20,
      14
    );

    // Word-wrap the error message
    const errLines = wrapText(order.labelError, font, 10, PAGE_W - MARGIN * 2);
    let errY = PAGE_H / 2 - 20;
    for (const line of errLines) {
      drawCenteredText(page, font, line, errY, 10, rgb(0.5, 0, 0));
      errY -= LINE_H;
    }

    drawCenteredText(
      page,
      font,
      "Create label manually and re-generate bundle",
      errY - 20,
      10,
      rgb(0.4, 0.4, 0.4)
    );
  } else {
    // No label and no error (shouldn't happen, but handle gracefully)
    drawCenteredText(
      page,
      boldFont,
      "NO LABEL AVAILABLE",
      PAGE_H / 2,
      18,
      rgb(0.6, 0, 0)
    );
    drawCenteredText(
      page,
      font,
      `Order: ${order.order_number}`,
      PAGE_H / 2 - 30,
      14
    );
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

  // Items
  const batchItems = order.items;
  draw(`ITEMS (${batchItems.length} shirt${batchItems.length !== 1 ? "s" : ""}):`, {
    bold: true,
  });
  nl();

  for (let i = 0; i < batchItems.length; i++) {
    const item = batchItems[i];
    const displayName = item.corrected_name ?? item.athlete_name;
    const jewelMark = item.has_jewel ? " -- Jewel" : "";
    const sizeColor = `${item.shirt_size} ${capitalize(item.shirt_color)}`;
    const line = `  ${i + 1}. ${displayName} -- ${sizeColor}${jewelMark}`;
    draw(line, { indent: MARGIN + 10, size: 10 });
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

// ─── Per-Shirt Slip (multi-shirt orders) ────────────────────────

function drawShirtSlip(
  doc: PDFDocument,
  font: Awaited<ReturnType<typeof PDFDocument.prototype.embedFont>>,
  boldFont: Awaited<ReturnType<typeof PDFDocument.prototype.embedFont>>,
  order: OrderWithItems,
  item: OrderItem,
  index: number,
  total: number
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
    }
  ) => {
    const size = opts?.size ?? 12;
    const f = opts?.bold ? boldFont : font;
    page.drawText(text, {
      x: opts?.x ?? MARGIN,
      y,
      size,
      font: f,
      color: opts?.color ?? rgb(0, 0, 0),
    });
  };

  const nl = (count = 1) => {
    y -= LINE_H * count;
  };

  // Shirt number header
  draw(`SHIRT ${index} of ${total}`, { size: 18, bold: true });
  nl();
  const rule = "=".repeat(33);
  draw(rule, { size: 12 });
  nl(1.5);

  // Order number
  draw(`Order: ${order.order_number}`, { size: 14, bold: true });
  nl(1.5);

  // Athlete
  const displayName = item.corrected_name ?? item.athlete_name;
  draw(`Athlete: ${displayName}`, { size: 14 });
  nl();

  // Size
  draw(`Size: ${item.shirt_size}`, { size: 14 });
  nl();

  // Color
  draw(`Color: ${capitalize(item.shirt_color)}`, { size: 14 });
  nl();

  // Back design
  if (item.shirt_backs) {
    draw(`Back: ${item.shirt_backs.level_group_label}`, { size: 14 });
    nl();
  }

  nl(2);

  // JEWEL NEEDED box (if applicable)
  if (item.has_jewel) {
    drawJewelBox(page, boldFont, y);
  }
}

// ─── Jewel Flag Page (single-shirt with jewel) ─────────────────

function drawJewelFlagPage(
  doc: PDFDocument,
  font: Awaited<ReturnType<typeof PDFDocument.prototype.embedFont>>,
  boldFont: Awaited<ReturnType<typeof PDFDocument.prototype.embedFont>>,
  order: OrderWithItems,
  item: OrderItem
) {
  const page = doc.addPage([PAGE_W, PAGE_H]);

  // Order info at top
  page.drawText(`Order: ${order.order_number}`, {
    x: MARGIN,
    y: PAGE_H - MARGIN,
    size: 14,
    font: boldFont,
  });
  const displayName = item.corrected_name ?? item.athlete_name;
  page.drawText(`Athlete: ${displayName}`, {
    x: MARGIN,
    y: PAGE_H - MARGIN - LINE_H * 1.5,
    size: 12,
    font,
  });
  page.drawText(`Size: ${item.shirt_size}  Color: ${capitalize(item.shirt_color)}`, {
    x: MARGIN,
    y: PAGE_H - MARGIN - LINE_H * 3,
    size: 12,
    font,
  });

  // Big JEWEL box centered in page
  drawJewelBox(page, boldFont, PAGE_H / 2 + 40);
}

// ─── Shared: Draw the large JEWEL NEEDED box ────────────────────

function drawJewelBox(
  page: ReturnType<typeof PDFDocument.prototype.addPage>,
  boldFont: Awaited<ReturnType<typeof PDFDocument.prototype.embedFont>>,
  centerY: number
) {
  const boxW = 280;
  const boxH = 160;
  const boxX = (PAGE_W - boxW) / 2;
  const boxY = centerY - boxH / 2;

  // Thick border rectangle
  page.drawRectangle({
    x: boxX,
    y: boxY,
    width: boxW,
    height: boxH,
    borderWidth: 4,
    borderColor: rgb(0, 0, 0),
    color: rgb(0.95, 0.95, 0.95),
  });

  // "JEWEL" text — large
  const jewelText = "JEWEL";
  const jewelSize = 36;
  const jewelW = boldFont.widthOfTextAtSize(jewelText, jewelSize);
  page.drawText(jewelText, {
    x: (PAGE_W - jewelW) / 2,
    y: centerY + 10,
    size: jewelSize,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  // "NEEDED" text — large
  const neededText = "NEEDED";
  const neededSize = 36;
  const neededW = boldFont.widthOfTextAtSize(neededText, neededSize);
  page.drawText(neededText, {
    x: (PAGE_W - neededW) / 2,
    y: centerY - 35,
    size: neededSize,
    font: boldFont,
    color: rgb(0, 0, 0),
  });
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
