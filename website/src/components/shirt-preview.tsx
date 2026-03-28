"use client";

import { useState, useMemo } from "react";

interface ShirtPreviewProps {
  frontPdfUrl: string | null;
  backPdfUrl: string | null;
  color: "white" | "grey";
  athleteName?: string;
  hasJewel?: boolean;
}

export function ShirtPreview({
  frontPdfUrl,
  backPdfUrl,
  color,
  athleteName,
  hasJewel = false,
}: ShirtPreviewProps) {
  const [side, setSide] = useState<"front" | "back">("front");

  // For the back with jewel, route through our star-drawing API
  const effectiveBackUrl = useMemo(() => {
    if (!backPdfUrl) return null;
    if (!hasJewel || !athleteName) return backPdfUrl;
    return `/api/shirt-preview?pdf_url=${encodeURIComponent(backPdfUrl)}&name=${encodeURIComponent(athleteName)}&jewel=true`;
  }, [backPdfUrl, athleteName, hasJewel]);

  const pdfUrl = side === "front" ? frontPdfUrl : effectiveBackUrl;

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
          className="absolute inset-0 z-0"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d={`
              M 75 0 L 0 55 L 32 85 L 58 70 L 58 350 L 242 350
              L 242 70 L 268 85 L 300 55 L 225 0
              C 215 32 183 48 150 48 C 117 48 85 32 75 0 Z
            `}
            fill={color === "white" ? "#f8f8f8" : "#b8b8b8"}
            stroke={color === "white" ? "#ddd" : "#888"}
            strokeWidth="1.5"
          />
          <path
            d="M 75 0 C 85 32 117 48 150 48 C 183 48 215 32 225 0"
            fill="none"
            stroke={color === "white" ? "#ccc" : "#777"}
            strokeWidth="1.5"
          />
        </svg>

        {/* Design overlay — use iframe for PDF rendering (most reliable cross-browser) */}
        <div
          className="absolute overflow-hidden z-10"
          style={{ top: 65, left: 70, width: 160, height: 230, borderRadius: 4 }}
        >
          {pdfUrl ? (
            <iframe
              key={pdfUrl} // Force re-render when URL changes (jewel toggle)
              src={`${pdfUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
              width="160"
              height="230"
              className="border-0 pointer-events-none"
              title={`${side} of shirt preview`}
            />
          ) : (
            <div className="flex items-center justify-center h-full bg-white/5 text-gray-500 text-xs text-center px-2">
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
