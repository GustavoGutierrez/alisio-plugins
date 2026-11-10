import { gzipSync } from "node:zlib";

export interface TarEntry {
  name: string;
  data?: Buffer;
  type?: "0" | "1" | "2" | "5" | "x";
  linkname?: string;
}

function header(name: string, size: number, type: string, linkname = "") {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(linkname, 157);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

/** A gzipped ustar archive, like an npm tarball. Long names use a pax `path` record. */
export function makeTgz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    if (entry.name.length > 100) {
      const record = ` path=${entry.name}\n`;
      let length = record.length + 2;
      length = `${length}${record}`.length;
      const pax = Buffer.from(`${length}${record}`);
      parts.push(
        header("PaxHeader", pax.length, "x"),
        pax,
        Buffer.alloc((512 - (pax.length % 512)) % 512),
      );
    }
    parts.push(header(entry.name, data.length, entry.type ?? "0", entry.linkname));
    parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
