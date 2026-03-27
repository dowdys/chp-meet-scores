import { NextRequest, NextResponse } from "next/server";

// EasyPost webhook
export async function POST(request: NextRequest) {
  // TODO: Implement easypost webhook
  return NextResponse.json({ message: "EasyPost webhook - not yet implemented" }, { status: 501 });
}
