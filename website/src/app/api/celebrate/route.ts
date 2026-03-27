import { NextRequest, NextResponse } from "next/server";

// Scan tracking
export async function POST(request: NextRequest) {
  // TODO: Implement scan tracking
  return NextResponse.json({ message: "Scan tracking - not yet implemented" }, { status: 501 });
}

export async function GET(request: NextRequest) {
  // TODO: Implement scan tracking GET
  return NextResponse.json({ message: "Scan tracking GET - not yet implemented" }, { status: 501 });
}
