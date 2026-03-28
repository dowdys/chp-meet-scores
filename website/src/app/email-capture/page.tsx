"use client";

import { useState } from "react";
import Link from "next/link";

export default function EmailCapturePage() {
  const [form, setForm] = useState({
    email: "",
    phone: "",
    athlete_name: "",
    state: "",
    gym: "",
    level: "",
  });
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await fetch("/api/email-capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, source: "website" }),
      });

      if (!res.ok) {
        const data = await res.json();
        setErrorMsg(data.error || "Something went wrong");
        setStatus("error");
        return;
      }

      setStatus("success");
    } catch {
      setErrorMsg("Network error. Please try again.");
      setStatus("error");
    }
  };

  if (status === "success") {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white flex items-center justify-center px-6">
        <div className="text-center max-w-md">
          <div className="text-5xl mb-4">📬</div>
          <h1 className="text-2xl font-bold mb-3">You&apos;re on the list!</h1>
          <p className="text-gray-300 mb-6">
            We&apos;ll email you as soon as the results are ready. Your gym
            should also receive order forms in the mail soon!
          </p>
          <Link
            href="/"
            className="text-red-500 hover:underline"
          >
            Back to home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white">
      <header className="p-6 max-w-6xl mx-auto">
        <Link href="/" className="text-xl font-bold">
          The State Champion
        </Link>
      </header>

      <main className="max-w-md mx-auto px-6 py-12">
        <h1 className="text-2xl font-bold mb-2">Get Notified</h1>
        <p className="text-gray-400 mb-8">
          We&apos;re still processing results for this meet. Enter your info
          and we&apos;ll let you know when everything is ready to order!
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Email <span className="text-red-400">*</span>
            </label>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white"
              placeholder="parent@email.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Phone <span className="text-gray-500">(optional)</span>
            </label>
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white"
              placeholder="(555) 123-4567"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Athlete&apos;s Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              required
              value={form.athlete_name}
              onChange={(e) =>
                setForm({ ...form, athlete_name: e.target.value })
              }
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white"
              placeholder="Jane Smith"
              maxLength={100}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">State</label>
              <input
                type="text"
                value={form.state}
                onChange={(e) => setForm({ ...form, state: e.target.value })}
                className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white"
                placeholder="Nevada"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Level</label>
              <input
                type="text"
                value={form.level}
                onChange={(e) => setForm({ ...form, level: e.target.value })}
                className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white"
                placeholder="Level 7"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Gym</label>
            <input
              type="text"
              value={form.gym}
              onChange={(e) => setForm({ ...form, gym: e.target.value })}
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white"
              placeholder="Gold Medal Gymnastics"
            />
          </div>

          {errorMsg && (
            <p className="text-red-400 text-sm">{errorMsg}</p>
          )}

          <button
            type="submit"
            disabled={status === "loading"}
            className="w-full bg-red-600 text-black py-3 rounded-lg font-bold hover:bg-red-500 transition disabled:opacity-50"
          >
            {status === "loading" ? "Submitting..." : "Notify Me"}
          </button>
        </form>
      </main>
    </div>
  );
}
