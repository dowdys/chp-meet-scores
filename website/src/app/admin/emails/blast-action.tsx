"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function BlastAction({ state, count }: { state: string; count: number }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleBlast = async () => {
    if (!confirm(`Send results-ready email to ${count} people in ${state}?`)) return;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/email-blast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
      if (res.ok) {
        setSent(true);
        router.refresh();
      }
    } catch {
      alert("Failed to send blast");
    }
    setLoading(false);
  };

  if (sent) {
    return <span className="text-green-600 text-sm font-medium">Sent!</span>;
  }

  return (
    <button
      onClick={handleBlast}
      disabled={loading}
      className="bg-blue-500 text-white px-4 py-2 rounded text-sm hover:bg-blue-600 disabled:opacity-50"
    >
      {loading ? "Sending..." : "Send Blast"}
    </button>
  );
}
