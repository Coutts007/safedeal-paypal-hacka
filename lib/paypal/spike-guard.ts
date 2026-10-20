import { NextResponse } from "next/server";

/** Spike routes exist only in local development; production builds answer 404. */
export function spikeDisabled(): NextResponse | null {
  return process.env.NODE_ENV === "production"
    ? NextResponse.json({ error: "not found" }, { status: 404 })
    : null;
}
