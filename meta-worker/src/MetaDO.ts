export class MetaDO implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response('Not implemented', { status: 501 });
  }
}
