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

  // For the back, use the star-annotated version when jewel is checked
  const effectiveBackUrl = useMemo(() => {
    if (!backPdfUrl) return null;
    if (!hasJewel || !athleteName) return backPdfUrl;
    // Route through our API that adds red stars next to the athlete's name
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
      <div className="relative mx-auto" style={{ width: 280, height: 340 }}>
        {/* Shirt silhouette */}
        <svg
          viewBox="0 0 280 340"
          className="absolute inset-0"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d={`
              M 70 0
              L 0 50
              L 30 80
              L 55 65
              L 55 330
              L 225 330
              L 225 65
              L 250 80
              L 280 50
              L 210 0
              C 200 30 170 45 140 45
              C 110 45 80 30 70 0
              Z
            `}
            fill={color === "white" ? "#ffffff" : "#c0c0c0"}
            stroke={color === "white" ? "#e0e0e0" : "#999999"}
            strokeWidth="1.5"
          />
          <path
            d={`
              M 70 0
              C 80 30 110 45 140 45
              C 170 45 200 30 210 0
            `}
            fill="none"
            stroke={color === "white" ? "#d0d0d0" : "#888888"}
            strokeWidth="1.5"
          />
        </svg>

        {/* PDF overlay area */}
        <div
          className="absolute overflow-hidden rounded"
          style={{ top: 70, left: 65, width: 150, height: 200 }}
        >
          {pdfUrl ? (
            <object
              data={`${pdfUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
              type="application/pdf"
              width="150"
              height="200"
              className="pointer-events-none"
            >
              <div className="flex items-center justify-center h-full bg-gray-100 text-gray-400 text-xs text-center p-2">
                {side === "front" ? "Front design" : "Back design"}
              </div>
            </object>
          ) : (
            <div className="flex items-center justify-center h-full bg-gray-100/50 text-gray-400 text-xs text-center p-2">
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
        {side === "back" && hasJewel && " • ★ Jewel accent"}
      </p>
    </div>
  );
}
