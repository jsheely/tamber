/**
 * @tamber/client - the shared, platform-neutral TypeScript surface of the Tamber API.
 * See README.md and docs/API.md.
 */
export * from './types.ts';
export * from './errors.ts';
export * from './platform.ts';
export { base64ToBytes, bytesToBase64, Utf8StreamDecoder, concatBytes } from './encoding.ts';
export { NdjsonLineSplitter, readNdjson, parseNdjsonText, toTtsEvent } from './ndjson.ts';
export * from './languages.ts';
export * from './voice-spec.ts';
export * from './chunking.ts';
export * from './timeline.ts';
export * from './settings.ts';
export * from './wav.ts';
export * from './client.ts';
export { brand, themeSpec } from './brand.ts';
