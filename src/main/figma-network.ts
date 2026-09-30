export function rateLimitMessage(value: string | null) {
  const seconds = Number(value);
  if (value && Number.isFinite(seconds) && seconds > 0) {
    const wait =
      seconds >= 3600
        ? `about ${Math.ceil(seconds / 3600)} hours`
        : seconds >= 60
          ? `about ${Math.ceil(seconds / 60)} minutes`
          : `${Math.ceil(seconds)} seconds`;
    return `Figma rate limit reached. Figma asks you to wait ${wait} before retrying. Repeated retries will not reset this limit.`;
  }
  return 'Figma rate limit reached. Wait for your Figma API quota to reset before retrying.';
}

export async function readBounded(response: Response, limit: number) {
  if (Number(response.headers.get('content-length') ?? 0) > limit)
    throw new Error('Figma response is too large. Choose a smaller frame.');
  if (!response.body) throw new Error('Figma returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit)
        throw new Error('Figma response is too large. Choose a smaller frame.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

function safeCode(error: unknown) {
  const value = error as {
    name?: string;
    message?: string;
    cause?: { code?: string };
  };
  const code =
    value.cause?.code ?? value.message?.match(/\bERR_[A-Z_]+\b/)?.[0];
  if (code && /^[A-Z0-9_]+$/.test(code)) return code;
  return value.name === 'TimeoutError' || value.name === 'AbortError'
    ? 'TIMEOUT'
    : 'NETWORK_ERROR';
}
export async function downloadFigmaAsset(
  address: string,
  fetcher: typeof fetch,
  allowed: (url: URL) => boolean,
  pause = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let assetUrl = new URL(address);
    for (let hop = 0; hop < 4; hop++) {
      if (!allowed(assetUrl))
        throw new Error('Figma returned an unsupported asset host.');
      let response: Response;
      try {
        response = await fetcher(assetUrl.toString(), {
          redirect: 'manual',
          signal: AbortSignal.timeout(60000),
        });
      } catch (error) {
        if (attempt === 2)
          throw new Error(
            `Could not download a Figma asset from ${assetUrl.hostname} after 3 attempts (${safeCode(error)}). Check your connection or system proxy, then retry.`,
          );
        break;
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location)
          throw new Error('Figma asset redirect has no destination.');
        if (hop === 3)
          throw new Error('Figma asset exceeded the redirect limit.');
        assetUrl = new URL(location, assetUrl);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429)
          throw new Error(
            rateLimitMessage(response.headers.get('retry-after')),
          );
        if ([408, 500, 502, 503, 504].includes(response.status) && attempt < 2)
          break;
        throw new Error(
          `Figma asset download from ${assetUrl.hostname} returned HTTP ${response.status}. Try importing again later.`,
        );
      }
      try {
        return await readBounded(response, 12 * 1024 * 1024);
      } catch (error) {
        if (
          error instanceof Error &&
          /too large|empty response/.test(error.message)
        )
          throw error;
        if (attempt === 2)
          throw new Error(
            `Figma asset download from ${assetUrl.hostname} was interrupted after 3 attempts (${safeCode(error)}). Retry when the connection is stable.`,
          );
        break;
      }
    }
    if (attempt < 2) await pause(500 * 2 ** attempt);
  }
  throw new Error('Figma asset download did not complete.');
}
