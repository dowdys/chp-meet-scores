import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";

const SIZE_ORDER = ["YS", "YM", "YL", "S", "M", "L", "XL", "XXL"];

interface OrderItem {
  id: number;
  athlete_name: string;
  corrected_name: string | null;
  shirt_size: string;
  shirt_color: string;
  has_jewel: boolean;
  back_id: number | null;
  printer_batch_id: number | null;
}

interface BackGroup {
  backId: number;
  meetName: string;
  levelGroupLabel: string;
  items: OrderItem[];
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const batchIdParam = request.nextUrl.searchParams.get("batchId");
  if (!batchIdParam || isNaN(Number(batchIdParam))) {
    return NextResponse.json({ error: "batchId required" }, { status: 400 });
  }
  const batchId = Number(batchIdParam);

  const supabase = createServiceClient();

  // Fetch the batch metadata
  const { data: batch, error: batchError } = await supabase
    .from("printer_batches")
    .select("id, batch_name, screen_printer, created_at")
    .eq("id", batchId)
    .single();

  if (batchError || !batch) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  // Fetch all backs in this batch with their shirt_back metadata
  const { data: batchBacks, error: backsError } = await supabase
    .from("printer_batch_backs")
    .select("back_id, shirt_backs(id, meet_name, level_group_label)")
    .eq("batch_id", batchId)
    .order("back_id");

  if (backsError || !batchBacks) {
    return NextResponse.json({ error: "Failed to fetch batch backs" }, { status: 500 });
  }

  if (batchBacks.length === 0) {
    return NextResponse.json({ error: "No backs in this batch" }, { status: 404 });
  }

  const backIds = batchBacks.map((b: { back_id: number }) => b.back_id);

  // Fetch all order items for these backs in this batch
  const { data: items, error: itemsError } = await supabase
    .from("order_items")
    .select("id, athlete_name, corrected_name, shirt_size, shirt_color, has_jewel, back_id, printer_batch_id")
    .eq("printer_batch_id", batchId)
    .in("back_id", backIds)
    .not("production_status", "eq", "cancelled")
    .order("back_id")
    .order("athlete_name");

  if (itemsError) {
    return NextResponse.json({ error: "Failed to fetch order items" }, { status: 500 });
  }

  const allItems: OrderItem[] = items || [];

  // Build a map of back_id -> shirt_back metadata
  const backMeta = new Map<number, { meetName: string; levelGroupLabel: string }>();
  for (const bb of batchBacks) {
    // Supabase returns joined rows as array or object depending on relation type;
    // cast through unknown to handle either shape safely.
    const raw = bb.shirt_backs as unknown;
    const sb = (Array.isArray(raw) ? raw[0] : raw) as {
      id: number;
      meet_name: string;
      level_group_label: string;
    } | null;
    if (sb) {
      backMeta.set(bb.back_id, {
        meetName: sb.meet_name,
        levelGroupLabel: sb.level_group_label,
      });
    }
  }

  // Group items by back_id in back order
  const backGroups: BackGroup[] = backIds.map((backId: number) => {
    const meta = backMeta.get(backId) ?? { meetName: "Unknown", levelGroupLabel: "Unknown" };
    return {
      backId,
      meetName: meta.meetName,
      levelGroupLabel: meta.levelGroupLabel,
      items: allItems.filter((item) => item.back_id === backId),
    };
  });

  // Generate PDF
  const pdfBytes = await buildManifestPdf(batch, backGroups);

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="manifest-batch-${batchId}.pdf"`,
    },
  });
}

async function buildManifestPdf(
  batch: { batch_name: string; screen_printer: string; created_at: string },
  backGroups: BackGroup[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Courier);
  const boldFont = await doc.embedFont(StandardFonts.CourierBold);

  const PAGE_W = 612;
  const PAGE_H = 792;
  const MARGIN = 48;
  const LINE_H = 14;
  const BODY_W = PAGE_W - MARGIN * 2;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  function ensureSpace(needed: number) {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  }

  function drawText(
    text: string,
    options: {
      size?: number;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      x?: number;
      rightAlign?: boolean;
    } = {}
  ) {
    const size = options.size ?? 10;
    const f = options.bold ? boldFont : font;
    const color = options.color ?? rgb(0, 0, 0);
    const x = options.x ?? MARGIN;
    const drawX = options.rightAlign
      ? PAGE_W - MARGIN - f.widthOfTextAtSize(text, size)
      : x;
    page.drawText(text, { x: drawX, y, size, font: f, color });
  }

  function newLine(count = 1) {
    y -= LINE_H * count;
  }

  function drawRule(thickness = 0.5) {
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness,
      color: rgb(0.4, 0.4, 0.4),
    });
    y -= 4;
  }

  // ─── Header ───────────────────────────────────────────────────
  const printerLabel =
    batch.screen_printer === "printer_1" ? "Printer 1" : "Printer 2";
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  drawText("PRINT MANIFEST", { size: 16, bold: true });
  drawText(`— ${batch.batch_name}`, {
    size: 16,
    bold: true,
    x: MARGIN + boldFont.widthOfTextAtSize("PRINT MANIFEST", 16) + 6,
  });
  newLine();
  newLine(0.4);
  drawText(`Date: ${today}`, { size: 9 });
  drawText(`Printer: ${printerLabel}`, { size: 9, rightAlign: true });
  newLine();
  newLine(0.6);
  drawRule(1);
  newLine();

  // ─── Grand total accumulators ──────────────────────────────────
  let grandTotal = 0;
  let grandJewels = 0;

  // ─── Per-back sections ────────────────────────────────────────
  for (const group of backGroups) {
    const { backId, meetName, levelGroupLabel, items } = group;

    // Section header
    ensureSpace(LINE_H * 4);
    const sectionHeader = `${meetName} — ${levelGroupLabel} (Back #${backId})`;
    drawText(sectionHeader, { size: 10, bold: true, color: rgb(0.1, 0.1, 0.5) });
    newLine();
    drawText(`Total shirts: ${items.length}`, { size: 9 });
    newLine();
    newLine(0.5);

    // Column headers
    ensureSpace(LINE_H * 2);
    const COL = { check: MARGIN, name: MARGIN + 18, size: MARGIN + 230, color: MARGIN + 268, jewel: MARGIN + 320 };
    drawText("  ", { size: 9, x: COL.check });
    drawText("Athlete Name", { size: 9, bold: true, x: COL.name });
    drawText("Size", { size: 9, bold: true, x: COL.size });
    drawText("Color", { size: 9, bold: true, x: COL.color });
    drawText("Jewel", { size: 9, bold: true, x: COL.jewel });
    newLine();

    page.drawLine({
      start: { x: MARGIN, y: y + 2 },
      end: { x: PAGE_W - MARGIN, y: y + 2 },
      thickness: 0.3,
      color: rgb(0.7, 0.7, 0.7),
    });
    newLine(0.4);

    // Item rows
    const sizeCounts: Record<string, number> = {};
    let sectionJewels = 0;

    for (const item of items) {
      ensureSpace(LINE_H + 4);

      const displayName = item.corrected_name ?? item.athlete_name;
      const truncName = displayName.length > 28 ? displayName.slice(0, 27) + "…" : displayName;
      const jewelLabel = item.has_jewel ? "YES" : "no";
      const jewelColor = item.has_jewel ? rgb(0.1, 0.5, 0.1) : rgb(0.6, 0.6, 0.6);

      // Checkbox square
      page.drawRectangle({
        x: COL.check,
        y: y - 1,
        width: 9,
        height: 9,
        borderWidth: 0.8,
        borderColor: rgb(0.3, 0.3, 0.3),
        color: rgb(1, 1, 1),
      });

      drawText(truncName, { size: 9, x: COL.name });
      drawText(item.shirt_size, { size: 9, x: COL.size });
      drawText(item.shirt_color, { size: 9, x: COL.color });
      drawText(jewelLabel, { size: 9, x: COL.jewel, color: jewelColor });
      newLine();

      sizeCounts[item.shirt_size] = (sizeCounts[item.shirt_size] ?? 0) + 1;
      if (item.has_jewel) sectionJewels++;
    }

    newLine(0.5);

    // Size totals line
    ensureSpace(LINE_H * 3);
    const sizeParts = SIZE_ORDER.map((s) => `${s}:${sizeCounts[s] ?? 0}`).join("  ");
    drawText(`Size totals: ${sizeParts}`, { size: 8, color: rgb(0.3, 0.3, 0.3) });
    newLine();
    drawText(`Jewel count: ${sectionJewels}`, { size: 8, color: rgb(0.3, 0.3, 0.3) });
    newLine();
    newLine(0.5);

    page.drawLine({
      start: { x: MARGIN, y: y + 4 },
      end: { x: PAGE_W - MARGIN, y: y + 4 },
      thickness: 0.3,
      color: rgb(0.8, 0.8, 0.8),
    });
    y -= 6;

    grandTotal += items.length;
    grandJewels += sectionJewels;
  }

  // ─── Grand Totals ─────────────────────────────────────────────
  ensureSpace(LINE_H * 5);
  newLine();
  drawRule(1);
  newLine(0.4);
  drawText("GRAND TOTALS", { size: 11, bold: true });
  newLine();
  drawText(`Total shirts: ${grandTotal}`, { size: 10 });
  newLine();
  drawText(`Total jewels: ${grandJewels}`, { size: 10 });

  return doc.save();
}
