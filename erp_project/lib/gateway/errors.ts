import { NextResponse } from "next/server"

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public headers?: Record<string , string>
  ) {
    super(message)
  }
}

export function toErrorResponse(err: unknown, requestId: string) {
  if (err instanceof ApiError) {
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details, requestId },
      { status: err.status , headers : err.headers }
    )
  }
  return NextResponse.json(
    { error: "Database error", code: "internal", requestId },
    { status: 500 }
  )
}
