import { NextRequest, NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";

/**
 * Generate a back-of-shirt preview with red stars next to the athlete's name.
 *
 * Query params:
 *   pdf_url  - URL of the back_of_shirt.pdf in Supabase Storage
 *   name     - Athlete name to highlight
 *   jewel    - "true" to draw stars, "false" for plain PDF
 *
 * Returns: Modified PDF as application/pdf
 */
export async function GET(request: NextRequest) {
  const pdfUrl = request.nextUrl.searchParams.get("pdf_url");
  const athleteName = request.nextUrl.searchParams.get("name");
  const showJewel = request.nextUrl.searchParams.get("jewel") === "true";

  if (!pdfUrl) {
    return NextResponse.json({ error: "pdf_url required" }, { status: 400 });
  }

  try {
    // Fetch the original PDF
    const pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) {
      return NextResponse.json({ error: "Failed to fetch PDF" }, { status: 502 });
    }

    const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());

    // If no jewel or no name, return as-is
    if (!showJewel || !athleteName) {
      return new NextResponse(pdfBytes, {
        headers: {
          "Content-Type": "application/pdf",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // Use pdfjs-dist to find text positions
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
    const pdfJsDoc = await loadingTask.promise;

    // Load with pdf-lib for modification
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();

    const searchName = athleteName.toUpperCase().trim();

    for (let pageNum = 1; pageNum <= pdfJsDoc.numPages; pageNum++) {
      const jsPage = await pdfJsDoc.getPage(pageNum);
      const textContent = await jsPage.getTextContent();
      const pdfLibPage = pages[pageNum - 1];

      for (const item of textContent.items) {
        if (!("str" in item)) continue;
        const ti = item as {
          str: string;
          transform: number[];
          width: number;
          height: number;
        };

        if (ti.str.toUpperCase().includes(searchName)) {
          const tx = ti.transform[4];
          const ty = ti.transform[5];
          const textH = ti.height || Math.abs(ti.transform[3]);
          const fontSize = textH * 0.8;
          const outerR = fontSize * 0.65;
          const innerR = outerR * 0.4;

          // Star to the LEFT of the name
          const leftCx = tx - outerR - 3;
          const cy = ty + textH / 2;
          appendStarToPage(pdfLibPage, leftCx, cy, outerR, innerR);

          // Star to the RIGHT of the name
          const rightCx = tx + ti.width + outerR + 3;
          appendStarToPage(pdfLibPage, rightCx, cy, outerR, innerR);

          break;
        }
      }
    }

    const result = await pdfDoc.save();

    return new NextResponse(Buffer.from(result), {
      headers: {
        "Content-Type": "application/pdf",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    console.error("Shirt preview error:", err);
    // On error, try to return the original PDF
    try {
      const fallback = await fetch(pdfUrl!);
      return new NextResponse(await fallback.arrayBuffer(), {
        headers: { "Content-Type": "application/pdf" },
      });
    } catch {
      return NextResponse.json({ error: "Preview failed" }, { status: 500 });
    }
  }
}

/**
 * Append a 5-pointed star as raw PDF content stream operators.
 * This matches the Python draw_star_polygon exactly.
 */
function appendStarToPage(
  page: ReturnType<typeof PDFDocument.prototype.getPages>[0],
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
) {
  // Generate 10 points of the star (alternating outer/inner radius)
  const points: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const angle = Math.PI / 2 + i * (Math.PI / 5);
    const r = i % 2 === 0 ? outerR : innerR;
    points.push([
      cx + r * Math.cos(angle),
      cy + r * Math.sin(angle),
    ]);
  }

  // Build raw PDF path operators
  // Color: ORDER_FORM_RED = (0.8, 0, 0)
  let ops = `q\n0.8 0 0 rg\n`;
  ops += `${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)} m\n`;
  for (let i = 1; i < points.length; i++) {
    ops += `${points[i][0].toFixed(2)} ${points[i][1].toFixed(2)} l\n`;
  }
  ops += `h\nf\nQ\n`;

  // Append to the page's content stream
  const context = page.doc.context;
  const stream = context.flateStream(ops);
  const ref = context.register(stream);
  page.node.addContentStream(ref);
}
