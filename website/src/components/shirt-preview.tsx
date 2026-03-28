"use client";

interface ShirtPreviewProps {
  frontImageUrl: string | null;
  backImageUrl: string | null;
  color: "white" | "grey";
  athleteName?: string;
  hasJewel?: boolean;
}

function ShirtSilhouette({
  imageUrl,
  label,
  color,
}: {
  imageUrl: string | null;
  label: string;
  color: "white" | "grey";
}) {
  const fillColor = color === "white" ? "#ffffff" : "#d4d4d4";
  const strokeColor = color === "white" ? "#e5e5e5" : "#a0a0a0";
  const neckColor = color === "white" ? "#ddd" : "#888";

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: 220, height: 270 }}>
        <svg
          viewBox="0 0 220 270"
          className="absolute inset-0 z-0"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d={`
              M 55 0 L 0 40 L 24 62 L 43 52 L 43 262 L 177 262
              L 177 52 L 196 62 L 220 40 L 165 0
              C 157 24 135 36 110 36 C 85 36 63 24 55 0 Z
            `}
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth="1"
          />
          <path
            d="M 55 0 C 63 24 85 36 110 36 C 135 36 157 24 165 0"
            fill="none"
            stroke={neckColor}
            strokeWidth="1"
          />
        </svg>

        <div
          className="absolute overflow-hidden z-10 flex items-center justify-center"
          style={{ top: 48, left: 52, width: 116, height: 170, borderRadius: 2 }}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={label}
              className="w-full h-full object-contain"
              crossOrigin="anonymous"
            />
          ) : (
            <div className="text-gray-400 text-[10px] text-center px-1">
              Not yet available
            </div>
          )}
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-1">{label}</p>
    </div>
  );
}

export function ShirtPreview({
  frontImageUrl,
  backImageUrl,
  color,
}: ShirtPreviewProps) {
  return (
    <div className="flex gap-6 justify-center items-start">
      <ShirtSilhouette
        imageUrl={frontImageUrl}
        label="Front"
        color={color}
      />
      <ShirtSilhouette
        imageUrl={backImageUrl}
        label="Back"
        color={color}
      />
    </div>
  );
}
