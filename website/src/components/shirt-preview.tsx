"use client";

import { useState, useMemo } from "react";

interface ShirtPreviewProps {
  frontImageUrl: string | null;
  backPdfUrl: string | null;
  color: "white" | "grey";
  athleteName?: string;
  hasJewel?: boolean;
}

export function ShirtPreview({
  frontImageUrl,
  backPdfUrl,
  color,
  athleteName,
  hasJewel = false,
}: ShirtPreviewProps) {
  const [side, setSide] = useState<"front" | "back">("front");

  // Back preview: route through API that adds stars when jewel is checked
  // TODO: Convert back PDFs to PNGs too once Electron publishes them
  const backImageUrl = useMemo(() => {
    if (!backPdfUrl) return null;
    // For now, back PDFs can't be rendered as images client-side
    // This will work once we convert backs to PNGs during Electron publish
    return null;
  }, [backPdfUrl]);

  const currentImage = side === "front" ? frontImageUrl : backImageUrl;

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

        {/* Design image overlay */}
        <div
          className="absolute overflow-hidden z-10 flex items-center justify-center"
          style={{ top: 65, left: 70, width: 160, height: 230, borderRadius: 4 }}
        >
          {currentImage ? (
            <img
              src={currentImage}
              alt={`${side} of shirt`}
              className="w-full h-full object-contain"
              crossOrigin="anonymous"
            />
          ) : (
            <div className="text-gray-500 text-xs text-center px-2">
              {side === "front"
                ? "Front preview loading..."
                : "Back preview available after meet processing"}
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
