"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ShipAction({ orderId }: { orderId: number }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleCreateLabel = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: [orderId] }),
      });
      const data = await res.json();
      if (data.results?.[0]?.success) {
        setResult(`Tracking: ${data.results[0].trackingNumber}`);
        router.refresh();
      } else {
        setResult(`Error: ${data.results?.[0]?.error || "Unknown"}`);
      }
    } catch {
      setResult("Network error");
    }
    setLoading(false);
  };

  if (result) {
    return <span className="text-xs text-gray-500">{result}</span>;
  }

  return (
    <button
      onClick={handleCreateLabel}
      disabled={loading}
      className="bg-blue-500 text-white px-3 py-1 rounded text-xs hover:bg-blue-600 disabled:opacity-50"
    >
      {loading ? "Creating..." : "Create Label"}
    </button>
  );
}
