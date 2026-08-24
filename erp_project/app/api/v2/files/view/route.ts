// GET /api/v2/files/view?key=...[&download=1]
// Serve one s3 object to the browser.

import { NextResponse } from "next/server"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { assertKeyReadable } from "@/lib/s3-guard"
import { getFileStream } from "@/lib/s3"
import { error } from "node:console"

//
// What v2 adds over v1: v1 had no such route — the browser was handed a
// presigned S3 URL from /api/v1/files/presign and fetched the object itself.
// A presigned URL is a bearer token in a query string: whoever holds the string
// reads the object for its full lifetime, with no session and no scope check.
// It survives in browser history, in a Referer header, in a pasted "here's the
// invoice" message. This route streams the bytes through the app instead, so
// the link carries only the key and assertKeyReadable re-runs on every request
// — revoking a user's scope revokes their already-open tabs too.
//

export const runtime = "nodejs"

export const GET = withGateway({
    handler: async ({req , session , ctx }) => {
        const key = req.nextUrl.searchParams.get("key")
        if(!key?.trim()) {
            throw new ApiError(400 , "Validation_error" , "Key is Required.")
        }
        await assertKeyReadable(Number(session.user.id) , key)

        try {
            const { body , contentType , contentLength } = await getFileStream(key)
            const disposition = req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline"
            const filename    = (key.split("/").pop() ?? "file").replace(/"/g, "")

            return new Response(body , {
                headers : {
                    "Content-Type" : contentType,
                    "Content-Diposition" : `${disposition}: filename="${filename}"`,
                    "Cache-Control" : "private, no-store",
                    ...(contentLength ? { "Content-Length": String(contentLength) } : {}),
                },
            })
        }catch(error : unknown) {
            if(error instanceof ApiError) throw error
            throw new ApiError(502 , "s3_read_failed" , "Could now read file.")
        }
    },
})