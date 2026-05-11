// Placeholder — will be replaced with @victusfate/ricochet RecDO in Slice 4.
export class RecDO implements DurableObject {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(_state: DurableObjectState, _env: unknown) {}
  async fetch(_request: Request): Promise<Response> {
    return new Response('RecDO not yet migrated', { status: 503 });
  }
}
