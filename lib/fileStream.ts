// Shared file-serving helper for the voiceover/video download+stream routes.
// Streams from disk (never buffers the whole file into memory — some of
// these are 50MB+ HeyGen exports) and honors HTTP Range requests, which
// <video>/<audio> elements need to seek without downloading the whole file
// first. Per AGENTS.md, based on the Route Handler streaming guidance in
// node_modules/next/dist/docs/01-app/02-guides/streaming.md (Web
// ReadableStream via a Node Readable, since Range needs createReadStream's
// {start, end} — the docs' own file-streaming example covers only the
// whole-file case).
import fs from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";

export function streamFile(
  request: Request,
  filePath: string,
  contentType: string,
  disposition: "inline" | "attachment",
  downloadName: string
): NextResponse {
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: `File no longer exists at ${filePath}.` }, {
      status: 404,
    });
  }

  const size = fs.statSync(filePath).size;
  const range = request.headers.get("range");
  const dispositionHeader = `${disposition}; filename="${downloadName}"`;

  if (!range) {
    const nodeStream = fs.createReadStream(filePath);
    return new NextResponse(Readable.toWeb(nodeStream) as ReadableStream, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(size),
        "Content-Disposition": dispositionHeader,
        "Accept-Ranges": "bytes",
      },
    });
  }

  // "bytes=START-END", END optional.
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    return new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }
  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : size - 1;
  if (start >= size || end >= size || start > end) {
    return new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }

  const nodeStream = fs.createReadStream(filePath, { start, end });
  return new NextResponse(Readable.toWeb(nodeStream) as ReadableStream, {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Disposition": dispositionHeader,
      "Accept-Ranges": "bytes",
    },
  });
}
