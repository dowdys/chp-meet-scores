"use client";

import { useState, useRef, useCallback } from "react";

interface ShirtPreviewProps {
  frontImageUrl: string | null;
  backImageUrl: string | null;
  color: "white" | "grey";
  athleteName?: string;
  hasJewel?: boolean;
}

/**
 * Product image magnifier — shows a zoomed box on hover.
 */
function ImageMagnifier({
  src,
  alt,
  zoomLevel = 2.5,
  magnifierSize = 180,
  style,
  className,
}: {
  src: string;
  alt: string;
  zoomLevel?: number;
  magnifierSize?: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [showMagnifier, setShowMagnifier] = useState(false);
  const [magnifierPos, setMagnifierPos] = useState({ x: 0, y: 0 });
  const [bgPos, setBgPos] = useState({ x: 0, y: 0 });

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const img = imgRef.current;
      if (!img) return;

      const rect = img.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Position magnifier (centered on cursor, clamped to image bounds)
      setMagnifierPos({
        x: e.clientX - magnifierSize / 2,
        y: e.clientY - magnifierSize / 2,
      });

      // Background position for the zoomed view
      const bgX = (x / rect.width) * 100;
      const bgY = (y / rect.height) * 100;
      setBgPos({ x: bgX, y: bgY });
    },
    [magnifierSize]
  );

  return (
    <>
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        className={className}
        style={{ ...style, cursor: "crosshair" }}
        crossOrigin="anonymous"
        onMouseEnter={() => setShowMagnifier(true)}
        onMouseLeave={() => setShowMagnifier(false)}
        onMouseMove={handleMouseMove}
      />
      {showMagnifier && (
        <div
          className="fixed pointer-events-none z-50 rounded-lg border-2 border-gray-300 shadow-2xl"
          style={{
            left: magnifierPos.x,
            top: magnifierPos.y,
            width: magnifierSize,
            height: magnifierSize,
            backgroundImage: `url(${src})`,
            backgroundSize: `${zoomLevel * 100}%`,
            backgroundPosition: `${bgPos.x}% ${bgPos.y}%`,
            backgroundRepeat: "no-repeat",
            backgroundColor: "#fff",
          }}
        />
      )}
    </>
  );
}

/**
 * Draw red stars on a canvas overlay next to the athlete's name position.
 * This is a visual approximation — stars appear in the upper-center area
 * where names typically are on the back design.
 */
function JewelStarOverlay() {
  return (
    <div className="absolute inset-0 pointer-events-none z-20 flex items-start justify-center" style={{ paddingTop: "15%" }}>
      <svg width="20" height="20" viewBox="0 0 20 20" className="text-red-600 drop-shadow-sm">
        <polygon
          points="10,1 12.5,7.5 19,7.5 13.5,12 15.5,19 10,14.5 4.5,19 6.5,12 1,7.5 7.5,7.5"
          fill="currentColor"
        />
      </svg>
    </div>
  );
}

function ShirtMockup({
  imageUrl,
  label,
  color,
  isBack = false,
  showJewelStar = false,
}: {
  imageUrl: string | null;
  label: string;
  color: "white" | "grey";
  isBack?: boolean;
  showJewelStar?: boolean;
}) {
  const shirtBg = color === "white" ? "#f0f0f0" : "#444";
  const shirtHighlight = color === "white" ? "#fafafa" : "#555";
  const shirtDark = color === "white" ? "#e0e0e0" : "#2a2a2a";
  const sleeveColor = color === "white" ? "#d8d8d8" : "#4a4a4a";

  return (
    <div className="flex flex-col items-center flex-1">
      <div
        className="relative rounded-lg overflow-hidden"
        style={{
          width: "100%",
          maxWidth: 550,
          aspectRatio: "3/4",
          background: `radial-gradient(ellipse at 50% 35%, ${shirtHighlight} 0%, ${shirtBg} 50%, ${shirtDark} 100%)`,
          boxShadow: "0 8px 30px rgba(0,0,0,0.12)",
        }}
      >
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
            top: isBack ? "6%" : "14%",
            left: isBack ? "6%" : "10%",
            width: isBack ? "88%" : "80%",
            height: isBack ? "88%" : "70%",
          }}
        >
          {imageUrl ? (
            isBack ? (
              <ImageMagnifier
                src={imageUrl}
                alt={label}
                className="w-full h-full object-contain"
                style={{
                  mixBlendMode: color === "white" ? "multiply" : "screen",
                  filter: color === "white" ? "none" : "brightness(1.1)",
                }}
                zoomLevel={3}
                magnifierSize={200}
              />
            ) : (
              <img
                src={imageUrl}
                alt={label}
                className="w-full h-full object-contain"
                crossOrigin="anonymous"
                style={{
                  mixBlendMode: color === "white" ? "multiply" : "screen",
                  filter: color === "white" ? "none" : "brightness(1.1)",
                }}
              />
            )
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

          {/* Jewel star overlay on back */}
          {showJewelStar && isBack && imageUrl && <JewelStarOverlay />}
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
      <p className="text-sm text-gray-500 mt-3 font-medium">
        {label}
        {showJewelStar && isBack && (
          <span className="text-red-500 ml-1">★ Jewel</span>
        )}
      </p>
    </div>
  );
}

export function ShirtPreview({
  frontImageUrl,
  backImageUrl,
  color,
  athleteName,
  hasJewel = false,
}: ShirtPreviewProps) {
  return (
    <div className="flex gap-8 justify-center items-start max-w-6xl mx-auto px-4">
      <ShirtMockup imageUrl={frontImageUrl} label="Front" color={color} />
      <ShirtMockup
        imageUrl={backImageUrl}
        label="Back"
        color={color}
        isBack
        showJewelStar={hasJewel}
      />
    </div>
  );
}
