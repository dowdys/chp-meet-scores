import { NextRequest, NextResponse } from "next/server";

// Order CRUD
export async function POST(request: NextRequest) {
  // TODO: Implement order crud
  return NextResponse.json({ message: "Order CRUD - not yet implemented" }, { status: 501 });
}

export async function GET(request: NextRequest) {
  // TODO: Implement order crud GET
  return NextResponse.json({ message: "Order CRUD GET - not yet implemented" }, { status: 501 });
}
