"use client";

interface ShirtPreviewProps {
  frontImageUrl: string | null;
  backImageUrl: string | null;
  color: "white" | "grey";
}

function ShirtMockup({
  imageUrl,
  label,
  color,
}: {
  imageUrl: string | null;
  label: string;
  color: "white" | "grey";
}) {
  const shirtBg = color === "white" ? "#f0f0f0" : "#444";
  const shirtHighlight = color === "white" ? "#fafafa" : "#555";
  const shirtDark = color === "white" ? "#e0e0e0" : "#2a2a2a";
  const collarColor = color === "white" ? "#d0d0d0" : "#555";
  const sleeveColor = color === "white" ? "#d8d8d8" : "#4a4a4a";

  return (
    <div className="flex flex-col items-center flex-1">
      <div
        className="relative rounded-lg overflow-hidden"
        style={{
          width: "100%",
          maxWidth: 460,
          aspectRatio: "3/4",
          background: `radial-gradient(ellipse at 50% 35%, ${shirtHighlight} 0%, ${shirtBg} 50%, ${shirtDark} 100%)`,
          boxShadow: "0 8px 30px rgba(0,0,0,0.12)",
        }}
      >
        {/* Collar */}
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{
            top: "5%",
            width: "24%",
            height: "7%",
            borderRadius: "0 0 50% 50%",
            border: `2px solid ${collarColor}`,
            borderTop: "none",
          }}
        />

        {/* Left sleeve seam */}
        <div
          className="absolute"
          style={{
            top: "8%",
            left: "2%",
            width: "20%",
            height: "16%",
            borderBottom: `1px solid ${sleeveColor}`,
            borderRadius: "0 0 0 50%",
            transform: "rotate(-8deg)",
          }}
        />

        {/* Right sleeve seam */}
        <div
          className="absolute"
          style={{
            top: "8%",
            right: "2%",
            width: "20%",
            height: "16%",
            borderBottom: `1px solid ${sleeveColor}`,
            borderRadius: "0 0 50% 0",
            transform: "rotate(8deg)",
          }}
        />

        {/* Design overlay */}
        <div
          className="absolute flex items-center justify-center"
          style={{
            top: "14%",
            left: "10%",
            width: "80%",
            height: "70%",
          }}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={label}
              className="w-full h-full object-cover"
              crossOrigin="anonymous"
              style={{
                mixBlendMode: color === "white" ? "multiply" : "screen",
                filter: color === "white" ? "none" : "brightness(1.1)",
              }}
            />
          ) : (
            <div
              className="text-center px-4"
              style={{ color: color === "white" ? "#bbb" : "#777" }}
            >
              <p className="text-sm">Preview not available</p>
              <p className="text-xs mt-1">
                Design appears once meet is processed
              </p>
            </div>
          )}
        </div>

        {/* Subtle fabric texture */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "repeating-linear-gradient(0deg, transparent, transparent 1px, rgba(128,128,128,0.02) 1px, rgba(128,128,128,0.02) 2px)",
          }}
        />
      </div>
      <p className="text-sm text-gray-500 mt-3 font-medium">{label}</p>
    </div>
  );
}

export function ShirtPreview({
  frontImageUrl,
  backImageUrl,
  color,
}: ShirtPreviewProps) {
  return (
    <div className="flex gap-8 justify-center items-start max-w-5xl mx-auto px-4">
      <ShirtMockup imageUrl={frontImageUrl} label="Front" color={color} />
      <ShirtMockup imageUrl={backImageUrl} label="Back" color={color} />
    </div>
  );
}
