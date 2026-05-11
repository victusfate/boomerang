// Placeholder — will be replaced with ported meta-worker MetaDO in Slice 3.
export class MetaDO implements DurableObject {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_state: DurableObjectState, _env: unknown) {}
  async fetch(_request: Request): Promise<Response> {
    return new Response('MetaDO not yet migrated', { status: 503 });
  }
}
