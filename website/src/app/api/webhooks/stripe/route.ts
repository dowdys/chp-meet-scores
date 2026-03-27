import { NextRequest, NextResponse } from "next/server";

// Stripe webhook
export async function POST(request: NextRequest) {
  // TODO: Implement stripe webhook
  return NextResponse.json({ message: "Stripe webhook - not yet implemented" }, { status: 501 });
}
