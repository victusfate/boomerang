export const DEFAULT_META_WORKER_URL = 'https://boomerang-meta.boomerang.workers.dev';

export function metaWorkerWsUrl(base: string): string {
  return base.replace(/^http/, 'ws') + '/ws';
}

// Client → DO
export interface SubscribeMsg   { type: 'subscribe'; articleIds: string[] }
export interface CatchUpMsg     { type: 'catchUp'; since: number }
export interface SubmitTagsMsg  { type: 'submitTags'; articles: Array<{ articleId: string; tags: string[] }> }
export interface PongMsg        { type: 'pong' }
export type ClientMsg = SubscribeMsg | CatchUpMsg | SubmitTagsMsg | PongMsg;

// DO → Client
export interface WelcomeMsg  { type: 'welcome' }
export interface PingMsg     { type: 'ping' }
export interface TagsMsg     { type: 'tags'; articleId: string; tags: string[]; updatedAt: number }
export interface CatchUpReplyMsg { type: 'catchUp'; updates: Array<{ articleId: string; tags: string[]; updatedAt: number }> }
export type ServerMsg = WelcomeMsg | PingMsg | TagsMsg | CatchUpReplyMsg;

export function parseServerMsg(raw: string): ServerMsg | null {
  try {
    const msg = JSON.parse(raw) as ServerMsg;
    if (typeof msg.type !== 'string') return null;
    return msg;
  } catch {
    return null;
  }
}
