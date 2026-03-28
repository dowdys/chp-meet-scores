"use client";

import { useState, useEffect, useRef, useMemo } from "react";

interface ShirtPreviewProps {
  frontPdfUrl: string | null;
  backPdfUrl: string | null;
  color: "white" | "grey";
  athleteName?: string;
  hasJewel?: boolean;
}

/**
 * Render a PDF page to a canvas and return as data URL.
 * Uses pdfjs-dist loaded from CDN for client-side rendering.
 */
async function renderPdfToImage(pdfUrl: string): Promise<string | null> {
  try {
    // Dynamic import of pdf.js from CDN (client-side only)
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

    const doc = await pdfjsLib.getDocument(pdfUrl).promise;
    const page = await doc.getPage(1);

    const scale = 1.5; // Higher = sharper
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d")!;

    await page.render({ canvasContext: ctx, viewport } as any).promise;

    return canvas.toDataURL("image/png");
  } catch (err) {
    console.error("PDF render failed:", err);
    return null;
  }
}

export function ShirtPreview({
  frontPdfUrl,
  backPdfUrl,
  color,
  athleteName,
  hasJewel = false,
}: ShirtPreviewProps) {
  const [side, setSide] = useState<"front" | "back">("front");
  const [frontImage, setFrontImage] = useState<string | null>(null);
  const [backImage, setBackImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // For jewel preview, route through our star-drawing API
  const effectiveBackUrl = useMemo(() => {
    if (!backPdfUrl) return null;
    if (!hasJewel || !athleteName) return backPdfUrl;
    return `/api/shirt-preview?pdf_url=${encodeURIComponent(backPdfUrl)}&name=${encodeURIComponent(athleteName)}&jewel=true`;
  }, [backPdfUrl, athleteName, hasJewel]);

  // Render front PDF to image
  useEffect(() => {
    if (!frontPdfUrl) return;
    setLoading(true);
    renderPdfToImage(frontPdfUrl).then((img) => {
      setFrontImage(img);
      setLoading(false);
    });
  }, [frontPdfUrl]);

  // Render back PDF to image (re-renders when jewel toggles)
  useEffect(() => {
    if (!effectiveBackUrl) return;
    setLoading(true);
    renderPdfToImage(effectiveBackUrl).then((img) => {
      setBackImage(img);
      setLoading(false);
    });
  }, [effectiveBackUrl]);

  const currentImage = side === "front" ? frontImage : backImage;

  return (
    <div className="space-y-3">
      <div className="flex gap-2 justify-center">
        <button
          onClick={() => setSide("front")}
          className={`px-4 py-1.5 rounded text-sm font-medium transition ${
            side === "front"
              ? "bg-red-600 text-white"
              : "bg-white/10 text-gray-400 hover:text-white"
          }`}
        >
          Front
        </button>
        <button
          onClick={() => setSide("back")}
          className={`px-4 py-1.5 rounded text-sm font-medium transition ${
            side === "back"
              ? "bg-red-600 text-white"
              : "bg-white/10 text-gray-400 hover:text-white"
          }`}
        >
          Back
        </button>
      </div>

      {/* Shirt shape */}
      <div className="relative mx-auto" style={{ width: 300, height: 360 }}>
        {/* T-shirt silhouette */}
        <svg
          viewBox="0 0 300 360"
          className="absolute inset-0"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d={`
              M 75 0
              L 0 55
              L 32 85
              L 58 70
              L 58 350
              L 242 350
              L 242 70
              L 268 85
              L 300 55
              L 225 0
              C 215 32 183 48 150 48
              C 117 48 85 32 75 0
              Z
            `}
            fill={color === "white" ? "#f8f8f8" : "#b8b8b8"}
            stroke={color === "white" ? "#ddd" : "#888"}
            strokeWidth="1.5"
          />
          <path
            d={`
              M 75 0
              C 85 32 117 48 150 48
              C 183 48 215 32 225 0
            `}
            fill="none"
            stroke={color === "white" ? "#ccc" : "#777"}
            strokeWidth="1.5"
          />
        </svg>

        {/* Design image overlay */}
        <div
          className="absolute overflow-hidden flex items-center justify-center"
          style={{ top: 65, left: 70, width: 160, height: 230 }}
        >
          {loading && (
            <div className="text-gray-400 text-xs animate-pulse">
              Loading preview...
            </div>
          )}
          {!loading && currentImage && (
            <img
              src={currentImage}
              alt={`${side} of shirt`}
              className="w-full h-full object-contain"
            />
          )}
          {!loading && !currentImage && (
            <div className="text-gray-500 text-xs text-center px-2">
              {side === "front"
                ? "Front preview not available"
                : "Back preview not available"}
            </div>
          )}
        </div>
      </div>

      <p className="text-center text-xs text-gray-500">
        {side === "front" ? "Front of shirt" : "Back of shirt"} •{" "}
        {color === "white" ? "White" : "Grey"}
        {side === "back" && hasJewel && (
          <span className="text-red-400"> • ★ Jewel accent</span>
        )}
      </p>
    </div>
  );
}
