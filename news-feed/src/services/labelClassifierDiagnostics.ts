export const TAG_LOG = '[AI Tags]';

export const LM_TEXT_EN_IO = {
  expectedInputs: [{ type: 'text' as const, languages: ['en' as const] }],
  expectedOutputs: [{ type: 'text' as const, languages: ['en' as const] }],
};

export function isPromptApiAvailable(): boolean {
  return typeof (globalThis as any).LanguageModel !== 'undefined';
}

export function isProbablyMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

async function readAvailability(label: string, options?: unknown): Promise<string | null> {
  const LM = (globalThis as any).LanguageModel;
  if (typeof LM?.availability !== 'function') return null;
  try {
    const status = options === undefined
      ? await LM.availability()
      : await LM.availability(options);
    console.info(TAG_LOG, `availability ${label}`, status, options ?? {});
    return String(status);
  } catch (e) {
    console.warn(TAG_LOG, `availability ${label} error`, e, options ?? {});
    return null;
  }
}

export async function getPromptApiAvailability(): Promise<string | null> {
  if (!isPromptApiAvailable()) return null;
  return readAvailability('status poll text en I/O', LM_TEXT_EN_IO);
}

async function logPromptApiDiagnostics(tag: string): Promise<string | null> {
  const userActivation = typeof navigator !== 'undefined'
    ? (navigator as any).userActivation
    : null;
  const mobileLike = isProbablyMobileBrowser();
  console.info(TAG_LOG, tag, 'Prompt API diagnostics', {
    hasLanguageModel: isPromptApiAvailable(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    languages: typeof navigator !== 'undefined' ? navigator.languages : null,
    secureContext: typeof isSecureContext !== 'undefined' ? isSecureContext : null,
    origin: typeof location !== 'undefined' ? location.origin : null,
    mobileLike,
    userActivation: userActivation
      ? { isActive: userActivation.isActive, hasBeenActive: userActivation.hasBeenActive }
      : null,
    docs: 'https://developer.chrome.com/docs/ai/get-started',
    internals: 'chrome://on-device-internals',
  });
  if (mobileLike) {
    console.info(
      TAG_LOG,
      'Prompt API likely unavailable because Chrome reports a mobile user agent. Disable DevTools device emulation / mobile UA override and retry on desktop Chrome.',
    );
  }
  return readAvailability('text en I/O', LM_TEXT_EN_IO);
}

export async function getLanguageModelAvailability(tag: string): Promise<string | null> {
  return logPromptApiDiagnostics(tag);
}
