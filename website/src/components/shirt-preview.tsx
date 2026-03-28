"use client";

interface ShirtPreviewProps {
  frontImageUrl: string | null;
  backImageUrl: string | null;
  color: "white" | "grey";
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
  const fill = color === "white" ? "#ffffff" : "#d0d0d0";
  const stroke = color === "white" ? "#ffffff" : "#b0b0b0";

  return (
    <div className="flex flex-col items-center flex-1">
      <div className="relative w-full" style={{ maxWidth: 320, aspectRatio: "220/270" }}>
        <svg
          viewBox="0 0 220 270"
          className="absolute inset-0 w-full h-full z-0"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d={`
              M 55 0 L 0 40 L 24 62 L 43 52 L 43 262 L 177 262
              L 177 52 L 196 62 L 220 40 L 165 0
              C 157 24 135 36 110 36 C 85 36 63 24 55 0 Z
            `}
            fill={fill}
            stroke={stroke}
            strokeWidth="0.5"
          />
          <path
            d="M 55 0 C 63 24 85 36 110 36 C 135 36 157 24 165 0"
            fill="none"
            stroke={color === "white" ? "#f0f0f0" : "#aaa"}
            strokeWidth="0.5"
          />
        </svg>

        {/* Design overlay — positioned relative to shirt body */}
        <div
          className="absolute overflow-hidden z-10 flex items-center justify-center"
          style={{
            top: "18%",
            left: "24%",
            width: "52%",
            height: "63%",
          }}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={label}
              className="w-full h-full object-contain"
              crossOrigin="anonymous"
            />
          ) : (
            <div className="text-gray-500 text-xs text-center px-1">
              Not yet available
            </div>
          )}
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-2">{label}</p>
    </div>
  );
}

export function ShirtPreview({
  frontImageUrl,
  backImageUrl,
  color,
}: ShirtPreviewProps) {
  return (
    <div className="flex gap-4 justify-center items-start max-w-3xl mx-auto">
      <ShirtSilhouette imageUrl={frontImageUrl} label="Front" color={color} />
      <ShirtSilhouette imageUrl={backImageUrl} label="Back" color={color} />
    </div>
  );
}
