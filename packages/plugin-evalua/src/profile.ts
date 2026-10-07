import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { cleanText, isRecord } from "./schemas.js";
import { assertRelativePath, atomicWrite, ensureInside } from "./storage.js";
import type { TeacherProfile } from "./types.js";

export const PROFILE_FILE = "teacher.yaml";
export const DEFAULT_SUBJECT = "Matemáticas";
const MAX_PROFILE_BYTES = 64 * 1024;
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const languagePattern = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const logoPattern = /^assets\/[A-Za-z0-9._-]{1,64}\.(png|jpg|jpeg|webp)$/;

/** Validate and normalize a profile; throws an Error naming the offending field. */
export function validateProfile(input: unknown): TeacherProfile {
  if (!isRecord(input)) throw new Error("Teacher profile must be a mapping");
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
    throw new Error(`Unsupported teacher profile schemaVersion ${String(input.schemaVersion)}`);
  }
  const teacherName = cleanText(input.teacherName, "teacherName", 100);
  const institution = cleanText(input.institution, "institution", 150);
  const subject =
    input.subject === undefined ? DEFAULT_SUBJECT : cleanText(input.subject, "subject", 80);
  const language = input.language === undefined ? "es" : String(input.language);
  if (!languagePattern.test(language))
    throw new Error("language must be a language tag such as es");
  const paper = input.paper === undefined ? "letter" : input.paper;
  if (paper !== "letter" && paper !== "a4") throw new Error("paper must be letter or a4");
  let logo: string | undefined;
  if (input.logo !== undefined && input.logo !== null) {
    if (typeof input.logo !== "string") throw new Error("logo must be text");
    try {
      assertRelativePath(input.logo);
    } catch {
      throw new Error(`logo must be a path under assets/ (got an unsafe path)`);
    }
    if (!logoPattern.test(input.logo)) {
      throw new Error("logo must be a PNG, JPEG or WebP file under assets/");
    }
    logo = input.logo;
  }
  return {
    schemaVersion: 1,
    teacherName,
    institution,
    ...(logo ? { logo } : {}),
    subject,
    language,
    paper,
  };
}

export function parseProfile(text: string): TeacherProfile {
  if (Buffer.byteLength(text) > MAX_PROFILE_BYTES) {
    throw new Error("teacher.yaml is too large (64 KB maximum)");
  }
  const parsed: unknown = parse(text, { schema: "core", maxAliasCount: 0, uniqueKeys: true });
  if (!isRecord(parsed)) throw new Error("teacher.yaml must be a mapping of fields");
  return validateProfile(parsed);
}

export function stringifyProfile(profile: TeacherProfile): string {
  const ordered = {
    schemaVersion: profile.schemaVersion,
    teacherName: profile.teacherName,
    institution: profile.institution,
    ...(profile.logo ? { logo: profile.logo } : {}),
    subject: profile.subject,
    language: profile.language,
    paper: profile.paper,
  };
  return `# Evalua teacher profile. Edit by hand if you like; paper is letter or a4.\n${stringify(ordered, { lineWidth: 0 })}`;
}

/** Read `<root>/teacher.yaml`; undefined when it does not exist. */
export async function readProfile(root: string): Promise<TeacherProfile | undefined> {
  const file = join(root, PROFILE_FILE);
  let text: string;
  try {
    await ensureInside(root, file);
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return parseProfile(text);
  } catch (error) {
    throw new Error(`${PROFILE_FILE} is invalid: ${(error as Error).message}`);
  }
}

export async function writeProfile(root: string, profile: TeacherProfile): Promise<void> {
  const file = join(root, PROFILE_FILE);
  await ensureInside(root, file);
  await atomicWrite(file, stringifyProfile(validateProfile(profile)), 0o644);
}

export type ImageKind = "png" | "jpg" | "webp" | "svg";

/** Identify an image by magic bytes only (never by file name). */
export function detectImageKind(bytes: Uint8Array): ImageKind | undefined {
  const buffer = Buffer.from(bytes.subarray(0, 256));
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  const head = buffer.toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return undefined;
}

/**
 * Validate a logo file and copy it to `<root>/assets/logo.<ext>`. Only PNG, JPEG and WebP up to
 * 2 MB are accepted; SVG is refused (script surface). Returns the root-relative path.
 */
export async function copyLogo(root: string, source: string): Promise<string> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Logo file not found: ${source}`);
    }
    throw error;
  }
  if (!info.isFile()) throw new Error("The logo must be a regular file");
  if (info.size > MAX_LOGO_BYTES) throw new Error("The logo must be 2 MB or smaller");
  const bytes = await readFile(source);
  const kind = detectImageKind(bytes);
  if (kind === "svg") {
    throw new Error("SVG logos are not supported; use a PNG, JPEG or WebP image");
  }
  if (!kind)
    throw new Error("The logo must be a PNG, JPEG or WebP image (checked by file content)");
  const target = join(root, "assets", `logo.${kind}`);
  await ensureInside(root, target);
  await atomicWrite(target, bytes, 0o644);
  for (const other of ["png", "jpg", "webp"]) {
    if (other !== kind) await rm(join(root, "assets", `logo.${other}`), { force: true });
  }
  return `assets/logo.${kind}`;
}
