// Lists every record in a WARC: type, HTTP method or status, URL, payload size.
// Usage: node warc-summary.mjs <warcio module path> <archive.warc.gz>
import { createReadStream } from "node:fs";

const { WARCParser } = await import(process.argv[2]);
const parser = new WARCParser(createReadStream(process.argv[3]));
for await (const record of parser) {
  const payload = await record.readFully(false);
  const http = record.httpHeaders;
  const head =
    record.warcType === "request"
      ? `${http?.method ?? "?"}`
      : `${http?.statusCode ?? "-"}`;
  const body = new TextDecoder()
    .decode(payload.slice(0, 60))
    .replace(/\s+/g, " ");
  console.log(
    `${record.warcType.padEnd(8)} ${head.padEnd(5)} ${record.warcTargetURI}  (${payload.byteLength} B)${record.warcType === "request" && payload.byteLength ? `  body=${body}` : ""}`,
  );
}
