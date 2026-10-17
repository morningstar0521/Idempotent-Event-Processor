export async function postEvent(
  key: string,
  body: unknown,
  baseUrl: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'change-me', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
