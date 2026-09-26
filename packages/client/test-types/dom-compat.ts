// Compile-only: proves real DOM objects fit the package's platform-neutral types.
import {
  TamberClient,
  type AbortSignalLike,
  type FetchLike,
  type ResponseLike,
} from '../src/index.ts';

declare const res: Response;
declare const ctrl: AbortController;
declare const file: File;

const f: FetchLike = fetch;
const r: ResponseLike = res;
const s: AbortSignalLike = ctrl.signal;

const client = new TamberClient({ baseUrl: 'https://tts.example.com', fetch });
void client.extract({ file, filename: file.name }, { signal: ctrl.signal });
void client.synthesize({ text: 'hi' }, { signal: ctrl.signal });
void [f, r, s];
