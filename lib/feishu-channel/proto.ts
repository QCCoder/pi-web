/**
 * Minimal protobuf codec for the Feishu long-connection `pbbp2.Frame` schema.
 *
 * Every WebSocket message on the Feishu 长连接 (long-connection) is exactly one
 * protobuf `Frame` (proto2, package `pbbp2`), with NO outer length prefix — the
 * WebSocket message boundary IS the frame boundary. This hand-rolled codec
 * implements precisely that schema (verified byte-for-byte against the official
 * @larksuiteoapi/node-sdk `ws-client/proto-buf/pbbp2.js`) so feishu-channel
 * ships with zero third-party protobuf dependencies.
 *
 *   message Header { optional string key = 1; optional string value = 2; }
 *   message Frame {
 *     required uint64 SeqID           = 1;  // tag 0x08, wire 0
 *     required uint64 LogID           = 2;  // tag 0x10, wire 0
 *     required int32  service         = 3;  // tag 0x18, wire 0  (service_id)
 *     required int32  method          = 4;  // tag 0x20, wire 0  (0=control, 1=data)
 *     repeated Header headers         = 5;  // tag 0x2A, wire 2
 *     optional string payloadEncoding = 6;  // tag 0x32, wire 2  (unused by server)
 *     optional string payloadType     = 7;  // tag 0x3A, wire 2  (unused by server)
 *     optional bytes  payload         = 8;  // tag 0x42, wire 2
 *     optional string LogIDNew        = 9;  // tag 0x4A, wire 2
 *   }
 */

export interface PbHeader {
  key: string;
  value: string;
}

export interface PbFrame {
  seqId: number;
  logId: number;
  service: number;
  method: number;
  headers: PbHeader[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  logIdNew?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- varint (LEB128, little-endian groups of 7 bits) -----------------------
// Operates on 0..2^53. The SDK disables protobufjs Long support, so uint64
// fields arrive as JS Numbers; this matches that behavior. service/method and
// realistic SeqID/LogID values are far below 2^32.

function writeVarint(out: number[], value: number): void {
  let v = value;
  if (!Number.isFinite(v) || v < 0) v = 0;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v % 0x80);
}

function readVarint(bytes: Uint8Array, pos: { i: number }): number {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = bytes[pos.i++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return result;
}

function pushBytes(out: number[], bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

function writeString(out: number[], tag: number, value: string): void {
  const bytes = encoder.encode(value);
  out.push(tag);
  writeVarint(out, bytes.length);
  pushBytes(out, bytes);
}

export function encodeHeader(header: PbHeader): Uint8Array {
  const out: number[] = [];
  writeString(out, 0x0a, header.key); // id 1, wire 2
  writeString(out, 0x12, header.value); // id 2, wire 2
  return Uint8Array.from(out);
}

export function encodeFrame(frame: PbFrame): Uint8Array {
  const out: number[] = [];
  out.push(0x08);
  writeVarint(out, frame.seqId); // id 1, wire 0
  out.push(0x10);
  writeVarint(out, frame.logId); // id 2, wire 0
  out.push(0x18);
  writeVarint(out, frame.service); // id 3, wire 0
  out.push(0x20);
  writeVarint(out, frame.method); // id 4, wire 0
  for (const header of frame.headers) {
    const sub = encodeHeader(header);
    out.push(0x2a); // id 5, wire 2
    writeVarint(out, sub.length);
    pushBytes(out, sub);
  }
  if (frame.payloadEncoding !== undefined) writeString(out, 0x32, frame.payloadEncoding); // id 6
  if (frame.payloadType !== undefined) writeString(out, 0x3a, frame.payloadType); // id 7
  if (frame.payload) {
    out.push(0x42); // id 8, wire 2
    writeVarint(out, frame.payload.length);
    pushBytes(out, frame.payload);
  }
  if (frame.logIdNew !== undefined) writeString(out, 0x4a, frame.logIdNew); // id 9
  return Uint8Array.from(out);
}

function readLengthDelimited(bytes: Uint8Array, pos: { i: number }): Uint8Array {
  const length = readVarint(bytes, pos);
  const slice = bytes.subarray(pos.i, pos.i + length);
  pos.i += length;
  return slice;
}

function readString(bytes: Uint8Array, pos: { i: number }): string {
  return decoder.decode(readLengthDelimited(bytes, pos));
}

function skipField(bytes: Uint8Array, pos: { i: number }, wire: number): void {
  switch (wire) {
    case 0:
      readVarint(bytes, pos);
      break; // varint
    case 1:
      pos.i += 8;
      break; // 64-bit fixed
    case 2:
      pos.i += readVarint(bytes, pos);
      break; // length-delimited
    case 5:
      pos.i += 4;
      break; // 32-bit fixed
    default:
      break;
  }
}

export function decodeHeader(bytes: Uint8Array): PbHeader {
  const pos = { i: 0 };
  const header: PbHeader = { key: "", value: "" };
  while (pos.i < bytes.length) {
    const tag = readVarint(bytes, pos);
    const fieldNo = tag >>> 3;
    const wire = tag & 7;
    if (fieldNo === 1) header.key = readString(bytes, pos);
    else if (fieldNo === 2) header.value = readString(bytes, pos);
    else skipField(bytes, pos, wire);
  }
  return header;
}

export function decodeFrame(bytes: Uint8Array): PbFrame {
  const pos = { i: 0 };
  const frame: PbFrame = { seqId: 0, logId: 0, service: 0, method: 0, headers: [] };
  while (pos.i < bytes.length) {
    const tag = readVarint(bytes, pos);
    const fieldNo = tag >>> 3;
    const wire = tag & 7;
    switch (fieldNo) {
      case 1:
        frame.seqId = readVarint(bytes, pos);
        break;
      case 2:
        frame.logId = readVarint(bytes, pos);
        break;
      case 3:
        frame.service = readVarint(bytes, pos);
        break;
      case 4:
        frame.method = readVarint(bytes, pos);
        break;
      case 5:
        frame.headers.push(decodeHeader(readLengthDelimited(bytes, pos)));
        break;
      case 6:
        frame.payloadEncoding = readString(bytes, pos);
        break;
      case 7:
        frame.payloadType = readString(bytes, pos);
        break;
      case 8:
        frame.payload = readLengthDelimited(bytes, pos);
        break;
      case 9:
        frame.logIdNew = readString(bytes, pos);
        break;
      default:
        skipField(bytes, pos, wire);
        break;
    }
  }
  return frame;
}
