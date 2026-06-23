export type CaptureDestination =
  | { type: 'saved-list' }
  | { type: 'github'; owner: string; repo: string; path: string; branch: string };

export type CaptureTokenRecord =
  | { roomId: string; destinationType: 'saved-list' }
  | {
      roomId: string;
      destinationType: 'github';
      destinationConfig: { owner: string; repo: string; path: string; branch: string };
    };

export interface CaptureRecord {
  id: string;
  url: string;
  title: string;
  note: string;
  ts: string;
  source: string;
}
